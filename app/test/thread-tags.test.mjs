// Channel @-tag resolution: who a post wakes (prefix of a member sid), the @all / @human keywords, and the
// "a tag is prose unless it matches" tolerance. Pure — no server, no restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTags, resolveTags, tagHit, matchTagSpans, classifyMentionSpawn } from "../thread-tags.js";

const MEMBERS = ["a927e694-839d-4aea-b0a4-39353072a4e9", "83adfb9c-73ab-468b-9c4c-4bef636cf997"];

test("parseTags pulls @tokens, lowercased and de-duped; ignores email-ish @", () => {
  assert.deepEqual(parseTags("hey @a9 and @A9 again, ping @83adfb9c"), ["a9", "83adfb9c"]);
  assert.deepEqual(parseTags("mail me at foo@bar.com"), [], "@ after a word char is not a tag");
  assert.deepEqual(parseTags("no tags here"), []);
});

test("a prefix tag resolves to the member it uniquely names", () => {
  const r = resolveTags("can you take this @a9?", MEMBERS);
  assert.deepEqual(r.members, [MEMBERS[0]]);
  assert.equal(r.wakeAll, false);
  assert.equal(r.human, false);
  assert.deepEqual(r.unknown, []);
});

test("the first hash segment also works as a tag", () => {
  assert.deepEqual(resolveTags("@83adfb9c please commit", MEMBERS).members, [MEMBERS[1]]);
});

test("@all / @everyone / @channel / @here flag a whole-room wake", () => {
  for (const t of ["@all", "@everyone", "@channel", "@here"]) {
    const r = resolveTags(`heads up ${t}`, MEMBERS);
    assert.equal(r.wakeAll, true, `${t} → wakeAll`);
    assert.deepEqual(r.members, []);
  }
});

test("@human / @user address the board owner, not a session", () => {
  const r = resolveTags("@human your turn", MEMBERS);
  assert.equal(r.human, true);
  assert.deepEqual(r.members, []);
  assert.equal(r.wakeAll, false);
});

test("an ambiguous prefix wakes every member it matches (safe over-notify)", () => {
  // both members would match "" ; use a shared leading char scenario with crafted ids
  const ids = ["abc111", "abc222", "zzz999"];
  assert.deepEqual(resolveTags("@abc go", ids).members, ["abc111", "abc222"]);
  assert.deepEqual(resolveTags("@z go", ids).members, ["zzz999"]);
});

test("a tag that matches no member is prose, not an error", () => {
  const r = resolveTags("see @nobody about it", MEMBERS);
  assert.deepEqual(r.members, []);
  assert.deepEqual(r.unknown, ["nobody"]);
  assert.equal(r.wakeAll, false);
});

test("mixed: a member tag plus @human resolves both channels", () => {
  const r = resolveTags("@a9 can you confirm, @human fyi", MEMBERS);
  assert.deepEqual(r.members, [MEMBERS[0]]);
  assert.equal(r.human, true);
});

// ── tagging by role NAME (agent-roles.md): a card spawned as a role is named `<RoleName>.<short-sid>`,
// and a tag prefix-matches that name as well as the sid — so `@Oracle` reaches the role, `@Oracle.a8`
// one instance, all through the same prefix mechanism. Members may be {sid,name} entries OR bare sids.
const NAMED = [
  { sid: "a87c860f-1111", name: "Oracle.a87c860f" },
  { sid: "b1234567-2222", name: "Oracle.b1234567" },
  { sid: "c0ffee00-3333", name: "Scribe.c0ffee00" },
];

test("parseTags keeps a Name.sid handle as ONE token (the dot is in the grammar)", () => {
  assert.deepEqual(parseTags("ping @Oracle.a8 now"), ["oracle.a8"]);
  assert.deepEqual(parseTags("ask @Oracle please"), ["oracle"]);
});

test("a tag at the end of a sentence drops the trailing full stop (so it still wakes)", () => {
  // `@26.` must parse to `26`, not `26.` — a sid is dot-free, so the trailing period would orphan the wake.
  assert.deepEqual(parseTags("Hi @26. I'm testing"), ["26"]);
  assert.deepEqual(parseTags("now @26. Please commit"), ["26"]);
  assert.deepEqual(parseTags("done @a9-"), ["a9"]);
  // an INTERNAL dot (the role handle) is preserved; only a TRAILING one is punctuation.
  assert.deepEqual(parseTags("@Oracle.a8. thanks"), ["oracle.a8"]);
  // and it actually resolves: `@26.` reaches the member whose sid starts 26…
  assert.deepEqual(resolveTags("Hi @26. testing", ["26a21ae7-f00"]).members, ["26a21ae7-f00"]);
});

test("@RoleName wakes every live instance of that role", () => {
  const r = resolveTags("@Oracle what's the entry point?", NAMED);
  assert.deepEqual(r.members, ["a87c860f-1111", "b1234567-2222"], "both Oracle instances");
  assert.deepEqual(r.unknown, []);
});

test("@RoleName.sidprefix disambiguates a single instance", () => {
  assert.deepEqual(resolveTags("@Oracle.b1 take this", NAMED).members, ["b1234567-2222"]);
});

test("a bare sid prefix still resolves alongside name matching", () => {
  assert.deepEqual(resolveTags("@c0ffee go", NAMED).members, ["c0ffee00-3333"]);
});

test("resolveTags still accepts bare sid strings (back-compat) — no names known", () => {
  const r = resolveTags("@oracle anyone?", ["oracle-is-an-id-here", "other-id"]);
  assert.deepEqual(r.members, ["oracle-is-an-id-here"], "matches the sid prefix as before");
});

test("a role tag matching nothing is prose, not an error", () => {
  const r = resolveTags("@Ghost around?", NAMED);
  assert.deepEqual(r.members, []);
  assert.deepEqual(r.unknown, ["ghost"]);
});

// ── tagHit / matchTagSpans: the SHARED predicate + span finder the channel-card highlighter consumes, so it
// lights exactly the tags resolveTags wakes (one grammar, no client/server drift). tagHit answers "would this
// single token resolve?" (keyword OR sid/name prefix); matchTagSpans returns the highlight ranges in `text`.

test("tagHit: keyword, sid prefix, and role-name prefix all hit; prose misses", () => {
  for (const kw of ["all", "everyone", "channel", "here", "human", "user"]) {
    assert.equal(tagHit(kw, NAMED), true, `@${kw} is a keyword`);
  }
  assert.equal(tagHit("Oracle", NAMED), true, "role name prefix");
  assert.equal(tagHit("oracle.b1", NAMED), true, "disambiguated role handle");
  assert.equal(tagHit("c0ffee", NAMED), true, "bare sid prefix");
  assert.equal(tagHit("Coordinator", NAMED), false, "no member named Coordinator → miss");
  assert.equal(tagHit("nobody", NAMED), false, "prose → miss");
  assert.equal(tagHit("a9", MEMBERS), true, "bare-sid members still match");
});

test("matchTagSpans: returns the highlight range of each RESOLVING tag only", () => {
  const text = "hey @Oracle and @nobody, ping @all";
  const spans = matchTagSpans(text, NAMED);
  // @Oracle (hit) and @all (keyword hit) — @nobody is prose, no span.
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => text.slice(s.start, s.end)), ["@Oracle", "@all"]);
  assert.deepEqual(spans.map((s) => s.token), ["oracle", "all"]);
});

test("matchTagSpans: a Name.sid handle highlights whole; a trailing full stop stays outside the span", () => {
  const dotted = "ask @Oracle.b1 now";
  assert.deepEqual(
    matchTagSpans(dotted, NAMED).map((s) => dotted.slice(s.start, s.end)),
    ["@Oracle.b1"],
  );
  // trailing sentence punctuation is NOT part of the highlight (matches parseTags' strip).
  const ended = "Hi @c0ffee. done";
  const [sp] = matchTagSpans(ended, NAMED);
  assert.equal(ended.slice(sp.start, sp.end), "@c0ffee", "the period is left unhighlighted");
});

test("matchTagSpans: an email-ish @ is not a tag (no span)", () => {
  assert.deepEqual(matchTagSpans("mail foo@bar.com please", NAMED), []);
});

// ── classifyMentionSpawn (threads-as-cards roadmap step 5): an UNKNOWN @-tag (one resolveTags left in its
// `unknown` bucket) is classified for COLD-SPAWN — @Agent → a seatless plain worker, a known role → its
// first seat, anything else → prose (null). Pure: no server, no spawn — just the routing decision.
const ROLES = [
  { roleId: "pm", name: "Coordinator" },
  { roleId: "generalist", name: "Generalist" },
  { roleId: "oracle", name: "Oracle" },
];

test("classifyMentionSpawn: @Agent (any case) → a seatless plain worker", () => {
  for (const tok of ["agent", "Agent", "AGENT"]) {
    // parseTags lower-cases, but the classifier is defensive about case either way.
    assert.deepEqual(classifyMentionSpawn(tok, ROLES), { kind: "agent" });
  }
});

test("classifyMentionSpawn: a known role by display NAME → its first seat", () => {
  assert.deepEqual(classifyMentionSpawn("coordinator", ROLES), { kind: "role", roleId: "pm", name: "Coordinator" });
  assert.deepEqual(classifyMentionSpawn("oracle", ROLES), { kind: "role", roleId: "oracle", name: "Oracle" });
});

test("classifyMentionSpawn: a known role by roleId slug also matches", () => {
  // `@pm` names the Coordinator role by its filesystem slug, not its display name.
  assert.deepEqual(classifyMentionSpawn("pm", ROLES), { kind: "role", roleId: "pm", name: "Coordinator" });
});

test("classifyMentionSpawn: an unknown token → null (stays prose, no spawn)", () => {
  assert.equal(classifyMentionSpawn("nobody", ROLES), null);
  assert.equal(classifyMentionSpawn("coord", ROLES), null, "partial role name does NOT match (exact only)");
  assert.equal(classifyMentionSpawn("scribe", ROLES), null);
});

test("classifyMentionSpawn: @Agent wins over a role literally named Agent", () => {
  const withAgentRole = [...ROLES, { roleId: "agent", name: "Agent" }];
  assert.deepEqual(classifyMentionSpawn("agent", withAgentRole), { kind: "agent" }, "reserved keyword takes precedence");
});

test("classifyMentionSpawn: tolerates an empty/absent role roster", () => {
  assert.deepEqual(classifyMentionSpawn("agent", undefined), { kind: "agent" });
  assert.equal(classifyMentionSpawn("coordinator", undefined), null);
  assert.equal(classifyMentionSpawn("coordinator", []), null);
});

test("classifyMentionSpawn composes with resolveTags: the unknown bucket is what gets classified", () => {
  // A message @-tagging a role with no current member: resolveTags leaves it unknown, classify routes it.
  const r = resolveTags("@Generalist can you take this?", MEMBERS);
  assert.deepEqual(r.members, [], "no member matched");
  assert.deepEqual(r.unknown, ["generalist"]);
  assert.deepEqual(classifyMentionSpawn(r.unknown[0], ROLES), { kind: "role", roleId: "generalist", name: "Generalist" });
});
