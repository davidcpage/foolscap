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
  seatForSid,
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
  const first = fillSeat(repo, id, "PM", "sid-a", 100);
  assert.equal(first.refilled, false, "first fill creates the seat");
  assert.deepEqual(first.seat, { role: "PM", sid: "sid-a", createdAt: 100, filledAt: 100, fills: 1 });
  // Same occupant re-onboards (a re-announced edge): no change, no write.
  const again = fillSeat(repo, id, "PM", "sid-a", 200);
  assert.equal(again.refilled, false);
  assert.equal(readThreadMeta(repo, id).seats.PM.filledAt, 100, "idempotent — the marker didn't churn");
  // A fresh session of the same role (respawn): the SEAT persists, the occupant changes.
  const refill = fillSeat(repo, id, "PM", "sid-b", 300);
  assert.equal(refill.refilled, true, "a new occupant is a re-fill");
  assert.deepEqual(refill.seat, { role: "PM", sid: "sid-b", createdAt: 100, filledAt: 300, fills: 2 });
  // A second role gets its own seat beside it.
  fillSeat(repo, id, "Reviewer", "sid-c", 400);
  const seats = readThreadMeta(repo, id).seats;
  assert.deepEqual(Object.keys(seats).sort(), ["PM", "Reviewer"]);
  // seatForSid resolves the current occupants only — the parked sid-a no longer holds a seat.
  assert.equal(seatForSid(seats, "sid-b"), "PM");
  assert.equal(seatForSid(seats, "sid-c"), "Reviewer");
  assert.equal(seatForSid(seats, "sid-a"), null);
  assert.equal(seatForSid(undefined, "sid-b"), null, "no seats map → null, not a throw");
});
