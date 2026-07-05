// The doc-watch ledger (P1, wakeable-substrate-plan W4): a per-doc watch marker beside the annotation
// ledger — a doc's SEAT roster (who's armed to be woken by a comment, at what level). The annotations
// ledger's sibling; a JSON marker, not an append-log.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canvasAnnotationsDir,
  readWatchers,
  setWatcher,
  setWatcherState,
  removeWatcher,
  watcherEffectiveLevel,
  listWatchedPaths,
} from "../doc-watch.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doc-watch-"));
}
const DOC = "docs/thing.md";

test("no marker → no watchers, never a throw", () => {
  const repo = tmpRepo();
  assert.deepEqual(readWatchers(repo, DOC), []);
  assert.deepEqual(listWatchedPaths(repo), []);
});

test("setWatcher binds a role, defaulting the level to `all`, state active; the marker lands beside the ledger", () => {
  const repo = tmpRepo();
  const w = setWatcher(repo, DOC, { role: "Coordinator", by: "human", ts: 100 });
  assert.equal(w.role, "Coordinator");
  assert.equal(w.level, "all");
  assert.equal(w.state, "active");
  assert.equal(w.by, "human");
  assert.equal(w.createdAt, 100);
  // Persisted under .canvas/annotations/ with the encoded doc path + .watch.json.
  const f = path.join(canvasAnnotationsDir(repo), encodeURIComponent(DOC) + ".watch.json");
  assert.ok(fs.existsSync(f), "watch marker sits beside the annotation ledger");
  assert.deepEqual(readWatchers(repo, DOC), [w]);
  assert.deepEqual(listWatchedPaths(repo), [DOC]);
});

test("an unknown level normalizes to `all`; an explicit level is kept", () => {
  const repo = tmpRepo();
  assert.equal(setWatcher(repo, DOC, { role: "R", level: "nonsense" }).level, "all");
  assert.equal(setWatcher(repo, DOC, { role: "R", level: "mentions" }).level, "mentions");
});

test("re-binding a role RE-LEVELS in place, preserving createdAt/by (arming provenance) and state", () => {
  const repo = tmpRepo();
  setWatcher(repo, DOC, { role: "Coordinator", level: "all", by: "human", ts: 100 });
  setWatcherState(repo, DOC, "Coordinator", "paused");
  const w = setWatcher(repo, DOC, { role: "Coordinator", level: "mentions", by: "someone-else", ts: 999 });
  assert.equal(w.level, "mentions", "re-level applied");
  assert.equal(w.createdAt, 100, "createdAt written once");
  assert.equal(w.by, "human", "arming provenance kept");
  assert.equal(w.state, "paused", "state preserved across a re-level");
  assert.equal(readWatchers(repo, DOC).length, 1, "one watcher per role, not a duplicate");
});

test("two roles coexist on one doc", () => {
  const repo = tmpRepo();
  setWatcher(repo, DOC, { role: "Coordinator", level: "all" });
  setWatcher(repo, DOC, { role: "Reviewer", level: "mentions" });
  const roles = readWatchers(repo, DOC).map((w) => w.role).sort();
  assert.deepEqual(roles, ["Coordinator", "Reviewer"]);
});

test("pause/resume flips state without touching level; a missing watcher → null", () => {
  const repo = tmpRepo();
  assert.equal(setWatcherState(repo, DOC, "Ghost", "paused"), null, "no watcher → null, not a throw");
  setWatcher(repo, DOC, { role: "Coordinator", level: "mentions" });
  assert.equal(setWatcherState(repo, DOC, "Coordinator", "paused").state, "paused");
  assert.equal(readWatchers(repo, DOC)[0].level, "mentions", "level survives the pause");
  assert.equal(setWatcherState(repo, DOC, "Coordinator", "active").state, "active");
});

test("watcherEffectiveLevel is `paused` while state is paused, else the standing level", () => {
  assert.equal(watcherEffectiveLevel({ level: "all", state: "active" }), "all");
  assert.equal(watcherEffectiveLevel({ level: "all", state: "paused" }), "paused");
  assert.equal(watcherEffectiveLevel({ level: "mentions", state: "paused" }), "paused");
  assert.equal(watcherEffectiveLevel(undefined), "all");
});

test("removeWatcher drops one; the marker file is deleted when the last watcher goes", () => {
  const repo = tmpRepo();
  setWatcher(repo, DOC, { role: "Coordinator" });
  setWatcher(repo, DOC, { role: "Reviewer" });
  assert.equal(removeWatcher(repo, DOC, "Ghost"), false, "removing an absent role → false");
  assert.equal(removeWatcher(repo, DOC, "Coordinator"), true);
  assert.deepEqual(readWatchers(repo, DOC).map((w) => w.role), ["Reviewer"]);
  const f = path.join(canvasAnnotationsDir(repo), encodeURIComponent(DOC) + ".watch.json");
  assert.ok(fs.existsSync(f), "marker survives while a watcher remains");
  assert.equal(removeWatcher(repo, DOC, "Reviewer"), true);
  assert.equal(fs.existsSync(f), false, "last watcher gone → marker file removed");
  assert.deepEqual(listWatchedPaths(repo), [], "and the doc is no longer watched");
});
