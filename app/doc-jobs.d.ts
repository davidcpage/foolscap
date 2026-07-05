// Types for doc-jobs.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import the
// doc standing-job ledger without allowJs. Keep in sync with the exports in doc-jobs.js. A doc job IS a
// StandingJob (same record shape as a thread job — the W6 drop-in); only the marker home differs.

import type { StandingJob, UpsertJobOpts } from "./standing-jobs.js";

export function readDocJobs(repoPath: string, filePath: string): StandingJob[];
export function upsertDocJob(
  repoPath: string,
  filePath: string,
  opts: UpsertJobOpts,
): { job: StandingJob; jobs: StandingJob[] };
export function removeDocJob(repoPath: string, filePath: string, id: string): { removed: boolean; jobs: StandingJob[] };
export function stampDocFired(repoPath: string, filePath: string, id: string, ts: number): StandingJob[];
export function docJobClaimKey(filePath: string): string;
export function listDocsWithJobs(repoPath: string): string[];
