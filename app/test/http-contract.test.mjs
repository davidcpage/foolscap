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
  // noSessions: this suite's annotation/thread writes fire the SAME wake paths a human's do, and they used
  // to auto-spawn a REAL doc worker (a live `claude` process, real token spend) once per run. The flag
  // marks the scratch board spawn-refusing — belt to the tmpdir backstop's braces (sessionSpawnRefusal).
  const res = await fetch(`${HOST}/api/boards`, j({ repoPath: scratch, noSessions: true }));
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

test("scratch board stays out of the GET /api/boards listing", { skip: !up && "no dev server on 5173" }, async () => {
  // The mount works in-memory (this suite reaches its board by id all through the run), but a tmpdir
  // scratch board must not show in the picker — it used to linger in the boards menu until a restart.
  const listed = (await (await fetch(`${HOST}/api/boards`)).json()).boards;
  assert.ok(Array.isArray(listed) && listed.length > 0, "listing still serves real boards");
  assert.equal(listed.find((b) => b.boardId === boardId), undefined, "tmpdir scratch board is not listed");
});

test("no real sessions on a scratch board: explicit spawn is 403", { skip: !up && "no dev server on 5173" }, async () => {
  // The tmpdir backstop alone must refuse (the sticky noSessions flag is belt on top): a board whose repo
  // lives under os.tmpdir() never runs a live `claude`. If this 200s, a test run just cost real tokens.
  const res = await fetch(`${HOST}/api/session/spawn?board=${boardId}`, j({ prompt: "should never run" }));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /never spawn/);
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

test("POST /api/command with no tab commits server-side: ok + authoritative seq + minted id, visible at once", { skip: !up && "no dev server on 5173" }, async () => {
  // §9 stage 2 RETIRED the 503-on-no-tab: the server itself is the write authority — it validates the
  // command via core's defaultCommands, durably appends the event (server-minted seq, events.jsonl), and
  // folds it into the live store. A tab is a VIEW that receives the resulting diff, not a requirement.
  // Prove the no-tab case specifically: this board has ZERO tabs (the exact case that used to 503), and
  // the write must still land and be readable the instant the response returns.
  const before = await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json();
  assert.equal(before.tabs, 0, "precondition: nobody can render this board — the old 503-on-no-tab case");
  const res = await fetch(
    `${HOST}/api/command?board=${boardId}`,
    j({ type: "addNode", actor: "user", payload: { type: "note", title: "headless", x: 10, y: 20 } }),
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(typeof out.seq, "number");
  assert.ok(out.seq > (before.snapshot.seq ?? 0), "the server minted the board's next authoritative seq");
  // Bug B/C id-echo, now live end-to-end: the caller omitted payload.id, so the SERVER minted the node id
  // and echoed it — the created record is addressable without a tab ever existing.
  assert.match(out.id, /^node:/);
  // Durable + folded at commit: the record is visible to the agent read (GET /api/canvas, served from the
  // live server store) immediately, with the response's seq as the board's new watermark.
  const after = await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json();
  assert.equal(after.tabs, 0, "still no tab — nothing but the server committed this");
  assert.equal(after.snapshot.seq, out.seq);
  assert.ok(after.snapshot.records.some((r) => r.id === out.id), "created record visible in GET /api/canvas");
});

// NOTE (historical): before §9 stage 2 merged, the Bug B/C id-echo could not be asserted here (the
// always-on 5173 server served pre-merge plugin code — the dev-server-serves-stale-plugin-code footgun).
// Stage 2 is merged and live, so the command test above now carries the id-echo contract end-to-end;
// the minting LOGIC remains covered hermetically in middleware-hermetic.

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
  // Mint the save's seq from the board's CURRENT live seq, never a hardcoded number: since stage 2 the
  // command test above commits server-side and advances the board's one authoritative counter, and the
  // live store only folds a snapshot save that is strictly AHEAD of its watermark (seq > watermark is
  // the "carries state no event delivered" signal). A stale/equal seq is correctly ignored — so a
  // hardcoded seq would silently fail to land the thread node and 404 the append below.
  const curSeq = (await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json()).snapshot.seq ?? 0;
  const snapUrl = `${HOST}/api/board/persist/snapshot?board=${boardId}`;
  const saved = await fetch(snapUrl, j({ snapshot: { seq: curSeq + 1, version: 3, records: [{ typeName: "node", id: threadId, type: "thread", title: "Contract" }] } }));
  assert.equal(saved.status, 200, "the thread-node save must land ahead of the live watermark");
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

test("inbox read params (default budget + recovery): every window/recovery param parses to the 404 probe, never a 500", { skip: !up && "no dev server on 5173" }, async () => {
  // The inbox-hardening contract (default byte budget, ?since replay, ?peek non-consume) needs a LIVE
  // session to observe its windowing/cursor BEHAVIOR — but the scratch board refuses to spawn one (403,
  // sessionSpawnRefusal), so that behavior is covered hermetically in middleware-hermetic.test.mjs (a fake
  // ServerContext with a live session + thread log). What THIS live net owns is the status-code semantics:
  // the new query params must PARSE on the real handler and short-circuit to the same 404 liveness probe —
  // a 400 or 500 here would mean a param-parse regression (e.g. nonNegParam or the peek read throwing).
  const ghost = "00000000-0000-0000-0000-000000000000";
  const q = [
    "bytes=100", // explicit budget override
    "limit=2", // opt-in count cap
    "since=0", // replay-from-seq recovery (0 is valid — replay all — unlike the >0 windowParam)
    "since=5&bytes=2000", // combined recovery + budget
    "peek=1", // non-consuming peek
    "bytes=-1&limit=abc&since=-3", // garbage: rejected to null (no budget/window), still just the 404
  ];
  for (const params of q) {
    const res = await fetch(`${HOST}/api/inbox?session=${ghost}&${params}`);
    assert.equal(res.status, 404, `?${params} must parse and reach the 404 liveness probe, never 400/500`);
  }
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

test("delete-card-keep-session: edge removal alone never drops membership (BUG-5); an explicit /leave does", { skip: !up && "no dev server on 5173" }, async () => {
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
  // Remove ONLY the edge; the session CARD stays. Pre-BUG-5 the diff read this as a deliberate leave and
  // dropped the durable member — the split-brain root cause (display-layer save races silently erasing
  // live members). Durable membership is authoritative now: NO snapshot-diff path may drop a member, so
  // the edge-gone save must be a no-op and a leave must go through the sanctioned mutation instead.
  assert.equal((await fetch(snap, j({ snapshot: { seq: 63, version: 7, records: [
    { typeName: "node", id: threadId, type: "thread", title: "Leave" },
    { typeName: "node", id: sessionNode, type: "session", title: sid },
  ] } }))).status, 200);
  const after = await (await fetch(msgUrl, j({ from: "human", text: "left?" }))).json();
  assert.equal(after.members, 1, "edge removal alone is display noise — membership survives (BUG-5)");
  const leaveUrl = `${HOST}/api/thread/${encodeURIComponent(threadId)}/leave?board=${boardId}`;
  assert.equal((await fetch(leaveUrl, j({ from: sid }))).status, 200, "explicit /leave as the session");
  const gone = await (await fetch(msgUrl, j({ from: "human", text: "left now?" }))).json();
  assert.equal(gone.members, 0, "the explicit /leave is what drops membership");
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

test("Origin/Host allowlist (pre-push audit): foreign Origin / rebind Host rejected, no-Origin + same-origin allowed", { skip: !up && "no dev server on 5173" }, async (t) => {
  // The reject path, live, via the Origin header (which undici honors; it silently OVERRIDES a custom Host,
  // so the DNS-rebind Host clause is proven by the unit test originHostAllowed(undefined,"rebind…")===false
  // and by the curl end-to-end probe, not here). The LIVE contract net lags a contract change until the
  // running server hot-reloads the merged code (contract-tests-lag-contract-changes): if this server predates
  // the guard, a foreign-Origin request is NOT rejected — skip cleanly rather than redden the gate. Once
  // reloaded (or when CANVAS_TEST_HOST points at a worktree server already carrying the guard) it runs for real.
  const probe = await fetch(`${HOST}/api/boards`, { headers: { Origin: "https://evil.example" } });
  if (probe.status !== 403) {
    t.skip("running server predates the Origin/Host guard (live contract net lags until hot-reload)");
    return;
  }
  // REJECT — cross-origin browser fetch (a webpage no-cors POSTing to the loopback API).
  assert.equal(probe.status, 403, "foreign Origin on a plain read is 403");
  assert.equal(
    (await fetch(`${HOST}/api/command?board=${boardId}`, { ...j({ type: "addNode", actor: "user", payload: { type: "note" } }), headers: { "Content-Type": "application/json", Origin: "https://evil.example" } })).status,
    403,
    "foreign Origin on a state-changing POST is 403 (the real risk: spawn/command/file-write)",
  );
  // ALLOW — same-origin browser traffic (Origin === our loopback origin) still works.
  assert.equal((await fetch(`${HOST}/api/boards`, { headers: { Origin: HOST } })).status, 200, "same-origin browser read still 200");
  // ALLOW — no-Origin CLI/agent-bus traffic still works (this is the path every other test here rides).
  assert.equal((await fetch(`${HOST}/api/boards`)).status, 200, "no-Origin CLI read still 200");
});

test("cleanup: scratch board store cleared", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(`${HOST}/api/board/persist?board=${boardId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  // Empty the dir but keep it: the registry row (stable path → stable boardId) stays valid, so the
  // picker's entry still mounts instead of 404ing.
  for (const f of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, f), { recursive: true, force: true });
});
