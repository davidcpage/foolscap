// The worktree spawn primitive (Stage 1 of the worktree-based multi-agent workflow, node:thread:e1784729):
// per-work-item isolated git worktrees — create/re-attach/teardown, keyed by WORK ITEM (not the ephemeral
// sid) so a respawn lands back in the same tree, with a dirty/unmerged teardown guard and node_modules
// symlinked (never copied). These tests drive the ledger against a REAL throwaway git repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureWorktree,
  removeWorktree,
  mergeWorktree,
  listWorktrees,
  workItemKey,
  worktreesDir,
  linkNodeModules,
  worktreeOnboarding,
} from "../worktrees.js";
import { readThreadMeta } from "../thread-ledger.js";

// A throwaway git repo (on `main`) with the three package dirs committed (so a worktree checkout HAS them)
// and a canonical node_modules on disk in each (gitignored — as in the real repo — so it never lands in the
// worktree and must be symlinked). Each package carries a package.json with trivially-green `test` +
// `typecheck` scripts (`node -e ""`), so the merge-on-green gate can run for real in the throwaway repo (a
// branch overrides its own script to test the red path). Returns the repo path.
function tmpRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.canvas/\n");
  for (const pkg of ["core", "interaction", "app"]) {
    fs.mkdirSync(path.join(repo, pkg), { recursive: true });
    fs.writeFileSync(path.join(repo, pkg, "index.js"), `// ${pkg}\n`);
    fs.writeFileSync(
      path.join(repo, pkg, "package.json"),
      JSON.stringify({ name: pkg, version: "0.0.0", private: true, scripts: { test: 'node -e ""', typecheck: 'node -e ""' } }, null, 2) + "\n",
    );
    fs.mkdirSync(path.join(repo, pkg, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, pkg, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return repo;
}
const gitOut = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
// Commit a change on a worktree's branch (helper for the merge tests).
function commitInWorktree(wtPath, relPath, contents, msg) {
  fs.mkdirSync(path.dirname(path.join(wtPath, relPath)), { recursive: true });
  fs.writeFileSync(path.join(wtPath, relPath), contents);
  execFileSync("git", ["add", "-A"], { cwd: wtPath });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", msg], { cwd: wtPath });
}

test("workItemKey: explicit key wins, then role seat, then thread, else null", () => {
  assert.equal(workItemKey({ threadId: "node:thread:t", roleId: "pm", explicitKey: "K" }), "K");
  assert.equal(workItemKey({ threadId: "node:thread:t", roleId: "pm" }), "role:pm");
  assert.equal(workItemKey({ threadId: "node:thread:t" }), "node:thread:t");
  assert.equal(workItemKey({}), null);
});

test("ensureWorktree cuts an isolated worktree on its own branch, recorded on the thread marker", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  assert.equal(wt.reused, false);
  assert.ok(fs.existsSync(wt.path), "worktree dir exists");
  assert.ok(wt.path.startsWith(fs.realpathSync(worktreesDir(repo))), "lives under .canvas/worktrees/");
  assert.equal(wt.branch, "agent/node-thread-abc");
  // git knows it as a worktree on that branch, isolated from the canonical checkout.
  assert.match(gitOut(repo, "worktree", "list", "--porcelain"), /agent\/node-thread-abc/);
  // durable record on the thread marker (survives the session).
  const rec = readThreadMeta(repo, thread).worktrees[key];
  assert.equal(rec.branch, "agent/node-thread-abc");
  assert.equal(rec.path, wt.path);
  // node_modules symlinked (not copied) for each package.
  for (const pkg of ["core", "interaction", "app"]) {
    const nm = path.join(wt.path, pkg, "node_modules");
    assert.ok(fs.lstatSync(nm).isSymbolicLink(), `${pkg}/node_modules is a symlink`);
    assert.ok(fs.existsSync(path.join(nm, "dep", "index.js")), `${pkg} dep resolves through the link`);
  }
  assert.deepEqual([...wt.linked].sort(), ["app", "core", "interaction"]);
});

test("ensureWorktree RE-ATTACHES to the same tree/branch on a respawn (never a fresh cut)", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "role:builder";
  const first = ensureWorktree(repo, thread, key);
  assert.equal(first.reused, false);
  // Simulate work in the worktree: a new commit on the branch.
  fs.writeFileSync(path.join(first.path, "work.txt"), "in progress\n");
  execFileSync("git", ["add", "-A"], { cwd: first.path });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "wip"], { cwd: first.path });
  // Respawn: same work item → same path + branch, reused, and the mid-flight work is still there.
  const second = ensureWorktree(repo, thread, key);
  assert.equal(second.reused, true);
  assert.equal(second.path, first.path);
  assert.equal(second.branch, first.branch);
  assert.ok(fs.existsSync(path.join(second.path, "work.txt")), "re-attached to the same tree, work intact");
  // Exactly one worktree for this key (no duplicate cut).
  assert.equal(first.branch, "agent/role-builder");
  const wts = gitOut(repo, "worktree", "list").split("\n").filter((l) => l.includes("agent/role-builder"));
  assert.equal(wts.length, 1);
});

test("teardown removes a clean, merged worktree and drops the record", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  // Clean tree, branch has no commits beyond HEAD → fully merged.
  const r = removeWorktree(repo, thread, key);
  assert.equal(r.removed, true);
  assert.ok(!fs.existsSync(wt.path), "worktree dir gone");
  assert.deepEqual(listWorktrees(repo, thread), {}, "record dropped from the marker");
  assert.doesNotMatch(gitOut(repo, "worktree", "list"), /agent\//, "git no longer lists it");
});

test("teardown GUARD: skips a dirty tree unless force", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  fs.writeFileSync(path.join(wt.path, "uncommitted.txt"), "dirty\n"); // uncommitted change
  const skipped = removeWorktree(repo, thread, key);
  assert.equal(skipped.removed, false);
  assert.equal(skipped.dirty, true);
  assert.match(skipped.reason, /dirty/);
  assert.ok(fs.existsSync(wt.path), "worktree preserved");
  assert.ok(listWorktrees(repo, thread)[key], "record preserved");
  // force blows past the guard.
  const forced = removeWorktree(repo, thread, key, { force: true });
  assert.equal(forced.removed, true);
  assert.ok(!fs.existsSync(wt.path));
});

test("teardown GUARD: skips an unmerged branch unless force", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  // A committed-but-unmerged change: clean tree, but the branch is ahead of HEAD.
  fs.writeFileSync(path.join(wt.path, "feature.txt"), "done\n");
  execFileSync("git", ["add", "-A"], { cwd: wt.path });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "feature"], { cwd: wt.path });
  const skipped = removeWorktree(repo, thread, key);
  assert.equal(skipped.removed, false);
  assert.equal(skipped.unmerged, true);
  assert.match(skipped.reason, /unmerged/);
  assert.ok(fs.existsSync(wt.path), "unmerged work preserved");
  const forced = removeWorktree(repo, thread, key, { force: true });
  assert.equal(forced.removed, true);
});

// ── BUG-8: the OCCUPANCY guard — never `git worktree remove` a tree a LIVE session is cwd-ed in ──────────
// The recurring shape: a worker's merge-on-green (or a peer's) tore down the worktree the still-live worker
// was running in; the process then failed every fs/git op (spawn ENOENT into the removed cwd) and exited
// code=1, which session-host classifies as a self-death → a FALSE red "crashed" band. The fix: teardown
// takes an `isOccupied(wtPath) => sid | null` lookup (built from the live-session registry) and DEFERS (with
// an honest removed:false, deferred:true, occupant:<sid> result) while it names an occupant.

test("teardown OCCUPANCY guard: skips (defers) a tree a live session occupies, even with force", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  const isOccupied = () => "sess-live-1"; // a live session (this sid) is cwd-ed in this worktree

  const skipped = removeWorktree(repo, thread, key, { isOccupied });
  assert.equal(skipped.removed, false);
  assert.equal(skipped.deferred, true, "honest shape: deferred, not removed");
  assert.equal(skipped.occupied, true);
  assert.equal(skipped.occupant, "sess-live-1", "names the occupying session");
  assert.match(skipped.reason, /live session sess-live-1 is running in this worktree/);
  assert.ok(fs.existsSync(wt.path), "the live session's cwd is NOT yanked out from under it");
  // The deferred teardown is recorded, not abandoned — pendingReap flags it for the reap sweep.
  assert.equal(listWorktrees(repo, thread)[key].pendingReap, true, "record stamped pendingReap");

  // force must NOT bypass the occupancy guard (force discards WORK; it must not crash a running session).
  const forced = removeWorktree(repo, thread, key, { isOccupied, force: true });
  assert.equal(forced.removed, false);
  assert.equal(forced.deferred, true);
  assert.ok(fs.existsSync(wt.path), "force still refuses to yank a live cwd");
});

test("teardown OCCUPANCY guard: reaps the deferred tree once the occupant has exited", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  // First attempt while occupied → deferred + pendingReap stamped.
  removeWorktree(repo, thread, key, { isOccupied: () => "sess-live-1" });
  assert.ok(fs.existsSync(wt.path));
  // Occupant has exited (lookup now returns null) → the (now-safe) removal succeeds and the record is dropped.
  const reaped = removeWorktree(repo, thread, key, { isOccupied: () => null });
  assert.equal(reaped.removed, true);
  assert.ok(!fs.existsSync(wt.path), "worktree removed once no live session occupies it");
  assert.deepEqual(listWorktrees(repo, thread), {}, "record dropped");
});

test("merge-on-green OCCUPANCY guard: still merges the branch, DEFERS teardown of the live tree", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  commitInWorktree(wt.path, "app/feature.js", "export const feature = 1;\n", "add feature");
  const before = gitOut(repo, "rev-parse", "HEAD");

  // The classic BUG-8 case: the worker that ran merge-on-green is still alive (about to post its proof).
  const r = mergeWorktree(repo, thread, key, { isOccupied: () => "sess-worker" });
  assert.equal(r.merged, true, "the merge itself still lands — the branch value is preserved");
  assert.equal(r.deferred, true, "honest shape: teardown deferred, not done");
  assert.equal(r.occupied, true);
  assert.equal(r.occupant, "sess-worker");
  assert.equal(r.removed, false, "teardown deferred — the live worker's cwd is NOT yanked");
  assert.equal(r.teardown.deferred, true, "the nested teardown result is honest too");
  // main advanced with the feature (the valuable half happened) …
  assert.notEqual(gitOut(repo, "rev-parse", "HEAD"), before, "main advanced with the merge");
  assert.ok(fs.existsSync(path.join(repo, "app", "feature.js")), "feature landed on main");
  // … but the worktree is preserved (no crash) and flagged for the reap sweep.
  assert.ok(fs.existsSync(wt.path), "worktree preserved while the session is live");
  assert.equal(listWorktrees(repo, thread)[key].pendingReap, true, "deferred teardown flagged pendingReap");

  // Once the worker exits, the deferred teardown completes (what reapPendingWorktreesTick drives). The branch
  // is already merged, so the reap is safe by construction even across a server restart.
  const reaped = removeWorktree(repo, thread, key, { isOccupied: () => null });
  assert.equal(reaped.removed, true);
  assert.ok(!fs.existsSync(wt.path), "worktree reaped after the occupant exits");
});

test("teardown with no occupancy predicate behaves exactly as before (removes a clean merged tree)", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  const r = removeWorktree(repo, thread, key); // no isOccupied — legacy callers unaffected
  assert.equal(r.removed, true);
  assert.ok(!fs.existsSync(wt.path));
});

test("teardown on a work item with no worktree is a no-op, not a throw", () => {
  const repo = tmpRepo();
  const r = removeWorktree(repo, "node:thread:abc", "node:thread:abc");
  assert.equal(r.removed, false);
  assert.match(r.reason, /no worktree/);
});

test("linkNodeModules is idempotent and skips an already-present link", () => {
  const repo = tmpRepo();
  const wt = ensureWorktree(repo, "node:thread:abc", "node:thread:abc");
  const again = linkNodeModules(repo, wt.path); // links already exist from ensureWorktree
  assert.deepEqual(again, [], "no re-link when the symlink is already there");
});

// ── merge-on-green (Stage 3) ────────────────────────────────────────────────────────────────────────

test("merge-on-green: green gate passes → merges --no-ff into main and tears down", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  commitInWorktree(wt.path, "app/feature.js", "export const feature = 1;\n", "add feature");
  const before = gitOut(repo, "rev-parse", "HEAD");

  const r = mergeWorktree(repo, thread, key); // real gate: app package.json scripts are green
  assert.equal(r.merged, true);
  assert.equal(r.testsPassed, true);
  assert.deepEqual(r.testsRun, ["app"], "only app touched → only app gated");
  assert.equal(r.removed, true);
  // main advanced with a merge commit that carries the feature.
  assert.notEqual(gitOut(repo, "rev-parse", "HEAD"), before, "main advanced");
  assert.ok(fs.existsSync(path.join(repo, "app", "feature.js")), "feature landed on main");
  assert.match(gitOut(repo, "log", "-1", "--pretty=%s"), /Merge agent\/node-thread-abc into main/);
  // worktree + branch + record all gone.
  assert.ok(!fs.existsSync(wt.path), "worktree dir removed");
  assert.deepEqual(listWorktrees(repo, thread), {}, "record dropped");
  assert.doesNotMatch(gitOut(repo, "worktree", "list"), /agent\//, "git no longer lists the worktree");
});

test("merge-on-green: also gates core/interaction when the branch touched them", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  commitInWorktree(wt.path, "core/added.ts", "export const x = 1;\n", "touch core");
  const r = mergeWorktree(repo, thread, key);
  assert.equal(r.merged, true);
  assert.deepEqual(r.testsRun, ["core", "app"], "core touched → core + app gated, deps-first");
});

test("merge --no-verify: skips the gate, still merges + tears down", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  commitInWorktree(wt.path, "app/feature.js", "export const f = 1;\n", "feature");
  const r = mergeWorktree(repo, thread, key, { noVerify: true });
  assert.equal(r.merged, true);
  assert.equal(r.testsPassed, null, "gate skipped → testsPassed null");
  assert.deepEqual(r.testsRun, [], "no packages gated");
  assert.equal(r.removed, true);
  assert.ok(!fs.existsSync(wt.path));
});

test("merge ABORTS on a red gate: no merge, worktree preserved, main untouched", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  // The branch ships a failing test script — the gate runs the BRANCH's scripts, so it must fail.
  const redPkg = JSON.stringify(
    { name: "app", version: "0.0.0", private: true, scripts: { test: 'node -e "process.exit(1)"', typecheck: 'node -e ""' } },
    null, 2,
  ) + "\n";
  commitInWorktree(wt.path, "app/package.json", redPkg, "break the test");
  const before = gitOut(repo, "rev-parse", "HEAD");

  const r = mergeWorktree(repo, thread, key);
  assert.equal(r.merged, false);
  assert.equal(r.testsPassed, false);
  assert.equal(r.gate.pkg, "app");
  assert.match(r.gate.step, /npm test/);
  assert.match(r.reason, /green gate failed/);
  // Nothing merged, nothing torn down.
  assert.equal(gitOut(repo, "rev-parse", "HEAD"), before, "main untouched");
  assert.ok(fs.existsSync(wt.path), "worktree preserved");
  assert.ok(listWorktrees(repo, thread)[key], "record preserved");
});

test("merge REFUSES a dirty worktree (commit first)", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  fs.writeFileSync(path.join(wt.path, "app", "wip.js"), "uncommitted\n");
  const r = mergeWorktree(repo, thread, key, { noVerify: true });
  assert.equal(r.merged, false);
  assert.equal(r.dirty, true);
  assert.match(r.reason, /uncommitted/);
  assert.ok(fs.existsSync(wt.path), "worktree preserved");
});

test("merge REFUSES a dirty canonical checkout", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  commitInWorktree(wt.path, "app/feature.js", "1\n", "feature");
  fs.writeFileSync(path.join(repo, "app", "dirty.js"), "uncommitted in canonical\n"); // dirty main
  const r = mergeWorktree(repo, thread, key, { noVerify: true });
  assert.equal(r.merged, false);
  assert.match(r.reason, /canonical checkout \(main\) has uncommitted/);
  assert.ok(fs.existsSync(wt.path), "worktree preserved");
});

test("merge REFUSES when the canonical checkout is on the wrong branch", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  commitInWorktree(wt.path, "app/feature.js", "1\n", "feature");
  execFileSync("git", ["checkout", "-q", "-b", "sidebar"], { cwd: repo }); // canonical off main
  const r = mergeWorktree(repo, thread, key, { base: "main", noVerify: true });
  assert.equal(r.merged, false);
  assert.match(r.reason, /on "sidebar", not the merge target "main"/);
});

test("merge conflict → git merge --abort, canonical left clean, worktree preserved", () => {
  const repo = tmpRepo();
  const thread = "node:thread:abc";
  const key = "node:thread:abc";
  const wt = ensureWorktree(repo, thread, key);
  // Both the branch and main edit the SAME line of the SAME file → a real conflict at merge.
  commitInWorktree(wt.path, "app/index.js", "// branch edit\n", "branch edits index");
  fs.writeFileSync(path.join(repo, "app", "index.js"), "// main edit\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "main edits index"], { cwd: repo });
  const before = gitOut(repo, "rev-parse", "HEAD");

  const r = mergeWorktree(repo, thread, key, { noVerify: true });
  assert.equal(r.merged, false);
  assert.equal(r.conflict, true);
  assert.match(r.reason, /conflicted/);
  // The abort left the canonical tree clean (no conflict markers / no MERGE_HEAD) and HEAD unmoved.
  assert.equal(gitOut(repo, "status", "--porcelain"), "", "canonical tree clean after abort");
  assert.equal(gitOut(repo, "rev-parse", "HEAD"), before, "main HEAD unmoved");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")), "no in-progress merge left behind");
  assert.ok(fs.existsSync(wt.path), "worktree preserved for a re-merge after resolution");
});

test("merge with no worktree recorded is a no-op refusal, not a throw", () => {
  const repo = tmpRepo();
  const r = mergeWorktree(repo, "node:thread:abc", "node:thread:abc");
  assert.equal(r.merged, false);
  assert.match(r.reason, /no worktree/);
});

// The isolation-onboarding block a --worktree worker gets appended to its system prompt. The bug it closes:
// a worktree worker's cwd is its isolated checkout, but every path pointer in its onboarding names the main
// checkout, so without an explicit confine-edits-here instruction it anchors on main and dirties it.
test("worktreeOnboarding names the worktree cwd, the main checkout, and the confinement rule", () => {
  const cwd = "/repo/.canvas/worktrees/node-mrdl7er8-i";
  const repoPath = "/repo";
  const block = worktreeOnboarding({ cwd, repoPath, branch: "agent/node-mrdl7er8-i" });

  // Both directories are stated verbatim so the worker can distinguish where it edits vs. what it only reads.
  assert.ok(block.includes(cwd), "block should name the worktree cwd");
  assert.ok(block.includes(repoPath), "block should name the main checkout");
  assert.ok(block.includes("agent/node-mrdl7er8-i"), "block should carry the branch when supplied");
  // The load-bearing instruction and the self-verify step.
  assert.match(block, /confine ALL edits|MUST live under your worktree/i);
  assert.match(block, /git -C .* status/);
  // NEVER edit main is stated outright.
  assert.match(block, /NEVER Edit or Write a path under the main checkout/);
});

test("worktreeOnboarding is robust to a missing branch (git miss)", () => {
  const block = worktreeOnboarding({ cwd: "/wt", repoPath: "/repo" });
  assert.ok(block.includes("/wt"));
  assert.ok(block.includes("/repo"));
  // No dangling "(branch ``)" artifact when the branch is unknown.
  assert.ok(!block.includes("(branch"), "should omit the branch label entirely when unknown");
});
