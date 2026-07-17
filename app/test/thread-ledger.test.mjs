// The thread ledger (renamed from the channel ledger at threads-as-cards §8 step 2): durable
// `.canvas/threads/` storage that survives a COLD restart (the in-memory threadLogs only survives a hot
// re-eval) and backs the list rail. The sessions ledger's twin. Includes the one-time channels→threads
// dir migration, the legacy `chanId` marker tolerance, and the §5 seat records.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canvasThreadsDir,
  migrateChannelLedger,
  appendThreadLine,
  readThreadLog,
  readThreadMeta,
  upsertThreadMeta,
  listThreads,
  fillSeat,
  releaseSeat,
  seatForSid,
  ownBlockedIntentKeys,
  sessionDeclaredDone,
  sessionIdleIntent,
  setThreadLevel,
  threadLevelForSid,
  readPins,
  pinMessage,
  refreshPinSnapshot,
  unpinMessage,
  readSeenMentions,
  markSeenMentions,
  addThreadMember,
  removeThreadMember,
  threadMembersFromMeta,
  setMemberOffset,
  memberOffsetFromMeta,
  setReopenSet,
  readReopenSet,
  untaggedSeatNudgeTarget,
  roleMentionRoute,
} from "../thread-ledger.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "thread-ledger-"));
}
const msg = (seq, text, extra = {}) => ({ seq, ts: seq * 10, from: "s1", text, ...extra });

test("a message log round-trips and lands under the board's .canvas/ home", () => {
  const repo = tmpRepo();
  const id = "node:thread:abc";
  assert.deepEqual(readThreadLog(repo, id), [], "no file → empty, not a throw");
  appendThreadLine(repo, id, msg(1, "hello"));
  appendThreadLine(repo, id, msg(2, "world", { kind: "ask" }));
  assert.deepEqual(readThreadLog(repo, id), [msg(1, "hello"), msg(2, "world", { kind: "ask" })]);
  // The colon-bearing thread id is percent-encoded into the filename (a colon isn't a safe filename).
  const f = path.join(canvasThreadsDir(repo), encodeURIComponent(id) + ".jsonl");
  assert.ok(fs.existsSync(f), "log lives under .canvas/threads/ with an encoded name");
});

test("BUG-6: an accepted post is durably re-readable with FRESH state (survives a restart)", () => {
  // The accept path's durable step is appendThreadLine (fsync'd). A post that returned 200 must be readable
  // after a cold restart — modelled here by re-reading with NO in-memory cache via readThreadLog, exactly what
  // the server does through threadLog/seedThreadLogs on boot. This is the durability guarantee the honest
  // accept path (durable-before-200) now makes.
  const repo = tmpRepo();
  const id = "node:thread:durable";
  appendThreadLine(repo, id, msg(1, "persisted before the 200"));
  appendThreadLine(repo, id, msg(2, "and this one too"));
  // Fresh-state re-read — no process memory involved, marker-independent (the .jsonl IS the message store).
  assert.deepEqual(
    readThreadLog(repo, id),
    [msg(1, "persisted before the 200"), msg(2, "and this one too")],
    "both accepted posts survive a restart via a marker-independent .jsonl re-read",
  );
  assert.equal(readThreadMeta(repo, id), null, "durability does not depend on the marker — the .jsonl alone carries it");
});

test("BUG-6: a durable append that CANNOT be persisted THROWS — it is no longer swallowed", () => {
  // The 2026-07-12 loss: appendThreadLine swallowed a write error and let the accept path return a dishonest
  // 200 with the message only in the bounded in-memory tail (gone on the next restart). It must now surface
  // the failure so the accept path returns 500. Force a write failure with a repoPath that is a FILE, so the
  // `.canvas/threads` mkdir fails ENOTDIR.
  const filePath = fs.mkdtempSync(path.join(os.tmpdir(), "thread-ledger-notdir-")) + "/afile";
  fs.writeFileSync(filePath, "i am a file, not a directory");
  assert.throws(
    () => appendThreadLine(filePath, "node:thread:x", msg(1, "boom")),
    "a durable append that can't be made durable surfaces the error instead of swallowing it",
  );
});

test("readThreadLog tolerates a ragged first line (a tail-cut / torn mid-write append)", () => {
  const repo = tmpRepo();
  const id = "node:thread:ragged";
  fs.mkdirSync(canvasThreadsDir(repo), { recursive: true });
  // A chopped leading line (as a byte-bounded tail read would leave) followed by whole records.
  fs.writeFileSync(
    path.join(canvasThreadsDir(repo), encodeURIComponent(id) + ".jsonl"),
    `q":"partial"}\n${JSON.stringify(msg(5, "intact"))}\n`,
  );
  assert.deepEqual(readThreadLog(repo, id), [msg(5, "intact")], "the unparseable first line is skipped");
});

test("upsertThreadMeta writes createdAt once and refreshes title/activity", () => {
  const repo = tmpRepo();
  const id = "node:thread:m";
  assert.equal(readThreadMeta(repo, id), null, "no marker → null");
  upsertThreadMeta(repo, id, { title: "planning", text: "the brief", lastSeq: 1, lastTs: 100 });
  const first = readThreadMeta(repo, id);
  assert.equal(first.threadId, id);
  assert.equal(first.createdAt, 100, "createdAt seeds from the first activity ts");
  // A later append refreshes title/lastSeq/lastTs but must NOT move createdAt.
  upsertThreadMeta(repo, id, { title: "planning v2", lastSeq: 7, lastTs: 500 });
  const second = readThreadMeta(repo, id);
  assert.equal(second.createdAt, 100, "createdAt is written once, not clobbered");
  assert.equal(second.title, "planning v2");
  assert.equal(second.lastSeq, 7);
  assert.equal(second.text, "the brief", "an absent field keeps its prior value (merge, not replace)");
});

test("a declared-intents index on the marker survives activity upserts (the work-intent act relies on it)", () => {
  const repo = tmpRepo();
  const id = "node:thread:wi";
  // The intent handler writes the full latest-per-participant map onto the marker…
  upsertThreadMeta(repo, id, { intents: { s1: { intent: "working", ts: 100 } }, lastSeq: 1, lastTs: 100 });
  // …and every ordinary post's activity upsert (lastSeq/lastTs/title) must shallow-merge AROUND it, not
  // clobber it — the property that makes the marker a safe home for the index.
  upsertThreadMeta(repo, id, { title: "build", lastSeq: 2, lastTs: 200 });
  assert.deepEqual(readThreadMeta(repo, id).intents, { s1: { intent: "working", ts: 100 } });
  // A later declaration replaces the map wholesale — the latest intent per participant wins.
  upsertThreadMeta(repo, id, {
    intents: { s1: { intent: "blocked:human", ts: 300, note: "need a nod" }, s2: { intent: "done", ts: 300 } },
  });
  const final = readThreadMeta(repo, id);
  assert.equal(final.intents.s1.intent, "blocked:human");
  assert.equal(final.intents.s2.intent, "done");
  assert.equal(final.title, "build", "the intent upsert keeps the activity fields");
});

test("listThreads returns every marked thread, newest activity first", () => {
  const repo = tmpRepo();
  upsertThreadMeta(repo, "node:thread:old", { title: "old", lastSeq: 1, lastTs: 100 });
  upsertThreadMeta(repo, "node:thread:new", { title: "new", lastSeq: 1, lastTs: 900 });
  upsertThreadMeta(repo, "node:thread:mid", { title: "mid", lastSeq: 1, lastTs: 500 });
  // A bare .jsonl with no marker (a torn write that never upserted) must NOT appear — the marker is the index.
  appendThreadLine(repo, "node:thread:nomarker", msg(1, "orphan log"));
  const ids = listThreads(repo).map((m) => m.threadId);
  assert.deepEqual(ids, ["node:thread:new", "node:thread:mid", "node:thread:old"]);
});

test("a missing threads dir yields an empty list, not a throw", () => {
  const repo = tmpRepo();
  assert.deepEqual(listThreads(repo), []);
});

test("migrateChannelLedger renames .canvas/channels/ → .canvas/threads/ once, verbatim", () => {
  const repo = tmpRepo();
  const id = "node:chan:carried";
  // A pre-rename board: a channel ledger with a legacy `chanId` marker and a real log.
  const channels = path.join(repo, ".canvas", "channels");
  fs.mkdirSync(channels, { recursive: true });
  fs.writeFileSync(
    path.join(channels, encodeURIComponent(id) + ".meta.json"),
    JSON.stringify({ chanId: id, title: "dev", createdAt: 50, lastSeq: 2, lastTs: 90 }),
  );
  fs.writeFileSync(path.join(channels, encodeURIComponent(id) + ".jsonl"), JSON.stringify(msg(1, "carried")) + "\n");

  assert.equal(migrateChannelLedger(repo), true, "first boot migrates");
  assert.ok(!fs.existsSync(channels), "the old dir is gone (renamed, not copied)");
  // The carried-over channel is a long-lived thread now: listable (chanId normalized), log intact.
  assert.equal(listThreads(repo).length, 1);
  assert.equal(listThreads(repo)[0].threadId, id, "legacy chanId normalizes to threadId on read");
  assert.deepEqual(readThreadLog(repo, id), [msg(1, "carried")]);
  assert.equal(readThreadMeta(repo, id).title, "dev");
  assert.equal(migrateChannelLedger(repo), false, "second boot is a no-op");
  // An upsert onto the legacy marker keeps its fields and stamps the canonical key.
  upsertThreadMeta(repo, id, { lastSeq: 3, lastTs: 120 });
  const m = readThreadMeta(repo, id);
  assert.equal(m.threadId, id);
  assert.equal(m.createdAt, 50, "createdAt carried over, not re-seeded");
});

test("migrateChannelLedger leaves an already-migrated (or fresh) board alone", () => {
  const repo = tmpRepo();
  assert.equal(migrateChannelLedger(repo), false, "nothing to migrate on a fresh board");
  upsertThreadMeta(repo, "node:thread:t", { title: "t", lastTs: 1 });
  // Both dirs present (a hand-made partial state): threads wins, channels is left untouched.
  fs.mkdirSync(path.join(repo, ".canvas", "channels"), { recursive: true });
  assert.equal(migrateChannelLedger(repo), false);
  assert.ok(fs.existsSync(path.join(repo, ".canvas", "channels")), "no destructive merge is attempted");
});

test("seats: fillSeat creates once, is idempotent for the same occupant, and re-fills on a respawn", () => {
  const repo = tmpRepo();
  const id = "node:thread:seats";
  const first = fillSeat(repo, id, "Coordinator", "sid-a", 100);
  assert.equal(first.refilled, false, "first fill creates the seat");
  assert.deepEqual(first.seat, { role: "Coordinator", sid: "sid-a", createdAt: 100, filledAt: 100, fills: 1 });
  // Same occupant re-onboards (a re-announced edge): no change, no write.
  const again = fillSeat(repo, id, "Coordinator", "sid-a", 200);
  assert.equal(again.refilled, false);
  assert.equal(readThreadMeta(repo, id).seats.Coordinator.filledAt, 100, "idempotent — the marker didn't churn");
  // A fresh session of the same role (respawn): the SEAT persists, the occupant changes.
  const refill = fillSeat(repo, id, "Coordinator", "sid-b", 300);
  assert.equal(refill.refilled, true, "a new occupant is a re-fill");
  assert.deepEqual(refill.seat, { role: "Coordinator", sid: "sid-b", createdAt: 100, filledAt: 300, fills: 2 });
  // A second role gets its own seat beside it.
  fillSeat(repo, id, "Reviewer", "sid-c", 400);
  const seats = readThreadMeta(repo, id).seats;
  assert.deepEqual(Object.keys(seats).sort(), ["Coordinator", "Reviewer"]);
  // seatForSid resolves the current occupants only — the parked sid-a no longer holds a seat.
  assert.equal(seatForSid(seats, "sid-b"), "Coordinator");
  assert.equal(seatForSid(seats, "sid-c"), "Reviewer");
  assert.equal(seatForSid(seats, "sid-a"), null);
  assert.equal(seatForSid(undefined, "sid-b"), null, "no seats map → null, not a throw");
});

// ownBlockedIntentKeys — the detection half of the work-intent self-freshen (part 2). Which intent slots
// hold a `blocked:*` THIS session itself declared, so a resume can auto-transition them to `working`.
test("ownBlockedIntentKeys: finds a session's own blocks (sid-keyed OR seat-keyed via the record's sid stamp)", () => {
  const intents = {
    // sid-keyed self-declaration
    "sid-a": { intent: "blocked:human", ts: 1, sid: "sid-a" },
    // seat-keyed self-declaration (recordThreadIntent stamps the declarer's sid)
    Reviewer: { intent: "blocked:peer", ts: 2, sid: "sid-a" },
    // this session's non-block slot — not returned
    Extra: { intent: "working", ts: 3, sid: "sid-a" },
  };
  assert.deepEqual(ownBlockedIntentKeys(intents, "sid-a").sort(), ["Reviewer", "sid-a"]);
});

test("ownBlockedIntentKeys: both blocked:human and blocked:peer count; working/done never do", () => {
  const intents = {
    a: { intent: "blocked:human", ts: 1, sid: "s" },
    b: { intent: "blocked:peer", ts: 1, sid: "s" },
    c: { intent: "working", ts: 1, sid: "s" },
    d: { intent: "done", ts: 1, sid: "s" },
  };
  assert.deepEqual(ownBlockedIntentKeys(intents, "s").sort(), ["a", "b"]);
});

// sessionDeclaredDone — the reaper's read (reap-only-on-done): true iff the session declared done and is
// active nowhere. Every other stance parks, so the reaper only needs this one bit.
test("sessionDeclaredDone: true only when done AND active nowhere; any working/blocked keeps it parked", () => {
  const meta = (intents) => ({ intents });
  // done on its only thread → done
  assert.equal(sessionDeclaredDone([meta({ Coordinator: { intent: "done", sid: "s" } })], "s"), true);
  // done on one thread but still active on another → NOT done (must not reap a session working elsewhere)
  assert.equal(
    sessionDeclaredDone([meta({ Coordinator: { intent: "done", sid: "s" } }), meta({ x: { intent: "working", sid: "s" } })], "s"),
    false,
  );
  assert.equal(
    sessionDeclaredDone([meta({ Coordinator: { intent: "done", sid: "s" } }), meta({ x: { intent: "blocked:human", sid: "s" } })], "s"),
    false,
  );
  // working / blocked / undeclared / empty → false (parked)
  assert.equal(sessionDeclaredDone([meta({ x: { intent: "working", sid: "s" } })], "s"), false);
  assert.equal(sessionDeclaredDone([meta({ x: { intent: "blocked:peer", sid: "s" } })], "s"), false);
  assert.equal(sessionDeclaredDone([], "s"), false);
  assert.equal(sessionDeclaredDone(undefined, "s"), false);
});

test("sessionDeclaredDone: sid-keyed OR seat-keyed (sid-stamped) self-declaration; never another occupant's seat-inherited intent", () => {
  // matches a bare sid key and a seat-keyed record stamped with this sid
  assert.equal(sessionDeclaredDone([{ intents: { "sid-a": { intent: "done", sid: "sid-a" } } }], "sid-a"), true);
  assert.equal(sessionDeclaredDone([{ intents: { Reviewer: { intent: "done", sid: "sid-a" } } }], "sid-a"), true);
  // a `done` a DIFFERENT (exited) occupant left on a seat this session later re-filled is NOT this session's —
  // the fresh occupant must not be reaped on the departed's behalf.
  assert.equal(sessionDeclaredDone([{ intents: { Coordinator: { intent: "done", sid: "sid-old" } } }], "sid-new"), false);
});

// sessionIdleIntent — the whole-session declared-intent refinement for the IDLE status band (thread
// mrcmofwf-10). blocked:human outranks blocked:peer whole-session; working/done never paint the idle band.
test("sessionIdleIntent: blocked:human > blocked:peer, aggregated across all the session's threads", () => {
  const meta = (intents) => ({ intents });
  // a single declared block on the session's one thread
  assert.equal(sessionIdleIntent([meta({ x: { intent: "blocked:human", sid: "s" } })], "s"), "blocked:human");
  assert.equal(sessionIdleIntent([meta({ x: { intent: "blocked:peer", sid: "s" } })], "s"), "blocked:peer");
  // blocked:human on ANY thread outranks a blocked:peer on another (whole-session precedence)
  assert.equal(
    sessionIdleIntent([meta({ a: { intent: "blocked:peer", sid: "s" } }), meta({ b: { intent: "blocked:human", sid: "s" } })], "s"),
    "blocked:human",
  );
});

test("sessionIdleIntent: working and done NEVER paint the idle band (done shows only once the process exits)", () => {
  const meta = (intents) => ({ intents });
  assert.equal(sessionIdleIntent([meta({ x: { intent: "working", sid: "s" } })], "s"), null);
  assert.equal(sessionIdleIntent([meta({ x: { intent: "done", sid: "s" } })], "s"), null);
  // a done on one thread + a blocked:peer on another → blue (done is inert, the peer-wait wins)
  assert.equal(
    sessionIdleIntent([meta({ a: { intent: "done", sid: "s" } }), meta({ b: { intent: "blocked:peer", sid: "s" } })], "s"),
    "blocked:peer",
  );
  assert.equal(sessionIdleIntent([], "s"), null);
  assert.equal(sessionIdleIntent(undefined, "s"), null);
});

test("sessionIdleIntent: sid-stamped self-declaration only, never another (exited) occupant's seat-inherited block", () => {
  // matches a bare sid key and a seat-keyed record stamped with this sid
  assert.equal(sessionIdleIntent([{ intents: { "sid-a": { intent: "blocked:human", sid: "sid-a" } } }], "sid-a"), "blocked:human");
  assert.equal(sessionIdleIntent([{ intents: { Reviewer: { intent: "blocked:peer", sid: "sid-a" } } }], "sid-a"), "blocked:peer");
  // a block a DIFFERENT (exited) occupant left on a seat this session re-filled is NOT this session's
  assert.equal(sessionIdleIntent([{ intents: { Coordinator: { intent: "blocked:human", sid: "sid-old" } } }], "sid-new"), null);
});

test("ownBlockedIntentKeys: NEVER a seat-inherited block another (exited) occupant left — the sacred waiting state", () => {
  // A prior occupant (sid-old) asked the human and crashed; the seat still carries its blocked:human. A
  // fresh occupant (sid-new) re-filled the seat and is now resuming — it must NOT retire the old question.
  const intents = { Coordinator: { intent: "blocked:human", ts: 1, sid: "sid-old" } };
  assert.deepEqual(ownBlockedIntentKeys(intents, "sid-new"), [], "another agent's block is left untouched");
  assert.deepEqual(ownBlockedIntentKeys(intents, "sid-old"), ["Coordinator"], "the original asker would clear it");
});

test("ownBlockedIntentKeys: empty/absent intents → [], not a throw", () => {
  assert.deepEqual(ownBlockedIntentKeys(undefined, "s"), []);
  assert.deepEqual(ownBlockedIntentKeys({}, "s"), []);
});

test("seats: the live-occupancy guard never displaces a LIVE seat, but an EXITED one still re-fills", () => {
  const repo = tmpRepo();
  const id = "node:thread:seat-guard";
  // sid-a holds the Coordinator seat.
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  // A second Coordinator (sid-b) joins while sid-a is LIVE: the guard blocks the steal — no write, and the
  // result reports who holds it so the caller can onboard the joiner seatless. THE CORE FIX.
  const live = new Set(["sid-a"]);
  const isLive = (sid) => live.has(sid);
  const blocked = fillSeat(repo, id, "Coordinator", "sid-b", 200, isLive);
  assert.equal(blocked.blocked, true, "a live occupant is not displaced");
  assert.equal(blocked.heldBy, "sid-a", "the result names the live holder");
  assert.equal(blocked.refilled, false);
  const seats1 = readThreadMeta(repo, id).seats;
  assert.equal(seats1.Coordinator.sid, "sid-a", "the seat still belongs to the live occupant");
  assert.equal(seats1.Coordinator.fills, 1, "no re-fill happened (fills unchanged)");
  // Now sid-a EXITS (the legitimate respawn case): sid-b re-filling passes the guard and takes the seat.
  live.delete("sid-a");
  const refill = fillSeat(repo, id, "Coordinator", "sid-b", 300, isLive);
  assert.equal(refill.blocked, undefined, "an exited holder does not block the respawn re-fill");
  assert.equal(refill.refilled, true);
  const seats2 = readThreadMeta(repo, id).seats;
  assert.equal(seats2.Coordinator.sid, "sid-b", "the exited seat re-fills to the fresh occupant");
  assert.equal(seats2.Coordinator.fills, 2);
  // Idempotent onboarding of the live holder itself is never blocked (same sid → no-op, guard skipped).
  live.add("sid-b");
  const same = fillSeat(repo, id, "Coordinator", "sid-b", 400, isLive);
  assert.equal(same.blocked, undefined);
  assert.equal(same.refilled, false, "same live occupant re-onboarding is an idempotent no-op");
  // With no predicate, the old unconditional re-fill still holds (callers that vetted liveness themselves).
  const noPred = fillSeat(repo, id, "Coordinator", "sid-c", 500);
  assert.equal(noPred.refilled, true, "omitting isLive keeps the unconditional re-fill");
});

test("seats: releaseSeat frees the seat a leaver holds, self-healing a stuck seat", () => {
  const repo = tmpRepo();
  const id = "node:thread:seat-release";
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  fillSeat(repo, id, "Reviewer", "sid-b", 110);
  // The Coordinator LEAVES: its seat is returned, the Reviewer seat is untouched.
  assert.equal(releaseSeat(repo, id, "sid-a"), "Coordinator", "returns the freed handle");
  const seats = readThreadMeta(repo, id).seats;
  assert.deepEqual(Object.keys(seats), ["Reviewer"], "only the leaver's seat is cleared");
  // A vacated seat now frees for the next same-role join to fill fresh.
  const refill = fillSeat(repo, id, "Coordinator", "sid-c", 200);
  assert.equal(refill.refilled, false, "the freed seat fills as a fresh seat, not a re-fill");
  assert.equal(readThreadMeta(repo, id).seats.Coordinator.sid, "sid-c");
  // Releasing when the sid holds no seat is a harmless no-op.
  assert.equal(releaseSeat(repo, id, "sid-a"), null, "a non-holder release is a no-op → null");
  assert.equal(releaseSeat(repo, id, "sid-nobody"), null);
});

test("pins (R-PIN): pin snapshots a message, is idempotent, stays chronological, and unpins", () => {
  const repo = tmpRepo();
  const id = "node:thread:pins";
  assert.deepEqual(readPins(repo, id), [], "no marker → no pins, not a throw");
  // Pin out of order — the set stays sorted by seq (chronological head context).
  pinMessage(repo, id, msg(5, "done-when"), "human", 900);
  const after1 = pinMessage(repo, id, msg(2, "task statement"), "s1", 800);
  assert.deepEqual(after1.map((p) => p.seq), [2, 5], "pins are kept seq-sorted regardless of pin order");
  // A pin is a SNAPSHOT (survives the log's bounded tail), carrying who/when it was pinned.
  assert.deepEqual(readPins(repo, id)[0], {
    seq: 2, from: "s1", text: "task statement", ts: 20, pinnedBy: "s1", pinnedAt: 800,
  });
  // Re-pinning the same seq is a no-op — never a duplicate.
  const again = pinMessage(repo, id, msg(2, "task statement"), "human", 999);
  assert.deepEqual(again.map((p) => p.seq), [2, 5], "re-pin is idempotent");
  // Unpin by seq; unpinning an unpinned seq is a harmless no-op.
  assert.deepEqual(unpinMessage(repo, id, 2).map((p) => p.seq), [5]);
  assert.deepEqual(unpinMessage(repo, id, 2).map((p) => p.seq), [5], "unpin of a non-pin is a no-op");
  assert.deepEqual(readPins(repo, id).map((p) => p.seq), [5], "the durable marker reflects the unpin");
});

test("refreshPinSnapshot: an amendment of a pinned message updates its snapshot text (edit + tombstone)", () => {
  const repo = tmpRepo();
  const id = "node:thread:pin-refresh";
  pinMessage(repo, id, msg(3, "teh done-when"), "human", 300);
  pinMessage(repo, id, msg(7, "chatter"), "human", 700);
  // An edit refreshes only the matching pin's text; who/when pinned is untouched.
  const afterEdit = refreshPinSnapshot(repo, id, 3, "the done-when");
  assert.equal(afterEdit.find((p) => p.seq === 3).text, "the done-when");
  assert.equal(afterEdit.find((p) => p.seq === 3).pinnedAt, 300, "pin provenance is preserved");
  assert.equal(afterEdit.find((p) => p.seq === 7).text, "chatter", "an unrelated pin is untouched");
  assert.equal(readPins(repo, id).find((p) => p.seq === 3).text, "the done-when", "the durable marker reflects it");
  // A tombstone refreshes the pin to the stub.
  refreshPinSnapshot(repo, id, 7, "[deleted]");
  assert.equal(readPins(repo, id).find((p) => p.seq === 7).text, "[deleted]");
  // No-ops: an unpinned seq, or a no-change text, don't churn the marker.
  assert.deepEqual(refreshPinSnapshot(repo, id, 999, "x").map((p) => p.seq), [3, 7], "unpinned seq → no-op returns prior set");
  assert.equal(refreshPinSnapshot(repo, id, 3, "the done-when").find((p) => p.seq === 3).text, "the done-when", "same-text → no-op, still correct");
});

test("pins ride the marker beside seats/intents without clobbering them", () => {
  const repo = tmpRepo();
  const id = "node:thread:coexist";
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  upsertThreadMeta(repo, id, { intents: { Coordinator: { intent: "working", ts: 100, sid: "sid-a" } } });
  pinMessage(repo, id, msg(1, "Done when: tests green"), "sid-a", 200);
  const meta = readThreadMeta(repo, id);
  assert.equal(meta.seats.Coordinator.sid, "sid-a", "seat survives a pin write");
  assert.equal(meta.intents.Coordinator.intent, "working", "intent survives a pin write");
  assert.equal(meta.pins.length, 1, "pins land alongside");
});

// F-H5 residue: the thread HUD's two durable pieces — the Coordinator SEAT and the PINNED head context —
// must survive together across a cold re-read (a restart) AND across each other's writes (a re-fill must not
// resurrect an unpinned pin; a pin/unpin must not disturb the seat). readThreadMeta/readPins re-read the
// durable marker each call, so a fresh read IS the cold-restart read.
test("HUD seat/pin round-trip: seat + pins co-persist through a re-fill and an unpin (F-H5)", () => {
  const repo = tmpRepo();
  const id = "node:thread:hud-roundtrip";
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  pinMessage(repo, id, msg(2, "task statement"), "sid-a", 150);
  pinMessage(repo, id, msg(5, "Done when: tests green"), "human", 160);
  // Cold re-read: seat occupant + both pin SNAPSHOTS (incl. text) survive together.
  let meta = readThreadMeta(repo, id);
  assert.equal(seatForSid(meta.seats, "sid-a"), "Coordinator", "the seat occupant survives the round-trip");
  assert.deepEqual(readPins(repo, id).map((p) => p.seq), [2, 5], "both pins survive, seq-sorted");
  assert.equal(readPins(repo, id)[1].text, "Done when: tests green", "the pin snapshot text is durable");
  // A respawn re-fills the SAME seat; an unpin removes one pin. Neither write clobbers the other's slot.
  assert.equal(fillSeat(repo, id, "Coordinator", "sid-b", 300).refilled, true, "a new occupant is a re-fill");
  unpinMessage(repo, id, 2);
  meta = readThreadMeta(repo, id);
  assert.equal(seatForSid(meta.seats, "sid-b"), "Coordinator", "the re-filled occupant is durable");
  assert.equal(seatForSid(meta.seats, "sid-a"), null, "the parked occupant no longer holds the seat");
  assert.equal(meta.seats.Coordinator.fills, 2, "the seat's fill-count/createdAt round-trip across the re-fill");
  assert.deepEqual(readPins(repo, id).map((p) => p.seq), [5], "the unpin is durable — the seat write didn't resurrect it");
});

test("seenMentions (user waiting-state): union add, sorted, idempotent, marker-coexisting", () => {
  const repo = tmpRepo();
  const id = "node:thread:seen";
  assert.deepEqual(readSeenMentions(repo, id), [], "no marker → no seen set, not a throw");
  // Mark out of order — the durable set stays sorted.
  assert.deepEqual(markSeenMentions(repo, id, [5, 2]), [2, 5], "union add is sorted");
  // A second mark unions in the new seq (and drops a duplicate) without churning the rest.
  assert.deepEqual(markSeenMentions(repo, id, [2, 7]), [2, 5, 7], "existing seq is a no-op; new one unions in");
  assert.deepEqual(readSeenMentions(repo, id), [2, 5, 7], "the durable marker reflects the union");
  // Nothing new → returns the prior array unchanged (no churn).
  const before = readSeenMentions(repo, id);
  assert.deepEqual(markSeenMentions(repo, id, [2, 5]), before, "re-marking only seen seqs is a no-op");
  // Non-positive / non-integer seqs are ignored (defensive, mirrors the endpoint's guard).
  assert.deepEqual(markSeenMentions(repo, id, [0, -1, 3.5, 9]), [2, 5, 7, 9], "only positive integers land");
});

test("seenMentions rides the marker beside pins/seats/intents without clobbering them", () => {
  const repo = tmpRepo();
  const id = "node:thread:seen-coexist";
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  pinMessage(repo, id, msg(1, "Done when: tests green"), "sid-a", 200);
  markSeenMentions(repo, id, [3]);
  const meta = readThreadMeta(repo, id);
  assert.equal(meta.seats.Coordinator.sid, "sid-a", "seat survives a seen write");
  assert.equal(meta.pins.length, 1, "pins survive a seen write");
  assert.deepEqual(meta.seenMentions, [3], "seen set lands alongside");
});

// ── durable membership (delete-card-keep-session) ───────────────────────────────────────────────────

test("members: addThreadMember records durably, is idempotent, and removeThreadMember drops one", () => {
  const repo = tmpRepo();
  const id = "node:thread:members";
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, id)), [], "no marker → no members, not a throw");
  addThreadMember(repo, id, "sid-a", 100);
  addThreadMember(repo, id, "sid-b", 110);
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, id)).sort(), ["sid-a", "sid-b"]);
  assert.equal(readThreadMeta(repo, id).members["sid-a"].joinedAt, 100, "joinedAt is stamped");
  // Idempotent: re-adding the same member must NOT churn the marker (keep the original joinedAt).
  addThreadMember(repo, id, "sid-a", 999);
  assert.equal(readThreadMeta(repo, id).members["sid-a"].joinedAt, 100, "re-add is a no-op — joinedAt unchanged");
  // Remove one member; the other survives.
  removeThreadMember(repo, id, "sid-a");
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, id)), ["sid-b"], "only the removed sid is dropped");
  // Removing a non-member is a harmless no-op.
  removeThreadMember(repo, id, "sid-nobody");
  assert.deepEqual(threadMembersFromMeta(readThreadMeta(repo, id)), ["sid-b"]);
});

test("members: the durable set survives activity/seat/pin upserts (marker coexistence)", () => {
  const repo = tmpRepo();
  const id = "node:thread:members-coexist";
  addThreadMember(repo, id, "sid-a", 100);
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  pinMessage(repo, id, msg(1, "Done when: green"), "sid-a", 150);
  // An ordinary post's activity upsert must shallow-merge AROUND members (the property that makes the
  // marker a safe home for durable membership — the same guarantee seats/intents/pins rely on).
  upsertThreadMeta(repo, id, { title: "build", lastSeq: 3, lastTs: 300 });
  const meta = readThreadMeta(repo, id);
  assert.deepEqual(threadMembersFromMeta(meta), ["sid-a"], "membership survives an activity upsert");
  assert.equal(meta.seats.Coordinator.sid, "sid-a", "seat coexists");
  assert.equal(meta.pins.length, 1, "pins coexist");
  assert.equal(meta.title, "build");
});

// ── relative-offset layout (P2) ─────────────────────────────────────────────────────────────────────

test("setMemberOffset stores {dx,dy} on a membership; memberOffsetFromMeta reads it (null when absent)", () => {
  const repo = tmpRepo();
  const id = "node:thread:offset";
  assert.equal(setMemberOffset(repo, id, "sid-a", 30, -12), false, "not a member yet → no write");
  addThreadMember(repo, id, "sid-a", 100);
  assert.equal(memberOffsetFromMeta(readThreadMeta(repo, id), "sid-a"), null, "member but no offset → null");
  assert.equal(setMemberOffset(repo, id, "sid-a", 30, -12), true, "first offset → wrote");
  assert.deepEqual(memberOffsetFromMeta(readThreadMeta(repo, id), "sid-a"), { dx: 30, dy: -12 });
  // joinedAt is preserved alongside the offset (the offset rides the same record).
  assert.equal(readThreadMeta(repo, id).members["sid-a"].joinedAt, 100, "joinedAt untouched");
});

test("setMemberOffset is idempotent (unchanged / rounded), so a no-op save never churns the marker", () => {
  const repo = tmpRepo();
  const id = "node:thread:offset-idem";
  addThreadMember(repo, id, "sid-a", 100);
  assert.equal(setMemberOffset(repo, id, "sid-a", 30, 40), true);
  assert.equal(setMemberOffset(repo, id, "sid-a", 30, 40), false, "same value → no write");
  assert.equal(setMemberOffset(repo, id, "sid-a", 30.2, 40.4), false, "rounds to the same whole pixel → no write");
  assert.equal(setMemberOffset(repo, id, "sid-a", 31, 40), true, "a real move → writes");
  assert.deepEqual(memberOffsetFromMeta(readThreadMeta(repo, id), "sid-a"), { dx: 31, dy: 40 });
});

test("setMemberOffset rounds to whole pixels (sub-pixel noise would defeat the unchanged-guard)", () => {
  const repo = tmpRepo();
  const id = "node:thread:offset-round";
  addThreadMember(repo, id, "sid-a", 100);
  setMemberOffset(repo, id, "sid-a", 30.6, -12.4);
  assert.deepEqual(memberOffsetFromMeta(readThreadMeta(repo, id), "sid-a"), { dx: 31, dy: -12 });
});

test("memberOffsetFromMeta: null for a missing member / empty meta / partial record", () => {
  assert.equal(memberOffsetFromMeta(null, "sid-x"), null);
  assert.equal(memberOffsetFromMeta({}, "sid-x"), null);
  assert.equal(memberOffsetFromMeta({ members: { "sid-x": { joinedAt: 1, dx: 5 } } }, "sid-x"), null, "dy missing → null");
});

// ── reopen-set (P4) ─────────────────────────────────────────────────────────────────────────────────

test("setReopenSet stores the open-member sids; readReopenSet reads them (dedup + sorted, order-insensitive)", () => {
  const repo = tmpRepo();
  const id = "node:thread:reopen";
  assert.deepEqual(readReopenSet(readThreadMeta(repo, id)), [], "nothing recorded → []");
  assert.equal(setReopenSet(repo, id, ["sid-b", "sid-a", "sid-b"]), true, "first set → wrote");
  assert.deepEqual(readReopenSet(readThreadMeta(repo, id)), ["sid-a", "sid-b"], "deduped + sorted");
});

test("setReopenSet is idempotent (order-insensitive), so a save whose open-set didn't change never churns", () => {
  const repo = tmpRepo();
  const id = "node:thread:reopen-idem";
  assert.equal(setReopenSet(repo, id, ["sid-a", "sid-b"]), true);
  assert.equal(setReopenSet(repo, id, ["sid-b", "sid-a"]), false, "same set, different order → no write");
  assert.equal(setReopenSet(repo, id, ["sid-a"]), true, "a member closed → shrinks, writes");
  assert.deepEqual(readReopenSet(readThreadMeta(repo, id)), ["sid-a"]);
  assert.equal(setReopenSet(repo, id, []), true, "all closed → empty set, writes");
  assert.deepEqual(readReopenSet(readThreadMeta(repo, id)), []);
});

test("setReopenSet drops non-string / empty entries and rides the marker beside members without clobbering", () => {
  const repo = tmpRepo();
  const id = "node:thread:reopen-coexist";
  addThreadMember(repo, id, "sid-a", 100);
  setMemberOffset(repo, id, "sid-a", 10, 20);
  setReopenSet(repo, id, ["sid-a", "", null, undefined, "sid-c"]);
  const meta = readThreadMeta(repo, id);
  assert.deepEqual(readReopenSet(meta), ["sid-a", "sid-c"], "junk entries dropped");
  assert.equal(meta.members["sid-a"].joinedAt, 100, "membership untouched");
  assert.deepEqual(memberOffsetFromMeta(meta, "sid-a"), { dx: 10, dy: 20 }, "offset untouched");
});

test("readReopenSet: [] for empty / absent / non-array meta (never a throw)", () => {
  assert.deepEqual(readReopenSet(null), []);
  assert.deepEqual(readReopenSet({}), []);
  assert.deepEqual(readReopenSet({ reopenSet: "nope" }), []);
});

// ── notification levels (P1, wakeable-substrate-plan W4) ─────────────────────────────────────────────

test("threadLevelForSid defaults to `all` for an unknown member / empty meta", () => {
  assert.equal(threadLevelForSid(null, "sid-x"), "all");
  assert.equal(threadLevelForSid({}, "sid-x"), "all");
});

test("setThreadLevel rides the SEAT when the sid occupies one (durable across respawn)", () => {
  const repo = tmpRepo();
  const id = "node:thread:lvl";
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  const r = setThreadLevel(repo, id, "sid-a", "mentions");
  assert.deepEqual(r, { seat: "Coordinator", level: "mentions" });
  // Stored on the seat, so a re-fill by a fresh session of the role inherits it.
  const meta = readThreadMeta(repo, id);
  assert.equal(meta.seats.Coordinator.level, "mentions");
  assert.equal(threadLevelForSid(meta, "sid-a"), "mentions");
  // A fresh occupant re-fills the same seat and inherits the level.
  fillSeat(repo, id, "Coordinator", "sid-b", 200);
  assert.equal(threadLevelForSid(readThreadMeta(repo, id), "sid-b"), "mentions", "level survives respawn");
});

test("setThreadLevel falls back to a sid-keyed map for a seatless member", () => {
  const repo = tmpRepo();
  const id = "node:thread:lvl2";
  const r = setThreadLevel(repo, id, "sid-plain", "paused");
  assert.deepEqual(r, { seat: null, level: "paused" });
  const meta = readThreadMeta(repo, id);
  assert.equal(meta.levels["sid-plain"], "paused");
  assert.equal(threadLevelForSid(meta, "sid-plain"), "paused");
});

test("setThreadLevel normalizes an unknown level to `all` and preserves seats/pins", () => {
  const repo = tmpRepo();
  const id = "node:thread:lvl3";
  fillSeat(repo, id, "Coordinator", "sid-a", 100);
  pinMessage(repo, id, msg(1, "Done when: green"), "sid-a", 150);
  setThreadLevel(repo, id, "sid-a", "nonsense");
  const meta = readThreadMeta(repo, id);
  assert.equal(meta.seats.Coordinator.level, "all", "bad level → all");
  assert.equal(meta.seats.Coordinator.sid, "sid-a", "seat identity intact");
  assert.equal(meta.pins.length, 1, "pins survive a level write");
});

// ── untaggedSeatNudgeTarget (Option B: untagged post → the thread's LIVE Coordinator seat) ──────────
const alwaysLive = () => true;
const neverLive = () => false;
const coordMeta = { seats: { Coordinator: { role: "Coordinator", sid: "coord-1" } } };

test("untaggedSeatNudgeTarget: an untagged post returns the LIVE Coordinator seat sid", () => {
  const got = untaggedSeatNudgeTarget(coordMeta, "Coordinator", { broadcast: false, mentioned: new Set(), exceptSid: "poster", isLive: alwaysLive });
  assert.equal(got, "coord-1");
});

test("untaggedSeatNudgeTarget: a DORMANT Coordinator is NOT returned (no per-post respawn)", () => {
  const got = untaggedSeatNudgeTarget(coordMeta, "Coordinator", { broadcast: false, mentioned: new Set(), exceptSid: "poster", isLive: neverLive });
  assert.equal(got, null, "dormant seat → catch it on the heartbeat, don't respawn per post");
});

test("untaggedSeatNudgeTarget: a room broadcast is NOT untagged → null (normal fan-out covers it)", () => {
  const got = untaggedSeatNudgeTarget(coordMeta, "Coordinator", { broadcast: true, mentioned: new Set(), exceptSid: "poster", isLive: alwaysLive });
  assert.equal(got, null);
});

test("untaggedSeatNudgeTarget: an @-mentioned post is NOT untagged → null (mention path covers it)", () => {
  const got = untaggedSeatNudgeTarget(coordMeta, "Coordinator", { broadcast: false, mentioned: new Set(["someone"]), exceptSid: "poster", isLive: alwaysLive });
  assert.equal(got, null);
});

test("untaggedSeatNudgeTarget: the Coordinator posting its OWN untagged message does not self-nudge", () => {
  const got = untaggedSeatNudgeTarget(coordMeta, "Coordinator", { broadcast: false, mentioned: new Set(), exceptSid: "coord-1", isLive: alwaysLive });
  assert.equal(got, null, "sender === seat occupant → no self-nudge");
});

test("untaggedSeatNudgeTarget: a thread with no Coordinator seat → null (only stewarded threads fire)", () => {
  const got = untaggedSeatNudgeTarget({ seats: { Implementer: { role: "Implementer", sid: "imp-1" } } }, "Coordinator", { broadcast: false, mentioned: new Set(), exceptSid: "poster", isLive: alwaysLive });
  assert.equal(got, null);
});

test("untaggedSeatNudgeTarget: tolerates a null/empty meta → null", () => {
  assert.equal(untaggedSeatNudgeTarget(null, "Coordinator", { broadcast: false, mentioned: new Set(), exceptSid: "poster", isLive: alwaysLive }), null);
  assert.equal(untaggedSeatNudgeTarget({}, "Coordinator", { broadcast: false, mentioned: new Set(), exceptSid: "poster", isLive: alwaysLive }), null);
});

// ── roleMentionRoute (accidental-respawn fix: an @Role mention that fell to the cold-spawn path must consult
// the durable seat BEFORE minting a second occupant — thread "Accidental thread respawn") ──────────────────
// (a) a seated role whose occupant is LIVE → nudge, never a second spawn; (b) the AUTHOR holds the seat →
// skip (no self-revive/spawn, regardless of liveness); (c) a genuinely UNSEATED role → spawn (first contact).
test("roleMentionRoute (a): a seated role with a LIVE occupant → nudge, not spawn", () => {
  const got = roleMentionRoute(coordMeta, "Coordinator", { authorSid: "worker-9", isLive: alwaysLive });
  assert.deepEqual(got, { action: "nudge", occupant: "coord-1" }, "live seat is a wake target, never a duplicate");
});

test("roleMentionRoute (a'): a seated role whose occupant has EXITED → revive the SAME seat, not spawn", () => {
  const got = roleMentionRoute(coordMeta, "Coordinator", { authorSid: "worker-9", isLive: neverLive });
  assert.deepEqual(got, { action: "revive", occupant: "coord-1" }, "dormant seat reconstitutes in place");
});

test("roleMentionRoute (b): the AUTHOR holds the seat → skip (the departing occupant's self-mention)", () => {
  // The live-repro'd bug: a wind-down @Coordinator posted BY the Coordinator itself must not resurrect it.
  const live = roleMentionRoute(coordMeta, "Coordinator", { authorSid: "coord-1", isLive: alwaysLive });
  assert.deepEqual(live, { action: "skip", occupant: "coord-1" }, "self-mention of own seat → no-op");
  // …and never a revive/spawn even when the author's own session has already exited (the exact bug's timing).
  const gone = roleMentionRoute(coordMeta, "Coordinator", { authorSid: "coord-1", isLive: neverLive });
  assert.deepEqual(gone, { action: "skip", occupant: "coord-1" }, "author guard wins over liveness → never self-revive");
});

test("roleMentionRoute (c): a genuinely UNSEATED role → spawn (first contact preserved)", () => {
  const got = roleMentionRoute(coordMeta, "Reviewer", { authorSid: "worker-9", isLive: alwaysLive });
  assert.deepEqual(got, { action: "spawn" }, "no seat for the role → cold-spawn still fires");
  // …and a board with no seats at all is likewise first-contact.
  assert.deepEqual(roleMentionRoute(null, "Coordinator", { authorSid: "x", isLive: alwaysLive }), { action: "spawn" });
  assert.deepEqual(roleMentionRoute({}, "Coordinator", { authorSid: "x", isLive: alwaysLive }), { action: "spawn" });
});

test("roleMentionRoute: handle match is case-insensitive → drift degrades to a wake, not a duplicate spawn", () => {
  const got = roleMentionRoute(coordMeta, "coordinator", { authorSid: "worker-9", isLive: alwaysLive });
  assert.deepEqual(got, { action: "nudge", occupant: "coord-1" });
});

test("roleMentionRoute: omitting isLive treats the occupant as live (caller vetted liveness) → nudge", () => {
  const got = roleMentionRoute(coordMeta, "Coordinator", { authorSid: "worker-9" });
  assert.deepEqual(got, { action: "nudge", occupant: "coord-1" }, "no predicate → assume live, mirror fillSeat's convention");
});
