// The work-intent typed act (docs/threads-as-cards.md §6, docs/session-thread-lifecycle.md §2) — the one
// net-new primitive of the threads migration, shipped first (§8 step 1) on today's channel machinery.
//
// `idle+working`, `idle+blocked:human`, and `idle+done` are IDENTICAL at the process layer (a resident
// process emitting nothing), so the canvas cannot observe which it is — only the agent knows, so the agent
// must SAY. It says so with a structured act (an intent from this closed set, plus an optional prose note),
// not free text, so the reflex side can key on it without parsing prose: the step-3 thread-state projection
// (active/waiting/dormant), the rail's waiting-highlight, and slot reclamation on `done` all derive from it.
//
// Shared by the server (validation, the stored line) and the channel card (glyph/render), like
// thread-tags.js — one module so the enum and its rendering can't drift apart.

/** The closed set of declarable intents — a session's stance toward its current work-unit. */
export const WORK_INTENTS = ["working", "blocked:human", "blocked:peer", "done"];

/** Is `v` one of the declarable intents? The server's 400-gate: a typed act, never free text. */
export function isWorkIntent(v) {
  return typeof v === "string" && WORK_INTENTS.includes(v);
}

/**
 * The human-legible line a declared intent stores as the entry's `text` (and the card renders): the intent
 * itself, with the optional note appended. The structured fields (`kind`/`intent`) stay the machine truth;
 * this is just the legible face, so a generic renderer that knows nothing of intents still shows something.
 */
export function intentLine(intent, note) {
  return note ? `${intent} — ${note}` : intent;
}

// One glyph per intent for the card's status line. Mirrors the session status bands' vocabulary:
// working = quietly in motion, blocked:human = your turn (the loud one), blocked:peer = in flight
// elsewhere, done = wrapped up.
const GLYPHS = { working: "▸", "blocked:human": "✋", "blocked:peer": "⧗", done: "✓" };

/** The status-line glyph for an intent ("•" for an unknown value — render, don't throw). */
export function intentGlyph(intent) {
  return GLYPHS[intent] ?? "•";
}
