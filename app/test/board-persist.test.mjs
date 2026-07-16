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
  readBoardBoot,
  readBoardSnapshot,
  boardPersistMtime,
  describeBoardEvents,
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

test("readBoardBoot ships snapshot + only the POST-watermark tail (the fast-boot payload)", () => {
  const repo = tmpRepo();
  for (let seq = 1; seq <= 10; seq++) appendBoardEvent(repo, { seq });
  writeBoardSnapshot(repo, { records: [{ id: "n" }], version: 8, seq: 8 });
  const boot = readBoardBoot(repo);
  // The snapshot rides along; the events are ONLY the tail the snapshot hasn't absorbed (seq > 8).
  assert.deepEqual(boot.snapshot, { records: [{ id: "n" }], version: 8, seq: 8 });
  assert.deepEqual(boot.events, [{ seq: 9 }, { seq: 10 }]);
  assert.equal(boot.full, false);
  // The full log is untouched on disk — the lazy /log read still returns everything.
  assert.equal(readBoardPersist(repo).events.length, 10);
});

test("readBoardBoot: empty tail when the watermark == last seq (this-board case)", () => {
  const repo = tmpRepo();
  for (let seq = 1; seq <= 5; seq++) appendBoardEvent(repo, { seq });
  writeBoardSnapshot(repo, { records: [], version: 5, seq: 5 });
  const boot = readBoardBoot(repo);
  assert.deepEqual(boot.events, [], "nothing past the watermark → the boot fetch ships zero events");
  assert.equal(boot.snapshot.seq, 5);
});

test("readBoardBoot: a legacy snapshot with no seq ships the whole log (full:true)", () => {
  const repo = tmpRepo();
  appendBoardEvent(repo, { seq: 1 });
  appendBoardEvent(repo, { seq: 2 });
  writeBoardSnapshot(repo, { records: [], version: 2 }); // no seq stamp
  const boot = readBoardBoot(repo);
  assert.equal(boot.full, true);
  assert.deepEqual(boot.events, [{ seq: 1 }, { seq: 2 }], "can't define a tail safely → full log, hydrate's parent-filter fallback");
});

test("readBoardBoot: a fresh board is empty snapshot + empty tail", () => {
  const repo = tmpRepo();
  assert.deepEqual(readBoardBoot(repo), { snapshot: null, events: [], dropped: 0, full: true });
});

test("readBoardSnapshot reads only the snapshot; mtime reflects persisted state", () => {
  const repo = tmpRepo();
  assert.equal(readBoardSnapshot(repo), null);
  assert.equal(boardPersistMtime(repo), 0);
  appendBoardEvent(repo, { seq: 1 });
  assert.equal(readBoardSnapshot(repo), null); // events alone are not a snapshot
  assert.ok(boardPersistMtime(repo) > 0); // …but they are persisted state (falls back to the log)
  writeBoardSnapshot(repo, { records: [], version: 1, seq: 1 });
  assert.deepEqual(readBoardSnapshot(repo), { records: [], version: 1, seq: 1 });
});

test("readBoardSnapshot memo never serves stale: fresh after write, out-of-band replace, clear", () => {
  const repo = tmpRepo();
  writeBoardSnapshot(repo, { records: [], version: 1, seq: 1 });
  assert.deepEqual(readBoardSnapshot(repo), { records: [], version: 1, seq: 1 });
  assert.equal(readBoardSnapshot(repo), readBoardSnapshot(repo)); // memo hit — same shared object
  writeBoardSnapshot(repo, { records: [], version: 2, seq: 5 });
  assert.deepEqual(readBoardSnapshot(repo), { records: [], version: 2, seq: 5 }); // write refreshed it
  // Out-of-band replacement (another process): the (mtime,size) key must miss and re-parse.
  fs.writeFileSync(path.join(repo, ".canvas", "board", "snapshot.json"), JSON.stringify({ records: [], version: 3, seq: 9 }));
  assert.deepEqual(readBoardSnapshot(repo), { records: [], version: 3, seq: 9 });
  clearBoardPersist(repo);
  assert.equal(readBoardSnapshot(repo), null);
});

test("describeBoardEvents matches core's describe line format", () => {
  assert.equal(describeBoardEvents([]), "(no intent yet)");
  const events = [
    { ts: 100, actor: "user", type: "addNode", diff: { added: { a: {}, b: {} }, updated: {}, removed: {} } },
    { ts: 200, actor: "claude", type: "moveNode", diff: { added: {}, updated: { a: {} }, removed: {} } },
    { ts: 300, actor: "system", type: "tick", diff: { added: {}, updated: {}, removed: {} } },
  ];
  assert.equal(
    describeBoardEvents(events),
    "100 user addNode [+2]\n200 claude moveNode [~1]\n300 system tick [no-op]",
  );
  assert.equal(describeBoardEvents(events, 1), "300 system tick [no-op]"); // last-n window
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
