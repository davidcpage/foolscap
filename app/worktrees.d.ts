// Types for worktrees.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import
// the worktree spawn primitive without allowJs. Keep in sync with the exports in worktrees.js.

// A work item's durable worktree record, stored on the thread marker under `worktrees[key]`.
export interface WorktreeRecord {
  path: string; // absolute path of the worktree checkout (under <board>/.canvas/worktrees/)
  branch: string; // the agent branch it checks out (agent/<keyslug>)
  base: string; // the ref the branch was cut from (default HEAD)
  key: string; // the work-item key this worktree belongs to
  createdAt: number;
}

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
  forced?: boolean;
  path?: string;
  branch?: string;
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
  opts?: { force?: boolean },
): RemoveResult;
export function linkNodeModules(canonicalPath: string, wtPath: string): string[];
