// Channel @-tag resolution: who a post wakes (prefix of a member sid), the @all / @human keywords, and the
// "a tag is prose unless it matches" tolerance. Pure — no server, no restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTags, resolveTags } from "../channel-tags.js";

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
