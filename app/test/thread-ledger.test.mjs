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
  setThreadLevel,
  threadLevelForSid,
  readPins,
  pinMessage,
  unpinMessage,
  addThreadMember,
  removeThreadMember,
  threadMembersFromMeta,
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
