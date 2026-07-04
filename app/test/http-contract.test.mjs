// The agent-facing HTTP contracts, exercised against a LIVE dev server on a throwaway scratch board.
// These are the semantics CLAUDE.md documents as gotchas and agents script against — the status codes
// are the API. The whole file SKIPS (cleanly, not silently: one skip line per test) when no server
// answers on 5173, so `npm test` stays hermetic; with `npm run dev` up it becomes a real end-to-end
// probe of the middleware. Everything here targets a scratch board mounted from a tmpdir — never the
// dev repo's real board (a curl-write there can poison the one-time IndexedDB adoption).
//
// Hermetic (no-server-needed) middleware tests are the planned follow-up to the vite-fs-plugin split
// (docs/handoff: the handlers become testable once the pinned state rides an explicit context object);
// this file is the contract net that exists MEANWHILE, and the assertions to port when that lands.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = "http://127.0.0.1:5173";

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

test("cleanup: scratch board store cleared", { skip: !up && "no dev server on 5173" }, async () => {
  const res = await fetch(`${HOST}/api/board/persist?board=${boardId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  // Empty the dir but keep it: the registry row (stable path → stable boardId) stays valid, so the
  // picker's entry still mounts instead of 404ing.
  for (const f of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, f), { recursive: true, force: true });
});
