// The board owner's per-thread WAITING signal (user waiting-state + you-pill, thread node:mrbz24qp-h).
// Plain ESM, runs under node --test; imported by vite-fs-plugin.ts to compute `youWaiting` on the thread
// feed, which colours the human's "you" roster pill amber when a message awaits them.
//
// WHAT COUNTS AS WAITING (the human's product call): an @you/@human MENTION that sits UNADDRESSED. There is
// no human read-cursor and — by design — we don't add one: the human chose CLEAR-ON-REPLY over clear-on-view
// (the stalled agent is waiting on the human's REPLY, not merely their attention). So "unaddressed" is fully
// derivable from the existing thread log, read-time, with no durable state:
//
//   youWaiting  =  ∃ message with resolveTags(text).human === true  AND  seq > (latest from:"human" message).seq
//
// A `@human`/`@user` mention newer than the human's own last post is waiting; the moment the human posts
// anything, their message is newest, nothing is unaddressed, and the pill clears (clear-on-reply). If the
// human has never posted, any `@human` mention counts (lastHumanSeq = 0), which is correct.
//
// The `human` flag comes from thread-tags.js `resolveTags` — the single source of truth for what a mention
// IS (HUMAN_TOKENS = @human/@user). It's independent of the member list, so we pass none. Card-only entries
// (work-intents / ask echoes, `kind != null`) are bookkeeping, not messages that address the human — skipped,
// mirroring the unread/nudge path in vite-fs-plugin.ts (`cardOnly`).
//
// FUTURE (out of scope now): pending ASKS addressed to the human would OR into this — but the `/ask` channel
// can't target the human today, so there's no such signal yet; the shape (`waiting = mention || ask`) leaves
// room for it. And WhatsApp-style reply-to-a-specific-message could later scope the clear to the replied-to
// mention instead of clearing all; for now any human post clears everything.

import { resolveTags } from "./thread-tags.js";

// Hover-preview bounds (Phase 3): the pill/row hover reveals the ACTUAL waiting messages, not just a count.
// Bounded in the derivation (one place) so no consumer re-drops: keep the TAIL — the most recent mentions are
// the ones the human is catching up to — and surface the older overflow as `more` ("+N earlier"), never a
// silent truncation. The snippet is a single collapsed line, generous but bounded (CLAUDE.md size caps).
const PREVIEW_CAP = 4;
const SNIPPET_MAX = 100;

function snippet(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1).trimEnd() + "…" : s;
}

/**
 * Derive the human's waiting state for one thread from its message log. `log` is the ThreadMsg[] the feed
 * carries (`{ seq, ts, from, text, kind? }`). Returns `{ waiting, count, preview, more }` — `count` is how
 * many @human mentions sit past the human's last post, `waiting` is `count > 0`, `preview` is the most-recent
 * up-to-`PREVIEW_CAP` of those as `{ seq, from, text }` (for the hover preview + jump-to-message), and `more`
 * is how many older waiting mentions the preview omitted (`count - preview.length`). Pure; no I/O.
 */
export function humanWaiting(log) {
  const msgs = Array.isArray(log) ? log : [];
  let lastHumanSeq = 0;
  for (const m of msgs) if (m && m.from === "human" && m.seq > lastHumanSeq) lastHumanSeq = m.seq;
  const waiting = [];
  for (const m of msgs) {
    if (!m || m.kind != null) continue; // card-only (intent/ask) entries don't address the human
    if (m.seq <= lastHumanSeq) continue; // addressed: the human posted at or after this
    if (resolveTags(m.text ?? "", []).human) waiting.push(m); // an @human / @user mention
  }
  const count = waiting.length;
  // Keep the TAIL (most recent) — see PREVIEW_CAP above. In chronological order so it reads like the log.
  const tail = count > PREVIEW_CAP ? waiting.slice(count - PREVIEW_CAP) : waiting;
  const preview = tail.map((m) => ({ seq: m.seq, from: m.from, text: snippet(m.text) }));
  return { waiting: count > 0, count, preview, more: count - preview.length };
}
