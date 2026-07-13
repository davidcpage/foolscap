// The Coordinator heartbeat, expressed as a STANDING JOB (wakeable-substrate-plan.md — wake-live loop-migration).
//
// A looping role (the Coordinator, `agent-roles.md`) needs to sweep the board for STALLS — nothing emits an
// event when an agent goes silent, so a purely reactive session never wakes to notice. Historically this was
// a BESPOKE per-session heartbeat baked into `loopTick` (a server timer that nudged every already-live looping
// session on an adaptive cadence). It is now just a standing job on the Coordinator's thread, fired by the
// same tick as every other job — one driver, no bespoke fork.
//
// TIMERS NUDGE, NEVER SPAWN (human-locked, thread mrcauz0v-f). Like the old loopTick, the heartbeat can ONLY
// nudge a Coordinator that is ALREADY LIVE — it does NOT stand a dormant one back up (an earlier iteration let
// standingJobsTick respawn a dormant seat, which produced an endless-Coordinator runaway on a stood-down
// thread; that respawn is removed). What keeps the nudge effective is the REAPER, not a respawn: reap-only-on-
// done (auto-wake.reapKeepAliveMs) leaves a Coordinator PARKED (idle, no tokens) until it declares `done`, so
// the heartbeat always has a live seat to nudge. A Coordinator that has truly exited is revived only by a real
// event (@-mention / ask / human staffing), never by this timer.
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
// ask INTERRUPT path). The heartbeat is a pure NUDGE of the parked (reap-only-on-done) Coordinator, so the
// cadence is just how often it re-sweeps, not a race against reaping. This fast pulse is LOAD-BEARING while
// working/blocked:peer — it's how the Coordinator detects a peer finishing (a `done` intent wakes no one). It
// backs off only while the Coordinator is blocked:human (see heartbeatEffectiveInterval). Clamped up to the
// standing-job floor (MIN_INTERVAL_MS) by normInterval.
//
// CACHE-TTL DEPENDENCY (docs/token-efficiency-review-2026-07-11.md §6.2) — every cadence here must stay WELL
// UNDER the 1-HOUR prompt-cache TTL (measured: spawned sessions write exclusively to the `ephemeral_1h`
// bucket, refreshed on each use). A sweep inside the TTL replays the parked context at ~0.1× (cache read); a
// cadence PAST the TTL turns *every* sweep into a ~2× cold rewrite of the whole parked context — ~20× the
// warm price at observed sizes. This is also what makes the server-side gate below (heartbeatSweepSignature)
// a strict win: a gated-out quiet stretch under 1h costs nothing (the next wake is still warm), and past 1h
// the one-time cold rewrite is far smaller than the sweeps skipped. Re-check that arithmetic before slowing
// this cadence or if the account ever drops to a 5-minute TTL (e.g. usage overage) — at a 5-min TTL the gate
// wants hysteresis and a >5-min cadence goes cold every fire.
export const COORDINATOR_HEARTBEAT_INTERVAL_MS = 240_000; // 4 min — a calm re-sweep pulse for a parked Coordinator

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

// ── the server-side sweep gate (token-efficiency-review-2026-07-11.md §6.1) ─────────────────────────
// The server already knows everything a NO-OP sweep would discover — thread activity, declared intents,
// live session statuses — so it can decide "is there anything to sweep?" for free, in code, and skip the
// nudge (each one replays the Coordinator's whole parked context) when nothing changed since the last
// sweep. standingJobsTick computes this signature just before a Coordinator nudge and fires ONLY when it
// differs from the one stored at the previous fire; a gated skip does NOT stamp the job, so the gate
// re-evaluates every scheduler tick and the sweep fires the tick a change lands (never later than it
// would have un-gated). Stall detection survives because a stall IS a state: a non-self `working`/
// `blocked:peer` intent's AGE is quantized into buckets of this size, and each bucket crossing changes
// the signature — so a silently-stalled peer re-fires the sweep once per bucket, not once per 4 minutes.
export const HEARTBEAT_STALE_BUCKET_MS = 30 * 60_000; // re-sweep a stalled (unchanged working/blocked:peer) state this often

/**
 * A live session's whole-session BAND (session-status.ts — `sessionStatus`), COARSENED for the sweep so a
 * steadily-working session reads STABLY tick over tick. PURE.
 *
 * The bug this fixes: the raw process status oscillates running↔idle EVERY turn (`sessionStatus` →
 * `working` while mid-turn, the default idle `waiting` between turns), so a long build flipped the
 * signature every few seconds and the §6.1 gate never engaged — an active build woke the Coordinator each
 * cadence. But running and idle-between-turns both mean the same thing to a stall sweep: "this session is
 * actively engaged." So they fold to ONE token. The distinct calm band `scheduled` (a looping role parked
 * on its own heartbeat, no demand on anyone) is KEPT so a `scheduled`→working transition (a parked session
 * picking up work — the "idle→working" a sweep should notice) still fires; and the terminal bands
 * (`done`/`crashed`/`ended`) are kept so a working→done/crashed transition fires (such a session also
 * usually just leaves the live set). `blocked:human`/`blocked:peer` need no distinct session token here —
 * they ride the INTENT component below (value + stall bucket), which is where their stall is tracked.
 */
export function sweepSessionActivity(band) {
  if (band === "scheduled") return "scheduled";
  if (band === "done" || band === "crashed" || band === "ended") return band;
  return "working"; // working | waiting | waiting-agent | null → one "actively engaged" token
}

/**
 * The sweep-relevant board state, folded to a stable string — equal signatures ⇒ a sweep would find
 * nothing new. PURE; order-insensitive (threads, intent keys, and sessions are sorted). Components:
 *   - per thread: `lastTs` (any post/ask/answer bumps it — message content need not be read);
 *   - per declared intent (seat-keyed, `meta.intents`): its VALUE, plus — for stall detection — the
 *     quantized AGE of a non-self `working`/`blocked:peer` (self = `selfRole`, the sweeper's own seat:
 *     the watcher's own heartbeat must not tick itself awake forever on a quiet board);
 *   - per live session: `sid=activity`, where `activity` is the COARSENED whole-session band
 *     (sweepSessionActivity): a session appearing/disappearing or crossing between engaged/scheduled/
 *     terminal is sweep-relevant, but the running↔idle micro-flip of a steadily-working session is NOT.
 *     `sessions[].status` therefore carries the session's BAND (sessionStatus), not the raw process state;
 *     the caller has already dropped exited sessions.
 * The caller captures the signature AT FIRE TIME, so state the occupant itself mutates DURING the sweep
 * (its posts bump lastTs) reads as fresh change → at most one echo sweep per active episode, then the
 * gate engages. `threads` = thread meta markers (listThreads); `sessions` = `{sid, status}` (status = band).
 */
export function heartbeatSweepSignature({ threads, sessions } = {}, now, selfRole = COORDINATOR_ROLE) {
  const parts = [];
  const byId = [...(threads ?? [])].filter((t) => t && typeof t.threadId === "string");
  byId.sort((a, b) => a.threadId.localeCompare(b.threadId));
  for (const t of byId) {
    parts.push(`t:${t.threadId}@${t.lastTs ?? 0}`);
    const intents = t.intents ?? {};
    for (const key of Object.keys(intents).sort()) {
      const rec = intents[key] ?? {};
      let p = `i:${t.threadId}/${key}=${rec.intent ?? ""}`;
      if (key !== selfRole && (rec.intent === "working" || rec.intent === "blocked:peer"))
        p += `~${Math.floor(Math.max(0, now - (rec.ts ?? 0)) / HEARTBEAT_STALE_BUCKET_MS)}`;
      parts.push(p);
    }
  }
  const live = [...(sessions ?? [])].filter((s) => s && s.sid && s.status !== "exited");
  live.sort((a, b) => String(a.sid).localeCompare(String(b.sid)));
  for (const s of live) parts.push(`s:${s.sid}=${sweepSessionActivity(s.status)}`);
  return parts.join("|");
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
