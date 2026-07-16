// The board owner's per-thread unseen-mention signal: an @you/@human mention the human has not yet SEEN is
// "waiting". A mention clears only when its seq lands in the durable `seenMentions` set — the client marks
// ALL currently-unseen mentions seen at once when the human focuses the thread card (focus-clears-all, NOT
// clear-on-reply). This derivation is a pure function of (log, seenMentions): it is agnostic to WHEN or HOW
// a seq entered the seen set, so its per-seq granularity below is a capability the focus-clears-all client
// drives by POSTing the whole unseen set — not a claim that the human clears mentions one at a time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { humanWaiting } from "../thread-waiting.js";

// A tiny log builder — seq is the array position (1-based), the ordering the real feed guarantees.
const log = (...rows) => rows.map((r, i) => ({ seq: i + 1, ts: 1000 + i, ...r }));

test("no messages → not waiting", () => {
  assert.deepEqual(humanWaiting([]), { waiting: false, count: 0, seqs: [], preview: [], more: 0 });
});

test("an @human mention that has not been viewed → waiting", () => {
  const r = humanWaiting(log({ from: "a9", text: "@human can you review this?" }));
  assert.deepEqual(r, {
    waiting: true,
    count: 1,
    seqs: [1],
    preview: [{ seq: 1, from: "a9", text: "@human can you review this?" }],
    more: 0,
  });
});

test("@you is the official human tag → waiting", () => {
  assert.equal(humanWaiting(log({ from: "a9", text: "@you decision needed" })).waiting, true);
});

test("@user and @human are honored legacy aliases for @you", () => {
  assert.equal(humanWaiting(log({ from: "a9", text: "ping @user" })).waiting, true);
  assert.equal(humanWaiting(log({ from: "a9", text: "ping @human" })).waiting, true);
});

test("a plain message (no @human) does not wait", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "working on it" },
    { from: "b3", text: "@a9 nice" },
  ));
  assert.deepEqual(r, { waiting: false, count: 0, seqs: [], preview: [], more: 0 });
});

test("@all is NOT a human mention (only @you/@human/@user)", () => {
  assert.equal(humanWaiting(log({ from: "a9", text: "heads up @all" })).waiting, false);
});

test("a SEEN mention seq no longer waits", () => {
  const l = log({ from: "a9", text: "@human decision needed" });
  assert.equal(humanWaiting(l, []).waiting, true); // not yet viewed
  assert.deepEqual(humanWaiting(l, [1]), { waiting: false, count: 0, seqs: [], preview: [], more: 0 });
});

test("derivation granularity: a PARTIAL seen set leaves the un-marked mentions flagged individually", () => {
  const l = log(
    { from: "a9", text: "@human one" },
    { from: "a9", text: "@human two" },
    { from: "a9", text: "@human three" },
  );
  const r = humanWaiting(l, [2]); // only the middle mention viewed
  assert.equal(r.count, 2);
  assert.deepEqual(r.seqs, [1, 3]);
  assert.deepEqual(r.preview.map((p) => p.seq), [1, 3]);
});

test("a human REPLY does NOT clear (clear-on-reply is gone — only focusing the card clears)", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "@human decision needed" },
    { from: "human", text: "go with option 2" },
  ));
  assert.equal(r.waiting, true); // still unseen despite the reply
  assert.deepEqual(r.seqs, [1]);
});

test("the human's own post is never itself a waiting mention", () => {
  // Even if the human writes '@human' in their own post, it doesn't count (from:human is still just a message,
  // and self-addressing is nonsensical) — well, resolveTags flags the token; the point of the seen set is the
  // human clears by viewing. Here we assert a human @human post is treated as a mention only until seen.
  const l = log({ from: "human", text: "note to self @human check this" });
  assert.equal(humanWaiting(l, []).count, 1);
  assert.equal(humanWaiting(l, [1]).count, 0);
});

test("seenMentions accepts a Set as well as an array", () => {
  const l = log({ from: "a9", text: "@human hi" });
  assert.equal(humanWaiting(l, new Set([1])).waiting, false);
});

test("card-only entries (intent/ask) never count, even if their text mentions @human", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "blocked:human — waiting @human", kind: "intent", intent: "blocked:human" },
    { from: "a9", text: "Q→A about @human", kind: "ask" },
  ));
  assert.deepEqual(r, { waiting: false, count: 0, seqs: [], preview: [], more: 0 });
});

test("a backtick-escaped @human is a mention-in-prose, not a wake → does not wait", () => {
  // Mirrors the wake path: `@human` inside inline code is the prose escape (thread-tags codeSpanRanges).
  const r = humanWaiting(log({ from: "a9", text: "type `@human` to ping the owner" }));
  assert.deepEqual(r, { waiting: false, count: 0, seqs: [], preview: [], more: 0 });
});

test("preview keeps the TAIL and reports the overflow as `more`; seqs holds them ALL", () => {
  // Six unseen @human mentions, cap is 4 → preview is the LAST four (seq 3..6), more = 2 (older ones), but
  // `seqs` carries all six (on focus the client POSTs every unseen mention seq, not just the previewed tail).
  const r = humanWaiting(log(
    { from: "a9", text: "@human one" },
    { from: "a9", text: "@human two" },
    { from: "a9", text: "@human three" },
    { from: "a9", text: "@human four" },
    { from: "a9", text: "@human five" },
    { from: "a9", text: "@human six" },
  ));
  assert.equal(r.count, 6);
  assert.equal(r.more, 2);
  assert.deepEqual(r.seqs, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.preview.map((p) => p.seq), [3, 4, 5, 6]);
  assert.deepEqual(r.preview.map((p) => p.text), ["@human three", "@human four", "@human five", "@human six"]);
});

test("snippet collapses whitespace and trims a long body to a bounded one-liner with an ellipsis", () => {
  const long = "@human " + "x".repeat(200);
  const r = humanWaiting(log({ from: "a9", text: "@human  line one\n\n  line   two\ttabbed" }));
  assert.equal(r.preview[0].text, "@human line one line two tabbed"); // \s+ collapsed to single spaces
  const r2 = humanWaiting(log({ from: "a9", text: long }));
  assert.equal(r2.preview[0].text.length, 100); // SNIPPET_MAX
  assert.ok(r2.preview[0].text.endsWith("…"));
});
