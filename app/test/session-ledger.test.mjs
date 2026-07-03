// The canvas-session ledger: ownership markers that separate canvas-spawned sessions from external
// terminal `claude` transcripts sharing the same projects dir, and survive a server restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canvasSessionsDir,
  markCanvasSession,
  isCanvasSession,
  listSessions,
  readCanvasSession,
  recordSessionEnd,
  updateCanvasSession,
} from "../session-ledger.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
}
// A transcripts dir standing in for ~/.claude/projects/<repo>/, seeded with .jsonl files.
function transcriptsWith(ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-"));
  for (const id of ids) fs.writeFileSync(path.join(dir, id + ".jsonl"), "{}\n");
  return dir;
}

test("a marker round-trips and lands under the board's .canvas/ home", () => {
  const repo = tmpRepo();
  assert.equal(isCanvasSession(repo, "abc"), false, "unmarked session is not canvas-owned");
  markCanvasSession(repo, "abc", { spawnedAt: 123 });
  assert.equal(isCanvasSession(repo, "abc"), true, "marked session is canvas-owned");
  // It lives where the gitignored, shadow-versioned home expects it.
  const f = path.join(canvasSessionsDir(repo), "abc.json");
  assert.ok(fs.existsSync(f), "marker file is under .canvas/sessions/");
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { spawnedAt: 123 });
});

test("listSessions returns ONLY canvas-owned transcripts — externals are filtered out", () => {
  const repo = tmpRepo();
  const dir = transcriptsWith(["ours", "external", "alsoOurs"]);
  // Only two of the three transcripts are marked as canvas-owned.
  markCanvasSession(repo, "ours", { spawnedAt: 1 });
  markCanvasSession(repo, "alsoOurs", { spawnedAt: 2 });

  const ids = listSessions(dir, repo).map((s) => s.id);
  assert.ok(ids.includes("ours") && ids.includes("alsoOurs"), "canvas-owned sessions are listed");
  assert.ok(!ids.includes("external"), "an external terminal transcript is NOT listed");
  assert.equal(ids.length, 2);
});

test("with no markers the list is empty, not the raw transcript dir (pre-ledger / all-external)", () => {
  const repo = tmpRepo();
  const dir = transcriptsWith(["a", "b"]);
  assert.deepEqual(listSessions(dir, repo), [], "nothing is canvas-owned until adopted/spawned");
});

test("backfill-by-adoption: marking an existing transcript on serve makes it list (migration path)", () => {
  const repo = tmpRepo();
  const dir = transcriptsWith(["legacy"]);
  assert.equal(listSessions(dir, repo).length, 0, "a pre-ledger session starts unlisted");
  // handleSession marks on first serve when not already owned (adoptedAt, not clobbering a spawn marker).
  if (!isCanvasSession(repo, "legacy")) markCanvasSession(repo, "legacy", { adoptedAt: 9 });
  assert.deepEqual(
    listSessions(dir, repo).map((s) => s.id),
    ["legacy"],
    "after adoption it lists",
  );
});

test("a missing transcripts dir yields an empty list, not a throw", () => {
  const repo = tmpRepo();
  assert.deepEqual(listSessions(path.join(repo, "does-not-exist"), repo), []);
});

test("readCanvasSession returns the marker, or null when there's none", () => {
  const repo = tmpRepo();
  assert.equal(readCanvasSession(repo, "nope"), null, "no marker → null, not a throw");
  markCanvasSession(repo, "s", { spawnedAt: 7, origin: "x" });
  assert.deepEqual(readCanvasSession(repo, "s"), { spawnedAt: 7, origin: "x" });
});

test("recordSessionEnd (Phase 2): merges the end reason onto the existing spawn marker", () => {
  const repo = tmpRepo();
  markCanvasSession(repo, "s", { spawnedAt: 7, origin: "x" });
  recordSessionEnd(repo, "s", "done", 99);
  // The spawn fields survive — the end is layered on, not a clobber — and the session stays owned/listed.
  assert.deepEqual(readCanvasSession(repo, "s"), {
    spawnedAt: 7,
    origin: "x",
    endReason: "done",
    endedAt: 99,
  });
  assert.equal(isCanvasSession(repo, "s"), true);
});

test("recordSessionEnd writes even with no prior marker (an end implies ownership)", () => {
  const repo = tmpRepo();
  recordSessionEnd(repo, "orphan", "crashed", 5);
  assert.deepEqual(readCanvasSession(repo, "orphan"), { endReason: "crashed", endedAt: 5 });
  assert.equal(isCanvasSession(repo, "orphan"), true, "the marker now exists → owned");
});

test("recordSessionEnd can be re-applied — a later reason overwrites an earlier one", () => {
  const repo = tmpRepo();
  recordSessionEnd(repo, "s", "terminated", 1);
  recordSessionEnd(repo, "s", "done", 2);
  assert.deepEqual(readCanvasSession(repo, "s"), { endReason: "done", endedAt: 2 });
});

test("updateCanvasSession merges a patch without clobbering spawn identity or end state", () => {
  const repo = tmpRepo();
  markCanvasSession(repo, "s", { spawnedAt: 7, origin: "x", roleId: "pm" });
  updateCanvasSession(repo, "s", { read: { "node:thread:a": 4 }, waitingOn: null });
  // Spawn fields survive the patch — this is what markCanvasSession (a clobber) could not do.
  assert.deepEqual(readCanvasSession(repo, "s"), {
    spawnedAt: 7,
    origin: "x",
    roleId: "pm",
    read: { "node:thread:a": 4 },
    waitingOn: null,
  });
  // A later patch advances the cursor map wholesale and leaves everything else alone.
  updateCanvasSession(repo, "s", { read: { "node:thread:a": 9, "node:thread:b": 2 } });
  const m = readCanvasSession(repo, "s");
  assert.deepEqual(m.read, { "node:thread:a": 9, "node:thread:b": 2 });
  assert.equal(m.roleId, "pm");
});

test("updateCanvasSession writes even with no prior marker, and interleaves with recordSessionEnd", () => {
  const repo = tmpRepo();
  updateCanvasSession(repo, "s", { read: { t: 1 } });
  recordSessionEnd(repo, "s", "crashed", 5);
  assert.deepEqual(readCanvasSession(repo, "s"), { read: { t: 1 }, endReason: "crashed", endedAt: 5 });
});
