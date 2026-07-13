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
  projectsDirForCwd,
  projectsDirsForCwd,
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

test("listSessions finds a WORKTREE session's transcript via its marker cwd, not the board-root dir", () => {
  // The regression: a Coordinator worker runs in a worktree, so Claude Code writes its transcript into a
  // DIFFERENT projects dir than the board root's. Enumerating only the board-root dir dropped it. Driving
  // off the marker set + resolving each transcript dir from the marker's cwd is the fix.
  const repo = tmpRepo();
  const boardRootDir = transcriptsWith(["rootSession"]); // a board-root (browser-tab) session
  const worktreeDir = transcriptsWith(["wtSession"]); // a worktree (Coordinator-worker) session — separate dir
  markCanvasSession(repo, "rootSession", { spawnedAt: 1 }); // no cwd → board-root fallback
  markCanvasSession(repo, "wtSession", { spawnedAt: 2, cwd: "/some/board/.canvas/worktrees/w-1" });

  // dirForCwd stands in for projectsDirForCwd (a test can't seed the real ~/.claude/projects): the one
  // worktree cwd maps to worktreeDir; anything else is unmapped.
  const dirForCwd = (cwd) => (cwd === "/some/board/.canvas/worktrees/w-1" ? worktreeDir : "/nope");
  const ids = listSessions(boardRootDir, repo, dirForCwd).map((s) => s.id);
  assert.deepEqual(ids, ["wtSession", "rootSession"], "both list; worktree session resolved via marker cwd, newest first");
});

test("listSessions keeps an owned session whose transcript is missing, marked honestly", () => {
  const repo = tmpRepo();
  const dir = transcriptsWith(["present"]);
  markCanvasSession(repo, "present", { spawnedAt: 1 });
  markCanvasSession(repo, "gone", { spawnedAt: 2 }); // marker exists but no .jsonl in dir
  assert.deepEqual(listSessions(dir, repo), [
    { id: "gone", mtime: 2, bytes: null, noHistory: true },
    { id: "present", mtime: 1, bytes: 3 },
  ]);
});

test("listSessions includes a bound Codex conversation without a Claude transcript", () => {
  const repo = tmpRepo();
  const dir = transcriptsWith([]);
  markCanvasSession(repo, "codex", {
    provider: "codex",
    providerSessionId: "provider-thread-1",
    spawnedAt: 10,
    endedAt: 20,
  });
  markCanvasSession(repo, "failed", { provider: "codex", spawnedAt: 30 });
  assert.deepEqual(
    listSessions(dir, repo),
    [
      { id: "failed", mtime: 30, bytes: null, noHistory: true },
      { id: "codex", mtime: 20, bytes: null, noHistory: false },
    ],
    "provider history is not misreported as a zero-byte Claude file",
  );
});

test("listSessions uses durable lifecycle time when copied transcript mtimes collapse", () => {
  const repo = tmpRepo();
  const dir = transcriptsWith(["older", "newer"]);
  const copiedAt = new Date(9_999_000);
  fs.utimesSync(path.join(dir, "older.jsonl"), copiedAt, copiedAt);
  fs.utimesSync(path.join(dir, "newer.jsonl"), copiedAt, copiedAt);
  markCanvasSession(repo, "older", { spawnedAt: 100, endedAt: 200 });
  markCanvasSession(repo, "newer", { spawnedAt: 300, endedAt: 400 });
  assert.deepEqual(
    listSessions(dir, repo).map(({ id, mtime }) => ({ id, mtime })),
    [{ id: "newer", mtime: 400 }, { id: "older", mtime: 200 }],
  );
});

test("projectsDirForCwd slugs every non-alphanumeric character like Claude", () => {
  // The board root (no dots) is unchanged from the old '/'-only rule, so this stays back-compatible…
  assert.ok(projectsDirForCwd("/Users/me/foolscap").endsWith("-Users-me-foolscap"));
  // …but a worktree cwd's `.canvas` MUST slug the dot too, or the computed dir won't match Claude Code's.
  assert.ok(
    projectsDirForCwd("/Users/me/foolscap/.canvas/worktrees/w-1").endsWith("-Users-me-foolscap--canvas-worktrees-w-1"),
    "'/.canvas' → '--canvas' (both the slash and the dot become '-')",
  );
  assert.ok(
    projectsDirForCwd("/Users/me/foolscap_codex").endsWith("-Users-me-foolscap-codex"),
    "an underscore is a dash in Claude's real projects directory",
  );
  assert.equal(projectsDirsForCwd("/Users/me/foolscap").length, 1, "no redundant compatibility candidate");
  assert.equal(projectsDirsForCwd("/Users/me/foolscap_codex").length, 2, "legacy migrated slug remains readable");
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
