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
// respawn — an EXITED participant can still CARRY a `blocked:human` on its seat. But the `waiting`
// (orange "your turn") state requires a *live* (non-exited) participant to hold that block: a thread
// with no live sessions is never loud. An exited-only blocked:human falls to `dormant` and re-activates
// non-destructively on the next event (the question is preserved in the thread log, not in a loud rail
// signal that can outlive every session that could act on it). This deliberately supersedes the earlier
// "the loud state survives the asker's crash" design — a dead asker's stale block used to light the rail
// forever with no one able to clear it (per human feedback, seq 122/124 on this thread).

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

// The participant-pill STATE vocabulary — the `.chan-member.i-<state>` class suffix, and the semantic slot
// the SESSION CARD's own band shares. Six slots, one hue each: green `working`, orange `blocked-human`
// (idle "your turn" / a held permission), blue `blocked-peer` (waiting on an agent), teal `scheduled`, red
// `crashed`, grey `done`. This list is the contract a drift test locks against style.css.
export const PILL_STATES = ["working", "blocked-human", "blocked-peer", "scheduled", "crashed", "done"];

// The SINGLE band→pill-state map: the whole-session server band (SessionMeta.status, session-status.ts) →
// its pill slot. The card's visibility surfaces render those same bands through STATUS_COLOR, so this map
// is what keeps the card band and the thread pill from ever disagreeing on WHICH state a session is in —
// the whole point of the unification. Every band here is PROCESS-OBSERVED and GLOBAL to the session: it
// paints the card and the pill identically. `waiting` fuses idle-"your turn" and a held permission (both
// orange = blocked-human); `done`/`ended` share grey. Keep the keys a total cover of SessionStatus (a test
// asserts it) so a new band can't silently fall through to a neutral pill.
const BAND_TO_PILL = {
  working: "working",
  waiting: "blocked-human",
  "waiting-agent": "blocked-peer",
  scheduled: "scheduled",
  done: "done",
  crashed: "crashed",
  ended: "done",
};

// A declared work-intent → the pill slot it names. This is the PER-THREAD interaction axis: what a session
// declares about ITS work in THIS thread, which the server cannot observe per-thread. Only these four are
// declarable (work-intent.js). Used both as the fallback when there's no live session row and as the fold
// applied over the server band below.
const INTENT_TO_PILL = {
  working: "working",
  "blocked:human": "blocked-human",
  "blocked:peer": "blocked-peer",
  done: "done",
};

/** The pill slot a raw declared work-intent maps to (or null if it names nothing paintable). */
export function intentPillState(intent) {
  return (intent && INTENT_TO_PILL[intent]) ?? null;
}

/**
 * The pill state for a participant — a PURE rendering of the ONE whole-session server band (SessionMeta.status,
 * session-status.ts), the SAME value the session card paints its frame from, so the two surfaces can never
 * disagree (thread mrcmofwf-10). This does NOT fold in this thread's declared intent: the intent refinement
 * now happens ONCE, server-side and WHOLE-SESSION (vite-fs-plugin.ts sessionStatus × sessionIdleIntent), and
 * arrives already baked into `band`. Folding per-thread here is exactly the drift this unification removes —
 * a session in many threads must show the SAME pill everywhere, not one coloured by each thread's local
 * declaration. So: idle+blocked:human (any thread) already reads `waiting`; idle+blocked:peer already reads
 * `waiting-agent`; a `done` on a still-live session does NOT grey the band (it shows grey only once the
 * PROCESS exits, via endReason) — the old done-on-live→grey and untagged-blocked:peer→blue folds are gone,
 * lifted whole-session into the band.
 *
 * The one thing left here is the no-live-row fallback: with no session row (band null/undefined) the seat may
 * still carry a durable declaration — an exited seat holding `blocked:human`, or a `done` — so fall back to
 * the declared intent alone; null → a neutral "no status declared" pill (never fabricate one).
 *
 * @param {string|null|undefined} band  the session's whole-session SessionMeta.status, or null when there's no live row
 * @param {string|null|undefined} declaredIntent  this thread's latest declared work-intent — used ONLY for the no-row fallback
 * @returns {string|null} a PILL_STATES member, or null for a neutral pill
 */
export function memberPillState(band, declaredIntent) {
  const base = band ? (BAND_TO_PILL[band] ?? null) : null;
  return base ?? intentPillState(declaredIntent);
}

/**
 * Derive a thread's state from its participants (§4 table, in precedence order):
 *
 *   active  — any participant computing (`running`), or live and (declared-or-default) `working`.
 *   waiting — none active, and ≥1 *live* (non-exited) participant is effectively `blocked:human`. The
 *             liveness guard is what keeps this honest: a `blocked:human` on an EXITED seat no longer
 *             counts (it falls through to `dormant`), so a thread whose only asker has died is never
 *             loud — orange ⟺ a currently-live agent is blocked on the human. Deliberately NARROW:
 *             waiting is the state the whole design treats as sacred ("your turn", surfaced loud, never
 *             archived), and it stays meaningful only if it can't be entered by accident — nor left
 *             stuck on by a stale intent no session can clear. The lifecycle doc's other
 *             waiting trigger — inferring a provisional blocked:human from a trailing question to the
 *             human (§6/§8 fallback) — is an upstream EMITTER's job, not this machine's; when built it
 *             declares the intent and this function never knows the difference.
 *   dormant — every participant `done`/`exited`, with no LIVE `blocked:human`: nobody is working it and
 *             no live agent needs a person. (An exited seat still holding `blocked:human` lands here now,
 *             not in `waiting` — the liveness guard above dropped it; the question survives in the thread
 *             log and the first re-activation surfaces it again.) The archive predicate — both conjuncts,
 *             per §4 (quorum, not first-mover: one `done` never archives a thread someone else is still
 *             working). An UNSTAFFED thread
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
  if (participants.some((p) => p.processState !== "exited" && effectiveIntent(p) === "blocked:human"))
    return "waiting";
  if (participants.every((p) => p.processState === "exited" || effectiveIntent(p) === "done"))
    return "dormant";
  return "active"; // live blocked:peer chains — see the doc comment above
}
