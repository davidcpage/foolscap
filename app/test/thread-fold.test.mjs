// Unit tests for thread-fold.js — the read-time fold of amendment events (message edit + tombstone delete)
// and the pure edit-guardrail decision. No server; pure logic (like thread-tags/cas-guard tests).

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldAmendments, checkEdit, mentionSet, DELETED_STUB } from "../thread-fold.js";

const msg = (seq, text, extra = {}) => ({ seq, ts: 1_700_000_000_000 + seq, from: "a", text, ...extra });
const edit = (seq, target, text, extra = {}) => ({ seq, ts: 1_700_000_000_000 + seq, from: "a", text, kind: "edit", target, ...extra });

// ── foldAmendments ────────────────────────────────────────────────────────────────────────────────

test("foldAmendments: no amendments returns the SAME array reference (fast path, no copy)", () => {
  const log = [msg(1, "one"), msg(2, "two", { kind: "intent", intent: "working" })];
  assert.equal(foldAmendments(log), log);
});

test("foldAmendments: an edit replaces the target's text and drops the edit event", () => {
  const log = [msg(1, "teh cat"), edit(2, 1, "the cat")];
  const out = foldAmendments(log);
  assert.deepEqual(out.map((m) => m.seq), [1], "the kind:edit event is never itself projected");
  assert.equal(out[0].text, "the cat");
  assert.equal(out[0].edited, true);
  assert.equal(out[0].originalText, "teh cat");
  assert.equal(out[0].editedBy, "a");
});

test("foldAmendments: LAST edit per target wins (a re-edit overrides an earlier one)", () => {
  const log = [msg(1, "v0"), edit(2, 1, "v1"), edit(3, 1, "v2")];
  const out = foldAmendments(log);
  assert.deepEqual(out.map((m) => m.seq), [1]);
  assert.equal(out[0].text, "v2");
  assert.equal(out[0].originalText, "v0", "original is the true original, not the intermediate edit");
});

test("foldAmendments: a tombstone delete renders the stub, keeps seq + author, drops the event", () => {
  const log = [msg(1, "oops"), edit(2, 1, "", { deleted: true })];
  const out = foldAmendments(log);
  assert.deepEqual(out.map((m) => m.seq), [1], "the target survives (as a tombstone); the edit event is dropped");
  assert.equal(out[0].text, DELETED_STUB);
  assert.equal(out[0].deleted, true);
  assert.equal(out[0].deletedBy, "a");
  assert.equal(out[0].from, "a", "the author is preserved so #seq references still resolve");
});

test("foldAmendments: an edit AFTER a delete (last-wins) restores text — a tombstone is not terminal", () => {
  const log = [msg(1, "hi"), edit(2, 1, "", { deleted: true }), edit(3, 1, "back")];
  const out = foldAmendments(log);
  assert.equal(out[0].text, "back");
  assert.equal(out[0].edited, true);
  assert.ok(!out[0].deleted);
});

test("foldAmendments: non-targeted messages and card-only entries pass through unchanged", () => {
  const intent = msg(2, "working", { kind: "intent", intent: "working" });
  const log = [msg(1, "keep"), intent, msg(3, "amend me"), edit(4, 3, "amended")];
  const out = foldAmendments(log);
  assert.deepEqual(out.map((m) => m.seq), [1, 2, 3]);
  assert.equal(out[0], log[0], "an unamended message is the same object (no needless copy)");
  assert.equal(out[1], intent, "a card-only intent act is untouched");
  assert.equal(out[2].text, "amended");
});

test("foldAmendments: an edit targeting a scrolled-out seq (no such message) simply drops the orphan event", () => {
  const log = [msg(5, "only recent"), edit(6, 1, "target not in this window")];
  const out = foldAmendments(log);
  assert.deepEqual(out.map((m) => m.seq), [5], "the orphan edit event is dropped; no phantom message is invented");
});

test("foldAmendments: tolerates a null/garbage log", () => {
  assert.deepEqual(foldAmendments(null), []);
  assert.deepEqual(foldAmendments(undefined), []);
});

// ── mentionSet ────────────────────────────────────────────────────────────────────────────────────

test("mentionSet: order-independent, deduped, backtick-escaped tags excluded", () => {
  assert.equal(mentionSet("@a9 hi @all"), mentionSet("@all yo @a9"));
  assert.notEqual(mentionSet("@a9 hi"), mentionSet("@a9 @b7 hi"));
  assert.equal(mentionSet("no tags"), mentionSet("still none"));
  assert.equal(mentionSet("a mention of `@a9` in code"), mentionSet("a plain sentence"), "an in-code @handle is not a mention");
});

// ── checkEdit (the guardrails) ──────────────────────────────────────────────────────────────────────

test("checkEdit: 404 on a missing target", () => {
  const v = checkEdit(null, "x", { fromSid: "a" });
  assert.equal(v.ok, false);
  assert.equal(v.status, 404);
});

test("checkEdit: 409 — a card-only entry (ask/intent) is immutable", () => {
  const v = checkEdit(msg(1, "working", { kind: "intent" }), "nope", { fromSid: "a" });
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
});

test("checkEdit: 403 — author-only for an agent editing another's message", () => {
  const target = { seq: 1, ts: 1, from: "b", text: "b's message" };
  const v = checkEdit(target, "hijack", { fromSid: "a", isHuman: false });
  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
  // the human (isHuman) bypasses author-only
  assert.equal(checkEdit(target, "fix", { fromSid: "human", isHuman: true }).ok, true);
});

test("checkEdit: author may edit their own; mention-set invariance rejects a tag change", () => {
  const target = { seq: 1, ts: 1, from: "a", text: "hi @a9" };
  assert.equal(checkEdit(target, "hello @a9", { fromSid: "a", isHuman: false }).ok, true, "same mention set → allowed");
  const bad = checkEdit(target, "hi @a9 @b7", { fromSid: "a", isHuman: false });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  const removed = checkEdit(target, "hi", { fromSid: "a", isHuman: false });
  assert.equal(removed.ok, false, "removing a tag is also rejected");
  assert.equal(removed.status, 400);
});

test("checkEdit: a DELETE (newText null) is exempt from mention-set invariance", () => {
  const target = { seq: 1, ts: 1, from: "a", text: "ping @a9 @all" };
  assert.equal(checkEdit(target, null, { fromSid: "a", isHuman: false }).ok, true, "self-delete of a mentioning message is allowed");
});
