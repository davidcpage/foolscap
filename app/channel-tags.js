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
//
// A tag also matches a member's NAME when one is known (a session spawned as a role is named
// `<RoleName>.<short-sid>`, agent-roles.md): `@Oracle` prefix-matches the role across every instance of
// it, `@Oracle.a8` disambiguates one instance, and a bare sid prefix still works — all one prefix
// mechanism, no special-case role lookup. The dot is in the token grammar so `Name.sid` is one tag.

const ALL_TOKENS = new Set(["all", "everyone", "channel", "here"]);
const HUMAN_TOKENS = new Set(["human", "user"]);

/** The lowercased `@<token>` tags in `text`, in order, de-duplicated. `@` must not follow a word char (so
 *  an email-ish `foo@bar` is not a tag). Tokens are hex / hyphen / DOT (a `Name.sid` handle) / a few
 *  keywords (all/human/…). The dot lets a role handle `@Oracle.a8` parse as one tag, not `oracle` + stray. */
export function parseTags(text) {
  const out = [];
  const re = /(?<![\w@])@([A-Za-z0-9][\w.-]*)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const tok = m[1].toLowerCase();
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * Resolve a post's tags against the channel's members. `members` is an array of either bare sid strings
 * (the original shape, still accepted) or `{ sid, name }` entries — a tag prefix-matches a member's sid
 * OR its name (`<RoleName>.<short-sid>`), so `@Oracle` reaches every instance of a role and `@Oracle.a8`
 * one of them, with bare sid prefixes unchanged. Matching is case-insensitive.
 * Returns { wakeAll, human, members, unknown }:
 *   • wakeAll — an `@all`/`@everyone`/`@channel`/`@here` appeared → wake the whole room.
 *   • human   — an `@human`/`@user` appeared → addressed to the board owner.
 *   • members — the member SIDS named by a (possibly ambiguous) prefix tag, de-duplicated, in tag order.
 *   • unknown — tags that matched no member and weren't a keyword (left as prose; surfaced for debugging).
 */
export function resolveTags(text, members) {
  const entries = (members ?? []).map((m) =>
    typeof m === "string" ? { sid: m, name: null } : { sid: m.sid, name: m.name ?? null });
  let wakeAll = false;
  let human = false;
  const out = [];
  const unknown = [];
  for (const tok of parseTags(text)) {
    if (ALL_TOKENS.has(tok)) { wakeAll = true; continue; }
    if (HUMAN_TOKENS.has(tok)) { human = true; continue; }
    const matches = entries.filter(
      (e) =>
        String(e.sid).toLowerCase().startsWith(tok) ||
        (e.name && String(e.name).toLowerCase().startsWith(tok)),
    );
    if (matches.length === 0) { unknown.push(tok); continue; }
    for (const e of matches) if (!out.includes(e.sid)) out.push(e.sid);
  }
  return { wakeAll, human, members: out, unknown };
}
