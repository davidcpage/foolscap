// Types for shadow-git.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import
// the committer without allowJs. Keep in sync with the exports in shadow-git.js.

export const EXTERNAL_AUTHOR: string;

export interface CommitOpts {
  rootId?: string;
  gitRoot?: string;
  message?: string;
  author?: string;
  /** Stage ONLY these paths (relative to workTree), attributed per-tool-call. Mutually exclusive with exclude. */
  paths?: string[];
  /** Floor mode: `add -A` then unstage these paths so a claimed path stays dirty for its attributed commit. */
  exclude?: string[];
}
export interface CommitResult {
  committed: boolean;
  sha?: string;
}
export interface RootOpts {
  rootId?: string;
  gitRoot?: string;
}
export interface WatchOpts extends CommitOpts {
  settleMs?: number;
  ignored?: (p: string) => boolean;
  onCommit?: (r: CommitResult) => void;
  onError?: (e: unknown) => void;
}
export interface RootWatcher {
  /** A live tool_use claims its target path(s) (rel to workTree): the `external` floor skips them. */
  claim(paths: string[]): void;
  /** Drop a claim without committing (an abandoned/errored edit). */
  release(paths: string[]): void;
  /** Commit ONLY these paths, attributed to a session (per-tool-call). Releases the claim. */
  commitClaimed(paths: string[], over?: { author?: string; message?: string }): Promise<CommitResult>;
  close(): Promise<void>;
}

export function shadowGitDir(gitRoot: string, rootId?: string): string;
export function commitRoot(workTree: string, opts?: CommitOpts): Promise<CommitResult>;
export function watchRoot(workTree: string, opts?: WatchOpts): RootWatcher;
export function shadowTrackedPaths(workTree: string, opts?: RootOpts): Promise<string[]>;
export function shadowCommitCount(workTree: string, opts?: RootOpts): Promise<number>;
