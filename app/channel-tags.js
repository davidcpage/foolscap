// Channel @-tag resolution (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// A channel post can NAME members with `@<tag>`. A tag gates the WAKE (the content-free nudge), not the
// content: every post is still logged for every member to read on their own cursor — naming someone only
// decides who gets INTERRUPTED. With no tag, nobody is woken (the post is ambient background); `@all`
// (also everyone/channel/here) wakes the whole room on purpose; `@human`/`@user` addresses the board owner
// (who reads the card, so there's no stdin to wake — it's a surfacing hint, and it keeps the SENDER's
// status orange "waiting on a human" rather than blue "waiting on an agent").
//
// A member tag is a PREFIX of the member's session id — the canvas never makes a human type a full hash
// (the channel card's member pill drops the shortest unambiguous prefix, e.g. `@a9`, into the post box).
// An ambiguous prefix wakes every member it matches (safe over-notify); a tag that matches no member is
// treated as plain prose and ignored. All matching is case-insensitive over the session-id hex.

const ALL_TOKENS = new Set(["all", "everyone", "channel", "here"]);
const HUMAN_TOKENS = new Set(["human", "user"]);

/** The lowercased `@<token>` tags in `text`, in order, de-duplicated. `@` must not follow a word char (so
 *  an email-ish `foo@bar` is not a tag). Tokens are hex / hyphen / a few keywords (all/human/…). */
export function parseTags(text) {
  const out = [];
  const re = /(?<![\w@])@([A-Za-z0-9][A-Za-z0-9-]*)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const tok = m[1].toLowerCase();
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * Resolve a post's tags against the channel's member session ids.
 * Returns { wakeAll, human, members, unknown }:
 *   • wakeAll — an `@all`/`@everyone`/`@channel`/`@here` appeared → wake the whole room.
 *   • human   — an `@human`/`@user` appeared → addressed to the board owner.
 *   • members — the member sids named by a (possibly ambiguous) prefix tag, de-duplicated, in tag order.
 *   • unknown — tags that matched no member and weren't a keyword (left as prose; surfaced for debugging).
 */
export function resolveTags(text, memberSids) {
  let wakeAll = false;
  let human = false;
  const members = [];
  const unknown = [];
  for (const tok of parseTags(text)) {
    if (ALL_TOKENS.has(tok)) { wakeAll = true; continue; }
    if (HUMAN_TOKENS.has(tok)) { human = true; continue; }
    const matches = memberSids.filter((s) => String(s).toLowerCase().startsWith(tok));
    if (matches.length === 0) { unknown.push(tok); continue; }
    for (const s of matches) if (!members.includes(s)) members.push(s);
  }
  return { wakeAll, human, members, unknown };
}
