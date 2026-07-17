// P5 — the done-member DETACH sweep. Two layers of coverage:
//   (1) sweepThread — the per-member core (readCanvasSession → shouldDetachDoneMember → drop-membership +
//       releaseSeat) replayed over the REAL ledger, covering the seat drop and the reopen-set filter.
//   (2) the REAL ctx-bound tick (server-orchestration.detachDoneMembersTick) driven against a REAL fsState +
//       a minimal fake ServerContext (the middleware-hermetic pattern). This is the half the hand-replay
//       CANNOT see: the tick must clear BOTH the durable-member MARKER and the in-memory `fsState.durableMembers`
//       MIRROR — a marker-only drop (the BUG-1 regression: it called removeThreadMember, not forgetDurableMember)
//       left the mirror stale until restart, so pills never cleared and stale sids kept flowing into wake fan-out.
//   (3) the STILL-LIVE done-INTENT branch (thread "Thread liveness"): a shared Coordinator seated on a meta
//       thread + children, done on one child but still live, is detached off its per-thread `done` intent —
//       the pure predicates (threadIntentForSid + shouldDetachDoneIntent) and the real tick that reads them.
// (The best-effort client card-removal is a browser-only reactor; see the P5 report.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addThreadMember,
  fillSeat,
  readThreadMeta,
  readReopenSet,
  releaseSeat,
  removeThreadMember,
  seatForSid,
  setReopenSet,
  threadIntentForSid,
  threadMembersFromMeta,
  upsertThreadMeta,
} from "../thread-ledger.js";
import { recordSessionEnd, readCanvasSession } from "../session-ledger.js";
import { shouldDetachDoneIntent, shouldDetachDoneMember } from "../auto-wake.js";

// The split server modules import each other by the TS/Vite `.js`-specifier convention (`./server-context.js`
// resolving to server-context.ts). `node --test` resolves raw, so rewrite a relative `.js` import to its `.ts`
// sibling ONLY when the `.js` doesn't exist (hand-authored `.js` modules stay unchanged) — mirrors Vite/tsc.
// Must be registered before the dynamic imports below. (Same hook as middleware-hermetic.test.mjs.)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const orch = await import("../server-orchestration.ts");
const snap = await import("../server-snapshot.ts");
const serverCtx = await import("../server-context.ts");

const DELAY = 2 * 60_000;
const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "detach-done-"));

// Replays the per-member core of detachDoneMembersTick over ONE thread, using the real ledger + session-ledger
// + auto-wake code (the ctx-bound board/thread iteration is the only thing the tick adds around this).
function sweepThread(repo, threadId, now, isLive) {
  let detached = 0;
  for (const sid of threadMembersFromMeta(readThreadMeta(repo, threadId))) {
    if (!shouldDetachDoneMember(sid, readCanvasSession(repo, sid), now, DELAY, isLive)) continue;
    removeThreadMember(repo, threadId, sid);
    releaseSeat(repo, threadId, sid);
    detached++;
  }
  return detached;
}

test("detach sweep: a done+aged member is dropped from the roster and its seat released; a live member stays", () => {
  const repo = tmpRepo();
  const T = "node:thread:t1";
  const now = 10 * DELAY;
  addThreadMember(repo, T, "done-sid", 1);
  addThreadMember(repo, T, "live-sid", 1);
  fillSeat(repo, T, "worker", "done-sid", 1);
  recordSessionEnd(repo, "done-sid", "done", now - DELAY - 1); // ended past the grace window
  // live-sid: no end marker (still running) — and asserted live by the predicate

  assert.equal(sweepThread(repo, T, now, (s) => s === "live-sid"), 1, "exactly one member swept");
  const meta = readThreadMeta(repo, T);
  assert.deepEqual(threadMembersFromMeta(meta).sort(), ["live-sid"], "done member dropped, live kept");
  assert.equal(seatForSid(meta.seats, "done-sid"), null, "done member's seat released");
});

test("detach sweep: a just-done member (inside the grace window) is NOT dropped", () => {
  const repo = tmpRepo();
  const T = "node:thread:t2";
  const now = 10 * DELAY;
  addThreadMember(repo, T, "fresh-done", 1);
  recordSessionEnd(repo, "fresh-done", "done", now - 1); // ended a moment ago
  assert.equal(sweepThread(repo, T, now, () => false), 0);
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["fresh-done"]);
});

test("detach sweep: a terminated/crashed member is left as signal, not swept", () => {
  const repo = tmpRepo();
  const T = "node:thread:t3";
  const now = 10 * DELAY;
  addThreadMember(repo, T, "crashed-sid", 1);
  recordSessionEnd(repo, "crashed-sid", "terminated", now - DELAY - 1);
  assert.equal(sweepThread(repo, T, now, () => false), 0);
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["crashed-sid"]);
});

test("detach sweep: a LIVE session with a stale done marker is spared (belt-and-suspenders guard)", () => {
  const repo = tmpRepo();
  const T = "node:thread:t3b";
  const now = 100 * DELAY;
  addThreadMember(repo, T, "revived-sid", 1);
  recordSessionEnd(repo, "revived-sid", "done", now - 10 * DELAY); // old done marker...
  assert.equal(sweepThread(repo, T, now, (s) => s === "revived-sid"), 0, "isLive spares it despite the marker");
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["revived-sid"]);
});

test("detach sweep: the one-time cleanup — several long-done members all drop in one pass, live Coordinator untouched", () => {
  const repo = tmpRepo();
  const T = "node:thread:t4";
  const now = 100 * DELAY;
  for (const sid of ["old-a", "old-b", "old-c"]) {
    addThreadMember(repo, T, sid, 1);
    recordSessionEnd(repo, sid, "done", now - 10 * DELAY);
  }
  addThreadMember(repo, T, "coord-live", 1);
  fillSeat(repo, T, "pm", "coord-live", 1); // the live Coordinator seat — must survive
  assert.equal(sweepThread(repo, T, now, (s) => s === "coord-live"), 3);
  const meta = readThreadMeta(repo, T);
  assert.deepEqual(threadMembersFromMeta(meta), ["coord-live"]);
  assert.equal(seatForSid(meta.seats, "coord-live"), "pm", "live Coordinator's seat untouched");
});

test("reopen-set filter: a detached member frozen in the reopen-set is not restored on reopen", () => {
  const repo = tmpRepo();
  const T = "node:thread:t5";
  addThreadMember(repo, T, "still-member", 1);
  // The reopen-set was frozen (thread card closed) with a member that has SINCE been detached.
  setReopenSet(repo, T, ["still-member", "detached-sid"]);
  // The endpoint's filter: restore only sids still in the durable roster (members ∪ seat occupants).
  const meta = readThreadMeta(repo, T);
  const members = new Set(threadMembersFromMeta(meta));
  for (const s of Object.values(meta?.seats ?? {})) if (s?.sid) members.add(s.sid);
  const restored = readReopenSet(meta).filter((sid) => members.has(sid));
  assert.deepEqual(restored, ["still-member"], "only the still-durable member is restored; the detached one is dropped");
});

// ── the REAL ctx-bound tick against a REAL fsState (the half sweepThread cannot see: the in-memory mirror) ──
// Wire a minimal fake ServerContext whose fsState carries a real `durableMembers` map and the REAL
// forgetDurableMember/recordDurableMember (which both read that fsState via getServerContext). Then drive the
// actual orch.detachDoneMembersTick and assert BOTH tiers — marker AND in-memory mirror — clear together.
function wireDetachContext(repo) {
  const fsState = { durableMembers: new Map() };
  const published = [];
  const fake = {
    boards: new Map([["b1", { repoPath: repo }]]),
    liveSessions: new Map(),
    fsState,
    threadLog: () => [],
    publishThreadFeed: (boardId, threadId) => published.push({ boardId, threadId }),
    forgetDurableMember: snap.forgetDurableMember,
  };
  serverCtx.setServerContext(fake);
  return { fsState, published, liveSessions: fake.liveSessions };
}

test("real tick: a done+aged member is dropped from BOTH the marker and the in-memory durableMembers mirror", () => {
  const repo = tmpRepo();
  const T = "node:thread:real1";
  const { fsState, published } = wireDetachContext(repo);
  // recordDurableMember writes both tiers — exactly the member:open sighting path the server uses.
  snap.recordDurableMember(repo, T, "done-sid", 1);
  snap.recordDurableMember(repo, T, "live-sid", 1);
  recordSessionEnd(repo, "done-sid", "done", Date.now() - DELAY - 10_000); // aged past the grace window
  // Sanity: both tiers currently hold both sids.
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)).sort(), ["done-sid", "live-sid"]);
  assert.deepEqual([...fsState.durableMembers.get(T)].sort(), ["done-sid", "live-sid"]);

  orch.detachDoneMembersTick();

  // MARKER: the done member is gone, the (never-ended, so not-live-but-also-not-done) live-sid stays.
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["live-sid"], "marker: done member dropped");
  // MIRROR (the BUG-1 regression assertion): removeThreadMember-only left "done-sid" here until restart.
  assert.deepEqual([...(fsState.durableMembers.get(T) ?? [])], ["live-sid"], "in-memory mirror: done member dropped too");
  assert.ok(published.some((p) => p.threadId === T), "the pill-clearing thread-feed republish fired");
});

test("real tick: a live session with a stale done marker is spared in BOTH tiers", () => {
  const repo = tmpRepo();
  const T = "node:thread:real2";
  const { fsState, liveSessions } = wireDetachContext(repo);
  snap.recordDurableMember(repo, T, "revived-sid", 1);
  recordSessionEnd(repo, "revived-sid", "done", Date.now() - DELAY - 10_000); // old done marker...
  liveSessions.set("revived-sid", { status: "running" }); // ...but the process is live again

  orch.detachDoneMembersTick();

  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["revived-sid"], "marker: live member spared");
  assert.deepEqual([...fsState.durableMembers.get(T)], ["revived-sid"], "mirror: live member spared");
});

test("real tick: a just-done member inside the grace window is left in BOTH tiers", () => {
  const repo = tmpRepo();
  const T = "node:thread:real3";
  const { fsState } = wireDetachContext(repo);
  snap.recordDurableMember(repo, T, "fresh-done", 1);
  recordSessionEnd(repo, "fresh-done", "done", Date.now() - 1); // ended a moment ago

  orch.detachDoneMembersTick();

  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["fresh-done"], "marker: fresh-done retained");
  assert.deepEqual([...fsState.durableMembers.get(T)], ["fresh-done"], "mirror: fresh-done retained");
});

// ── the STILL-LIVE done-INTENT branch (thread "Thread liveness") ──────────────────────────────────────
// A shared Coordinator seated on a meta thread + children, done on ONE child but still LIVE (working the
// others), must be detached from that child off its per-thread `done` INTENT — the exited path never fires
// (the process hasn't exited) and a live member with no intent defaults to `working`, so the child would stay
// `active` forever. These cover the sweep's second trigger and the pure predicates behind it.

test("threadIntentForSid: resolves a SEAT-keyed record by its sid stamp; freshest wins; a predecessor's is not 'its own'", () => {
  const intents = {
    pm: { intent: "done", ts: 100, sid: "coord" }, // keyed by the SEAT HANDLE, stamped with the declarer
    "sess-x": { intent: "working", ts: 50, sid: "sess-x" }, // bare-sid key
  };
  assert.equal(threadIntentForSid(intents, "coord")?.intent, "done", "seat-keyed record found via sid stamp");
  assert.equal(threadIntentForSid(intents, "sess-x")?.intent, "working", "bare-sid record found");
  assert.equal(threadIntentForSid(intents, "nobody"), null, "no record → null");
  assert.equal(
    threadIntentForSid({ pm: { intent: "done", ts: 1, sid: "old-occupant" } }, "new-occupant"),
    null,
    "a predecessor's done on a re-filled seat is not the new occupant's own",
  );
  const dup = { pm: { intent: "done", ts: 100, sid: "c" }, c: { intent: "working", ts: 200, sid: "c" } };
  assert.equal(threadIntentForSid(dup, "c")?.intent, "working", "freshest by ts when two records match");
});

test("shouldDetachDoneIntent: done+aged → true; fresh / non-done / no-ts / null → false", () => {
  const now = 10 * DELAY;
  assert.equal(shouldDetachDoneIntent({ intent: "done", ts: now - DELAY - 1 }, now, DELAY), true, "done past the window");
  assert.equal(shouldDetachDoneIntent({ intent: "done", ts: now - 1 }, now, DELAY), false, "inside the grace window");
  assert.equal(shouldDetachDoneIntent({ intent: "working", ts: now - DELAY - 1 }, now, DELAY), false, "not a done intent");
  assert.equal(shouldDetachDoneIntent({ intent: "done" }, now, DELAY), false, "no honest ts clock");
  assert.equal(shouldDetachDoneIntent(null, now, DELAY), false, "no record at all");
});

test("real tick: a still-LIVE member that declared done on this thread (past the grace window) is detached", () => {
  const repo = tmpRepo();
  const T = "node:thread:live-done";
  const { fsState, published, liveSessions } = wireDetachContext(repo);
  snap.recordDurableMember(repo, T, "coord", 1);
  snap.recordDurableMember(repo, T, "worker", 1);
  fillSeat(repo, T, "pm", "coord", 1); // seated — its intent is keyed by the SEAT HANDLE, not the sid
  liveSessions.set("coord", { status: "idle" }); // still LIVE (working other threads); NO end marker
  liveSessions.set("worker", { status: "running" });
  // coord declared `done` on THIS thread past the grace window — the real shape: keyed "pm", stamped sid:coord.
  upsertThreadMeta(repo, T, { intents: { pm: { intent: "done", ts: Date.now() - DELAY - 10_000, sid: "coord" } } });

  orch.detachDoneMembersTick();

  const meta = readThreadMeta(repo, T);
  assert.deepEqual(threadMembersFromMeta(meta), ["worker"], "the live done-intent member is detached, the worker stays");
  assert.deepEqual([...fsState.durableMembers.get(T)], ["worker"], "in-memory mirror drops it too");
  assert.equal(seatForSid(meta.seats, "coord"), null, "its seat is released");
  assert.ok(published.some((p) => p.threadId === T), "the pill-clearing thread-feed republish fired");
});

test("real tick: a member that re-declared working after done is NOT detached (the newer intent cancels it)", () => {
  const repo = tmpRepo();
  const T = "node:thread:redeclared";
  const { fsState, liveSessions } = wireDetachContext(repo);
  snap.recordDurableMember(repo, T, "coord", 1);
  fillSeat(repo, T, "pm", "coord", 1);
  liveSessions.set("coord", { status: "idle" });
  // Re-declaring working OVERWRITES the done at the same seat key — the marker only ever holds the latest, so
  // even a fresh `working` timestamp still reads as `working`, well within any window.
  upsertThreadMeta(repo, T, { intents: { pm: { intent: "working", ts: Date.now(), sid: "coord" } } });

  orch.detachDoneMembersTick();

  const meta = readThreadMeta(repo, T);
  assert.deepEqual(threadMembersFromMeta(meta), ["coord"], "still a member");
  assert.deepEqual([...fsState.durableMembers.get(T)], ["coord"], "mirror unchanged");
  assert.equal(seatForSid(meta.seats, "coord"), "pm", "seat retained");
});

test("real tick: a still-LIVE done-intent INSIDE the grace window is left (the ts is the clock)", () => {
  const repo = tmpRepo();
  const T = "node:thread:live-fresh-done";
  const { fsState, liveSessions } = wireDetachContext(repo);
  snap.recordDurableMember(repo, T, "coord", 1);
  fillSeat(repo, T, "pm", "coord", 1);
  liveSessions.set("coord", { status: "idle" });
  upsertThreadMeta(repo, T, { intents: { pm: { intent: "done", ts: Date.now() - 1, sid: "coord" } } }); // just now

  orch.detachDoneMembersTick();

  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, T)), ["coord"], "not yet past the grace window");
  assert.deepEqual([...fsState.durableMembers.get(T)], ["coord"], "mirror retains it");
});
