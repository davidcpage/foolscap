// Standing jobs (R6, docs/wakeable-substrate-plan.md W6; docs/claude-tag-lessons.md R6). A STANDING JOB is a
// periodic, server-fired worker declared on a thread's durable marker: every `intervalMs` the server spawns a
// fresh session (the one W5 `serverSpawnWorker` primitive) seeded with the job's `instruction`, then the
// worker does its thing and winds down. It's the canvas-native answer to "a looping role needs a heartbeat":
// a `claude -p` session cannot self-schedule (canvas-session-self-wake), so the SERVER fires the timer and the
// durable RECORD — not the session — owns the schedule.
//
// Two norms ride the shape (R6): "skip days with nothing" — a firing that finds nothing to do posts nothing
// and winds down silently (the worker BRIEF instructs the silence; loop-until-dry alone isn't enough) — and
// "jobs survive their creator": the job lives on the thread's `.canvas/threads/` meta marker (beside seats /
// intents / pins), NOT on the session that created it, so it persists after that session exits AND across a
// server restart, and re-fires on the next tick.
//
// This module is the LEDGER (marker CRUD) + the PURE due-logic; the actual spawning stays in
// vite-fs-plugin.ts (standingJobsTick), which rides the loop heartbeat and calls serverSpawnWorker — the same
// separation auto-wake.js keeps (predicates here, ensureLiveSession there). FIRE-NEXT-DUE, never catch-up: a
// job overdue because the server was down fires ONCE on the next tick (its `lastFiredAt` re-bases to now),
// never replaying the fires missed while it slept — replaying them is exactly the wake-storm "skip days with
// nothing" forbids. SINGLE-FLIGHT: a still-running fire is not doubled (the tick skips a claimed surface).

import crypto from "node:crypto";
import { readThreadMeta, upsertThreadMeta } from "./thread-ledger.js";
import { seatSurfaceKey } from "./auto-wake.js";

// The interval FLOOR. The loop heartbeat evaluates jobs every LOOP_TICK_MS (~15s), so a sub-tick interval is
// meaningless; and a real standing job is minutes/hours/days, never seconds. Clamp up to this so a fat-fingered
// `intervalMs: 100` can't become a per-tick wake storm.
export const MIN_INTERVAL_MS = 60_000;

/** Normalize an interval to a finite ms value at or above the floor (bad input ⇒ the floor). */
export function normInterval(ms) {
  const n = Math.round(Number(ms));
  return Number.isFinite(n) ? Math.max(MIN_INTERVAL_MS, n) : MIN_INTERVAL_MS;
}

// ── The storage-agnostic CRUD core ────────────────────────────────────────────────────────────────
// The job RECORD and its lifecycle are the same whether the marker is a thread's meta (`.canvas/threads/`)
// or a DOC's marker (`.canvas/annotations/`; doc-jobs.js) — the doc-jobs drop-in W6 was structured for. So
// the CRUD operates over a STORE — `{ read(): jobs[], write(jobs) }` — and the thread/doc layers only supply
// that store. `read` returns the surface's jobs array (a non-array ⇒ treated as none); `write` persists it.

/** A surface's standing jobs (array), or [] if none / unreadable. Best-effort, never throws. */
export function readJobsIn(store) {
  const jobs = store.read();
  return Array.isArray(jobs) ? jobs : [];
}

/**
 * Create or update a standing job on a store (upsert by `id`). A fresh job mints a uuid, stamps `createdAt`,
 * and starts with `lastFiredAt: null` (its first fire is one interval after creation, not immediately — see
 * jobDue). Updating an existing job (pass its `id`) keeps `id`/`createdAt`/`by`/`lastFiredAt` and overlays the
 * given `role`/`intervalMs`/`instruction`. `role` null ⇒ a bare (seatless) worker; a named role fires INTO
 * that role's seat. Returns { job, jobs } (the whole updated list). Best-effort write.
 */
export function upsertJobIn(store, { id, role, intervalMs, instruction, by, ts } = {}) {
  const prior = readJobsIn(store);
  const now = ts ?? Date.now();
  const existing = id ? prior.find((j) => j.id === id) : null;
  const job = {
    id: existing?.id ?? (typeof id === "string" && id ? id : crypto.randomUUID()),
    role: role != null ? role : existing?.role ?? null,
    intervalMs: normInterval(intervalMs ?? existing?.intervalMs),
    instruction: instruction != null ? String(instruction) : existing?.instruction ?? "",
    by: existing?.by ?? by ?? "human",
    createdAt: existing?.createdAt ?? now,
    lastFiredAt: existing?.lastFiredAt ?? null,
  };
  const jobs = existing ? prior.map((j) => (j.id === job.id ? job : j)) : [...prior, job];
  store.write(jobs);
  return { job, jobs };
}

/** Remove a job by id. Returns { removed, jobs }. A missing id is a no-op (removed:false, no write). */
export function removeJobIn(store, id) {
  const prior = readJobsIn(store);
  const jobs = prior.filter((j) => j.id !== id);
  if (jobs.length === prior.length) return { removed: false, jobs: prior };
  store.write(jobs);
  return { removed: true, jobs };
}

/**
 * Stamp a job's `lastFiredAt` (called when a fire actually spawns/nudges a worker — a cap-skipped fire must
 * NOT stamp, so it retries next tick). Re-bases the schedule to `ts`, which is what makes a boot-time overdue
 * job fire exactly ONCE (fire-next-due) rather than replaying every missed interval. Returns updated jobs.
 */
export function stampFiredIn(store, id, ts) {
  const prior = readJobsIn(store);
  let hit = false;
  const jobs = prior.map((j) => {
    if (j.id !== id) return j;
    hit = true;
    return { ...j, lastFiredAt: ts };
  });
  if (hit) store.write(jobs);
  return jobs;
}

// ── Thread-marker layer ───────────────────────────────────────────────────────────────────────────
// A thread's jobs live on its `.canvas/threads/` meta marker, beside seats/intents/pins.

/** The job store backed by a thread's meta marker. */
function threadJobStore(repoPath, threadId) {
  return {
    read: () => readThreadMeta(repoPath, threadId)?.jobs,
    write: (jobs) => upsertThreadMeta(repoPath, threadId, { jobs }),
  };
}

/** A thread's standing jobs (array), or [] if none / no marker. Best-effort, never throws. */
export function readJobs(repoPath, threadId) {
  return readJobsIn(threadJobStore(repoPath, threadId));
}

/** Create or update a standing job on a thread (upsert by `id`). See upsertJobIn. */
export function upsertJob(repoPath, threadId, opts) {
  return upsertJobIn(threadJobStore(repoPath, threadId), opts);
}

/** Remove a thread job by id. Returns { removed, jobs }. See removeJobIn. */
export function removeJob(repoPath, threadId, id) {
  return removeJobIn(threadJobStore(repoPath, threadId), id);
}

/** Stamp a thread job's `lastFiredAt`. See stampFiredIn. */
export function stampFired(repoPath, threadId, id, ts) {
  return stampFiredIn(threadJobStore(repoPath, threadId), id, ts);
}

/**
 * PURE — is this job due to fire at `now`? Due once `intervalMs` has elapsed since its last fire (or, if it
 * has never fired, since it was created — so a fresh job's first fire is one interval out, not on creation).
 * A boot-time overdue job (server was down > interval) reads as due and fires ONCE; stampFired then re-bases
 * it, so there's no catch-up replay.
 */
export function jobDue(job, now) {
  if (!job || !job.intervalMs) return false;
  const since = job.lastFiredAt ?? job.createdAt ?? 0;
  return now - since >= job.intervalMs;
}

/** PURE — the due jobs among `jobs` at `now`. */
export function dueJobs(jobs, now) {
  return (jobs ?? []).filter((j) => jobDue(j, now));
}

/**
 * The single-flight claim key for a job's fire. A role-named job keys by its SEAT (seatSurfaceKey) so a
 * timer-fired worker and an activity-respawned worker (dormant-seat wake) don't BOTH grab the same seat — the
 * job and the reactive wake mutually exclude, exactly the intent. A bare (roleless) job keys by its own id so
 * two bare jobs on one thread run independently rather than blocking each other.
 */
export function jobClaimKey(threadId, job) {
  return job?.role ? seatSurfaceKey(threadId, job.role) : `job:${threadId}#${job?.id}`;
}

/**
 * PURE — is a wake ACTUALLY scheduled for session `sid`, given the thread markers `markers` (listThreads)?
 * A role-seat job fires INTO its role's seat every interval (standingJobsTick nudges or respawns the seat's
 * current occupant), so a live standing job schedules a wake for `sid` exactly when some marker carries a job
 * with a `role` whose seat is currently occupied by `sid`. A BARE (roleless) job always spawns a FRESH worker
 * — it targets no existing session — so it never schedules a wake for an already-live `sid`. This is the gate
 * behind the calm "scheduled" band: the static `loops` role flag means only "this is a looping-TYPE role", not
 * that any timer will fire (jobs are human-gated and often absent), so an idle looping session must consult
 * THIS before claiming it's asleep on a heartbeat rather than genuinely "waiting".
 */
export function sessionHasScheduledWake(markers, sid) {
  if (!sid) return false;
  for (const m of markers ?? []) {
    const jobs = Array.isArray(m?.jobs) ? m.jobs : [];
    const seats = m?.seats ?? {};
    for (const job of jobs) {
      if (job?.role && seats[job.role]?.sid === sid) return true;
    }
  }
  return false;
}

/**
 * PURE — the WAKE-LIVE-ELSE-RESPAWN decision for a role-seat job's fire, given the current liveness of the
 * seat's occupant. This is the efficiency norm (W6 seq 104) factored out of standingJobsTick so it can be
 * unit-tested (a "mocked tick") and shared: a job whose seat is occupied by a LIVE, IDLE session is served by
 * NUDGING it (cheap — assembled context intact); a MID-TURN occupant is skipped WITHOUT stamping (retry next
 * tick the moment it's idle, never talk over a working session); a DORMANT/absent occupant pays a fresh
 * respawn seeded from the durable record. `occupantStatus` is the LiveSession status of the seat's current
 * sid — `"idle"` / `"running"` (mid-turn) / `"exited"`, or `null` when the seat has no live occupant at all.
 * Returns `"nudge"` | `"skip"` (mid-turn, no stamp) | `"respawn"`.
 */
export function planRoleJobFire(occupantStatus) {
  if (occupantStatus === "idle") return "nudge";
  if (occupantStatus === "running") return "skip";
  return "respawn"; // "exited" or null (no live occupant) → reconstitute fresh
}
