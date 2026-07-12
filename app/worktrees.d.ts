// Types for worktrees.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import
// the worktree spawn primitive without allowJs. Keep in sync with the exports in worktrees.js.

// A work item's durable worktree record, stored on the thread marker under `worktrees[key]`.
export interface WorktreeRecord {
  path: string; // absolute path of the worktree checkout (under <board>/.canvas/worktrees/)
  branch: string; // the agent branch it checks out (agent/<keyslug>)
  base: string; // the ref the branch was cut from (default HEAD)
  key: string; // the work-item key this worktree belongs to
  createdAt: number;
  // BUG-8: set when a teardown was DEFERRED because a live session occupied the tree (its cwd). The
  // board-wide reapPendingWorktreesTick removes the tree once no live session occupies it any more.
  pendingReap?: boolean;
}

// A lookup the caller builds from the live-session registry: which LIVE session (if any) currently runs in
// `wtPath` (its process cwd)? Returns the occupant's sid, or null when free. Passed into teardown so it never
// yanks a running session's cwd (BUG-8 occupancy guard) and can name the occupant in the result.
export type OccupancyCheck = (wtPath: string) => string | null;

// What ensureWorktree returns: the record plus whether it was RE-ATTACHED (reused) and which package
// node_modules got symlinked this call.
export interface EnsuredWorktree extends WorktreeRecord {
  reused: boolean;
  linked: string[];
}

export interface RemoveResult {
  removed: boolean;
  reason?: string;
  dirty?: boolean;
  unmerged?: boolean;
  deferred?: boolean; // BUG-8: removal DEFERRED (not done) because a live session occupied the tree
  occupied?: boolean; // BUG-8: a live session was cwd-ed in the tree at teardown time
  occupant?: string; // BUG-8: the occupying session's sid (set when deferred)
  forced?: boolean;
  path?: string;
  branch?: string;
}

// A failing green-gate step (which package + `npm ...` step exited non-zero, with a bounded output tail).
export interface GateFailure {
  ok: false;
  pkg: string;
  step: string;
  code: number;
  output: string;
}

export interface MergeResult {
  merged: boolean;
  branch?: string;
  base?: string;
  testsRun: string[]; // packages the gate ran (empty when skipped)
  testsPassed: boolean | null; // true green, false red, null when skipped (noVerify)
  removed?: boolean; // teardown outcome on a merged worktree (false when deferred)
  deferred?: boolean; // BUG-8: merge landed but teardown deferred (a live session occupied the tree)
  occupied?: boolean; // BUG-8: a live session occupied the tree at teardown time
  occupant?: string; // BUG-8: the occupying session's sid (set when deferred)
  teardown?: RemoveResult;
  gate?: GateFailure; // present when the gate failed
  conflict?: boolean; // present (true) when the merge conflicted and was aborted
  dirty?: boolean; // present (true) when refused for a dirty worktree
  output?: string; // conflict output tail
  reason?: string;
}

export function worktreesDir(repoPath: string): string;
export function workItemKey(opts?: {
  threadId?: string | null;
  roleId?: string | null;
  explicitKey?: string | null;
}): string | null;
export function ensureWorktree(
  repoPath: string,
  threadId: string | null,
  key: string,
  base?: string | null,
): EnsuredWorktree;
export function recordWorktree(repoPath: string, threadId: string, key: string, record: WorktreeRecord): void;
export function listWorktrees(repoPath: string, threadId: string | null): Record<string, WorktreeRecord>;
export function removeWorktree(
  repoPath: string,
  threadId: string,
  key: string,
  opts?: { force?: boolean; isOccupied?: OccupancyCheck | null },
): RemoveResult;
export function mergeWorktree(
  repoPath: string,
  threadId: string,
  key: string,
  opts?: { base?: string; noVerify?: boolean; force?: boolean; isOccupied?: OccupancyCheck | null },
): MergeResult;
export function linkNodeModules(canonicalPath: string, wtPath: string): string[];
// Best-effort realpath (returns the input on failure). Exported so the reap sweep can compare a live
// session's cwd against a worktree record's path with the same canonicalization the worktree helpers use.
export function realpath(p: string): string;

// The isolation-onboarding block appended to a --worktree worker's system prompt: tells it its cwd is an
// isolated checkout and that ALL edits must stay there (the main checkout must stay clean). Pure — branch
// is passed in (best-effort), so it renders without git.
export function worktreeOnboarding(opts: { cwd: string; repoPath: string; branch?: string }): string;

// One parsed entry from `git worktree list --porcelain`. `branch` is "" when git prints neither a `branch`
// nor a `detached` line; `head` is the short 7-char sha (or "" if absent).
export interface WorktreePorcelainEntry {
  path: string;
  branch: string;
  head: string;
}
export function parseWorktreePorcelain(out: string): WorktreePorcelainEntry[];
