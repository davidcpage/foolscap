// The board owner's per-thread WAITING signal (user waiting-state + you-pill, thread node:mrbz24qp-h).
// Plain ESM, runs under node --test; imported by vite-fs-plugin.ts to compute the human's unseen-mention
// signal on the thread feed + the threads-list rail.
//
// WHAT COUNTS AS WAITING (the human's product call): an @you MENTION the human has not yet VIEWED (`@you`
// is the official human tag; `@human`/`@user` are honored legacy aliases — see thread-tags.js HUMAN_TOKENS).
// This REPLACES the earlier clear-on-reply model (a mention newer than the human's last post). The human
// asked for per-VIEWED-message clearing: a mention clears only when the human actually scrolls it into the
// thread-log viewport (while the card is focused), not when they reply, and not merely by focusing the card.
// So "unaddressed" is no longer a pure function of the log — it needs a small DURABLE per-thread set of the
// mention seqs the human has SEEN (thread-ledger.js `seenMentions`, cloned from the pin store, bounded to
// mention-seqs — mentions are few, so the set stays tiny and only grows when a NEW mention is viewed):
//
//   unseen(m)  =  resolveTags(m.text).human === true  AND  m.seq ∉ seenMentions
//
// A viewed mention's seq lands in `seenMentions` (POST /api/thread/:id/seen, driven by a client viewport
// observer) and drops out of the count individually; non-viewed mentions stay flagged. Presence (the you-pill
// green/grey) is DECOUPLED from this: it's live 'is the card focused' state with no durable storage, so
// focusing the card greens the pill but clears nothing — you clear a mention by scrolling to it.
//
// The `human` flag comes from thread-tags.js `resolveTags` — the single source of truth for what a mention
// IS (HUMAN_TOKENS = @human/@user). It's independent of the member list, so we pass none. Card-only entries
// (work-intents / ask echoes, `kind != null`) are bookkeeping, not messages that address the human — skipped
// via the shared `cardOnly` predicate below (vite-fs-plugin.ts's unread/nudge path imports the same one).
//
// FUTURE (out of scope now): pending ASKS addressed to the human would OR into this — but the `/ask` channel
// can't target the human today, so there's no such signal yet; the shape (`waiting = mention || ask`) leaves
// room for it.

import { resolveTags } from "./thread-tags.js";

// A "card-only" thread entry — a work-intent act or an ask echo, marked by a non-null `kind`. These are
// bookkeeping painted on the card, not messages that WAKE a member or address the human, so both the unread/
// nudge count (vite-fs-plugin.ts) and the human-waiting derivation below skip them. A falsy entry is treated
// as card-only too (there's nothing to address). One predicate so the two paths can't diverge.
export const cardOnly = (m) => !m || m.kind != null;

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
 * Derive the human's unseen-mention state for one thread from its message log and the set of mention seqs the
 * human has already VIEWED. `log` is the ThreadMsg[] the feed carries (`{ seq, ts, from, text, kind? }`);
 * `seenMentions` is the durable per-thread seen set (an array/Set/iterable of seqs — thread-ledger.js
 * `readSeenMentions`; omitted ⇒ nothing seen yet). Returns `{ waiting, count, seqs, preview, more }`:
 * `count` is how many @human mentions are still unseen, `waiting` is `count > 0`, `seqs` is EVERY unseen
 * mention seq (chronological — the client viewport observer watches exactly these), `preview` is the
 * most-recent up-to-`PREVIEW_CAP` of them as `{ seq, from, text }` (for the rail popover + cross-card jump),
 * and `more` is how many older unseen mentions the preview omitted (`count - preview.length`). Pure; no I/O.
 */
export function humanWaiting(log, seenMentions) {
  const msgs = Array.isArray(log) ? log : [];
  const seen = seenMentions instanceof Set ? seenMentions : new Set(seenMentions ?? []);
  const unseen = [];
  for (const m of msgs) {
    if (cardOnly(m)) continue; // card-only (intent/ask) entries don't address the human
    if (seen.has(m.seq)) continue; // the human has already viewed this mention (per-viewed clearing)
    if (resolveTags(m.text ?? "", []).human) unseen.push(m); // an @human / @user mention
  }
  const count = unseen.length;
  const seqs = unseen.map((m) => m.seq);
  // Keep the TAIL (most recent) — see PREVIEW_CAP above. In chronological order so it reads like the log.
  const tail = count > PREVIEW_CAP ? unseen.slice(count - PREVIEW_CAP) : unseen;
  const preview = tail.map((m) => ({ seq: m.seq, from: m.from, text: snippet(m.text) }));
  return { waiting: count > 0, count, seqs, preview, more: count - preview.length };
}
