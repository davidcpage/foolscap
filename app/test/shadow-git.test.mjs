// Step 0 of the shadow-git ledger (docs/shadow-git-ledger.md §11): prove the committer works AND that it
// does not interfere in EITHER direction — no feedback loop into the file watcher, no pollution of the
// human's `.git`. These are the two preconditions the review (doc §3) flagged as not-yet-true.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import chokidar from "chokidar";
import { commitRoot, watchRoot, shadowTrackedPaths, shadowCommitCount } from "../shadow-git.js";

// A throwaway repo that looks like a real project root: a human `.git`, a `.gitignore` that ignores
// `.canvas/` (the step-0a precondition) and node_modules, some source, junk, and an artefact.
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foolscap-shadow-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".canvas/\nnode_modules/\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "junk", "index.js"), "module.exports = {}\n");
  fs.mkdirSync(path.join(dir, ".canvas", "artefacts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".canvas", "artefacts", "note.md"), "# artefact\n");
  // A non-artefact `.canvas` CONTENT file (a dropped image) — the generalized force-add must version ALL of
  // `.canvas/` (docs/canvas-home.md §4), not just artefacts; the shadow DB under `.canvas/roots/` still stays out.
  fs.mkdirSync(path.join(dir, ".canvas", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".canvas", "images", "shot.png"), "PNGDATA\n");
  return dir;
}
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// A nested agent worktree under `.canvas/worktrees/<key>` (as `spawn --worktree` creates): its own LINKED
// git checkout, which the canonical repo sees as a gitlink/submodule boundary. `git worktree add` needs a
// commit to check out, so we land one in the human repo first. Returns the worktree's absolute path.
function addNestedWorktree(dir, key) {
  execFileSync("git", ["add", "src/a.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  const wt = path.join(dir, ".canvas", "worktrees", key);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", "agent/" + key, wt], { cwd: dir });
  return wt;
}

// Mirrors vite-fs-plugin isInternalPath (Rule B, docs/canvas-home.md §3/§5) after the Gate-1 narrowing: the
// shadow git-dirs under `.canvas/roots/` are internal (a commit writes objects there → re-fire → loop), but
// the REST of `.canvas/` is CONTENT the watcher must see. Both the feedback-loop and the steps-1+2
// integration tests below drive the real watcher through this predicate.
const BASENAME_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".vite", ".cache", "coverage", ".canvas"]);
const isInternalPath = (p) => {
  const segs = p.split(path.sep);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === ".canvas") { if (segs[i + 1] === "roots") return true; continue; } // git-dirs only
    if (BASENAME_EXCLUDE.has(s)) return true;
  }
  return false;
};

test("commits real edits, skips no-ops (never an empty commit)", async () => {
  const dir = tmpRepo();
  try {
    assert.equal((await commitRoot(dir, { message: "snap 1" })).committed, true);
    assert.equal((await commitRoot(dir, { message: "no change" })).committed, false);
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
    assert.equal((await commitRoot(dir, { message: "snap 2" })).committed, true);
    assert.equal(await shadowCommitCount(dir), 2);
  } finally {
    rm(dir);
  }
});

test("tracks src + ALL .canvas content; excludes node_modules + the shadow db", async () => {
  const dir = tmpRepo();
  try {
    await commitRoot(dir, { message: "snap" });
    const tracked = await shadowTrackedPaths(dir);
    assert.ok(tracked.includes("src/a.ts"), "src tracked");
    assert.ok(tracked.includes(".canvas/artefacts/note.md"), "artefact tracked → history/scrubbing");
    assert.ok(tracked.includes(".canvas/images/shot.png"), "non-artefact .canvas content tracked (generalized force-add)");
    assert.ok(!tracked.some((p) => p.startsWith("node_modules/")), "node_modules excluded");
    assert.ok(!tracked.some((p) => p.startsWith(".canvas/roots/")), "shadow db not self-tracked");
  } finally {
    rm(dir);
  }
});

test("non-interference: a shadow commit leaves the human repo untouched", async () => {
  const dir = tmpRepo();
  try {
    const before = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" });
    await commitRoot(dir, { message: "snap" });
    const after = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" });
    assert.equal(after, before, "human `git status` unchanged by the shadow commit");
    assert.ok(!after.includes(".canvas"), "`.canvas` is invisible to the human repo");
    const commits = execFileSync("git", ["rev-list", "--all", "--count"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(commits, "0", "no commits landed in the human repo");
  } finally {
    rm(dir);
  }
});

test("canonical committer snapshots AROUND a nested agent worktree (no `is in submodule` crash)", async () => {
  const dir = tmpRepo();
  const wtKey = "node-abc123-f";
  try {
    const wt = addNestedWorktree(dir, wtKey);
    // A session edits a file INSIDE the agent worktree — the exact shape that used to crash the floor commit
    // ("fatal: … is in submodule '.canvas/worktrees/…'"), because the force-add tried to stage the gitlink.
    fs.mkdirSync(path.join(wt, "app"), { recursive: true });
    fs.writeFileSync(path.join(wt, "app", "edited.ts"), "export const x = 1;\n");
    // The external floor must NOT throw on the nested checkout…
    await assert.doesNotReject(commitRoot(dir, { message: "external: edit" }));
    // …and must NOT stage the nested worktree (neither its files nor the gitlink itself).
    const tracked = await shadowTrackedPaths(dir);
    assert.ok(!tracked.some((p) => p.startsWith(".canvas/worktrees/")), `nested worktree not shadow-staged; got ${JSON.stringify(tracked)}`);
    assert.ok(!tracked.includes(".canvas/worktrees/" + wtKey), "the worktree gitlink itself is not staged");
    // Sanity: the canonical repo's own content is still versioned around it.
    assert.ok(tracked.includes("src/a.ts"), "canonical content still tracked");
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", path.join(dir, ".canvas", "worktrees", wtKey)], { cwd: dir });
    } catch {
      /* best-effort; the temp dir is removed regardless */
    }
    rm(dir);
  }
});

test("watchRoot commits on settle and coalesces a burst into one commit", async () => {
  const dir = tmpRepo();
  const ignored = (p) => p.split(path.sep).some((s) => ["node_modules", ".git", ".canvas"].includes(s));
  const commits = [];
  const handle = watchRoot(dir, { settleMs: 120, ignored, message: "external: edit", onCommit: (r) => commits.push(r) });
  try {
    await new Promise((res) => setTimeout(res, 250)); // let the watcher arm
    fs.writeFileSync(path.join(dir, "src", "c.ts"), "export const c = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "d.ts"), "export const d = 1;\n"); // same burst
    await new Promise((res) => setTimeout(res, 600));
    assert.equal(commits.length, 1, "burst of edits coalesced into one commit");
    const tracked = await shadowTrackedPaths(dir);
    assert.ok(tracked.includes("src/c.ts") && tracked.includes("src/d.ts"), "both edits captured");
  } finally {
    await handle.close();
    rm(dir);
  }
});

// Helpers for the attribution tests: read the shadow log / a commit's files.
const SHADOW = (dir) => ["--git-dir", path.join(dir, ".canvas", "roots", "repo", "git"), "--work-tree", dir];
const shadowLog1 = (dir) =>
  execFileSync("git", [...SHADOW(dir), "log", "-1", "--format=%an%x1f%s"], { cwd: dir, encoding: "utf8" }).trim().split("\x1f");
const shadowFilesIn = (dir, ref) =>
  execFileSync("git", [...SHADOW(dir), "show", "--name-only", "--format=", ref], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);

test("commitRoot with `paths` stages ONLY those paths (the rest stay dirty)", async () => {
  const dir = tmpRepo();
  try {
    await commitRoot(dir, { message: "base" }); // establish HEAD
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 9;\n");
    fs.writeFileSync(path.join(dir, "src", "other.ts"), "export const o = 1;\n");
    const r = await commitRoot(dir, { paths: ["src/a.ts"], author: "session:aaaa1111 <a@s>", message: "aaaa1111: edit src/a.ts" });
    assert.equal(r.committed, true);
    assert.deepEqual(shadowFilesIn(dir, "HEAD"), ["src/a.ts"], "commit holds ONLY the named path");
    // src/other.ts is still uncommitted — a floor commit picks it up separately.
    assert.equal((await commitRoot(dir, { message: "external: edit" })).committed, true, "remaining edit still pending");
    assert.ok(shadowFilesIn(dir, "HEAD").includes("src/other.ts"), "floor swept up the un-named path");
  } finally {
    rm(dir);
  }
});

test("concurrent path-scoped commits attribute each file to its own session (no cross-contamination)", async () => {
  const dir = tmpRepo();
  try {
    await commitRoot(dir, { message: "base" });
    fs.writeFileSync(path.join(dir, "src", "x.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "y.ts"), "export const y = 1;\n");
    // Two sessions' edits in flight at once; the per-root lock serializes the commits.
    await Promise.all([
      commitRoot(dir, { paths: ["src/x.ts"], author: "session:aaaa1111 <a@s>", message: "aaaa1111: edit src/x.ts" }),
      commitRoot(dir, { paths: ["src/y.ts"], author: "session:bbbb2222 <b@s>", message: "bbbb2222: edit src/y.ts" }),
    ]);
    const log = execFileSync("git", [...SHADOW(dir), "log", "-2", "--format=%an%x1f%s"], { cwd: dir, encoding: "utf8" })
      .trim().split("\n").map((l) => l.split("\x1f"));
    const byFile = Object.fromEntries(log.map(([an, s]) => [s.split("edit ")[1], an]));
    assert.equal(byFile["src/x.ts"], "session:aaaa1111", "x attributed to its session only");
    assert.equal(byFile["src/y.ts"], "session:bbbb2222", "y attributed to its session only");
    for (const sha of ["HEAD", "HEAD~1"]) assert.equal(shadowFilesIn(dir, sha).length, 1, "each commit holds exactly one file");
  } finally {
    rm(dir);
  }
});

test("watcher defer: a claimed path is left for its attributed commit, not the external floor", async () => {
  const dir = tmpRepo();
  const ignored = (p) => p.split(path.sep).some((s) => ["node_modules", ".git", ".canvas"].includes(s));
  const commits = [];
  const handle = watchRoot(dir, { settleMs: 120, ignored, message: "external: edit", onCommit: (r) => commits.push(r) });
  try {
    await commitRoot(dir, { message: "external: reconcile on start" }); // boot-reconcile (as syncShadowRoots does)
    await new Promise((res) => setTimeout(res, 250)); // arm the watcher
    handle.claim(["src/claimed.ts"]); // a live tool_use claims its target BEFORE the write settles
    fs.writeFileSync(path.join(dir, "src", "claimed.ts"), "export const c = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "floor.ts"), "export const f = 1;\n"); // unclaimed → floor commits it
    await new Promise((res) => setTimeout(res, 350)); // let the floor debounce fire
    assert.equal(commits.length, 1, "floor fired once");
    const [author, subject] = shadowLog1(dir);
    assert.equal(author, "foolscap-external", "floor commit is the external floor");
    assert.deepEqual(shadowFilesIn(dir, "HEAD"), ["src/floor.ts"], "floor committed ONLY the unclaimed path");
    // Now the tool_result lands: the claimed path commits attributed, and the claim releases.
    const r = await handle.commitClaimed(["src/claimed.ts"], { author: "session:abcd1234 <a@s>", message: "abcd1234: edit src/claimed.ts" });
    assert.equal(r.committed, true);
    const [a2] = shadowLog1(dir);
    assert.equal(a2, "session:abcd1234", "claimed path attributed to the session");
    assert.deepEqual(shadowFilesIn(dir, "HEAD"), ["src/claimed.ts"], "attributed commit holds only the claimed path");
  } finally {
    await handle.close();
    rm(dir);
  }
});

test("no double commit: after commitClaimed the floor finds nothing for that path", async () => {
  const dir = tmpRepo();
  const ignored = (p) => p.split(path.sep).some((s) => ["node_modules", ".git", ".canvas"].includes(s));
  const commits = [];
  const handle = watchRoot(dir, { settleMs: 120, ignored, message: "external: edit", onCommit: (r) => commits.push(r) });
  try {
    await commitRoot(dir, { message: "external: reconcile on start" }); // boot-reconcile (as syncShadowRoots does)
    await new Promise((res) => setTimeout(res, 250));
    handle.claim(["src/once.ts"]);
    fs.writeFileSync(path.join(dir, "src", "once.ts"), "export const o = 1;\n");
    await handle.commitClaimed(["src/once.ts"], { author: "session:abcd1234 <a@s>", message: "abcd1234: edit src/once.ts" });
    const n = commits.length;
    await new Promise((res) => setTimeout(res, 350)); // a settle was armed by the write — must no-op now
    assert.equal(commits.length, n, "floor produced no second commit for the already-committed path");
  } finally {
    await handle.close();
    rm(dir);
  }
});

test("no watcher feedback loop: a commit fires zero shadow-db events, yet .canvas CONTENT stays watched", async () => {
  const dir = tmpRepo();
  // Drives the real watcher through the narrowed Rule B (isInternalPath, module scope above): excludes only
  // `.canvas/roots`, so `.canvas` content is visible. Proves both halves below.
  const events = [];
  const watcher = chokidar.watch(dir, { ignoreInitial: true, ignored: (p) => isInternalPath(p) });
  try {
    await new Promise((res) => watcher.on("ready", res));
    watcher.on("all", (_ev, p) => events.push(path.relative(dir, p)));
    await commitRoot(dir, { message: "snap" }); // writes ONLY under .canvas/roots/.../git
    // A canvas CONTENT write under `.canvas/` (an image): the narrowed watcher MUST see it — that's the whole
    // point of Gate-1 narrowing (so it gets shadow-versioned / re-rendered).
    fs.mkdirSync(path.join(dir, ".canvas", "images"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".canvas", "images", "shot.png"), "PNGDATA");
    // Control: a NON-.canvas write the watcher MUST see, proving the window is long enough so the "no
    // shadow-db events" assertion means absence, not just an early read.
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "export const b = 1;\n");
    await new Promise((res) => setTimeout(res, 600));
    assert.ok(events.includes("src/b.ts"), "watcher is alive (saw the control write)");
    assert.ok(
      events.some((p) => p === path.join(".canvas", "images", "shot.png")),
      `.canvas content is watched; got ${JSON.stringify(events)}`,
    );
    // The loop guard: the commit's writes all land under `.canvas/roots/.../git`, which stays excluded — so
    // zero events under the shadow object store, no commit→event→commit.
    assert.ok(
      !events.some((p) => p.split(path.sep).includes("roots") && p.includes(".canvas")),
      `no shadow-db events; got ${JSON.stringify(events)}`,
    );
  } finally {
    await watcher.close();
    rm(dir);
  }
});

test("steps 1+2 integration: the live watcher versions a dropped .canvas content file", async () => {
  const dir = tmpRepo();
  // The real live committer (watchRoot) through the narrowed Rule B: a drop under `.canvas/images` must be
  // SEEN (step 1 — narrowed watcher) and VERSIONED (step 2 — the generalized `.canvas`-minus-roots force-add).
  const commits = [];
  const handle = watchRoot(dir, { settleMs: 120, ignored: (p) => isInternalPath(p), message: "external: edit", onCommit: (r) => commits.push(r) });
  try {
    await new Promise((res) => setTimeout(res, 250)); // let the watcher arm
    fs.writeFileSync(path.join(dir, ".canvas", "images", "drop.png"), "DROPPED\n");
    await new Promise((res) => setTimeout(res, 450)); // settle + commit
    assert.ok(commits.some((r) => r.committed), "the drop triggered a settle commit");
    const tracked = await shadowTrackedPaths(dir);
    assert.ok(tracked.includes(".canvas/images/drop.png"), "watcher saw the drop AND the floor versioned it");
    assert.ok(!tracked.some((p) => p.startsWith(".canvas/roots/")), "the shadow db itself still isn't tracked");
  } finally {
    await handle.close();
    rm(dir);
  }
});
