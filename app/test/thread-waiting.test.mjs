// The board owner's per-thread waiting signal: an @you/@human mention newer than the human's own last post
// is "waiting" (clear-on-reply). Pure derivation over the thread log — no server, no cursor, no restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { humanWaiting } from "../thread-waiting.js";

// A tiny log builder — seq is the array position (1-based), the ordering the real feed guarantees.
const log = (...rows) => rows.map((r, i) => ({ seq: i + 1, ts: 1000 + i, ...r }));

test("no messages → not waiting", () => {
  assert.deepEqual(humanWaiting([]), { waiting: false, count: 0 });
});

test("an @human mention with no prior human post → waiting (lastHumanSeq = 0)", () => {
  const r = humanWaiting(log({ from: "a9", text: "@human can you review this?" }));
  assert.deepEqual(r, { waiting: true, count: 1 });
});

test("@user is an alias for @human", () => {
  assert.equal(humanWaiting(log({ from: "a9", text: "ping @user" })).waiting, true);
});

test("a plain message (no @human) does not wait", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "working on it" },
    { from: "b3", text: "@a9 nice" },
  ));
  assert.deepEqual(r, { waiting: false, count: 0 });
});

test("@all is NOT a human mention (only @human/@user)", () => {
  assert.equal(humanWaiting(log({ from: "a9", text: "heads up @all" })).waiting, false);
});

test("clear-on-reply: a human post AFTER the mention clears it", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "@human decision needed" },
    { from: "human", text: "go with option 2" },
  ));
  assert.deepEqual(r, { waiting: false, count: 0 });
});

test("a mention AFTER the human's last post re-arms it", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "@human first ask" },
    { from: "human", text: "answered" },
    { from: "a9", text: "@human follow-up ask" },
  ));
  assert.deepEqual(r, { waiting: true, count: 1 });
});

test("count is only the mentions past the human's last post", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "@human one" }, // addressed by the human post below
    { from: "human", text: "ok" },
    { from: "a9", text: "@human two" },
    { from: "b3", text: "@human three" },
    { from: "b3", text: "plain, no tag" },
  ));
  assert.deepEqual(r, { waiting: true, count: 2 });
});

test("card-only entries (intent/ask) never count, even if their text mentions @human", () => {
  const r = humanWaiting(log(
    { from: "a9", text: "blocked:human — waiting @human", kind: "intent", intent: "blocked:human" },
    { from: "a9", text: "Q→A about @human", kind: "ask" },
  ));
  assert.deepEqual(r, { waiting: false, count: 0 });
});

test("a backtick-escaped @human is a mention-in-prose, not a wake → does not wait", () => {
  // Mirrors the wake path: `@human` inside inline code is the prose escape (thread-tags codeSpanRanges).
  const r = humanWaiting(log({ from: "a9", text: "type `@human` to ping the owner" }));
  assert.deepEqual(r, { waiting: false, count: 0 });
});
