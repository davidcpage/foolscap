// Worktree workflow (worktree-based multi-agent workflow, thread node:thread:e1784729):
// give a server-spawned session its OWN git worktree — an isolated checkout on its own branch — instead of
// the shared board root, so concurrent agents stop clobbering each other's files, tests, and commits.
// Stage 1 = the spawn primitive (ensureWorktree / removeWorktree, keyed by work item). Stage 3 =
// merge-on-green (mergeWorktree, at the bottom): green-gate the branch in its worktree, then merge into main
// and tear down in one act.
//
// KEYED BY WORK-ITEM, NOT SESSION. Sessions are ephemeral (fresh sid every respawn — see the
// never-resume-sessions norm), so keying a worktree by sid would leak it or lose it on respawn. Instead the
// worktree belongs to the WORK ITEM and whatever session is currently doing that work ATTACHES to it: a
// respawn re-attaches to the same worktree+branch, teardown fires on work-item completion, not on mere
// session exit. The durable record lives on the thread's `.canvas/threads/<id>.meta.json` marker (a
// `worktrees` map beside `seats`/`intents`/`pins`), so it survives the occupant's exit AND a server restart.
//
// Worktrees live under the board's `.canvas/worktrees/` home, which is git-excluded (.gitignore covers
// `.canvas/`), so an agent's worktree is invisible to the main repo's `git status` and never becomes noise
// in the canonical checkout. `node_modules` is gitignored too, so a fresh worktree checkout has none — we
// SYMLINK the canonical package node_modules in (single machine, native deps stay put; never copy).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readThreadMeta, upsertThreadMeta } from "./thread-ledger.js";

// Packages whose canonical node_modules get symlinked into a worktree so in-worktree `npm test`/`typecheck`
// resolve deps without a copy. The app imports the sibling engines from ../core/src etc. (no build step), so
// each package that has its own node_modules needs the link; @tldraw/state resolves transitively from core.
const SYMLINK_PACKAGES = ["core", "interaction", "app"];

/** The directory holding this board's agent worktrees, under its `.canvas/` home. */
export function worktreesDir(repoPath) {
  return path.join(repoPath, ".canvas", "worktrees");
}

/**
 * The DURABLE work-item key a worktree is keyed by. Precedence: an explicit override, else the role SEAT
 * (role-spawned workers of the same role re-fill the same seat, so they share a worktree), else the thread
 * id (a bare worker's work item IS the thread). Returns null when nothing durable identifies the work item
 * (a standalone --card spawn with no thread and no explicit key) — the caller rejects a worktree spawn then.
 */
export function workItemKey({ threadId = null, roleId = null, explicitKey = null } = {}) {
  if (explicitKey) return String(explicitKey);
  if (roleId) return `role:${roleId}`;
  if (threadId) return String(threadId);
  return null;
}

// A filesystem- and git-branch-safe slug of a work-item key (thread ids carry colons; roles may carry
// spaces). Collapses runs of unsafe chars to a single dash and bounds the length.
function keySlug(key) {
  const s = String(key)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || "wt";
}

// The branch a work item's worktree checks out. Namespaced so it's obviously agent-owned and never collides
// with a human branch.
function branchForKey(key) {
  return `agent/${keySlug(key)}`;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function gitOk(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Is `p` a live git worktree of the canonical repo right now? `git worktree list` is authoritative (the
// meta record can go stale if someone `git worktree remove`d by hand).
function worktreeExists(repoPath, wtPath) {
  let out;
  try {
    out = git(repoPath, ["worktree", "list", "--porcelain"]);
  } catch {
    return false;
  }
  const want = realpath(wtPath);
  return out.split("\n").some((l) => l.startsWith("worktree ") && realpath(l.slice(9)) === want);
}
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Does the local branch `branch` already exist? (A prior worktree removed without deleting its branch, or a
// re-attach after the worktree dir was cleaned.)
function branchExists(repoPath, branch) {
  return gitOk(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

// The symlinked node_modules would otherwise show as UNTRACKED in the worktree's `git status`: the repo's
// `.gitignore` ignores `node_modules/` (trailing slash → directories only), but git treats a symlink as a
// blob, not a directory, so the pattern misses it. That would pollute an agent's `git status`/`git add -A`
// (it could commit the symlink) and trip the teardown dirty-guard. Fix it at the source, the same way
// `.canvas/` is excluded: append a bare `node_modules` pattern (matches files/dirs/symlinks at any depth) to
// the repo's `.git/info/exclude` — shared across all worktrees + the main checkout, idempotent, and always
// semantically correct (node_modules is universally ignored). The main checkout's real dirs stay ignored too.
function ensureNodeModulesExcluded(canonicalPath) {
  let excludePath;
  try {
    const rel = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: canonicalPath, encoding: "utf8" }).trim();
    excludePath = path.isAbsolute(rel) ? rel : path.join(canonicalPath, rel);
  } catch {
    return; // not a git repo — ensureWorktree will fail loudly on its own
  }
  let current = "";
  try {
    current = fs.readFileSync(excludePath, "utf8");
  } catch {
    /* no exclude file yet — we create it below */
  }
  if (current.split("\n").some((l) => l.trim() === "node_modules")) return; // already there
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, (current && !current.endsWith("\n") ? "\n" : "") + "node_modules\n");
  } catch (err) {
    console.warn(`[worktree] could not add node_modules to ${excludePath}: ${String(err)}`);
  }
}

// Symlink each canonical package's node_modules into the worktree at the same relative path, so in-worktree
// `npm test` / `tsc` resolve deps against the ONE installed copy (native deps are code-signed per host —
// copying would break rollup et al.). Idempotent: skips a package with no canonical node_modules and one
// whose link/dir already exists. Best-effort per package; a failure is logged, not fatal (the worktree is
// still usable, tests just won't resolve until the link is fixed).
export function linkNodeModules(canonicalPath, wtPath) {
  const linked = [];
  for (const pkg of SYMLINK_PACKAGES) {
    const src = path.join(canonicalPath, pkg, "node_modules");
    const destPkg = path.join(wtPath, pkg);
    const dest = path.join(destPkg, "node_modules");
    if (!fs.existsSync(src)) continue; // package has no deps installed canonically — nothing to link
    if (!fs.existsSync(destPkg)) continue; // worktree doesn't have this package dir (shouldn't happen)
    if (fs.existsSync(dest) || isSymlink(dest)) continue; // already present (a copy, or our link)
    try {
      fs.symlinkSync(src, dest, "dir");
      linked.push(pkg);
    } catch (err) {
      console.warn(`[worktree] node_modules symlink failed for ${pkg}: ${String(err)}`);
    }
  }
  return linked;
}
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Ensure the work item's worktree exists and return where a session should run.
 *
 * RE-ATTACH is the whole point of keying by work item: if the record already names a live worktree, reuse
 * its path+branch (a respawned session lands back in the same tree, mid-flight work intact) rather than
 * cutting a fresh one. Only when there's no live worktree do we `git worktree add` — on a fresh branch off
 * `base` (default HEAD), or re-checking-out the branch if it survived a prior teardown.
 *
 * Returns { path, branch, base, reused, linked }. Throws only on a real git failure (not a repo, add
 * refused) — the caller surfaces that as a spawn error.
 */
export function ensureWorktree(repoPath, threadId, key, base = null) {
  const meta = threadId ? readThreadMeta(repoPath, threadId) : null;
  const record = meta?.worktrees?.[key];
  // Re-attach: the record names a worktree git still knows about → reuse verbatim.
  if (record?.path && worktreeExists(repoPath, record.path)) {
    const linked = linkNodeModules(repoPath, record.path); // heal a missing link (e.g. node_modules reinstalled)
    return { ...record, reused: true, linked };
  }
  const branch = record?.branch ?? branchForKey(key);
  const wtPath = record?.path ?? path.join(worktreesDir(repoPath), keySlug(key));
  ensureNodeModulesExcluded(repoPath); // keep the symlinked node_modules out of the worktree's git status
  fs.mkdirSync(worktreesDir(repoPath), { recursive: true });
  // A stale directory (worktree pruned but dir left behind) blocks `git worktree add` — clear an empty one.
  if (fs.existsSync(wtPath)) {
    try {
      fs.rmdirSync(wtPath); // only succeeds if empty — never blows away real content
    } catch {
      // non-empty: let git worktree add fail loudly rather than delete unknown content
    }
  }
  const baseRef = base || "HEAD";
  if (branchExists(repoPath, branch)) {
    // The branch outlived a prior teardown — check it back out (don't -b, that'd fail "already exists").
    git(repoPath, ["worktree", "add", wtPath, branch]);
  } else {
    git(repoPath, ["worktree", "add", "-b", branch, wtPath, baseRef]);
  }
  const linked = linkNodeModules(repoPath, wtPath);
  const created = { path: realpath(wtPath), branch, base: baseRef, key, createdAt: Date.now() };
  if (threadId) recordWorktree(repoPath, threadId, key, created);
  return { ...created, reused: false, linked };
}

/** Persist / update a work item's worktree record on the thread marker (beside seats/intents/pins). */
export function recordWorktree(repoPath, threadId, key, record) {
  const prior = readThreadMeta(repoPath, threadId)?.worktrees ?? {};
  upsertThreadMeta(repoPath, threadId, { worktrees: { ...prior, [key]: record } });
}

/** The worktrees recorded on a thread (work-item key → record). Empty object if none / no thread. */
export function listWorktrees(repoPath, threadId) {
  return (threadId ? readThreadMeta(repoPath, threadId)?.worktrees : null) ?? {};
}

// Is the worktree's working tree dirty (uncommitted changes)?
function isDirty(wtPath) {
  try {
    return git(wtPath, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    return false; // can't tell → don't claim dirty (the unmerged check is the other guard)
  }
}
// Does `branch` carry commits not yet reachable from the canonical HEAD (unmerged work that removal would
// strand)? merge-base --is-ancestor exits 0 when the branch tip is already in HEAD's history.
function isUnmerged(repoPath, branch) {
  if (!branchExists(repoPath, branch)) return false;
  return !gitOk(repoPath, ["merge-base", "--is-ancestor", branch, "HEAD"]);
}

/**
 * Tear down a work item's worktree — the EXPLICIT act fired on WORK-ITEM completion (a Coordinator merged
 * the branch and is done with it), NOT on mere session exit. GUARDED: if the tree is dirty or the branch is
 * unmerged, it SKIPS and warns (returns removed:false with a reason) rather than destroying unreviewed work
 * — unless `force`. On success, removes the worktree, deletes the (now-merged) branch, and drops the record.
 *
 * Returns { removed, reason?, dirty?, unmerged?, path?, branch? }.
 */
export function removeWorktree(repoPath, threadId, key, { force = false } = {}) {
  const record = listWorktrees(repoPath, threadId)[key];
  if (!record?.path) return { removed: false, reason: "no worktree recorded for this work item" };
  const { path: wtPath, branch } = record;
  if (!worktreeExists(repoPath, wtPath)) {
    // Already gone on disk (removed by hand / pruned) — just drop the stale record so it doesn't linger.
    dropRecord(repoPath, threadId, key);
    return { removed: true, path: wtPath, branch, reason: "worktree already absent; cleared stale record" };
  }
  const dirty = isDirty(wtPath);
  const unmerged = isUnmerged(repoPath, branch);
  if ((dirty || unmerged) && !force) {
    return {
      removed: false,
      dirty,
      unmerged,
      path: wtPath,
      branch,
      reason: `skipped: ${dirty ? "working tree is dirty" : ""}${dirty && unmerged ? " and " : ""}${
        unmerged ? "branch has unmerged commits" : ""
      } — commit/merge first, or pass force to discard`,
    };
  }
  git(repoPath, ["worktree", "remove", ...(dirty || force ? ["--force"] : []), wtPath]);
  // Delete the branch too. -d refuses an unmerged branch (safe); force → -D. Best-effort: a failure here
  // leaves an orphan branch, not a broken worktree, and never blocks the teardown.
  gitOk(repoPath, ["branch", force ? "-D" : "-d", branch]);
  dropRecord(repoPath, threadId, key);
  return { removed: true, path: wtPath, branch, dirty, unmerged, forced: force };
}

function dropRecord(repoPath, threadId, key) {
  const prior = readThreadMeta(repoPath, threadId)?.worktrees ?? {};
  const { [key]: _gone, ...rest } = prior;
  upsertThreadMeta(repoPath, threadId, { worktrees: rest });
}

// ── merge-on-green (Stage 3) ────────────────────────────────────────────────────────────────────────

// The canonical checkout's current branch (the merge lands HERE, so it must equal the merge target).
function currentBranch(repoPath) {
  try {
    return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return null;
  }
}

// Which packages a branch's changes touch, among the buildable ones — the green gate runs each. `app` is
// ALWAYS included (it's the integration surface + the primary dev package, and it imports the sibling
// engines); `core`/`interaction` join only when the branch diff touched their dirs. Ordered deps-first so a
// core break surfaces before the app run that depends on it.
function gatePackages(repoPath, base, branch) {
  const touched = new Set(["app"]);
  let out = "";
  try {
    out = git(repoPath, ["diff", "--name-only", `${base}...${branch}`]);
  } catch {
    return [...touched]; // can't diff (e.g. no merge-base) → fall back to the app baseline
  }
  for (const line of out.split("\n")) {
    const top = line.split("/")[0];
    if (top === "core" || top === "interaction") touched.add(top);
  }
  return ["core", "interaction", "app"].filter((p) => touched.has(p));
}

const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s);

// Run the green gate for a set of packages IN THE WORKTREE (the branch checkout): `npm test` then
// `npm run typecheck` per package, against the symlinked node_modules. First non-zero step aborts the whole
// gate and is reported. This is the real gate the docs/CLI promise — it exercises the branch's own scripts.
function runGate(wtPath, pkgs) {
  for (const pkg of pkgs) {
    const cwd = path.join(wtPath, pkg);
    for (const step of [["test"], ["run", "typecheck"]]) {
      try {
        execFileSync("npm", step, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        const output = tail(String(err.stdout || "") + String(err.stderr || ""), 4000);
        return { ok: false, pkg, step: `npm ${step.join(" ")}`, code: err.status ?? 1, output };
      }
    }
  }
  return { ok: true };
}

/**
 * Merge a work item's worktree branch into `base` and tear the worktree down — the one-command merge-on-green
 * a builder fires when its work is complete. The explicit act (like teardown), NOT auto-fired on /done.
 *
 * Order: resolve record → PRECONDITIONS (refuse a dirty worktree — a merge only carries COMMITTED work; refuse
 * a dirty or wrong-branch canonical checkout — never merge into an unclean/unexpected tree) → GREEN GATE (the
 * touched packages' `npm test` + `npm run typecheck` in the worktree; skipped by `noVerify`; any non-zero
 * aborts the whole op) → MERGE (`git merge --no-ff` into `base` from the canonical checkout; a conflict is
 * `git merge --abort`ed so the canonical index is never left conflicted) → TEARDOWN (reuse removeWorktree —
 * its unmerged guard is now a no-op since the branch is in HEAD; `force` forwards to it).
 *
 * Returns { merged, branch, base?, testsRun, testsPassed, removed?, teardown?, gate?, conflict?, dirty?, reason? }.
 * Never throws for an expected refusal/conflict — those come back as merged:false with a reason.
 */
export function mergeWorktree(repoPath, threadId, key, { base = "main", noVerify = false, force = false } = {}) {
  const record = listWorktrees(repoPath, threadId)[key];
  if (!record?.path) return { merged: false, testsRun: [], testsPassed: null, reason: "no worktree recorded for this work item" };
  const { path: wtPath, branch } = record;
  if (!worktreeExists(repoPath, wtPath))
    return { merged: false, branch, testsRun: [], testsPassed: null, reason: "worktree is gone on disk — nothing to merge (run teardown to clear the stale record)" };

  // PRECONDITIONS — never merge from/into an unclean or unexpected state. Clear, actionable messages.
  if (isDirty(wtPath))
    return { merged: false, branch, dirty: true, testsRun: [], testsPassed: null, reason: "worktree has uncommitted changes — commit them in the worktree first (a merge only carries committed work)" };
  const canon = currentBranch(repoPath);
  if (canon !== base)
    return { merged: false, branch, testsRun: [], testsPassed: null, reason: `canonical checkout is on "${canon}", not the merge target "${base}" — check out ${base} there first` };
  if (isDirty(repoPath))
    return { merged: false, branch, testsRun: [], testsPassed: null, reason: `canonical checkout (${base}) has uncommitted changes — commit or stash them before merging` };

  // GREEN GATE — the touched packages' tests + typecheck, run in the worktree (skip with noVerify).
  const gatePkgs = gatePackages(repoPath, base, branch);
  let testsRun = [];
  if (!noVerify) {
    linkNodeModules(repoPath, wtPath); // heal any missing dep link before the run resolves imports
    const gate = runGate(wtPath, gatePkgs);
    testsRun = gatePkgs;
    if (!gate.ok)
      return { merged: false, branch, testsRun, testsPassed: false, gate, reason: `green gate failed: ${gate.pkg} \`${gate.step}\` exited ${gate.code} — fix in the worktree and re-merge (or --no-verify to skip)` };
  }

  // MERGE — --no-ff for a legible merge commit; a conflict is aborted so the canonical tree is never left
  // with a conflicted index (the builder rebases/resolves and re-merges).
  try {
    git(repoPath, ["merge", "--no-ff", "-m", `Merge ${branch} into ${base} (worktree merge-on-green)`, branch]);
  } catch (err) {
    gitOk(repoPath, ["merge", "--abort"]);
    const output = tail(String(err.stdout || "") + String(err.stderr || ""), 2000);
    return { merged: false, branch, base, testsRun, testsPassed: noVerify ? null : true, conflict: true, output, reason: `merge into ${base} conflicted — aborted (canonical tree left clean); resolve on the branch and re-merge` };
  }

  // TEARDOWN — the branch is merged now, so removeWorktree's dirty/unmerged guard passes cleanly.
  const teardown = removeWorktree(repoPath, threadId, key, { force });
  return { merged: true, branch, base, testsRun, testsPassed: noVerify ? null : true, removed: teardown.removed, teardown };
}
