// Tests for board-memory.js — the R4/W3 board-memory reader that rides every spawned session's brief.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boardMemoryPath, readBoardMemory, boardMemoryBrief } from "../board-memory.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "board-memory-"));
}

function writeMemory(repo, content) {
  fs.mkdirSync(path.join(repo, ".canvas"), { recursive: true });
  fs.writeFileSync(boardMemoryPath(repo), content);
}

test("readBoardMemory returns null when there is no index", () => {
  const repo = tmpRepo();
  assert.equal(readBoardMemory(repo), null);
});

test("readBoardMemory returns the file content untruncated for a small index", () => {
  const repo = tmpRepo();
  writeMemory(repo, "# Board memory\n\n- a settled fact\n");
  const mem = readBoardMemory(repo);
  assert.ok(mem);
  assert.equal(mem.truncated, false);
  assert.match(mem.content, /a settled fact/);
});

test("readBoardMemory HEAD-caps a huge index and flags truncation", () => {
  const repo = tmpRepo();
  // 40KB > the 32KB cap; the kept content is the HEAD (a top-down index read, not a tail).
  const head = "HEAD-MARKER\n";
  writeMemory(repo, head + "x".repeat(40 * 1024) + "\nTAIL-MARKER\n");
  const mem = readBoardMemory(repo);
  assert.ok(mem);
  assert.equal(mem.truncated, true);
  assert.ok(mem.content.startsWith("HEAD-MARKER"), "keeps the head");
  assert.ok(!mem.content.includes("TAIL-MARKER"), "drops the tail past the cap");
});

test("boardMemoryBrief always states the convention, even with no index", () => {
  const repo = tmpRepo();
  const brief = boardMemoryBrief(repo);
  assert.match(brief, /BOARD MEMORY/);
  assert.match(brief, /one fact per line/);
  assert.match(brief, /newest-first/);
  assert.match(brief, /No `\.canvas\/memory\.md`/); // the "create one" hint when absent
});

test("boardMemoryBrief embeds the index content when the file exists", () => {
  const repo = tmpRepo();
  writeMemory(repo, "# Board memory\n\n- one task, one thread\n");
  const brief = boardMemoryBrief(repo);
  assert.match(brief, /BOARD MEMORY/); // convention still present
  assert.match(brief, /one task, one thread/); // ...and the embedded index
  assert.doesNotMatch(brief, /No `\.canvas\/memory\.md`/);
});

test("boardMemoryBrief surfaces the truncation note when the cap bites", () => {
  const repo = tmpRepo();
  writeMemory(repo, "# Board memory\n" + "y".repeat(40 * 1024));
  const brief = boardMemoryBrief(repo);
  assert.match(brief, /index truncated/);
});
