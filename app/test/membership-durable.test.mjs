// BUG-5 regression tests — durable thread membership is authoritative for membership MUTATIONS; no
// display-layer/snapshot-diff path may DROP (or invent) a durable member.
//
// Root cause under test (2026-07-12 silent worker drops): announceNewMemberships used to read a snapshot
// save pair where a member:open edge vanished while the session node remained as a "real leave" and called
// forgetDurableMember — so racing/stale tab saves (display noise) silently erased LIVE members from the
// ledger. Downstream: their worktree merges 403'd (the gate read the snapshot), and display repaints
// re-onboarded ledger-missing edges as fresh joins (the pill-click-on-a-Done-session spurious join).
//
// Hermetic (no dev server): the split modules are exercised against a MINIMAL fake ServerContext via
// setServerContext + tmp-dir thread markers, in the middleware-hermetic.test.mjs pattern (including its
// .js→.ts resolve hook).

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

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

const ctx = await import("../server-context.ts");
const snap = await import("../server-snapshot.ts");
const delivery = await import("../server-delivery.ts");
const ledger = await import("../thread-ledger.js");
const { threadRoutes } = await import("../routes/threads.ts");
const { detachedMemberCards, RECONCILE_ORPHAN_GRACE_MS } = await import("../src/reconcile-members.ts");

const BOARD = "board-1";
const THREAD = "node:thread:t1";
const SID = "w1-sid";
const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "bug5-"));

// A session card + its member:open edge, the spawn-time shape.
const cardAndEdge = (sid, threadId) => [
  { typeName: "node", id: `node:live:${sid}`, type: "session", title: sid },
  { typeName: "edge", id: `edge:member:${sid}:${threadId}`, from: `node:live:${sid}`, to: threadId, type: "member:open" },
];
const threadCard = (threadId) => [{ typeName: "node", id: threadId, type: "thread", title: "T1" }];

// Fake ServerContext: real pure resolvers from server-snapshot, everything effectful captured or stubbed.
function makeCtx(repoPath, records, over = {}) {
  const fsState = { durableMembers: new Map(), threadLogs: new Map() };
  const posted = [];
  const dispatched = [];
  const sent = []; // sendSessionInput pushes — the onboarding user-text (D7)
  const fake = {
    fsState,
    boards: new Map([[BOARD, { boardId: BOARD, repoPath }]]),
    liveSessions: new Map(),
    reqBoard: () => ({ boardId: BOARD, repoPath }),
    boardSnapshotRecords: () => records,
    threadNode: snap.threadNode,
    sessionNodeForSid: snap.sessionNodeForSid,
    sessionNameForSid: snap.sessionNameForSid,
    threadMemberSids: snap.threadMemberSids,
    forgetDurableMember: snap.forgetDurableMember,
    recordDurableMember: snap.recordDurableMember,
    historyKey: snap.historyKey,
    threadLog: () => [],
    appendThreadMsg: (b, t, from, text) => (posted.push({ from, text }), { seq: posted.length, from, text, ts: 1 }),
    wakeThreadMembers: () => 0,
    dispatchBusCommand: (b, cmd) => (dispatched.push(cmd), 1),
    // D7 onboarding deps: onboardMemberOpen is the REAL delivery fn (it re-reads this same fake via
    // getServerContext), so the /join route and the edge funnel exercise the actual code under test.
    onboardMemberOpen: delivery.onboardMemberOpen,
    repaintReopenedMemberEdges: delivery.repaintReopenedMemberEdges,
    sendSessionInput: (sid, text) => sent.push({ sid, text }),
    seedCursor: () => 0,
    ensureCoordinatorHeartbeat: () => {},
    persistSessionState: () => {},
    publishSession: () => {},
    publishThreadFeed: () => {},
    publishFeed: () => {},
    originOf: () => "127.0.0.1:0",
    ...over,
  };
  ctx.setServerContext(fake);
  return { fake, fsState, posted, dispatched, sent };
}

// Drive the POST /api/thread/<id>/<action> route with a JSON body; resolves with the JSON response.
function callThreadRoute(action, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(payload) {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(String(payload)) });
        } catch (e) {
          reject(e);
        }
      },
    };
    const url = new URL(`http://localhost/api/thread/${encodeURIComponent(THREAD)}/${action}?board=${BOARD}`);
    threadRoutes[0].run(req, res, url, [encodeURIComponent(THREAD), action]);
  });
}

// ── 1. The root-cause regression: the snapshot diff may NEVER drop a durable member ─────────────────

test("announceNewMemberships: edge vanished + node still standing does NOT drop the durable member (the 2026-07-12 drop)", () => {
  const repo = tmpRepo();
  const before = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD)];
  const after = [...threadCard(THREAD), before[1]]; // edge gone, session node present — the old "real leave" read
  const { fsState } = makeCtx(repo, after);
  ledger.addThreadMember(repo, THREAD, SID, 100);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  delivery.announceNewMemberships(BOARD, before, after, "127.0.0.1:0");
  assert.ok(ledger.threadMembersFromMeta(ledger.readThreadMeta(repo, THREAD)).includes(SID), "marker keeps the member");
  assert.ok(fsState.durableMembers.get(THREAD).has(SID), "in-memory tier keeps the member");
});

test("announceNewMemberships: thread-card close (all member edges cascade, session nodes remain) drops NO member", () => {
  const repo = tmpRepo();
  const s2 = "w2-sid";
  const before = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD), ...cardAndEdge(s2, THREAD)];
  // Thread card removed: its node + every member edge gone, both session nodes still standing.
  const after = [before[1], before[3]];
  const { fsState } = makeCtx(repo, after);
  for (const sid of [SID, s2]) ledger.addThreadMember(repo, THREAD, sid, 100);
  fsState.durableMembers.set(THREAD, new Set([SID, s2]));
  delivery.announceNewMemberships(BOARD, before, after, "127.0.0.1:0");
  assert.deepEqual(ledger.threadMembersFromMeta(ledger.readThreadMeta(repo, THREAD)).sort(), [SID, s2].sort());
});

test("announceNewMemberships: card delete (edge + node gone together) keeps membership, as before", () => {
  const repo = tmpRepo();
  const before = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD)];
  const after = threadCard(THREAD);
  const { fsState } = makeCtx(repo, after);
  ledger.addThreadMember(repo, THREAD, SID, 100);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  delivery.announceNewMemberships(BOARD, before, after, "127.0.0.1:0");
  assert.ok(ledger.threadMembersFromMeta(ledger.readThreadMeta(repo, THREAD)).includes(SID));
});

test("announceNewMemberships: a save that removes a member edge REPUBLISHES the thread's roster frame (pill freshness)", () => {
  const repo = tmpRepo();
  const before = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD)];
  const after = threadCard(THREAD); // select-delete of the session card: node + edge gone together
  const published = [];
  const { fsState } = makeCtx(repo, after, { publishThreadFeed: (b, t) => published.push({ board: b, thread: t }) });
  ledger.addThreadMember(repo, THREAD, SID, 100);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  delivery.announceNewMemberships(BOARD, before, after, "127.0.0.1:0");
  // Without this republish the card's pill rides the LAST-published frame (or none on a fresh tab), so a
  // deleted card dropped the pill of a still-durable member. One publish per touched thread, and the frame
  // it derives (threadMemberSids over the after-records ∪ durable tier) still carries the member.
  assert.deepEqual(published, [{ board: BOARD, thread: THREAD }], "one roster republish for the touched thread");
  assert.ok(snap.threadMemberSids(after, THREAD).includes(SID), "the fresh roster still carries the durable member");
});

test("announceNewMemberships: a save with no membership-edge change republishes NOTHING (no feed churn)", () => {
  const repo = tmpRepo();
  const records = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD)];
  const published = [];
  makeCtx(repo, records, { publishThreadFeed: (b, t) => published.push(t) });
  delivery.announceNewMemberships(BOARD, records, records, "127.0.0.1:0");
  assert.equal(published.length, 0);
});

// ── 2. /leave is the explicit drop — ledger-first, works with no card/edge, and is never silent ─────

test("POST /leave: a cardless ledger member (headless join) leaves — marker drops it, a system line records it", async () => {
  const repo = tmpRepo();
  const { fsState, posted } = makeCtx(repo, null); // NO canvas state at all
  ledger.addThreadMember(repo, THREAD, SID, 100);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  const r = await callThreadRoute("leave", { from: SID });
  assert.equal(r.status, 200);
  assert.equal(ledger.threadMembersFromMeta(ledger.readThreadMeta(repo, THREAD)).includes(SID), false, "marker dropped the leaver");
  assert.ok(posted.some((p) => p.from === "system" && p.text.includes("left")), "the departure is logged, not silent");
});

test("POST /leave: a non-member 404s and the marker is untouched", async () => {
  const repo = tmpRepo();
  makeCtx(repo, null);
  ledger.addThreadMember(repo, THREAD, "someone-else", 100);
  const r = await callThreadRoute("leave", { from: SID });
  assert.equal(r.status, 404);
  assert.deepEqual(ledger.threadMembersFromMeta(ledger.readThreadMeta(repo, THREAD)), ["someone-else"]);
});

// ── 3. The gates: worktree / message / pin existence-gate on the LEDGER, consent honors the marker ──

test("worktree op:list succeeds for a ledger member with NO snapshot presence at all (the 403'd-merge regression)", async () => {
  const repo = tmpRepo();
  makeCtx(repo, null); // thread card never persisted, no session card, no edge
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const r = await callThreadRoute("worktree", { from: SID, op: "list" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.worktrees, {});
});

test("worktree: a marker member whose card is on the snapshot WITHOUT its member edge passes the gate", async () => {
  const repo = tmpRepo();
  // The exact post-drop divergence W3 hit: session node present, member:open edge missing from the snapshot.
  const records = [...threadCard(THREAD), { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID }];
  makeCtx(repo, records);
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const r = await callThreadRoute("worktree", { from: SID, op: "list" });
  assert.equal(r.status, 200);
});

test("worktree: a session that is a member NOWHERE (snapshot or marker) still 403s", async () => {
  const repo = tmpRepo();
  const records = [...threadCard(THREAD), { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID }];
  makeCtx(repo, records);
  ledger.addThreadMember(repo, THREAD, "someone-else", 100);
  const r = await callThreadRoute("worktree", { from: SID, op: "list" });
  assert.equal(r.status, 403);
});

test("worktree: no marker AND no canvas node → 404", async () => {
  const repo = tmpRepo();
  makeCtx(repo, null);
  const r = await callThreadRoute("worktree", { from: SID, op: "list" });
  assert.equal(r.status, 404);
});

test("message: a ledger member posts to an off-canvas thread (marker exists, no card) — no 404/409", async () => {
  const repo = tmpRepo();
  const { posted } = makeCtx(repo, null);
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const r = await callThreadRoute("message", { from: SID, text: "hello" });
  assert.equal(r.status, 200);
  assert.equal(posted.at(-1).text, "hello");
});

test("message: a carded session that is a member nowhere still 403s", async () => {
  const repo = tmpRepo();
  const records = [...threadCard(THREAD), { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID }];
  makeCtx(repo, records);
  ledger.addThreadMember(repo, THREAD, "someone-else", 100);
  const r = await callThreadRoute("message", { from: SID, text: "hello" });
  assert.equal(r.status, 403);
});

test("pin: a marker member pins on an off-canvas thread; the pin lands on the marker", async () => {
  const repo = tmpRepo();
  makeCtx(repo, null, { threadLog: () => [{ seq: 1, from: SID, text: "pin me", ts: 1 }] });
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const r = await callThreadRoute("pin", { from: SID, seq: 1 });
  assert.equal(r.status, 200);
  assert.equal(ledger.readThreadMeta(repo, THREAD).pins.length, 1);
});

// ── 3b. D7: /join is ledger-first + unconditional — no session-card gate ─────────────────────────────

test("D7 /join: a session with NO card on the board joins (records durable membership + onboards, no 400)", async () => {
  const repo = tmpRepo();
  // Thread card present, but NO session card for SID (the closed-card / headless case — proof #3).
  const records = threadCard(THREAD);
  const { fsState, sent, dispatched } = makeCtx(repo, records);
  const r = await callThreadRoute("join", { from: SID });
  assert.equal(r.status, 200, "no session-card gate — the join is not refused");
  assert.ok(ledger.threadMembersFromMeta(ledger.readThreadMeta(repo, THREAD)).includes(SID), "durable membership recorded");
  assert.ok(fsState.durableMembers.get(THREAD)?.has(SID), "in-memory tier holds the member");
  assert.ok(sent.some((s) => s.sid === SID && s.text.includes("You joined thread")), "the joiner is onboarded fact-first");
  assert.equal(dispatched.filter((c) => c.type === "addEdge").length, 0, "no card ⇒ no member:open edge painted (zero effect on the fact)");
});

test("D7 /join: a re-join of an existing durable member is a no-op redraw (REOPEN GUARD — no re-onboard)", async () => {
  const repo = tmpRepo();
  const records = threadCard(THREAD);
  ledger.addThreadMember(repo, THREAD, SID, 100); // already a member
  const { sent } = makeCtx(repo, records);
  const r = await callThreadRoute("join", { from: SID });
  assert.equal(r.status, 200);
  assert.equal(sent.filter((s) => s.text.includes("You joined thread")).length, 0, "an existing member is not re-onboarded");
});

test("D7 /join: WITH a session card, the member:open edge VIEW is painted (and onboarding runs once)", async () => {
  const repo = tmpRepo();
  const records = [...threadCard(THREAD), { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID }];
  const { sent, dispatched } = makeCtx(repo, records);
  const r = await callThreadRoute("join", { from: SID });
  assert.equal(r.status, 200);
  const edges = dispatched.filter((c) => c.type === "addEdge" && c.payload?.type === "member:open");
  assert.equal(edges.length, 1, "one member:open edge painted as the view");
  assert.equal(edges[0].payload.from, `node:live:${SID}`);
  assert.equal(edges[0].payload.to, THREAD);
  assert.equal(sent.filter((s) => s.text.includes("You joined thread")).length, 1, "onboarded exactly once (fact-first, not via the edge)");
});

test("D7 /join: an unknown thread (no marker, no node) still 404s", async () => {
  const repo = tmpRepo();
  makeCtx(repo, null);
  const r = await callThreadRoute("join", { from: SID });
  assert.equal(r.status, 404);
});

// ── 3c. D7: the member:open edge is a SERVER repaint-on-(re)appearance projection ───────────────────

test("repaintReopenedMemberEdges: a session card that just APPEARED for a durable member paints its edge", () => {
  const repo = tmpRepo();
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const before = threadCard(THREAD); // no session card yet
  const after = [...threadCard(THREAD), { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID }];
  const { fsState, dispatched } = makeCtx(repo, after);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  delivery.repaintReopenedMemberEdges(BOARD, before, after, "127.0.0.1:0");
  const edges = dispatched.filter((c) => c.type === "addEdge" && c.payload?.type === "member:open");
  assert.equal(edges.length, 1, "the reappeared card's edge is repainted server-side");
  assert.equal(edges[0].payload.id, `edge:member:${SID}:${THREAD}`, "canonical edge id (converges with client redraw)");
  assert.equal(edges[0].payload.from, `node:live:${SID}`);
});

test("repaintReopenedMemberEdges: no repaint when the edge is already present (client redraw won the race)", () => {
  const repo = tmpRepo();
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const before = threadCard(THREAD);
  const after = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD)]; // card AND edge already present
  const { fsState, dispatched } = makeCtx(repo, after);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  delivery.repaintReopenedMemberEdges(BOARD, before, after, "127.0.0.1:0");
  assert.equal(dispatched.filter((c) => c.type === "addEdge").length, 0, "idempotent — no duplicate edge");
});

test("repaintReopenedMemberEdges: a card present in BOTH before and after (not newly-appeared) is not repainted", () => {
  const repo = tmpRepo();
  ledger.addThreadMember(repo, THREAD, SID, 100);
  const card = { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID };
  const before = [...threadCard(THREAD), card]; // card already on the board last save; only its edge missing
  const after = [...threadCard(THREAD), card];
  const { fsState, dispatched } = makeCtx(repo, after);
  fsState.durableMembers.set(THREAD, new Set([SID]));
  delivery.repaintReopenedMemberEdges(BOARD, before, after, "127.0.0.1:0");
  assert.equal(dispatched.filter((c) => c.type === "addEdge").length, 0, "only a (re)appearance repaints, not a standing card");
});

test("repaintReopenedMemberEdges: a card for a NON-member paints nothing (edge is a projection of the ledger fact)", () => {
  const repo = tmpRepo();
  const before = threadCard(THREAD);
  const after = [...threadCard(THREAD), { typeName: "node", id: `node:live:${SID}`, type: "session", title: SID }];
  const { dispatched } = makeCtx(repo, after); // SID never recorded as a durable member
  delivery.repaintReopenedMemberEdges(BOARD, before, after, "127.0.0.1:0");
  assert.equal(dispatched.filter((c) => c.type === "addEdge").length, 0, "no ledger membership ⇒ no edge");
});

// ── 4. Display repaint reads the LEDGER alone (pill-click on a Done session mutates nothing) ────────

test("durableSessionThreads: a snapshot-only edge (ledger doesn't back it) is NOT reported for redraw", () => {
  const repo = tmpRepo();
  makeCtx(repo, null);
  // The divergence that produced the spurious pill-join: canvas still shows a member edge, ledger has
  // dropped (detached done member / any past drop). sessionThreads (read paths) still unions the edge in;
  // the REDRAW source must not.
  const records = [...threadCard(THREAD), ...cardAndEdge(SID, THREAD)];
  assert.deepEqual(snap.sessionThreads(records, SID), [THREAD], "read-path union still sees the edge");
  assert.deepEqual(snap.durableSessionThreads(repo, SID), [], "redraw source reports nothing the ledger doesn't back");
});

test("durableSessionThreads: marker membership is reported even with the in-memory tier cold (re-eval survival)", () => {
  const repo = tmpRepo();
  makeCtx(repo, null); // fresh fsState — durableMembers empty
  ledger.addThreadMember(repo, THREAD, SID, 100);
  assert.deepEqual(snap.durableSessionThreads(repo, SID), [THREAD]);
});

// ── 5. The reconciler spares the stale-roster lag window (two-strike grace) ─────────────────────────

test("reconciler grace: a card orphaned on ONE pass (roster captured pre-join) is NOT removed", () => {
  const strikes = new Map();
  const edges = [{ from: `node:live:${SID}`, to: THREAD }];
  const staleRoster = new Map([[THREAD, new Set()]]); // thread confirmed, member not yet in it
  const due = detachedMemberCards(edges, staleRoster, strikes, 1_000);
  assert.deepEqual(due, [], "first sighting only stamps the strike");
  assert.ok(strikes.has(`node:live:${SID}`));
  // The roster refresh confirms the member → the strike clears; the card was never touched.
  const fresh = new Map([[THREAD, new Set([SID])]]);
  assert.deepEqual(detachedMemberCards(edges, fresh, strikes, 2_000), []);
  assert.equal(strikes.size, 0, "re-confirmed membership resets the strike");
});

test("reconciler grace: a card orphaned across passes beyond the window IS removed (detach still auto-closes)", () => {
  const strikes = new Map();
  const edges = [{ from: `node:live:${SID}`, to: THREAD }];
  const roster = new Map([[THREAD, new Set()]]);
  assert.deepEqual(detachedMemberCards(edges, roster, strikes, 1_000), []);
  assert.deepEqual(detachedMemberCards(edges, roster, strikes, 1_000 + RECONCILE_ORPHAN_GRACE_MS), [], "at the window edge — not yet");
  assert.deepEqual(
    detachedMemberCards(edges, roster, strikes, 2_000 + RECONCILE_ORPHAN_GRACE_MS),
    [`node:live:${SID}`],
    "past the window the orphan is removed",
  );
  assert.equal(strikes.size, 0);
});

test("reconciler grace: an unconfirmed thread (missing from the roster map) never strikes its cards", () => {
  const strikes = new Map();
  const edges = [{ from: `node:live:${SID}`, to: THREAD }];
  assert.deepEqual(detachedMemberCards(edges, new Map(), strikes, 1_000), []);
  assert.equal(strikes.size, 0, "under-remove on partial data: no strike, no removal");
});

test("reconciler grace: a stale strike for a since-closed card is pruned (no instant kill of a later same-id card)", () => {
  const strikes = new Map();
  const edges = [{ from: `node:live:${SID}`, to: THREAD }];
  const roster = new Map([[THREAD, new Set()]]);
  detachedMemberCards(edges, roster, strikes, 1_000); // strike one
  detachedMemberCards([], roster, strikes, 2_000); // card closed by other means — edge gone from the board
  assert.equal(strikes.size, 0, "the orphan stamp did not outlive the card");
});
