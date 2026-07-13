// The compare-and-swap guards (wakeable-substrate-plan.md W11 + W12): the pure logic behind the
// mention-gated thread-post reject and the doc-edit baseVersion→409 optimistic lock. Wiring (the HTTP
// 409 shape) lives in vite-fs-plugin.ts; here we pin the decision logic the handlers delegate to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unreadMentions, senderCursorAfterPost, contentVersion, isStaleWrite } from "../cas-guard.js";

// ── W11 — mention-gated thread-post guard ────────────────────────────────────────────────────────

const A = "9b58d109-d301-4bd5-a569-2a92f647ca42"; // the poster
const B = "be5d5798-2b17-4a25-ab90-eb77eee1deff"; // a peer
const members = [
  { sid: A, name: "Worker.9b58d109" },
  { sid: B, name: "Coordinator.be5d5798" },
];

test("W11 blocks a post when an unread message @-mentions the poster", () => {
  const log = [
    { seq: 1, from: B, text: "kicking things off" },
    { seq: 2, from: B, text: "@9b58 your task: build the pair" },
  ];
  // cursor at 1 → seq 2 (the mention) is unread → it blocks.
  const blocking = unreadMentions({ log, cursor: 1, from: A, members });
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].seq, 2);
});

test("W11 clears once the poster has read past the mention (the CAS resolves)", () => {
  const log = [{ seq: 2, from: B, text: "@9b58 your task" }];
  // cursor advanced to 2 (a GET /api/inbox read it) → nothing unread → post allowed.
  assert.equal(unreadMentions({ log, cursor: 2, from: A, members }).length, 0);
});

test("W11 does NOT block on ambient unread that doesn't mention the poster", () => {
  const log = [
    { seq: 1, from: B, text: "status: kicking W5" },
    { seq: 2, from: B, text: "@be5d I'll take the next one" }, // mentions B, not A
  ];
  assert.equal(unreadMentions({ log, cursor: 0, from: A, members }).length, 0);
});

test("W11 does NOT treat an @all broadcast as a mention (avoids over-blocking on room chatter)", () => {
  const log = [{ seq: 1, from: B, text: "@all standup in 5" }];
  assert.equal(unreadMentions({ log, cursor: 0, from: A, members }).length, 0);
});

test("W11 ignores card-only entries (intents/asks/pins wake no one, so never gate a post)", () => {
  const log = [
    { seq: 1, from: B, text: "@9b58 blocked:human — need a nod", kind: "intent" },
    { seq: 2, from: B, text: "@9b58 (ask echo)", kind: "ask" },
  ];
  assert.equal(unreadMentions({ log, cursor: 0, from: A, members }).length, 0);
});

test("W11 ignores the poster's OWN unread messages, even if self-tagged", () => {
  const log = [{ seq: 1, from: A, text: "@9b58 note to self" }];
  assert.equal(unreadMentions({ log, cursor: 0, from: A, members }).length, 0);
});

test("W11 matches a mention by role-name handle, not just sid prefix", () => {
  const log = [{ seq: 1, from: B, text: "@Worker can you take this?" }];
  const blocking = unreadMentions({ log, cursor: 0, from: A, members });
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].seq, 1);
});

test("W11 accepts bare-sid member entries (the original shape) and a missing cursor as 0", () => {
  const log = [{ seq: 1, from: B, text: `@${A.slice(0, 8)} ping` }];
  const blocking = unreadMentions({ log, from: A, members: [A, B] }); // no cursor → treated as 0
  assert.equal(blocking.length, 1);
});

test("W11 blocks on ANY unread mention among several, returning them all in order", () => {
  const log = [
    { seq: 5, from: B, text: "@9b58 one" },
    { seq: 6, from: B, text: "unrelated" },
    { seq: 7, from: B, text: "@9b58 two" },
  ];
  const blocking = unreadMentions({ log, cursor: 4, from: A, members });
  assert.deepEqual(blocking.map((m) => m.seq), [5, 7]);
});

test("W11 tolerates an empty/absent log", () => {
  assert.equal(unreadMentions({ log: [], cursor: 0, from: A, members }).length, 0);
  assert.equal(unreadMentions({ from: A, members }).length, 0);
});

// ── W11 (write half) — sender cursor after its own post never skips an interleaved unread ─────────

test("senderCursorAfterPost advances to ownSeq only when the sender was fully caught up", () => {
  // Caught up: cursor at the log's prior max (ownSeq-1) ⇒ safe to mark the own post read.
  assert.equal(senderCursorAfterPost(4, 5), 5);
  // First message ever (prevMax 0, cursor 0) ⇒ advances to 1 (nothing preceded it).
  assert.equal(senderCursorAfterPost(0, 1), 1);
});

test("senderCursorAfterPost HOLDS the cursor when unread messages from others interleaved (no silent skip)", () => {
  // Sender read up to seq 1, but seq 2 (from someone else) arrived before it posts seq 3. Jumping to 3 would
  // swallow seq 2 — the live repro. The cursor must stay at 1 so seq 2 is served on the next read.
  assert.equal(senderCursorAfterPost(1, 3), 1);
  // A wide gap holds just the same (many interleaved unread).
  assert.equal(senderCursorAfterPost(0, 401), 0);
});

test("senderCursorAfterPost treats a missing cursor as 0 and never moves it BACKWARD", () => {
  assert.equal(senderCursorAfterPost(undefined, 1), 1, "no prior cursor + first post ⇒ caught up");
  assert.equal(senderCursorAfterPost(undefined, 5), 0, "no prior cursor + a tail already present ⇒ hold at 0");
  // It only ever returns ownSeq (forward) or the current cursor (unchanged) — never a value below the cursor.
  assert.equal(senderCursorAfterPost(10, 5), 10, "a stale ownSeq below the cursor leaves the cursor put");
});

// ── W12 — doc-edit optimistic concurrency ────────────────────────────────────────────────────────

test("W12 contentVersion is deterministic and content-sensitive", () => {
  assert.equal(contentVersion("hello"), contentVersion("hello"));
  assert.notEqual(contentVersion("hello"), contentVersion("hello!"));
  assert.match(contentVersion("hello"), /^[0-9a-f]{16}$/);
});

test("W12 contentVersion treats a string and its utf8 Buffer identically", () => {
  assert.equal(contentVersion("café ☕"), contentVersion(Buffer.from("café ☕", "utf8")));
});

test("W12 contentVersion of absent content is null (the version of 'no file yet')", () => {
  assert.equal(contentVersion(null), null);
  assert.equal(contentVersion(undefined), null);
});

test("W12 isStaleWrite: a matching baseVersion passes, a moved one is stale", () => {
  const v = contentVersion("original");
  assert.equal(isStaleWrite(v, v), false); // read v, nothing changed → write proceeds
  assert.equal(isStaleWrite(v, contentVersion("edited by a peer")), true); // peer moved it → 409
});

test("W12 isStaleWrite handles the create case (absent → absent) and the deleted case", () => {
  assert.equal(isStaleWrite(null, null), false); // create-when-absent: baseVersion null, no file → fresh
  assert.equal(isStaleWrite(contentVersion("was here"), null), true); // file deleted under us → stale
  assert.equal(isStaleWrite(null, contentVersion("appeared")), true); // expected absent, someone created it
});
