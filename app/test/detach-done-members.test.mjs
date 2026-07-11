// P5 — the done-member DETACH sweep, proven end-to-end against the REAL ledger code. The ctx-bound tick
// (server-orchestration.detachDoneMembersTick) is a thin board→thread iteration around exactly the
// per-member core this file replays: readCanvasSession → shouldDetachDoneMember → removeThreadMember +
// releaseSeat. So these tests exercise the authoritative, tab-independent half (durable membership + seat
// drop) — the part that clears the pill — plus the reopen-set filter that keeps a detach from being undone
// on thread reopen. (The best-effort client card-removal is a browser-only reactor; see the P5 report.)

import { test } from "node:test";
import assert from "node:assert/strict";
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
  threadMembersFromMeta,
} from "../thread-ledger.js";
import { recordSessionEnd, readCanvasSession } from "../session-ledger.js";
import { shouldDetachDoneMember } from "../auto-wake.js";

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
