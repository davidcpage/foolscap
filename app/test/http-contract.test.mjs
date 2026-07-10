// The agent-facing HTTP contracts, exercised against a LIVE dev server on a throwaway scratch board.
// These are the semantics CLAUDE.md documents as gotchas and agents script against — the status codes
// are the API. The whole file SKIPS (cleanly, not silently: one skip line per test) when no server
// answers on 5173, so `npm test` stays hermetic; with `npm run dev` up it becomes a real end-to-end
// probe of the middleware. Everything here targets a scratch board mounted from a tmpdir — never the
// dev repo's real board (a curl-write there can poison the one-time IndexedDB adoption).
//
// Hermetic (no-server-needed) middleware tests — the payoff of the vite-fs-plugin split, once the pinned
// state rides an explicit context object — now live in middleware-hermetic.test.mjs (pure fs/snapshot
// resolvers + handlers wired to a fake ServerContext). This file remains the LIVE end-to-end contract net
// for the status-code semantics that only a real server exercises.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Default to the canonical dev port; CANVAS_TEST_HOST points the contract net at another running server
// (e.g. a worktree's server on an alternate port, so a change can be verified end-to-end before it merges).
const HOST = process.env.CANVAS_TEST_HOST || "http://127.0.0.1:5173";

async function serverUp() {
  try {
    const res = await fetch(`${HOST}/api/boards`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await serverUp();
// A STABLE scratch path (not mkdtemp): boardId hashes the realpath, so a fixed path means one
// registry row in the dev repo's boards.json, upserted per run — a fresh tmpdir per run would leave
// an accumulating row each time. Leftover state from a crashed run is handled by clearing the board
// store right after the mount; the thread test keys by a per-run thread id for the same reason.
const scratch = up ? path.join(os.tmpdir(), "canvas-contract-board") : null;
if (scratch) fs.mkdirSync(scratch, { recursive: true });
const runTag = Math.random().toString(36).slice(2, 8);
let boardId = null;

const j = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("mount: POST /api/boards is idempotent and mints a stable boardId", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(`${HOST}/api/boards`, j({ repoPath: scratch }));
  assert.equal(res.status, 200);
  const first = await res.json();
  assert.match(first.boardId, /^[a-z0-9-]+-[0-9a-f]{8}$/);
  const again = await (await fetch(`${HOST}/api/boards`, j({ repoPath: scratch }))).json();
  assert.equal(again.boardId, first.boardId);
  boardId = first.boardId;
  // Start from a clean store — a previous run that died before its cleanup must not skew the
  // watermark assertions below.
  assert.equal((await fetch(`${HOST}/api/board/persist?board=${boardId}`, { method: "DELETE" })).status, 200);
});

test("unknown ?board= is 400 on persist, 503-not-404 never leaks", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(`${HOST}/api/board/persist?board=no-such-board-00000000`);
  assert.equal(res.status, 400);
});

test("snapshot watermark: fresh saves land, a stale save is 409 and does not clobber", { skip: !up && "no dev server on 5173" }, async () => {
  const snapUrl = `${HOST}/api/board/persist/snapshot?board=${boardId}`;
  assert.equal((await fetch(snapUrl, j({ snapshot: { seq: 5, version: 1, records: [] } }))).status, 200);
  const stale = await fetch(snapUrl, j({ snapshot: { seq: 3, version: 1, records: [] } }));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "stale snapshot", storedSeq: 5, gotSeq: 3 });
  assert.equal((await fetch(snapUrl, j({ snapshot: { seq: 6, version: 2, records: [] } }))).status, 200);
  const read = await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json();
  assert.equal(read.snapshot.seq, 6); // the stale write left no mark
});

test("GET /api/canvas works with NO tab live and carries tabs as the liveness signal", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(`${HOST}/api/canvas?board=${boardId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tabs, 0); // nobody can ACT on this board; the read still worked
  assert.ok(body.snapshot);
});

test("POST /api/command with no tab on the board is 503 {delivered:0}", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(
    `${HOST}/api/command?board=${boardId}`,
    j({ type: "removeNode", actor: "user", payload: { id: "node:none" } }),
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).delivered, 0);
});

// NOTE: the end-to-end contract for the Bug B/C id-echo (POST /api/command addNode without an id returns
// the SERVER-minted node id) is exercised in a self-standing runner (npm run — see the branch handoff),
// NOT here: this file targets the ALWAYS-ON 5173 server, which serves the main checkout's plugin code and
// won't carry the fix until it's merged AND the dev server is manually restarted (the documented
// dev-server-serves-stale-plugin-code footgun). Adding it here would red-fail the merge-on-green gate
// against the still-stale shared server. The minting LOGIC is covered hermetically in middleware-hermetic.

test("thread append lazy-seeds from the on-disk ledger — never mints seq 1 onto a real tail", { skip: !up && "no dev server on 5173" }, async () => {
  // Per-run id: the server's in-memory thread log is pinned for the process, so re-using one id
  // across runs would serve the previous run's in-memory tail instead of exercising the lazy seed.
  const threadId = `node:thread:contract-${runTag}`;
  // A ledger tail written AFTER mount is exactly the never-seeded case (mount's boot seed ran before
  // the file existed — same shape as a board re-registered from boards.json with no tab ever mounted).
  const dir = path.join(scratch, ".canvas", "threads");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, encodeURIComponent(threadId) + ".jsonl"),
    JSON.stringify({ seq: 400, ts: 1, from: "human", text: "old tail" }) + "\n",
  );
  const snapUrl = `${HOST}/api/board/persist/snapshot?board=${boardId}`;
  await fetch(snapUrl, j({ snapshot: { seq: 7, version: 3, records: [{ typeName: "node", id: threadId, type: "thread", title: "Contract" }] } }));
  const res = await fetch(
    `${HOST}/api/thread/${encodeURIComponent(threadId)}/message?board=${boardId}`,
    j({ from: "human", text: "fresh" }),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).seq, 401);
});

test("thread pin (R-PIN): pin → unpin round-trip, snapshots head context, 400/404 on bad input", { skip: !up && "no dev server on 5173" }, async () => {
  const threadId = `node:thread:pin-${runTag}`;
  await fetch(
    `${HOST}/api/board/persist/snapshot?board=${boardId}`,
    j({ snapshot: { seq: 30, version: 3, records: [{ typeName: "node", id: threadId, type: "thread", title: "Pin" }] } }),
  );
  // Post a couple of messages to pin.
  await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/message?board=${boardId}`, j({ from: "human", text: "Done when: tests green" }));
  const m2 = await (await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/message?board=${boardId}`, j({ from: "human", text: "chatter" }))).json();
  const doneSeq = m2.seq - 1;
  // Pin the done-condition (bare call defaults pinned:true) — the response carries the pin snapshot.
  const pinRes = await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/pin?board=${boardId}`, j({ from: "human", seq: doneSeq }));
  assert.equal(pinRes.status, 200);
  const pinned = await pinRes.json();
  assert.equal(pinned.pinned, true);
  assert.deepEqual(pinned.pins.map((p) => p.seq), [doneSeq]);
  assert.equal(pinned.pins[0].text, "Done when: tests green", "the pin is a snapshot of the message text");
  // Re-pinning is idempotent; pinning a second message keeps them chronological.
  await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/pin?board=${boardId}`, j({ from: "human", seq: doneSeq }));
  const two = await (await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/pin?board=${boardId}`, j({ from: "human", seq: m2.seq }))).json();
  assert.deepEqual(two.pins.map((p) => p.seq), [doneSeq, m2.seq]);
  // Unpin.
  const un = await (await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/pin?board=${boardId}`, j({ from: "human", seq: doneSeq, pinned: false }))).json();
  assert.deepEqual(un.pins.map((p) => p.seq), [m2.seq]);
  // Bad input: a non-integer seq is 400; a seq with no message is 404.
  assert.equal((await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/pin?board=${boardId}`, j({ from: "human", seq: "x" }))).status, 400);
  assert.equal((await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/pin?board=${boardId}`, j({ from: "human", seq: 99999 }))).status, 404);
});

test("thread and channel API paths are aliases", { skip: !up && "no dev server on 5173" }, async () => {
  const a = await (await fetch(`${HOST}/api/threads?board=${boardId}`)).json();
  const b = await (await fetch(`${HOST}/api/channels?board=${boardId}`)).json();
  assert.deepEqual(
    a.threads.map((t) => t.threadId),
    b.threads.map((t) => t.threadId),
  );
  assert.ok(Array.isArray(a.channels)); // the response ships both keys during the rename
});

test("session verbs on an unknown session: input 409/404-class, inbox 404", { skip: !up && "no dev server on 5173" }, async () => {
  const ghost = "00000000-0000-0000-0000-000000000000";
  const inbox = await fetch(`${HOST}/api/inbox?session=${ghost}`);
  assert.equal(inbox.status, 404); // the documented liveness probe
  const input = await fetch(`${HOST}/api/session/${ghost}/input`, j({ text: "hi" }));
  assert.ok([404, 409].includes(input.status)); // not-live is an error, never a silent 200
});

test("annotations: create → reply → resolve → re-anchor round-trip, orphan derived at read", { skip: !up && "no dev server on 5173" }, async () => {
  // A clean ledger per run (the scratch dir persists across runs on purpose — stable boardId).
  fs.rmSync(path.join(scratch, ".canvas", "annotations"), { recursive: true, force: true });
  const doc = `docs/notes-${runTag}.md`;
  fs.mkdirSync(path.join(scratch, "docs"), { recursive: true });
  fs.writeFileSync(path.join(scratch, doc), "# Notes\n\nThe quick brown fox jumps over the lazy dog.\n");
  const post = (body) => fetch(`${HOST}/api/annotations?board=${boardId}`, j(body));
  const state = async () =>
    (await (await fetch(`${HOST}/api/annotations?board=${boardId}&path=${encodeURIComponent(doc)}`)).json());

  // Create: server-side write, no live tab anywhere near this board.
  const created = await post({
    path: doc,
    op: "create",
    anchor: { exact: "quick brown fox", prefix: "The ", suffix: " jumps", offset: 13 },
    text: "why a fox?",
    author: "human",
  });
  assert.equal(created.status, 200);
  const { id, orphaned } = await created.json();
  assert.match(id, /^anno:/);
  assert.equal(orphaned, false, "a fresh anchor against the live file resolves");

  // Reply lands on the fold; the read derives a resolved range against the current bytes.
  assert.equal((await post({ path: doc, op: "reply", id, from: "s1", text: "narrative color" })).status, 200);
  let s = await state();
  assert.equal(s.annotations.length, 1);
  assert.equal(s.annotations[0].replies[0].text, "narrative color");
  assert.equal(s.annotations[0].orphaned, false);
  assert.equal(s.annotations[0].range.start, 13);

  // Resolve closes it; the no-path sweep counts opens per file.
  assert.equal((await post({ path: doc, op: "resolve", id, by: "human" })).status, 200);
  const sweep = await (await fetch(`${HOST}/api/annotations?board=${boardId}`)).json();
  const mine = sweep.files.find((f) => f.path === doc);
  assert.deepEqual(mine, { path: doc, total: 1, open: 0, orphaned: 0, awaiting: 0, answered: 0, watched: 0, watchers: [] });

  // Edit the quote away: reopened, the annotation reads ORPHANED (quote intact — the payload), never dropped.
  assert.equal((await post({ path: doc, op: "reopen", id, by: "human" })).status, 200);
  fs.writeFileSync(path.join(scratch, doc), "# Notes\n\nEntirely rewritten body.\n");
  s = await state();
  assert.equal(s.annotations[0].orphaned, true);
  assert.equal(s.annotations[0].range, null);
  assert.equal(s.annotations[0].anchor.exact, "quick brown fox");

  // Re-anchor onto the new text (the §4 agent maintenance move) and it resolves again.
  assert.equal(
    (await post({ path: doc, op: "reanchor", id, anchor: { exact: "Entirely rewritten" }, by: "s1" })).status,
    200,
  );
  s = await state();
  assert.equal(s.annotations[0].orphaned, false);
});

test("annotations: the status codes are the API — 400 bad op/fields, 404 blocked path / unknown id", { skip: !up && "no dev server on 5173" }, async () => {
  const doc = `docs/notes-${runTag}.md`;
  const post = (body) => fetch(`${HOST}/api/annotations?board=${boardId}`, j(body));
  assert.equal((await post({ op: "create" })).status, 400); // no path
  assert.equal((await post({ path: doc, op: "sideways", id: "anno:x" })).status, 404); // unknown id checked first…
  assert.equal((await post({ path: doc, op: "create", anchor: { exact: "x" }, text: "q" })).status, 400); // …author missing
  // A blocked path (no text ext / internal) 404s like the file read — never confirms it exists.
  const blocked = await post({
    path: ".env", op: "create", anchor: { exact: "x" }, text: "q", author: "human",
  });
  assert.equal(blocked.status, 404);
  // Ops against an id nobody created: 404, and reply field validation is 400 on a known id.
  assert.equal((await post({ path: doc, op: "reply", id: "anno:ghost", from: "s1", text: "hi" })).status, 404);
  // GET of a never-annotated file is an empty list, not an error.
  const empty = await (await fetch(`${HOST}/api/annotations?board=${boardId}&path=never%2Fwas.md`)).json();
  assert.deepEqual(empty.annotations, []);
});

test("annotations: anchored async-ask — question create → answer → awaiting/answered sweep (W1)", { skip: !up && "no dev server on 5173" }, async () => {
  const doc = `docs/ask-${runTag}.md`;
  fs.mkdirSync(path.join(scratch, "docs"), { recursive: true });
  fs.writeFileSync(path.join(scratch, doc), "# Ask\n\nThe wake model for R2 is undecided here.\n");
  const post = (body) => fetch(`${HOST}/api/annotations?board=${boardId}`, j(body));
  const state = async () =>
    (await (await fetch(`${HOST}/api/annotations?board=${boardId}&path=${encodeURIComponent(doc)}`)).json());
  const sweepFor = async () =>
    (await (await fetch(`${HOST}/api/annotations?board=${boardId}`)).json()).files.find((f) => f.path === doc);

  // Raise a blocking, multiple-choice question anchored to the undecided span.
  const created = await post({
    path: doc,
    op: "create",
    kind: "question",
    anchor: { exact: "wake model for R2", prefix: "The ", suffix: " is" },
    text: "Which wake model?",
    author: "sess-asker",
    options: ["Always-wake", { label: "Tag-gated", description: "only @-mentions" }],
    blocking: true,
  });
  assert.equal(created.status, 200);
  const cj = await created.json();
  assert.equal(cj.kind, "question");
  assert.equal(cj.state, "awaiting", "a fresh question is born awaiting");
  const id = cj.id;

  // The read badges it a question awaiting a human, with its options and blocking flag.
  let s = await state();
  assert.equal(s.annotations[0].kind, "question");
  assert.equal(s.annotations[0].state, "awaiting");
  assert.equal(s.annotations[0].blocking, true);
  assert.deepEqual(s.annotations[0].options.map((o) => o.label), ["Always-wake", "Tag-gated"]);
  // The sweep counts it as awaiting a human, not just an open comment.
  assert.equal((await sweepFor()).awaiting, 1);
  assert.equal((await sweepFor()).answered, 0);

  // Answering a note-shaped comment is a category error; a question needs by + (choice|text).
  assert.equal((await post({ path: doc, op: "answer", id })).status, 400); // no by
  assert.equal((await post({ path: doc, op: "answer", id, by: "human" })).status, 400); // no choice/text

  // Human answers with an option choice + prose → awaiting flips to answered.
  assert.equal(
    (await post({ path: doc, op: "answer", id, by: "human", choice: "Tag-gated", text: "keep it gated" })).status,
    200,
  );
  s = await state();
  assert.equal(s.annotations[0].state, "answered");
  assert.equal(s.annotations[0].answer.choice, "Tag-gated");
  assert.equal(s.annotations[0].replies.at(-1).choice, "Tag-gated", "the answer rides the conversation view");
  assert.equal((await sweepFor()).awaiting, 0);
  assert.equal((await sweepFor()).answered, 1, "now it needs an agent to apply");

  // The asker resolves once applied → no longer counted awaiting/answered.
  assert.equal((await post({ path: doc, op: "resolve", id, by: "sess-asker" })).status, 200);
  assert.equal((await state()).annotations[0].state, "resolved");
  const swept = await sweepFor();
  assert.equal(swept.awaiting, 0);
  assert.equal(swept.answered, 0);
});

test("annotations: suggestion track-changes — create → ACCEPT applies to bytes, another → REJECT leaves bytes", { skip: !up && "no dev server on 5173" }, async () => {
  const doc = `docs/suggest-${runTag}.md`;
  fs.mkdirSync(path.join(scratch, "docs"), { recursive: true });
  const body0 = "# Draft\n\nThe quick brown fox jumps over the lazy dog.\n";
  fs.writeFileSync(path.join(scratch, doc), body0);
  const abs = path.join(scratch, doc);
  const post = (b) => fetch(`${HOST}/api/annotations?board=${boardId}`, j(b));
  const state = async () =>
    (await (await fetch(`${HOST}/api/annotations?board=${boardId}&path=${encodeURIComponent(doc)}`)).json());

  // A suggestion needs a replacement string (a create without one is 400).
  assert.equal(
    (await post({ path: doc, op: "create", kind: "suggestion", anchor: { exact: "quick brown fox" }, text: "tighten", author: "sess-1" })).status,
    400,
  );

  // Create a suggestion proposing to replace the span "quick brown fox" → "swift red fox".
  const c1 = await post({
    path: doc, op: "create", kind: "suggestion",
    anchor: { exact: "quick brown fox", prefix: "The ", suffix: " jumps", offset: 13 },
    text: "tighten the phrasing", replacement: "swift red fox", author: "sess-1",
  });
  assert.equal(c1.status, 200);
  const cj1 = await c1.json();
  assert.equal(cj1.kind, "suggestion");
  assert.equal(cj1.state, "pending", "a fresh suggestion is born pending");
  const id1 = cj1.id;
  // The read badges it a pending suggestion carrying its replacement.
  let s = await state();
  let a1 = s.annotations.find((a) => a.id === id1);
  assert.equal(a1.kind, "suggestion");
  assert.equal(a1.state, "pending");
  assert.equal(a1.replacement, "swift red fox");

  // accept/reject validate their target: not-a-suggestion / missing by.
  assert.equal((await post({ path: doc, op: "accept", id: id1 })).status, 400); // no by

  // ACCEPT: the replacement lands in the file's bytes and the suggestion resolves accepted.
  const acc = await post({ path: doc, op: "accept", id: id1, by: "human" });
  assert.equal(acc.status, 200);
  assert.equal((await acc.json()).applied, true);
  assert.equal(fs.readFileSync(abs, "utf8"), "# Draft\n\nThe swift red fox jumps over the lazy dog.\n", "accept spliced the span into the file");
  s = await state();
  a1 = s.annotations.find((a) => a.id === id1);
  assert.equal(a1.state, "accepted");
  assert.equal(a1.resolved, true);
  // A second decision on an already-decided suggestion is refused (terminal).
  assert.equal((await post({ path: doc, op: "accept", id: id1, by: "human" })).status, 409);
  assert.equal((await post({ path: doc, op: "reject", id: id1, by: "human" })).status, 409);

  // Create a second suggestion, then REJECT it — the bytes must be untouched.
  const bytesBeforeReject = fs.readFileSync(abs, "utf8");
  const c2 = await post({
    path: doc, op: "create", kind: "suggestion",
    anchor: { exact: "lazy dog", prefix: "the ", suffix: ".\n" },
    text: "no", replacement: "sleeping cat", author: "sess-1",
  });
  assert.equal(c2.status, 200);
  const id2 = (await c2.json()).id;
  const rej = await post({ path: doc, op: "reject", id: id2, by: "human" });
  assert.equal(rej.status, 200);
  assert.equal((await rej.json()).applied, false);
  assert.equal(fs.readFileSync(abs, "utf8"), bytesBeforeReject, "reject leaves the file's bytes untouched");
  s = await state();
  assert.equal(s.annotations.find((a) => a.id === id2).state, "rejected");

  // Accepting an ORPHANED suggestion (its span isn't in the doc) is refused 409 — can't apply a gone span.
  const c3 = await post({
    path: doc, op: "create", kind: "suggestion",
    anchor: { exact: "a span that does not exist in the doc at all" },
    text: "x", replacement: "y", author: "sess-1",
  });
  const c3j = await c3.json();
  assert.equal(c3j.orphaned, true, "an anchor that doesn't resolve is born orphaned");
  assert.equal((await post({ path: doc, op: "accept", id: c3j.id, by: "human" })).status, 409, "an orphaned suggestion can't be applied");
});

test("doc-watch (P1/W4): watch → re-level → pause/resume → unwatch, surfaced in read + sweep", { skip: !up && "no dev server on 5173" }, async () => {
  const doc = `docs/watch-${runTag}.md`;
  fs.mkdirSync(path.join(scratch, "docs"), { recursive: true });
  fs.writeFileSync(path.join(scratch, doc), "# Watched\n\nA doc that carries a watcher seat.\n");
  const post = (body) => fetch(`${HOST}/api/annotations?board=${boardId}`, j(body));
  const watchers = async () =>
    (await (await fetch(`${HOST}/api/annotations?board=${boardId}&path=${encodeURIComponent(doc)}`)).json()).watchers;
  const sweepFor = async () =>
    (await (await fetch(`${HOST}/api/annotations?board=${boardId}`)).json()).files.find((f) => f.path === doc);

  // Bad input: a watch needs a role; a watch on a blocked path 404s like create.
  assert.equal((await post({ path: doc, op: "watch" })).status, 400);
  assert.equal((await post({ path: ".env", op: "watch", role: "Coordinator" })).status, 404);
  // Pausing a not-yet-armed watcher is a 404 (nothing to pause).
  assert.equal((await post({ path: doc, op: "pause", role: "Coordinator" })).status, 404);

  // Arm a watcher — defaults to level `all`, state active; it surfaces on the read and the sweep.
  const armed = await post({ path: doc, op: "watch", role: "Coordinator", by: "human" });
  assert.equal(armed.status, 200);
  assert.equal((await armed.json()).watcher.level, "all");
  assert.deepEqual((await watchers()).map((w) => [w.role, w.level, w.state]), [["Coordinator", "all", "active"]]);
  assert.equal((await sweepFor()).watched, 1, "an active watcher counts in the sweep");

  // Re-level in place (no duplicate watcher).
  await post({ path: doc, op: "watch", role: "Coordinator", level: "mentions" });
  assert.deepEqual((await watchers()).map((w) => [w.role, w.level]), [["Coordinator", "mentions"]]);

  // Pause drops the sweep count but keeps the level (resume restores it, not a reset to `all`).
  await post({ path: doc, op: "pause", role: "Coordinator" });
  assert.equal((await watchers())[0].state, "paused");
  assert.equal((await sweepFor()).watched, 0, "a paused watcher is not counted active");
  await post({ path: doc, op: "resume", role: "Coordinator" });
  assert.deepEqual((await watchers()).map((w) => [w.role, w.level, w.state]), [["Coordinator", "mentions", "active"]]);

  // Unwatch removes it; the doc drops out of the sweep (no annotations, no watchers).
  assert.equal((await post({ path: doc, op: "unwatch", role: "Coordinator" })).status, 200);
  assert.deepEqual(await watchers(), []);
  assert.equal(await sweepFor(), undefined, "an unwatched, un-annotated doc is not in the sweep");
  assert.equal((await post({ path: doc, op: "unwatch", role: "Coordinator" })).status, 404, "double-unwatch is 404");
});

test("thread level (P1/W4): set → 400 on a bad level → seatless sid fallback", { skip: !up && "no dev server on 5173" }, async () => {
  const threadId = `node:thread:level-${runTag}`;
  await fetch(`${HOST}/api/board/persist/snapshot?board=${boardId}`, j({ snapshot: { seq: 40, version: 3, records: [{ typeName: "node", id: threadId, type: "thread", title: "Level" }] } }));
  const url = (a) => `${HOST}/api/thread/${encodeURIComponent(threadId)}/${a}?board=${boardId}`;
  // A non-session `from` (the human at the card) may set a level; a bad level is 400.
  assert.equal((await fetch(url("level"), j({ from: "human", level: "loud" }))).status, 400);
  const ok = await fetch(url("level"), j({ from: "human", level: "mentions" }));
  assert.equal(ok.status, 200);
  const oj = await ok.json();
  assert.equal(oj.level, "mentions");
  assert.equal(oj.seat, null, "a seatless (non-role) participant lands on the sid fallback");
});

test("standing job (R6/W6): create → GET jobs → update in place → remove; 400 on missing fields", { skip: !up && "no dev server on 5173" }, async () => {
  const threadId = `node:thread:job-${runTag}`;
  await fetch(`${HOST}/api/board/persist/snapshot?board=${boardId}`, j({ snapshot: { seq: 50, version: 3, records: [{ typeName: "node", id: threadId, type: "thread", title: "Job" }] } }));
  const url = (a) => `${HOST}/api/thread/${encodeURIComponent(threadId)}/${a}?board=${boardId}`;
  // Missing instruction is a 400; a create without a body role is a bare job.
  assert.equal((await fetch(url("job"), j({ from: "human" }))).status, 400, "no instruction ⇒ 400");
  const created = await (await fetch(url("job"), j({ from: "human", instruction: "sweep", intervalMs: 100 }))).json();
  assert.ok(created.ok && created.job.id, "created with an id");
  assert.equal(created.job.intervalMs, 60_000, "sub-floor interval clamped to the 60s floor");
  assert.equal(created.job.role, null, "no role ⇒ bare worker");
  // GET .../jobs reads it back off the marker.
  const listed = await (await fetch(url("jobs"), { method: "GET" })).json();
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].id, created.job.id);
  // Update in place by jobId — same id, new interval/instruction.
  const updated = await (await fetch(url("job"), j({ from: "human", jobId: created.job.id, instruction: "sweep v2", intervalMs: 300_000, role: "Coordinator" }))).json();
  assert.equal(updated.jobs.length, 1, "updated in place, not appended");
  assert.equal(updated.job.id, created.job.id);
  assert.equal(updated.job.intervalMs, 300_000);
  assert.equal(updated.job.role, "Coordinator");
  // Remove needs a jobId; removing an unknown id is 404; the real remove is 200 and empties the list.
  assert.equal((await fetch(url("job"), j({ from: "human", remove: true }))).status, 400, "remove without jobId ⇒ 400");
  assert.equal((await fetch(url("job"), j({ from: "human", remove: true, jobId: "no-such" }))).status, 404, "remove unknown ⇒ 404");
  const removed = await (await fetch(url("job"), j({ from: "human", remove: true, jobId: created.job.id }))).json();
  assert.ok(removed.ok && removed.removed);
  assert.equal((await (await fetch(url("jobs"), { method: "GET" })).json()).jobs.length, 0, "list empty after remove");
});

test("delete-card-keep-session: deleting a session card keeps its thread membership", { skip: !up && "no dev server on 5173" }, async () => {
  const threadId = `node:thread:keep-${runTag}`;
  const sid = `keep-sess-${runTag}`;
  const sessionNode = `node:live:${sid}`;
  const edge = `edge:member:${sid}:${threadId}`;
  const snap = `${HOST}/api/board/persist/snapshot?board=${boardId}`;
  const msgUrl = `${HOST}/api/thread/${encodeURIComponent(threadId)}/message?board=${boardId}`;
  // 1) A thread with one session card JOINED by a member:open edge. The persist-diff onboarding records the
  //    DURABLE membership. On this path the emitted-bridge stays empty (a snapshot save never dispatches a bus
  //    addEdge), so threadMemberSids counts this sid ONLY via the durable set — no 60s TTL masking the result.
  assert.equal((await fetch(snap, j({ snapshot: { seq: 60, version: 4, records: [
    { typeName: "node", id: threadId, type: "thread", title: "Keep" },
    { typeName: "node", id: sessionNode, type: "session", title: sid },
    { typeName: "edge", id: edge, from: sessionNode, to: threadId, type: "member:open" },
  ] } }))).status, 200);
  const before = await (await fetch(msgUrl, j({ from: "human", text: "hi" }))).json();
  assert.equal(before.members, 1, "the joined session counts as a member");
  // 2) DELETE THE CARD: persist a snapshot with the session node AND its member edge gone — exactly what
  //    select+delete produces (removeNode cascades the wire). Only the thread node remains. The membership
  //    edge and its node vanish together, so the diff reads this as a card delete, not a leave.
  assert.equal((await fetch(snap, j({ snapshot: { seq: 61, version: 5, records: [
    { typeName: "node", id: threadId, type: "thread", title: "Keep" },
  ] } }))).status, 200);
  const after = await (await fetch(msgUrl, j({ from: "human", text: "still a member?" }))).json();
  assert.equal(after.members, 1, "membership SURVIVES the card delete — the card was only a view");
});

test("delete-card-keep-session: a real leave (edge removed, card still present) DOES drop membership", { skip: !up && "no dev server on 5173" }, async () => {
  const threadId = `node:thread:leave-${runTag}`;
  const sid = `leave-sess-${runTag}`;
  const sessionNode = `node:live:${sid}`;
  const edge = `edge:member:${sid}:${threadId}`;
  const snap = `${HOST}/api/board/persist/snapshot?board=${boardId}`;
  const msgUrl = `${HOST}/api/thread/${encodeURIComponent(threadId)}/message?board=${boardId}`;
  assert.equal((await fetch(snap, j({ snapshot: { seq: 62, version: 6, records: [
    { typeName: "node", id: threadId, type: "thread", title: "Leave" },
    { typeName: "node", id: sessionNode, type: "session", title: sid },
    { typeName: "edge", id: edge, from: sessionNode, to: threadId, type: "member:open" },
  ] } }))).status, 200);
  assert.equal((await (await fetch(msgUrl, j({ from: "human", text: "hi" }))).json()).members, 1, "joined");
  // Remove ONLY the edge; the session CARD stays (the UI remove-member / disconnect action) → a deliberate
  // leave. The node's presence in the after-snapshot is the honest discriminator vs. a card delete.
  assert.equal((await fetch(snap, j({ snapshot: { seq: 63, version: 7, records: [
    { typeName: "node", id: threadId, type: "thread", title: "Leave" },
    { typeName: "node", id: sessionNode, type: "session", title: sid },
  ] } }))).status, 200);
  const after = await (await fetch(msgUrl, j({ from: "human", text: "left?" }))).json();
  assert.equal(after.members, 0, "a real leave (card present, edge gone) drops membership");
});

// Slice 2 (create new file cards) leans entirely on POST /api/file to CREATE a not-yet-existing file:
// addTextFileCard writes empty content to `.canvas/docs/<slug>.md`, and only drops a card if the write
// succeeds. So the two facts it depends on are (a) a POST to a fresh, text-extension path under `.canvas/`
// creates the file and returns ok+version, and (b) a non-text extension is gated (404, the same way a
// blocked read is) so the client leaves the board unchanged rather than carding a file that isn't there.
test("POST /api/file creates a new text file under .canvas (Slice 2 create-path)", { skip: !up && "no dev server on 5173" }, async () => {
  const rel = `.canvas/docs/new-doc-${runTag}.md`;
  const fileUrl = (p) => `${HOST}/api/file?board=${boardId}&root=repo&path=${encodeURIComponent(p)}`;
  // The path does not exist yet — a create, not an overwrite.
  const abs = path.join(scratch, rel);
  assert.equal(fs.existsSync(abs), false, "precondition: file absent before create");
  const res = await fetch(fileUrl(rel), j({ content: "" }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.path, rel);
  assert.ok(out.version, "returns a version for chained edits");
  assert.equal(fs.readFileSync(abs, "utf8"), "", "empty file written to disk");
  // The card's read path (fileContent) sees it immediately.
  const read = await fetch(fileUrl(rel));
  assert.equal(read.status, 200);
});

test("POST /api/file gates a non-text extension with 404 (Slice 2 leaves board unchanged)", { skip: !up && "no dev server on 5173" }, async () => {
  const rel = `.canvas/docs/nope-${runTag}.exe`;
  const res = await fetch(`${HOST}/api/file?board=${boardId}&root=repo&path=${encodeURIComponent(rel)}`, j({ content: "x" }));
  assert.equal(res.status, 404, "a blocked extension is 404, never confirmed");
  assert.equal(fs.existsSync(path.join(scratch, rel)), false, "nothing written for a rejected path");
});

test("cleanup: scratch board store cleared", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(`${HOST}/api/board/persist?board=${boardId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  // Empty the dir but keep it: the registry row (stable path → stable boardId) stays valid, so the
  // picker's entry still mounts instead of 404ing.
  for (const f of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, f), { recursive: true, force: true });
});
