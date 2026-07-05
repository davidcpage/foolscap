// Notification levels — the wake policy of a SEAT on a wakeable surface (P1, docs/wakeable-substrate-plan.md
// W4; docs/claude-tag-lessons.md R2 recast; docs/anchored-async-ask.md §2). The one primitive shared by
// every surface that generates activity — a thread, a doc, and (W6) a timer — so a member sets "how much
// does this surface wake me" ONCE per seat, rather than each surface inventing its own gate.
//
// A seat's level is a STATIC, self-declared preference (never a dynamic inference over others' work-intent —
// R2 names that as the trap that makes a wake unreliable). Three levels, the Slack-channel choice:
//   • all      — any room-wide activity wakes the seat (the default; a thread message with no tag is still
//                ambient and wakes no one — the level gates the BROADCAST, `@all` / any comment, not the
//                untagged post).
//   • mentions — only activity that @-addresses THIS seat wakes it; a broadcast does not.
//   • paused   — nothing auto-wakes it, but an explicit @-mention still overrides (a paused watcher can
//                always be summoned by name). Same wake predicate as `mentions`; the distinction is a
//                mute a surface's own `state:"paused"` axis (doc-watch) can toggle without losing the level.
//
// Shared by the server (the thread nudge fan-out, the doc-watch wake trigger W5 will add) and — via the
// hand-written .d.ts — the card chrome, like work-intent.js / thread-tags.js: one module so the enum and
// its wake semantics can't drift apart across the surfaces that adopt it.

/** The closed set of notification levels — a seat's wake preference on a surface. Ordered loud→quiet. */
export const NOTIFICATION_LEVELS = ["all", "mentions", "paused"];

/** Is `v` one of the levels? */
export function isNotificationLevel(v) {
  return typeof v === "string" && NOTIFICATION_LEVELS.includes(v);
}

/** Normalize any value to a level, defaulting to `all` (the R2 default — an unset seat wakes on everything). */
export function normLevel(v) {
  return isNotificationLevel(v) ? v : "all";
}

/**
 * Does activity wake a seat at `level`? The one wake predicate every surface routes through.
 *   - `mentioned` — the activity @-addresses THIS seat (an explicit tag; an `answer` to a question it
 *     asked). Always wakes — the @-mention override, even at `paused`.
 *   - `broadcast` — room-wide activity not addressed to anyone in particular (`@all`, any comment on a
 *     watched doc). Wakes only a seat at level `all`.
 *   - neither — an untagged/ambient event. Wakes no one.
 * `level` is normalized (an unknown value ⇒ `all`), so a caller can pass a raw stored value.
 */
export function wakesSeat(level, { mentioned = false, broadcast = false } = {}) {
  if (mentioned) return true; // the @-mention override — reaches a mentions/paused seat too
  if (broadcast) return normLevel(level) === "all";
  return false;
}
