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
  listWorktrees,
  workItemKey,
  worktreesDir,
  linkNodeModules,
} from "../worktrees.js";
import { readThreadMeta } from "../thread-ledger.js";

// A throwaway git repo with the three package dirs committed (so a worktree checkout HAS them) and a
// canonical node_modules on disk in each (gitignored — as in the real repo — so it never lands in the
// worktree and must be symlinked). Returns the repo path.
function tmpRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "worktrees-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.canvas/\n");
  for (const pkg of ["core", "interaction", "app"]) {
    fs.mkdirSync(path.join(repo, pkg), { recursive: true });
    fs.writeFileSync(path.join(repo, pkg, "index.js"), `// ${pkg}\n`);
    fs.mkdirSync(path.join(repo, pkg, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(repo, pkg, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return repo;
}
const gitOut = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

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
