// Thread @-tag resolution (plain ESM, runs under node --test; imported by vite-fs-plugin.ts). Né
// channel-tags.js — renamed with the thread migration (threads-as-cards §8); the grammar is unchanged.
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

// The canonical tag-token grammar, defined ONCE so the resolver (server) and the highlighter (client, which
// imports this module) can never drift apart — divergence here is exactly the @Coordinator-doesn't-light-up bug.
// `/g` is stateful (lastIndex), so hand out a FRESH RegExp per call rather than sharing one mutable literal.
function tagRe() {
  return /(?<![\w@])@([A-Za-z0-9][\w.-]*)/g;
}

// Normalize the members arg to `{ sid, name }` entries — bare sid strings (the original shape) still accepted.
function normEntries(members) {
  return (members ?? []).map((m) =>
    typeof m === "string" ? { sid: m, name: null } : { sid: m.sid, name: m.name ?? null });
}

// Does a single normalized entry match a lowercased token? A token prefix-matches the entry's sid OR its
// name (`<RoleName>.<short-sid>`), case-insensitive — the one rule shared by resolveTags and the highlighter.
function entryMatches(entry, tok) {
  return (
    String(entry.sid).toLowerCase().startsWith(tok) ||
    (entry.name && String(entry.name).toLowerCase().startsWith(tok))
  );
}

/** Whether a single `@`-token would RESOLVE to a wake target — a keyword (@all/@human/…) or a member by sid /
 *  name prefix. The predicate the channel-card highlighter uses so it lights exactly the tags the server honors
 *  (this module is the single source of truth; the client adds no second grammar). `token` may be raw-cased. */
export function tagHit(token, members) {
  const tok = String(token).toLowerCase();
  if (ALL_TOKENS.has(tok) || HUMAN_TOKENS.has(tok)) return true;
  return normEntries(members).some((e) => entryMatches(e, tok));
}

/** The character spans of the resolving `@`-tags in `text`, for highlighting — `[{ start, end, token }]` over
 *  the ORIGINAL string (no JSX; the React caller maps spans → highlight nodes). Mirrors parseTags' grammar and
 *  trailing-punctuation strip, but keeps positions: `@26.` highlights `@26` (the `.` is sentence punctuation),
 *  while an internal-dot handle `@Oracle.a8` highlights whole. Only tags that `tagHit` are returned. */
export function matchTagSpans(text, members) {
  const entries = normEntries(members);
  const s = String(text);
  const re = tagRe();
  const spans = [];
  let m;
  while ((m = re.exec(s))) {
    const raw = m[1].replace(/[.-]+$/, ""); // drop trailing `.`/`-` (sentence punctuation), as parseTags does
    if (!raw || !tagHit(raw, entries)) continue;
    spans.push({ start: m.index, end: m.index + 1 + raw.length, token: raw.toLowerCase() }); // +1 for the `@`
  }
  return spans;
}

/** The lowercased `@<token>` tags in `text`, in order, de-duplicated. `@` must not follow a word char (so
 *  an email-ish `foo@bar` is not a tag). Tokens are hex / hyphen / DOT (a `Name.sid` handle) / a few
 *  keywords (all/human/…). The dot lets a role handle `@Oracle.a8` parse as one tag, not `oracle` + stray. */
export function parseTags(text) {
  const out = [];
  const re = tagRe();
  let m;
  while ((m = re.exec(String(text)))) {
    // The grammar admits a DOT (for a `Name.sid` handle) and a hyphen, so a tag at the end of a sentence —
    // `@26.` or `@Oracle.` — absorbs the trailing punctuation into the token (`26.`), which then fails to
    // prefix-match the dot-free sid and the tagged member is never woken. A real handle never ENDS in a dot
    // or hyphen (they only ever sit BETWEEN segments), so strip trailing `.`/`-`: `@26.` → `26`, while an
    // internal-dot handle `@Oracle.a8` is untouched. (Other punctuation — `,` `?` `)` — already stops the
    // regex, so this closes the last gap.)
    const tok = m[1].toLowerCase().replace(/[.-]+$/, "");
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
/**
 * Classify an UNKNOWN @-tag — one resolveTags left in its `unknown` bucket (it matched no current member and
 * no keyword) — as a COLD-SPAWN target (threads-as-cards roadmap step 5): a mention that names something not
 * yet in the thread SUMMONS it. Spawn is ROLE/SEAT-BASED ONLY. Given the token (already lower-cased by
 * parseTags) and the board's role roster (`listRoles` shape: `[{ roleId, name }]`):
 *   • a KNOWN ROLE, matched EXACTLY (case-insensitive) on its `roleId` or display `name` → `{ kind: "role",
 *     roleId, name }` — the caller cold-spawns into the role's first seat on the thread. Exact (not prefix)
 *     so a typo/partial token never silently spawns the wrong role. Self-limiting: one seat per role.
 *   • anything else → `null` — the token stays inert prose (no spawn; the pre-existing silent-discard).
 * (A seatless reserved-keyword path once summoned a fresh plain worker per mention; it was REMOVED as a
 * footgun — naming the token in prose triggered a runaway spawn cascade — so only role/seat spawn remains.)
 * A token that ALREADY resolved to a member (a live or dormant seated role) never reaches here — it's in
 * resolveTags' `members`, so this is first-contact-only; existing-seat wakes ride the member/respawn path.
 */
export function classifyMentionSpawn(token, roles) {
  const tok = String(token).toLowerCase();
  const role = (roles ?? []).find(
    (r) => r && (String(r.roleId).toLowerCase() === tok || String(r.name).toLowerCase() === tok),
  );
  return role ? { kind: "role", roleId: role.roleId, name: role.name } : null;
}

export function resolveTags(text, members) {
  const entries = normEntries(members);
  let wakeAll = false;
  let human = false;
  const out = [];
  const unknown = [];
  for (const tok of parseTags(text)) {
    if (ALL_TOKENS.has(tok)) { wakeAll = true; continue; }
    if (HUMAN_TOKENS.has(tok)) { human = true; continue; }
    const matches = entries.filter((e) => entryMatches(e, tok));
    if (matches.length === 0) { unknown.push(tok); continue; }
    for (const e of matches) if (!out.includes(e.sid)) out.push(e.sid);
  }
  return { wakeAll, human, members: out, unknown };
}
