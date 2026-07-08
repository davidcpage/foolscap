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

/**
 * Derive the human's waiting state for one thread from its message log. `log` is the ThreadMsg[] the feed
 * carries (`{ seq, ts, from, text, kind? }`). Returns `{ waiting, count }` — `count` is how many @human
 * mentions sit past the human's last post (for a tooltip/badge), `waiting` is `count > 0`. Pure; no I/O.
 */
export function humanWaiting(log) {
  const msgs = Array.isArray(log) ? log : [];
  let lastHumanSeq = 0;
  for (const m of msgs) if (m && m.from === "human" && m.seq > lastHumanSeq) lastHumanSeq = m.seq;
  let count = 0;
  for (const m of msgs) {
    if (!m || m.kind != null) continue; // card-only (intent/ask) entries don't address the human
    if (m.seq <= lastHumanSeq) continue; // addressed: the human posted at or after this
    if (resolveTags(m.text ?? "", []).human) count++; // an @human / @user mention
  }
  return { waiting: count > 0, count };
}
