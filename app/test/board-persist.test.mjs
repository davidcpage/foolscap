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

test("clear drops both files", () => {
  const repo = tmpRepo();
  appendBoardEvent(repo, { seq: 1 });
  writeBoardSnapshot(repo, { records: [], version: 1, seq: 1 });
  clearBoardPersist(repo);
  assert.deepEqual(readBoardPersist(repo), { events: [], snapshot: null });
  assert.equal(hasBoardPersist(repo), false);
  clearBoardPersist(repo); // idempotent on an already-empty board
});
