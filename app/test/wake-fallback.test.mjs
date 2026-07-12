// BUG-7 — the STALE-SID SEAT FALLBACK in wakeThreadMembers (server-delivery.ts). An @-tag that resolves
// ONLY to a stale/non-live sid (a stale board snapshot, or a lingering durable card from delete-card-keep-
// session) used to wake nobody AND suppress the untagged→Coordinator fallback, so the post sat on
// "Scheduled" until the next heartbeat. The fix walks each such sid back to the SEAT it named and reaches
// that seat's CURRENT occupant from the FRESH durable marker: nudge it if live, else reconstitute the seat.
//
// Driven against the REAL ctx-bound wakeThreadMembers over a REAL thread-ledger marker, with a minimal fake
// ServerContext (the middleware-hermetic / detach-done-members pattern). The spawn (maybeRespawnDormantSeat)
// is a STUB spy — no real session is spawned in the test (per the assignment's mocked-spawn rule).

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fillSeat, readThreadMeta } from "../thread-ledger.js";

// Rewrite a relative `.js` import to its `.ts` sibling when the `.js` doesn't exist (the split server modules
// use the tsc/Vite `.js`-specifier convention). Same hook as detach-done-members.test.mjs; must precede the
// dynamic imports below.
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
const delivery = await import("../server-delivery.ts");
const serverCtx = await import("../server-context.ts");

const BOARD = "b1";
const ORIGIN = "127.0.0.1:5173";
const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "wake-fallback-"));

// Wire a minimal fake ServerContext over a REAL repo (so readThreadMeta reads the real seat marker). Returns
// handles the test drives + asserts: the liveSessions registry, the maybeRespawnDormantSeat spy, and a
// mutable `names` map backing sessionNameForSid (stale-sid → card name "<Role>.<sid>").
function wire(repo, { members, names = {}, liveSessions = new Map() } = {}) {
  const respawns = [];
  const fake = {
    boards: new Map([[BOARD, { repoPath: repo }]]),
    liveSessions,
    boardSnapshotRecords: () => [], // non-null (else the fn early-returns 0); roster comes from threadMemberSids
    threadMemberSids: () => members,
    sessionNameForSid: (_records, sid) => names[sid] ?? null,
    maybeRespawnDormantSeat: (boardId, threadId, dormantSid, origin, meta) =>
      respawns.push({ boardId, threadId, dormantSid, origin, meta }),
  };
  serverCtx.setServerContext(fake);
  return { respawns, liveSessions };
}
const liveSess = (id, status = "running") => [id, { id, status, nudge: false, read: {} }];

// ── the Scheduled repro: @-tag → stale sid, seat now held by a DIFFERENT live session ──────────────────
test("stale @-tag whose seat is held by a live session under a fresh sid → the live occupant is nudged", () => {
  const repo = tmpRepo();
  const T = "node:thread:sched";
  // The seat's CURRENT occupant is the live Coordinator (fresh sid); the stale card that the tag resolved to
  // is NOT in the (stale-snapshot) roster the loop walks — only the old sid is.
  fillSeat(repo, T, "Coordinator", "live-B", 1);
  const { respawns, liveSessions } = wire(repo, {
    members: ["stale-A"], // stale snapshot: only the departed card, not live-B
    names: { "stale-A": "Coordinator.stale-A" }, // resolves @Coordinator → stale-A by name
    liveSessions: new Map([liveSess("live-B", "running")]),
  });

  const woken = delivery.wakeThreadMembers(BOARD, T, "poster", {
    broadcast: false,
    mentioned: new Set(["stale-A"]),
    origin: ORIGIN,
  });

  assert.equal(woken, 1, "the live seat occupant was woken via the fallback");
  assert.equal(liveSessions.get("live-B").nudge, true, "live-B (current Coordinator) got the nudge");
  assert.equal(respawns.length, 0, "a LIVE occupant is nudged, not respawned");
});

// ── the revive path: @-tag → dormant seat (occupant exited, not re-filled) → reconstitute the seat ─────
test("stale @-tag whose seat has NO live occupant → the seat is reconstituted (respawn), not a no-op", () => {
  const repo = tmpRepo();
  const T = "node:thread:dormant";
  fillSeat(repo, T, "Impl", "stale-A", 1); // seat still points at the now-exited occupant
  const { respawns } = wire(repo, {
    members: ["stale-A"],
    names: { "stale-A": "Impl.stale-A" },
    liveSessions: new Map(), // stale-A is not live
  });

  const woken = delivery.wakeThreadMembers(BOARD, T, "poster", {
    broadcast: false,
    mentioned: new Set(["stale-A"]),
    origin: ORIGIN,
  });

  assert.equal(woken, 0, "nobody live to nudge");
  assert.equal(respawns.length, 1, "the dormant seat was reconstituted within this dispatch cycle");
  assert.equal(respawns[0].dormantSid, "stale-A");
  assert.equal(respawns[0].threadId, T);
  assert.equal(seatOf(readThreadMeta(repo, T), "stale-A"), "Impl", "resolved the right seat handle");
});

// ── the runaway guard: an UNTAGGED post to a dormant seat must NOT respawn (4f5a3ad invariant) ─────────
test("an UNTAGGED post to a dormant seat does NOT trigger the fallback respawn (no runaway)", () => {
  const repo = tmpRepo();
  const T = "node:thread:untagged";
  fillSeat(repo, T, "Impl", "stale-A", 1);
  const { respawns } = wire(repo, {
    members: ["stale-A"],
    names: { "stale-A": "Impl.stale-A" },
    liveSessions: new Map(),
  });

  const woken = delivery.wakeThreadMembers(BOARD, T, "poster", {
    broadcast: false,
    mentioned: new Set(), // untagged — ambient
    origin: ORIGIN,
  });

  assert.equal(woken, 0);
  assert.equal(respawns.length, 0, "an untagged post is ambient — it never reconstitutes a dormant seat");
});

// ── a broadcast (join room-event) to a dormant seat also never respawns (only an @-mention reconstitutes) ─
test("a broadcast to a dormant seat does NOT trigger the fallback respawn", () => {
  const repo = tmpRepo();
  const T = "node:thread:broadcast";
  fillSeat(repo, T, "Impl", "stale-A", 1);
  const { respawns } = wire(repo, {
    members: ["stale-A"],
    names: { "stale-A": "Impl.stale-A" },
    liveSessions: new Map(),
  });

  delivery.wakeThreadMembers(BOARD, T, "poster", { broadcast: true }); // a join room-event, no origin
  assert.equal(respawns.length, 0, "a broadcast never reconstitutes a dormant seat");
});

// ── existing behaviour intact: a direct @-tag to a LIVE member wakes it once, no fallback churn ─────────
test("a direct @-tag to a live member wakes it once; the fallback adds no double-nudge", () => {
  const repo = tmpRepo();
  const T = "node:thread:live";
  fillSeat(repo, T, "Coordinator", "live-B", 1);
  const { respawns, liveSessions } = wire(repo, {
    members: ["stale-A", "live-B"], // both the stale card AND the live occupant are in the roster + tagged
    names: { "stale-A": "Coordinator.stale-A", "live-B": "Coordinator.live-B" },
    liveSessions: new Map([liveSess("live-B", "running")]),
  });

  const woken = delivery.wakeThreadMembers(BOARD, T, "poster", {
    broadcast: false,
    mentioned: new Set(["stale-A", "live-B"]),
    origin: ORIGIN,
  });

  assert.equal(woken, 1, "the live member is woken exactly once (no fallback double-count)");
  assert.equal(liveSessions.get("live-B").nudge, true);
  assert.equal(respawns.length, 0);
});

// seatForSid re-exported inline for the assertion (avoid a second import churn).
function seatOf(meta, sid) {
  for (const [handle, s] of Object.entries(meta?.seats ?? {})) if (s && s.sid === sid) return handle;
  return null;
}
