// board-persist.js — the server-side durable board store (events.jsonl + snapshot.json under
// `<repo>/.canvas/board/`). Round-trips, torn-line tolerance, the import-once guard, clear.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  boardPersistDir,
  readBoardPersist,
  hasBoardPersist,
  appendBoardEvent,
  writeBoardSnapshot,
  importBoardPersist,
  clearBoardPersist,
  compactBoardEvents,
} from "../board-persist.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "board-persist-"));
}

test("fresh repo reads as empty", () => {
  const repo = tmpRepo();
  assert.deepEqual(readBoardPersist(repo), { events: [], snapshot: null });
  assert.equal(hasBoardPersist(repo), false);
});

test("events append and read back in order", () => {
  const repo = tmpRepo();
  appendBoardEvent(repo, { seq: 1, diff: { a: 1 } });
  appendBoardEvent(repo, { seq: 2, diff: { b: 2 } });
  const { events } = readBoardPersist(repo);
  assert.deepEqual(
    events,
    [
      { seq: 1, diff: { a: 1 } },
      { seq: 2, diff: { b: 2 } },
    ],
  );
  assert.equal(hasBoardPersist(repo), true);
});

test("snapshot round-trips and replaces", () => {
  const repo = tmpRepo();
  writeBoardSnapshot(repo, { records: [{ id: "n1" }], version: 3, seq: 7 });
  writeBoardSnapshot(repo, { records: [{ id: "n2" }], version: 4, seq: 9 });
  const { snapshot } = readBoardPersist(repo);
  assert.deepEqual(snapshot, { records: [{ id: "n2" }], version: 4, seq: 9 });
  // atomic write leaves no tmp file behind
  assert.deepEqual(
    fs.readdirSync(boardPersistDir(repo)).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("a torn last line is skipped, earlier events survive", () => {
  const repo = tmpRepo();
  appendBoardEvent(repo, { seq: 1 });
  appendBoardEvent(repo, { seq: 2 });
  // simulate a crash mid-append: a partial JSON line with no newline
  fs.appendFileSync(path.join(boardPersistDir(repo), "events.jsonl"), '{"seq":3,"di');
  const { events } = readBoardPersist(repo);
  assert.deepEqual(events, [{ seq: 1 }, { seq: 2 }]);
  // and the log still accepts appends afterwards (the ragged tail line stays skipped)
  appendBoardEvent(repo, { seq: 4 });
  assert.deepEqual(readBoardPersist(repo).events, [{ seq: 1 }, { seq: 2 }, { seq: 4 }]);
});

test("import seeds an empty board and refuses a non-empty one", () => {
  const repo = tmpRepo();
  const ok = importBoardPersist(repo, [{ seq: 1 }, { seq: 2 }], { records: [], version: 2, seq: 2 });
  assert.equal(ok, true);
  assert.deepEqual(readBoardPersist(repo), {
    events: [{ seq: 1 }, { seq: 2 }],
    snapshot: { records: [], version: 2, seq: 2 },
  });
  // a second import must never clobber the now-authoritative state
  assert.equal(importBoardPersist(repo, [{ seq: 99 }], null), false);
  assert.deepEqual(readBoardPersist(repo).events, [{ seq: 1 }, { seq: 2 }]);
});

test("import with events only / snapshot only", () => {
  const a = tmpRepo();
  assert.equal(importBoardPersist(a, [{ seq: 1 }], null), true);
  assert.deepEqual(readBoardPersist(a), { events: [{ seq: 1 }], snapshot: null });
  const b = tmpRepo();
  assert.equal(importBoardPersist(b, [], { records: [], version: 0 }), true);
  assert.deepEqual(readBoardPersist(b), { events: [], snapshot: { records: [], version: 0 } });
});

test("compaction drops only events well below the watermark, keeps the tail", () => {
  const repo = tmpRepo();
  for (let seq = 1; seq <= 30; seq++) appendBoardEvent(repo, { seq });
  writeBoardSnapshot(repo, { records: [], version: 30, seq: 25 });
  // keepTail 10 → cut at seq ≤ 15; minDrop 1 forces the rewrite
  const { dropped } = compactBoardEvents(repo, { keepTail: 10, minDrop: 1 });
  assert.equal(dropped, 15);
  const { events } = readBoardPersist(repo);
  assert.equal(events.length, 15);
  assert.equal(events[0].seq, 16); // tail below the watermark survives…
  assert.equal(events.at(-1).seq, 30); // …and everything past the watermark is untouchable
  // and the log still appends normally afterwards
  appendBoardEvent(repo, { seq: 31 });
  assert.equal(readBoardPersist(repo).events.at(-1).seq, 31);
});

test("compaction is a no-op without a watermark, below minDrop, and for seq-less events", () => {
  const noSnap = tmpRepo();
  appendBoardEvent(noSnap, { seq: 1 });
  assert.deepEqual(compactBoardEvents(noSnap, { keepTail: 0, minDrop: 1 }), { dropped: 0 });

  const few = tmpRepo();
  for (let seq = 1; seq <= 10; seq++) appendBoardEvent(few, { seq });
  writeBoardSnapshot(few, { records: [], version: 10, seq: 10 });
  assert.deepEqual(compactBoardEvents(few, { keepTail: 0, minDrop: 500 }), { dropped: 0 });
  assert.equal(readBoardPersist(few).events.length, 10);

  const legacy = tmpRepo();
  appendBoardEvent(legacy, { parent: 0 }); // pre-watermark event, no seq — never safely droppable
  appendBoardEvent(legacy, { seq: 1 });
  writeBoardSnapshot(legacy, { records: [], version: 2, seq: 100 });
  assert.deepEqual(compactBoardEvents(legacy, { keepTail: 0, minDrop: 1 }), { dropped: 1 });
  assert.deepEqual(readBoardPersist(legacy).events, [{ parent: 0 }]);
});

test("clear drops both files", () => {
  const repo = tmpRepo();
  appendBoardEvent(repo, { seq: 1 });
  writeBoardSnapshot(repo, { records: [], version: 1, seq: 1 });
  clearBoardPersist(repo);
  assert.deepEqual(readBoardPersist(repo), { events: [], snapshot: null });
  assert.equal(hasBoardPersist(repo), false);
  clearBoardPersist(repo); // idempotent on an already-empty board
});
