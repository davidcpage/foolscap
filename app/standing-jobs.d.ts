// Types for standing-jobs.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the R6/W6 standing-job ledger without allowJs. Keep in sync with the exports in standing-jobs.js.

export interface StandingJob {
  id: string;
  role: string | null; // a named role fires INTO that role's seat; null ⇒ a bare thread worker
  intervalMs: number; // clamped up to MIN_INTERVAL_MS
  instruction: string;
  by: string;
  createdAt: number;
  lastFiredAt: number | null; // null until the first fire; re-based on each fire (fire-next-due)
}

export const MIN_INTERVAL_MS: number;
export function normInterval(ms: unknown): number;

export function readJobs(repoPath: string, threadId: string): StandingJob[];
export function upsertJob(
  repoPath: string,
  threadId: string,
  opts: { id?: string; role?: string | null; intervalMs?: unknown; instruction?: string; by?: string; ts?: number },
): { job: StandingJob; jobs: StandingJob[] };
export function removeJob(repoPath: string, threadId: string, id: string): { removed: boolean; jobs: StandingJob[] };
export function stampFired(repoPath: string, threadId: string, id: string, ts: number): StandingJob[];

export function jobDue(job: StandingJob | null | undefined, now: number): boolean;
export function dueJobs(jobs: StandingJob[] | null | undefined, now: number): StandingJob[];
export function jobClaimKey(threadId: string, job: StandingJob): string;
