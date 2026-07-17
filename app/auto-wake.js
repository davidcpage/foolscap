// Server-spawn-from-a-durable-record: the single-flight core + wake-qualification predicates (P2,
// docs/wakeable-substrate-plan.md W5; docs/anchored-async-ask.md §5 push half; docs/claude-tag-lessons.md
// R1). The reusable seam W6 (standing jobs) rides next — so it stays PURE here (no spawning, no I/O): the
// wiring in vite-fs-plugin.ts owns the actual ensureLiveSession call, and this module owns (a) the
// single-flight claim registry that stops a wake storm fanning out into duplicate workers, and (b) the
// qualification predicates that decide whether an activity clears a watcher's level — reusing W4's
// `wakesSeat` / `watcherEffectiveLevel` rather than reinventing the wake policy.
//
// SINGLE-FLIGHT is per SURFACE (a doc, or a thread-seat): one worker services a surface's whole open queue
// at a time (loop-until-dry, §5), so a burst of comments is one worker not five. The registry is IN-MEMORY
// and best-effort — a claim is transient (it lives only as long as the worker), and a dev-server restart
// mid-service simply forgets the claim, so the next activity may spawn a fresh worker. That's acceptable:
// the queue ops (apply/answer/resolve) are idempotent, so a rare duplicate re-services an already-drained
// queue and winds down. The claim is keyed to the worker's sid so the exit hook can release exactly its own.

import { wakesSeat } from "./notification-levels.js";
import { watcherEffectiveLevel } from "./doc-watch.js";

// surfaceKey → the sid of the worker currently servicing it. A Map, not a Set, so the exit hook can assert
// it's releasing its own claim (a stale release from a superseded worker must not free a live one's slot).
const claims = new Map();

/** The single-flight key for a DOC surface (its open-annotation queue). */
export const docSurfaceKey = (filePath) => `doc:${filePath}`;

/** The single-flight key for a THREAD SEAT surface (a dormant seat being reconstituted). */
export const seatSurfaceKey = (threadId, handle) => `thread:${threadId}#${handle}`;

/** Claim a surface for `sid` (the worker about to service it). Overwrites any prior claim — the caller has
 *  already checked it's unclaimed (or is deliberately superseding a dead one). */
export function claimSurface(key, sid) {
  claims.set(key, sid);
}

/** Release a surface claim, but ONLY if `sid` still holds it (an exited worker must not free a claim a
 *  newer worker took over). Returns whether this call released it. */
export function releaseSurface(key, sid) {
  if (claims.get(key) !== sid) return false;
  return claims.delete(key);
}

/** The sid currently servicing `key`, or null. */
export function surfaceClaimant(key) {
  return claims.get(key) ?? null;
}

/** Is any worker servicing `key`? */
export function isSurfaceClaimed(key) {
  return claims.has(key);
}

/** Drop every claim — test-only reset (the registry is process-global). */
export function clearAllClaims() {
  claims.clear();
}

/**
 * The wake CLASS of an annotation event, in the `wakesSeat` vocabulary:
 *   - an `answer` on a question is activity ADDRESSED to the seat that asked it → a `mentioned` event
 *     (wakes a seat at any level, including a paused/mentions ask-armed one — the @-mention override).
 *   - a `note` comment is room-wide activity ADDRESSED to no one in particular → a `broadcast` (wakes a
 *     watcher at level `all` only).
 *   - a `suggestion` create is a track-changes PROPOSAL awaiting an accept/reject decision — room-wide
 *     activity a reviewer should look at → a `broadcast` too (same class as a note).
 * These wake a doc worker (docs/wakeable-substrate-plan.md W5 refinement: a fresh `question` awaits a
 * HUMAN, so it must NOT wake an agent — no-op spawn avoidance; `reply`/`resolve`/`reanchor`/`thread` and a
 * suggestion's TERMINAL `accept`/`reject` aren't agent-actionable triggers — the decision is already made,
 * so waking on it would spawn a no-op worker). Any other kind returns neither → wakes no one.
 */
export function annotationWakeClass(eventKind) {
  if (eventKind === "answer") return { mentioned: true, broadcast: false };
  if (eventKind === "note" || eventKind === "suggestion") return { mentioned: false, broadcast: true };
  return { mentioned: false, broadcast: false };
}

/**
 * The keep-alive window to apply to an idle auto-wake worker given its currently DECLARED work-intent.
 *
 * REAP ONLY WHEN DONE (human-locked, thread mrcauz0v-f). The idle timer winds a worker down ONLY once it has
 * declared `done` (finished — reclaim the slot after the ordinary grace window). EVERY other stance — and an
 * undeclared idle — returns `null` (NEVER idle-reap): the session is left PARKED. This is the deliberate flip
 * from a keep-alive-per-intent policy, and it is the counterpart to the "timers nudge, never spawn" invariant
 * (standing-jobs.planRoleJobFire): a reaped worker can no longer be revived by any timer (the heartbeat is
 * nudge-only now), so aggressively reaping a still-relevant Coordinator would silently drop proactive stall
 * detection until a human noticed. A parked idle session is essentially harmless — it holds a process slot but
 * burns no tokens — whereas the failure it prevents (a wound-down seat the heartbeat used to respawn in a
 * loop) was the runaway. So: park by default, reap only the explicitly-finished. A worker that finishes
 * without declaring `done` parks harmlessly rather than being churned; a real event (@-mention/ask/human)
 * still wakes any parked session reactively.
 *
 * Pure/unit-testable; the reaper tick supplies `done` (thread-ledger.sessionDeclaredDone) and the default
 * window (IDLE_KEEPALIVE_MS). Since REAP-ONLY-ON-DONE collapsed the old per-intent policy to a single bit,
 * the param is now just that bit — not the intent string. A `null` return threads through shouldReapIdle as
 * never-reap.
 */
export function reapKeepAliveMs(done, defaultMs) {
  return done ? defaultMs : null; // done → reclaim after the grace window; every other stance → park (never reap)
}

/**
 * The R1 keep-alive reap decision (docs/claude-tag-lessons.md R1): is this session an auto-wake worker
 * that has been idle past the grace window and should now be wound down? Pure so it's unit-testable without
 * a live wait — the reaper tick (vite-fs-plugin.ts) just maps it over the live sessions. Only an auto-wake
 * worker is eligible (a human card / a human-spawned looping Coordinator has no `autoWake`, so never reaps);
 * it must be `idle` (a mid-turn worker is left alone) with an `idleSince` stamp at least `keepAliveMs` old.
 * A `null` / non-finite `keepAliveMs` means NEVER reap on the idle timer (e.g. a `blocked:human` session,
 * via reapKeepAliveMs) — the session's declared block explains its idleness, so we don't wind it down.
 */
export function shouldReapIdle(session, now, keepAliveMs) {
  return !!(
    session &&
    session.autoWake &&
    session.status === "idle" &&
    session.idleSince &&
    keepAliveMs != null &&
    Number.isFinite(keepAliveMs) &&
    now - session.idleSince >= keepAliveMs
  );
}

/**
 * The P5 done-member DETACH decision: should a thread's durable member `sid` be dropped from the thread now?
 * Pure/unit-testable — the sweep (server-orchestration.detachDoneMembersTick) maps it over every board's
 * thread members, passing the session's marker (session-ledger.readCanvasSession), the delay window, and a
 * liveness predicate. Detach iff ALL of:
 *   - the session FINISHED cleanly: `endReason === "done"` (a `terminated`/`crashed`/still-open member is left
 *     alone — a lingering crashed pill is signal, not clutter; only a clean done detaches).
 *   - it finished AT LEAST `delayMs` ago (a valid finite `endedAt` stamp; the grace window so a just-done card
 *     doesn't vanish out from under a human still looking at it).
 *   - it is NOT currently live (belt-and-suspenders: a `done` marker can't co-exist with a live process, since
 *     endSession deletes from liveSessions before stamping — but the guard makes the blast radius provably
 *     done-only, so a re-used sid or a racing state can never detach a working session).
 * `marker` is the session-ledger marker (or null when there's none → never detach). `isLive(sid)` returns true
 * when a non-exited live session holds this sid.
 */
export function shouldDetachDoneMember(sid, marker, now, delayMs, isLive) {
  if (!marker || marker.endReason !== "done") return false; // not a cleanly-finished session → leave it
  if (typeof marker.endedAt !== "number" || !Number.isFinite(marker.endedAt)) return false; // no honest end stamp
  if (now - marker.endedAt < delayMs) return false; // still inside the grace window
  if (isLive && isLive(sid)) return false; // never detach a live session
  return true;
}

/**
 * The done-INTENT detach decision — the STILL-LIVE companion to shouldDetachDoneMember (thread "Thread
 * liveness"). A shared Coordinator seated on several threads (a meta thread + children) that finishes ONE child
 * declares `done` on that child's seat while its process stays live (working the others). The exited-done path
 * above never fires — the session hasn't exited — and a live member with no per-thread intent defaults to
 * `working` (thread-state.js), so the finished child stays `active` forever. This detaches such a member off
 * its own PER-THREAD `done` intent instead of its process end, so the child goes dormant. Detach iff BOTH:
 *   - the member's latest OWN intent on THIS thread is `done` (threadIntentForSid resolves it by the record's
 *     `sid` stamp — the intent is often keyed by SEAT HANDLE, not sid). A later non-`done` declaration
 *     overwrites the `done` at the same key, so a re-declared `working` cancels the pending detach for free.
 *   - that declaration is AT LEAST `delayMs` old (its `ts` is the clock; the same grace window the exited path
 *     gives, so a just-closed child doesn't vanish out from under a human still reading it).
 * DELIBERATELY no liveness guard: this branch EXISTS to detach a still-live member (its whole reason for being).
 * `intentRec` is threadIntentForSid's result (or null when the member declared nothing → never detach).
 */
export function shouldDetachDoneIntent(intentRec, now, delayMs) {
  if (!intentRec || intentRec.intent !== "done") return false; // no own `done` on this thread → leave it
  if (typeof intentRec.ts !== "number" || !Number.isFinite(intentRec.ts)) return false; // no honest clock
  if (now - intentRec.ts < delayMs) return false; // still inside the grace window
  return true;
}

/**
 * Which of a doc's `watchers` does an annotation event of `eventKind` wake? Filters the watcher roster
 * through `wakesSeat(watcherEffectiveLevel(w), class)` — the exact W4 gate a thread nudge uses, one surface
 * over. Empty when the event wakes no one (a non-triggering kind, or every watcher opted below its class).
 * The caller spawns ONE worker per doc regardless of how many watchers qualify (single-flight); the roster
 * is returned so the caller can pick the worker's role from it.
 */
export function qualifyingWatchers(watchers, eventKind) {
  const cls = annotationWakeClass(eventKind);
  if (!cls.mentioned && !cls.broadcast) return [];
  return (watchers ?? []).filter((w) => wakesSeat(watcherEffectiveLevel(w), cls));
}
