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
// This module is the LEDGER (marker CRUD) + the PURE due-logic; the actual firing stays in vite-fs-plugin.ts
// (standingJobsTick), which rides the loop heartbeat. TIMERS NUDGE, NEVER SPAWN (human-locked, thread
// mrcauz0v-f): a fire may only NUDGE an already-live seat occupant, never create a session — session creation
// is reserved for explicit events (human spawn / reactive @-mention / ask). This structurally removes the
// endless-Coordinator runaway; see planRoleJobFire. FIRE-NEXT-DUE, never catch-up: a
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
  return jobDueWithInterval(job, now, job?.intervalMs);
}

/**
 * PURE — like jobDue, but against an EXPLICIT `intervalMs` rather than the job's own. The standing-job tick
 * uses this to apply the intent-keyed heartbeat backoff (coordinator-heartbeat.heartbeatEffectiveInterval):
 * a Coordinator parked on the human fires on a slower effective interval than its stored `job.intervalMs`,
 * derived per-tick from live intent so nothing about the job record changes. `intervalMs` falsy ⇒ not due.
 */
export function jobDueWithInterval(job, now, intervalMs) {
  if (!job || !intervalMs) return false;
  const since = job.lastFiredAt ?? job.createdAt ?? 0;
  return now - since >= intervalMs;
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
 * A role-seat job fires INTO its role's seat every interval (standingJobsTick NUDGES the seat's live occupant
 * — timers nudge, never spawn: a dormant seat is left for a real event to revive, per 4f5a3ad), so a live
 * standing job schedules a wake for `sid` exactly when some marker carries a job
 * with a `role` whose seat is currently occupied by `sid`. A BARE (roleless) job is a no-op on fire (no seat
 * to nudge, and timers don't spawn) — it targets no session — so it never schedules a wake for any `sid`. This is the gate
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
 * PURE — the fire decision for a role-seat job, given the current liveness of the seat's occupant AND the
 * seat's declared work-intent. Factored out of standingJobsTick so it can be unit-tested (a "mocked tick").
 *
 * TIMERS NUDGE, NEVER SPAWN (human-locked invariant, thread mrcauz0v-f). A standing job may only NUDGE an
 * already-live seat occupant; it must NEVER create a session. There is deliberately NO "respawn" outcome:
 * session creation is reserved for explicit EVENTS (a human spawn, a reactive @-mention / ask), never a
 * periodic timer — which structurally removes the endless-Coordinator runaway (a dormant seat the timer used
 * to respawn every interval, forever, on a thread with no live work). A wound-down Coordinator is instead kept
 * PARKED by the reaper (reap-only-on-done, auto-wake.reapKeepAliveMs) so this nudge has a live target; if it
 * has truly exited it simply waits for a real event to revive it.
 *
 * The decision:
 *   - seat declared `done` (stood down) → `"none"`: don't nudge it back into a sweep it declared finished
 *     (and — reap-only-on-done — let the reaper reclaim the idle done session rather than the nudge keeping it
 *     alive forever). Checked FIRST so a stood-down-but-not-yet-exited occupant is left alone.
 *   - live + `idle` → `"nudge"`: the one action a timer may take (cheap — assembled context intact).
 *   - live + `running` (mid-turn) → `"skip"`: don't interrupt; retry next tick (caller does NOT stamp).
 *   - dormant / absent / `exited` → `"none"`: nothing to do — timers never spawn.
 *
 * `occupantStatus` is the LiveSession status of the seat's current sid — `"idle"` / `"running"` / `"exited"`,
 * or `null` when the seat has no live occupant. `seatIntent` is the seat's declared work-intent
 * (`meta.intents[role].intent`), or null/undefined when none. Returns
 * `"nudge"` | `"skip"` (mid-turn, no stamp) | `"none"` (nothing to do, no stamp — dormant or stood down).
 */
export function planRoleJobFire(occupantStatus, seatIntent) {
  if (seatIntent === "done") return "none"; // stood down → don't nudge; the reaper reclaims the idle session
  if (occupantStatus === "idle") return "nudge";
  if (occupantStatus === "running") return "skip";
  return "none"; // dormant / absent / exited → TIMERS NEVER SPAWN, so there is nothing to do
}
