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
// ENABLING a live, auto-firing Coordinator job is the AUTONOMY SWITCH and stays HUMAN-GATED — but the gate is
// now the act of STAFFING a Coordinator, not a separate remembered command. A Coordinator that can't sweep is
// useless (peers signal completion via a `done` intent that wakes no one, so only a proactive sweep notices),
// and the standalone CLI step was routinely forgotten — so vite-fs-plugin.ts auto-enables this job the FIRST
// time a Coordinator SEAT is staffed on a thread (ensureCoordinatorHeartbeat). The CLI verb
// (`scripts/canvas job coordinator <thread>`) remains, for a custom `--interval` or to re-enable one a human
// removed. This module only DEFINES the job; both creators build it from `coordinatorHeartbeatJobSpec()`.

import { normInterval } from "./standing-jobs.js";

// The role the heartbeat fires INTO. A role-named job keys its single-flight claim by the role's SEAT
// (jobClaimKey → seatSurfaceKey), so a timer fire and a dormant-seat reconstitution mutually exclude — one
// Coordinator per thread, never two racing onto the seat.
export const COORDINATOR_ROLE = "Coordinator";

// The default cadence — a calm few minutes, deliberately NOT the 60s floor (an idle proactive sweep every
// minute is eager waste; urgent events don't wait for the heartbeat — they wake instantly via the @-mention/
// ask INTERRUPT path). Set well INSIDE the idle keep-alive window (IDLE_KEEPALIVE_MS, 15 min) so wake-live-else-
// respawn favours the CHEAP branch: a heartbeat at this interval finds the last-woken Coordinator still alive
// (not yet reaped) and NUDGES it (context intact) rather than paying a fresh respawn's context reassembly each
// sweep. This fast pulse is LOAD-BEARING while working/blocked:peer — it's how the Coordinator detects a peer
// finishing (a `done` intent wakes no one). It backs off only while the Coordinator is blocked:human (see
// heartbeatEffectiveInterval). Clamped up to the standing-job floor (MIN_INTERVAL_MS) by normInterval.
export const COORDINATOR_HEARTBEAT_INTERVAL_MS = 240_000; // 4 min — inside the 15-min keep-alive, nudge-favouring

// Part 4 — intent-keyed backoff. A Coordinator that has EXPLICITLY declared `blocked:human` (it escalated and
// is parked on a human) needn't keep the fast pulse: the human's reply wakes it reactively, so a frequent
// sweep just burns turns finding the same block. So while its own declared intent is `blocked:human`, the
// heartbeat's EFFECTIVE interval slows to this; every other stance (`working`/`blocked:peer`/`done`/none)
// keeps the base cadence. Derived LIVE from the seat's current intent each tick — no stored backoff counter —
// so it snaps back the instant the block clears (resumeRunning auto-freshens blocked:* → working on resume).
export const HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS = 30 * 60_000; // 30 min

/**
 * The heartbeat's EFFECTIVE fire interval given the seat occupant's currently declared work-intent (part 4):
 * `blocked:human` → the slow backoff pulse (never shorter than the base — max guards a base already longer);
 * anything else → the base interval unchanged. PURE. `intent` is the seat's declared intent
 * (`meta.intents[role].intent`), or null/undefined when none is declared.
 */
export function heartbeatEffectiveInterval(baseIntervalMs, intent) {
  if (intent === "blocked:human") return Math.max(baseIntervalMs, HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS);
  return baseIntervalMs;
}

// The sweep instruction — the heartbeat's payload, carried verbatim into the job worker's brief/nudge. It is
// the same "read your inbox + the board, sweep for stalls, act or sleep" tick the bespoke heartbeat used, made
// self-contained for a standing-job worker (which may be a FRESH respawn with no recovered process state, so
// it's told to read the thread for context and to be SILENT when it finds nothing — the "skip days with
// nothing" R6 norm). `<your session id>` is substituted by the worker from its own id (the brief bakes it in).
export const COORDINATOR_HEARTBEAT_INSTRUCTION =
  "Coordinator heartbeat — your scheduled sweep (not a human message). " +
  "Read your inbox (GET /api/inbox?session=<your session id>) and the board (GET /api/canvas, GET /api/sessions); " +
  "then sweep for stalled or blocked agents, unanswered asks, pending questions, and drifting work. " +
  "Act on what you find — nudge a stalled thread, answer or route a blocked agent, make an uncontentious call. " +
  "ESCALATE to the human (post the issue and declare intent blocked:human) ONLY when work you are watching shows " +
  "NO PROGRESS and you cannot move it forward — e.g. the peer's session is idle/dead, no new commits, no thread " +
  "activity. While a peer is ACTIVELY working (running, committing, recent posts), it is NOT stuck: stay silent " +
  "and let the next heartbeat check again — do NOT escalate merely because this sweep found nothing to do. " +
  "Then wind down until the next heartbeat. " +
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
