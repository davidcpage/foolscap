// The Coordinator heartbeat, expressed as a STANDING JOB (wakeable-substrate-plan.md — wake-live loop-migration).
//
// A looping role (the Coordinator, `agent-roles.md`) needs to sweep the board for STALLS — nothing emits an
// event when an agent goes silent, so a purely reactive session never wakes to notice. Historically this was
// a BESPOKE per-session heartbeat baked into `loopTick` (a server timer that nudged every already-live looping
// session on an adaptive cadence). That path could only ever nudge a session that was ALREADY LIVE — it could
// not stand a DORMANT Coordinator back up. The standing-job machinery (R6/W6) does strictly more: its
// WAKE-LIVE-ELSE-RESPAWN fire (standingJobsTick → the one serverSpawnWorker primitive) nudges a live+idle seat
// AND reconstitutes a dormant one. So the Coordinator heartbeat is now just a standing job on the
// Coordinator's thread, fired by the same tick as every other job — one driver, no bespoke fork.
//
// This module is the SINGLE SOURCE OF TRUTH for what that job looks like: the role it fires into, its default
// cadence, and the sweep instruction. The CLI enable verb (`scripts/canvas job coordinator <thread>`) and any
// programmatic creator both build the job from `coordinatorHeartbeatJobSpec()` so the instruction never drifts.
//
// ENABLING a live, auto-firing Coordinator job is the AUTONOMY SWITCH and is HUMAN-GATED — this module only
// DEFINES the job; creating it on a real thread is a deliberate one-command human act (see the CLI verb).

import { normInterval } from "./standing-jobs.js";

// The role the heartbeat fires INTO. A role-named job keys its single-flight claim by the role's SEAT
// (jobClaimKey → seatSurfaceKey), so a timer fire and a dormant-seat reconstitution mutually exclude — one
// Coordinator per thread, never two racing onto the seat.
export const COORDINATOR_ROLE = "Coordinator";

// The default cadence — a calm few minutes, deliberately NOT the 60s floor (an idle proactive sweep every
// minute is eager waste; urgent events don't wait for the heartbeat — they wake instantly via the @-mention/
// ask INTERRUPT path). Set just INSIDE the ~5-min idle keep-alive window (IDLE_KEEPALIVE_MS) so wake-live-else-
// respawn favours the CHEAP branch: a heartbeat at this interval finds the last-woken Coordinator still alive
// (not yet reaped) and NUDGES it (context intact) rather than paying a fresh respawn's context reassembly each
// sweep. A longer `--interval` (past keep-alive) flips it to reap-then-respawn, freeing the slot between sweeps
// — a real tradeoff, hence overridable. Clamped up to the standing-job floor (MIN_INTERVAL_MS) by normInterval.
export const COORDINATOR_HEARTBEAT_INTERVAL_MS = 240_000; // 4 min — inside the 5-min keep-alive, nudge-favouring

// The sweep instruction — the heartbeat's payload, carried verbatim into the job worker's brief/nudge. It is
// the same "read your inbox + the board, sweep for stalls, act or sleep" tick the bespoke heartbeat used, made
// self-contained for a standing-job worker (which may be a FRESH respawn with no recovered process state, so
// it's told to read the thread for context and to be SILENT when it finds nothing — the "skip days with
// nothing" R6 norm). `<your session id>` is substituted by the worker from its own id (the brief bakes it in).
export const COORDINATOR_HEARTBEAT_INSTRUCTION =
  "Coordinator heartbeat — your scheduled sweep (not a human message). " +
  "Read your inbox (GET /api/inbox?session=<your session id>) and the board (GET /api/canvas, GET /api/sessions); " +
  "then sweep for stalled or blocked agents, unanswered asks, pending questions, and drifting work. " +
  "Act on what you find — nudge a stalled thread, answer or route a blocked agent, make an uncontentious call, " +
  "or escalate to the human — then wind down until the next heartbeat. " +
  "If NOTHING needs attention, post nothing and wind down silently (skip days with nothing).";

/**
 * The canonical Coordinator-heartbeat standing-job spec — `{ role, intervalMs, instruction }`, ready to hand
 * to `upsertJob(repoPath, threadId, spec)` / the `/api/thread/<id>/job` endpoint. Pass `{ intervalMs }` to
 * override the default cadence (still floor-clamped). PURE — builds a record, creates nothing.
 */
export function coordinatorHeartbeatJobSpec({ intervalMs } = {}) {
  return {
    role: COORDINATOR_ROLE,
    intervalMs: normInterval(intervalMs ?? COORDINATOR_HEARTBEAT_INTERVAL_MS),
    instruction: COORDINATOR_HEARTBEAT_INSTRUCTION,
  };
}
