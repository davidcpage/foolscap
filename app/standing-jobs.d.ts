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

// A storage-agnostic job STORE — the marker read/write the doc/thread layers supply, so the identical CRUD
// serves both a thread's meta marker and a doc's marker (doc-jobs.js).
export interface JobStore {
  read(): StandingJob[] | undefined | null;
  write(jobs: StandingJob[]): void;
}
export type UpsertJobOpts = {
  id?: string;
  role?: string | null;
  intervalMs?: unknown;
  instruction?: string;
  by?: string;
  ts?: number;
};

// The shared CRUD core (operates over any JobStore).
export function readJobsIn(store: JobStore): StandingJob[];
export function upsertJobIn(store: JobStore, opts?: UpsertJobOpts): { job: StandingJob; jobs: StandingJob[] };
export function removeJobIn(store: JobStore, id: string): { removed: boolean; jobs: StandingJob[] };
export function stampFiredIn(store: JobStore, id: string, ts: number): StandingJob[];

export function readJobs(repoPath: string, threadId: string): StandingJob[];
export function upsertJob(
  repoPath: string,
  threadId: string,
  opts: UpsertJobOpts,
): { job: StandingJob; jobs: StandingJob[] };
export function removeJob(repoPath: string, threadId: string, id: string): { removed: boolean; jobs: StandingJob[] };
export function stampFired(repoPath: string, threadId: string, id: string, ts: number): StandingJob[];

export function jobDue(job: StandingJob | null | undefined, now: number): boolean;
export function jobDueWithInterval(
  job: StandingJob | null | undefined,
  now: number,
  intervalMs: number | null | undefined,
): boolean;
export function dueJobs(jobs: StandingJob[] | null | undefined, now: number): StandingJob[];
export function jobClaimKey(threadId: string, job: StandingJob): string;
export function planRoleJobFire(
  occupantStatus: "idle" | "running" | "exited" | null | undefined,
): "nudge" | "skip" | "respawn";

// Is a wake ACTUALLY scheduled for `sid`? True iff some thread marker (the listThreads meta list) carries a
// role-job whose seat is currently occupied by `sid`. Loose marker shape — only jobs[].role + seats[].sid matter.
export function sessionHasScheduledWake(
  markers: ReadonlyArray<{ jobs?: StandingJob[]; seats?: Record<string, { sid?: string } | undefined> }> | null | undefined,
  sid: string,
): boolean;
