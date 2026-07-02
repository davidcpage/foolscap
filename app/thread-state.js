// The derived thread-state projection (threads-as-cards §8 step 3; state machine specified in
// session-thread-lifecycle.md §4/§6). Plain ESM so it runs under node --test and either side of the
// stack can import it; the SERVER is the one computer today (vite-fs-plugin.ts assembles the
// participants and serves `state` on /api/threads, the way `status` rides /api/sessions).
//
// A thread's state is a PURE FUNCTION of its participants' (process-state, work-intent) pairs — no
// clock anywhere. That is the §5 asymmetry: raw inactivity conflates "nobody needs anything" (dormant,
// hide it) with "it is the human's turn" (waiting, surface it), and only the declared intent can tell
// them apart. A timer may later demote a long-waiting thread to a quieter tier; it must never decide
// dormant-vs-waiting.
//
// One participant = one agent on the thread: `processState` is what the canvas observes of its process
// ("running" | "idle" | "exited"), `intent` its latest declared work-intent (work-intent.js), or null
// if it never declared. Intents are seat-keyed upstream, so a declaration survives its occupant's
// respawn — which is why an EXITED participant can still carry a live `blocked:human` (the question it
// asked is still on the table; the loud state must survive the asker's crash).

export const THREAD_STATES = ["active", "waiting", "dormant"];

/** @param {unknown} s */
export function isThreadState(s) {
  return typeof s === "string" && THREAD_STATES.includes(s);
}

// A participant's EFFECTIVE intent when it never declared one: a live session is assumed `working`
// (§2: working covers "idle between turns, will continue when nudged" — the default errs toward
// active, which neither hides the thread nor falsely claims the human's turn); an exited one is
// assumed `done` (its part is over — a crashed session is loud on its own card, and a dormant thread
// re-activates non-destructively on the next event).
const effectiveIntent = (p) => p.intent ?? (p.processState === "exited" ? "done" : "working");

/**
 * Derive a thread's state from its participants (§4 table, in precedence order):
 *
 *   active  — any participant computing (`running`), or live and (declared-or-default) `working`.
 *   waiting — none active, and ≥1 participant declared `blocked:human` (regardless of liveness — the
 *             seat-keyed declaration outlives its occupant). Deliberately NARROW: waiting is the state
 *             the whole design treats as sacred ("your turn", surfaced loud, never archived), and it
 *             stays meaningful only if it can't be entered by accident. The lifecycle doc's other
 *             waiting trigger — inferring a provisional blocked:human from a trailing question to the
 *             human (§6/§8 fallback) — is an upstream EMITTER's job, not this machine's; when built it
 *             declares the intent and this function never knows the difference.
 *   dormant — every participant `done`/`exited`, none `blocked:human`: nobody is working it and nobody
 *             needs a person. The archive predicate — both conjuncts, per §4 (quorum, not first-mover:
 *             one `done` never archives a thread someone else is still working). An UNSTAFFED thread
 *             (no agent participants at all — freshly created, or everyone left) is dormant by the
 *             same predicate: nothing is computing and no one declared a human-block. Its card is
 *             still wherever the human put it, and the first join/message re-activates it — archiving
 *             hides, never drops. (The alternative — unstaffed ⇒ waiting — made every carried-over
 *             pre-seat channel permanently loud, which is exactly the "top of the rail stops meaning
 *             anything" failure §8 warns about.)
 *
 * Live participants stuck on `blocked:peer` fall through all three conditions (the §4 table's gap —
 * an ask-cycle between agents): they resolve to ACTIVE, the honest bucket of the three — live
 * inter-agent work, not the human's turn, not archivable.
 *
 * @param {Array<{processState: "running"|"idle"|"exited", intent?: string|null}>} participants
 * @returns {"active"|"waiting"|"dormant"}
 */
export function deriveThreadState(participants) {
  if (!participants || participants.length === 0) return "dormant";
  if (participants.some((p) => p.processState === "running")) return "active";
  if (participants.some((p) => p.processState !== "exited" && effectiveIntent(p) === "working"))
    return "active";
  if (participants.some((p) => effectiveIntent(p) === "blocked:human")) return "waiting";
  if (participants.every((p) => p.processState === "exited" || effectiveIntent(p) === "done"))
    return "dormant";
  return "active"; // live blocked:peer chains — see the doc comment above
}
