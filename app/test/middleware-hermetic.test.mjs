// Hermetic middleware tests — the payoff of the vite-fs-plugin.ts god-file split (P1). These exercise the
// extracted server-*.ts modules with NO live dev server on port 5173: the pure fs-confinement + snapshot
// record resolvers directly, and a handful of stateful handlers wired to a MINIMAL fake ServerContext via
// setServerContext(fake). This is the no-server complement to http-contract.test.mjs (which needs a live
// server and skips otherwise) — the "planned follow-up" that file's header points at, now realised.
//
// The split modules import each other by the TypeScript/Vite `.js`-specifier convention (`./server-context.js`
// resolving to server-context.ts) — the dev server bundles through Vite and typecheck runs under tsc, but
// `node --test` resolves raw. The resolve hook below rewrites a relative `.js` import to its `.ts` sibling
// ONLY when the `.js` doesn't exist (so hand-authored `.js` modules keep resolving unchanged), mirroring what
// Vite/tsc already do. It must be registered before the dynamic imports so those specifiers resolve.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context); // a real hand-authored .js module — resolve as-is
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context); // only a .ts sibling exists (a split module)
      }
    }
    return nextResolve(specifier, context);
  },
});

const fsMod = await import("../server-fs.ts");
const snap = await import("../server-snapshot.ts");
const ctx = await import("../server-context.ts");
const orch = await import("../server-orchestration.ts");
const sess = await import("../server-sessions.ts");
const boardsMod = await import("../server-boards.ts");
const delivery = await import("../server-delivery.ts");
const engine = await import("../board-engine.ts");
const bp = await import("../board-persist.js");
const ledger = await import("../thread-ledger.js");
const filesRoute = await import("../routes/files.ts");
const plugin = await import("../vite-fs-plugin.ts"); // runRoute — the dispatch-seam error boundary (BUG-4b)
const inbox = await import("../routes/inbox.ts"); // computeInbox — the inbox read as a pure computation
const casGuard = await import("../cas-guard.js"); // senderCursorAfterPost — the post-cursor invariant

// ── Group A: server-fs pure confinement / gates (no context, no server) ─────────────────────────────
test("server-fs safeResolve confines a path to its root and refuses every escape", () => {
  const root = path.resolve("/srv/board");
  // In-root resolves land under the root.
  assert.equal(fsMod.safeResolve(root, "docs/a.md"), path.join(root, "docs/a.md"));
  assert.equal(fsMod.safeResolve(root, "a/b/../c"), path.join(root, "a/c"));
  // The root itself (empty / dot) is allowed — it equals root, not merely a prefix.
  assert.equal(fsMod.safeResolve(root, ""), root);
  assert.equal(fsMod.safeResolve(root, "."), root);
  // A `..` escape out of the root is refused.
  assert.equal(fsMod.safeResolve(root, "../secret"), null);
  assert.equal(fsMod.safeResolve(root, "a/../../../etc/passwd"), null);
  // A sibling directory that merely shares the root's name PREFIX must not pass the startsWith check.
  assert.equal(fsMod.safeResolve(root, "../board-evil/x"), null);
});

test("server-fs isInternalPath hides generated/internal trees but keeps .canvas content reachable", () => {
  // Generated / VCS dirs are internal wherever they appear.
  assert.equal(fsMod.isInternalPath("node_modules/pkg/index.js"), true);
  assert.equal(fsMod.isInternalPath("src/.git/config"), true);
  assert.equal(fsMod.isInternalPath("dist/bundle.js"), true);
  // A normal source path is not internal.
  assert.equal(fsMod.isInternalPath("app/src/NodeView.tsx"), false);
  // .canvas CONTENT is browsable/servable...
  assert.equal(fsMod.isInternalPath(".canvas/memory/foo.md"), false);
  assert.equal(fsMod.isInternalPath(".canvas/threads/t.jsonl"), false);
  // ...but the two off-limits .canvas subtrees are internal (the shadow object store + the record store).
  assert.equal(fsMod.isInternalPath(".canvas/roots/abc123/git/objects/aa/bb"), true);
  assert.equal(fsMod.isInternalPath(".canvas/board/events.jsonl"), true);
  // Path-aware, not basename: `.canvas` alone is fine; only the adjacent `roots`/`board` segment trips it.
  assert.equal(fsMod.isInternalPath("/abs/repo/.canvas/roles/pm/role.md"), false);
});

test("server-fs isInternalPath excludes Python virtualenvs (the fd-exhaustion guard) at any depth", () => {
  // chokidar v4 holds one kqueue fd per watched file; a mounted external repo's ~10k-file `.venv`
  // exhausted the process fd table (spawn EBADF, 2026-07-15). The watchers' shared `ignored` predicate
  // must reject a venv wherever it appears — absolute or root-relative, `.venv` or bare `venv`.
  assert.equal(fsMod.isInternalPath(".venv/lib/python3.12/site-packages/x.py"), true);
  assert.equal(fsMod.isInternalPath("/abs/repo/.venv/lib/python3.12/x.py"), true);
  assert.equal(fsMod.isInternalPath("venv/bin/activate"), true);
  assert.equal(fsMod.isInternalPath("sub/project/.venv/pyvenv.cfg"), true);
  // ...and the pre-existing heavy dirs stay excluded alongside it.
  assert.equal(fsMod.isInternalPath("/abs/repo/node_modules/x"), true);
  assert.equal(fsMod.isInternalPath("/abs/repo/.git/objects/aa/bb"), true);
  // A normal source path — including one that merely CONTAINS the substring — is still served.
  assert.equal(fsMod.isInternalPath("src/venv-tools.ts"), false);
  assert.equal(fsMod.isInternalPath("docs/venvs.md"), false);
});

test("server-fs openRootWatcher never descends into a venv (behavioral: no fd, no event)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-venv-watch-"));
  fs.mkdirSync(path.join(root, ".venv/lib/python3.12"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
  const events = [];
  const close = fsMod.openRootWatcher(root, (ev) => events.push(ev));
  try {
    // Write into the excluded trees AND at the top level each round, then wait for the top-level add
    // to arrive — chokidar picks both up in the same pass, so if the watcher had descended into
    // `.venv`/`node_modules` their adds would ride along with (or before) the sentinel's. Rounds
    // repeat because the first writes can land before chokidar's initial scan completes.
    const deadline = Date.now() + 8000;
    let round = 0;
    while (!events.some((e) => e.path === `ok-${round}.txt`)) {
      round++;
      fs.writeFileSync(path.join(root, ".venv/lib/python3.12", `x-${round}.py`), "x = 1\n");
      fs.writeFileSync(path.join(root, "node_modules/pkg", `y-${round}.js`), "y\n");
      fs.writeFileSync(path.join(root, `ok-${round}.txt`), "ok\n");
      const until = Date.now() + 400;
      while (Date.now() < until && !events.some((e) => e.path === `ok-${round}.txt`))
        await new Promise((r) => setTimeout(r, 25));
      assert.ok(Date.now() < deadline, "watcher never delivered the top-level sentinel event");
    }
    await new Promise((r) => setTimeout(r, 300)); // settle: catch any straggler event from the excluded trees
    const leaked = events.filter((e) => /(^|\/)(\.venv|node_modules)\//.test(e.path));
    assert.deepEqual(leaked, [], "no watch event may come from inside .venv/ or node_modules/");
  } finally {
    close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("server-fs extension gates classify text vs image vs blocked", () => {
  for (const ext of [".md", ".ts", ".json", ".py", ".sh"]) assert.equal(fsMod.TEXT_EXT.has(ext), true, ext);
  for (const ext of [".png", ".jpg", ".svg", ".webp"]) assert.equal(fsMod.IMAGE_EXT.has(ext), true, ext);
  // A blocked/binary extension is in neither set — the same disjointness the file/asset endpoints rely on.
  for (const ext of [".exe", ".bin", ".env"]) {
    assert.equal(fsMod.TEXT_EXT.has(ext), false, ext);
    assert.equal(fsMod.IMAGE_EXT.has(ext), false, ext);
  }
});

test("server-fs fileVersion: null for absent, stable per bytes, changes on edit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-fv-"));
  const abs = path.join(dir, "note.md");
  try {
    assert.equal(fsMod.fileVersion(abs), null, "absent file has the null version (a create passes baseVersion:null)");
    fs.writeFileSync(abs, "hello");
    const v1 = fsMod.fileVersion(abs);
    assert.ok(v1, "a real file stamps a version");
    assert.equal(fsMod.fileVersion(abs), v1, "identical bytes → identical version (a pure content hash)");
    fs.writeFileSync(abs, "hello world");
    assert.notEqual(fsMod.fileVersion(abs), v1, "changed bytes → a different version (CAS detects the edit)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server-fs readFileWithVersion: ONE read yields preview + truncated + the same version fileVersion would", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-rfv-"));
  const abs = path.join(dir, "note.md");
  try {
    assert.equal(fsMod.readFileWithVersion(abs), null, "absent file → null (same contract as readText)");
    fs.writeFileSync(abs, "hello world");
    const r = fsMod.readFileWithVersion(abs);
    assert.equal(r.content, "hello world");
    assert.equal(r.truncated, false);
    // The version derived from the same buffer MUST equal the standalone fileVersion (the full-file hash) —
    // that equality is what lets the /api/file read collapse its old two-read (preview + hash) into one.
    assert.equal(r.version, fsMod.fileVersion(abs), "version from the shared buffer == the full-file hash");
    // A tiny maxBytes head-clips the preview and flags it, while the version still hashes the FULL bytes.
    const clipped = fsMod.readFileWithVersion(abs, 5);
    assert.equal(clipped.content, "hello");
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.version, r.version, "the version is the full-file hash regardless of the preview cap");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server-http sendJson: gzip only when the client accepts it AND the body clears the threshold", async () => {
  const http = await import("../server-http.ts");
  const zlib = await import("node:zlib");
  const big = { blob: "x".repeat(4000) }; // well over GZIP_MIN_BYTES
  // No req → plain JSON, exactly as every existing caller gets.
  const plain = fakeRes();
  http.sendJson(plain, 200, big);
  assert.equal(plain._headers["Content-Encoding"], undefined, "no req ⇒ never gzip (backwards-compatible)");
  assert.deepEqual(JSON.parse(plain._body), big);
  // Client accepts gzip + body is large ⇒ gzip'd, and it round-trips back to the same JSON.
  const gz = fakeRes();
  http.sendJson(gz, 200, big, { headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(gz._headers["Content-Encoding"], "gzip");
  assert.equal(gz._headers["Vary"], "Accept-Encoding");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz._body).toString("utf8")), big);
  assert.ok(gz._body.length < Buffer.byteLength(JSON.stringify(big)), "the gzip payload is smaller than the raw JSON");
  // A tiny body stays uncompressed even when accepted (the framing would cost more than it saves).
  const small = fakeRes();
  http.sendJson(small, 200, { ok: true }, { headers: { "accept-encoding": "gzip" } });
  assert.equal(small._headers["Content-Encoding"], undefined, "below the threshold ⇒ plain");
  assert.deepEqual(JSON.parse(small._body), { ok: true });
  // Client does NOT accept gzip ⇒ plain, even for a large body.
  const noAccept = fakeRes();
  http.sendJson(noAccept, 200, big, { headers: {} });
  assert.equal(noAccept._headers["Content-Encoding"], undefined, "no gzip in Accept-Encoding ⇒ plain");
});

// ── Group B: server-snapshot pure record resolvers (no context) ─────────────────────────────────────
const RECORDS = [
  { typeName: "node", id: "node:live:s1", type: "session", title: "s1", name: "Coordinator.s1" },
  { typeName: "node", id: "node:live:s2", type: "session", title: "s2" }, // a session card with no display name
  { typeName: "node", id: "node:thread:t1", type: "thread", title: "T1" },
  { typeName: "node", id: "node:thread:t2", type: "channel", title: "Legacy" }, // carried-over legacy type
  { typeName: "node", id: "node:doc:d1", type: "doc", title: "A doc" },
  { typeName: "edge", id: "e1", from: "node:live:s1", to: "node:thread:t1", type: "member:open" },
];

test("server-snapshot sidFromSessionNode maps BOTH session-node vintages to their sid", () => {
  assert.equal(snap.sidFromSessionNode("node:live:abc-123"), "abc-123", "spawn/summon vintage");
  // A card reopened from the rail is the node:session: vintage (loader.openSession) — id-based sid
  // resolution must handle it too, else a reopened card's leave/adoption silently mis-resolves (GAP B).
  assert.equal(snap.sidFromSessionNode("node:session:abc-123"), "abc-123", "reopen vintage");
  assert.equal(snap.sidFromSessionNode("node:thread:t1"), null);
  assert.equal(snap.sidFromSessionNode("garbage"), null);
});

test("server-snapshot node/session/thread resolvers read the records with no context", () => {
  // nodeSessionId: a session card carries its sid as the node title; non-session nodes resolve to null.
  assert.equal(snap.nodeSessionId(RECORDS, "node:live:s1"), "s1");
  assert.equal(snap.nodeSessionId(RECORDS, "node:thread:t1"), null);
  assert.equal(snap.nodeSessionId(RECORDS, "node:doc:d1"), null);
  // sessionNodeForSid: the reverse lookup by title.
  assert.equal(snap.sessionNodeForSid(RECORDS, "s1"), "node:live:s1");
  assert.equal(snap.sessionNodeForSid(RECORDS, "nope"), null);
  // sessionNameForSid: the display name when present, else null (renderer falls back to the short sid).
  assert.equal(snap.sessionNameForSid(RECORDS, "s1"), "Coordinator.s1");
  assert.equal(snap.sessionNameForSid(RECORDS, "s2"), null);
  // threadNode: both the `thread` and the legacy `channel` node types resolve; a doc / unknown id is null.
  assert.equal(snap.threadNode(RECORDS, "node:thread:t1")?.title, "T1");
  assert.equal(snap.threadNode(RECORDS, "node:thread:t2")?.title, "Legacy");
  assert.equal(snap.threadNode(RECORDS, "node:doc:d1"), null);
  assert.equal(snap.threadNode(RECORDS, "node:thread:missing"), null);
});

test("server-snapshot historyKey / seedCursor are pure backlog-visibility helpers", () => {
  assert.equal(snap.historyKey("node:thread:t1", "s1"), "node:thread:t1|s1");
  const log = [{ seq: 10 }, { seq: 11 }, { seq: 12 }];
  assert.equal(snap.seedCursor("full", log), 0, "full ⇒ everything unread from seq 0");
  assert.equal(snap.seedCursor("future", log), 12, "future ⇒ start at the current tail");
  assert.equal(snap.seedCursor("future", []), 0, "future on an empty log ⇒ 0 (nothing to skip)");
});

// ── Group C: context-injected handlers via setServerContext(fake) — the pattern-setter ──────────────
// The P2 payoff: a MINIMAL fake ServerContext whose fsState omits the maps that used to be `??=`-inited by
// the shell no longer crashes at the former `!` assertion sites — each lazy accessor inits its map in place.

test("server-context accessors lazily init their map in place and are idempotent", () => {
  // A bare fsState (no maps) — exactly what the shell no longer pre-populates.
  const st = {};
  const asks = ctx.getPendingAsks(st);
  assert.ok(asks instanceof Map);
  assert.equal(st.pendingAsks, asks, "the accessor stores the map back on fsState (in place)");
  assert.equal(ctx.getPendingAsks(st), asks, "a second read returns the SAME instance, not a fresh map");

  const perms = ctx.getPendingPermissions(st);
  assert.ok(perms instanceof Map);
  assert.equal(ctx.getPendingPermissions(st), perms);

  const ws = ctx.getWsClients(st);
  assert.ok(ws instanceof Set);
  assert.equal(ctx.getWsClients(st), ws);

  const hist = ctx.getPendingHistoryMode(st);
  assert.ok(hist instanceof Map);
  assert.equal(ctx.getPendingHistoryMode(st), hist);
});

test("publishFeed reaches subscribers with a fsState that has NO wsClients (former wsClients! site)", () => {
  const frames = [];
  const fake = {
    liveSessions: new Map(),
    // wsClients DELIBERATELY absent — pre-P2 the `for (const c of fsState.wsClients!)` would throw here.
    fsState: {
      feedClients: new Set([{ res: { write: (s) => frames.push(s) } }]),
      feedValues: new Map(),
    },
  };
  ctx.setServerContext(fake);
  orch.publishFeed("git:HEAD", { sha: "deadbeef" });
  assert.equal(fake.fsState.feedValues.get("git:HEAD").sha, "deadbeef", "the value is recorded for late subscribers");
  assert.equal(frames.length, 1, "the existing SSE subscriber got the frame");
  assert.match(frames[0], /git:HEAD/);
  assert.ok(fake.fsState.wsClients instanceof Set, "getWsClients lazily created the ws set on the bare fsState");
});

test("getBusClients lazily inits the per-board SSE map in place and is idempotent", () => {
  const st = {};
  const bus = ctx.getBusClients(st);
  assert.ok(bus instanceof Map);
  assert.equal(st.busClients, bus, "the accessor stores the map back on fsState (in place)");
  assert.equal(ctx.getBusClients(st), bus, "a second read returns the SAME instance, not a fresh map");
});

test("dispatchBusCommand COMMITS server-side with zero tabs and is durable + live-store visible (§9 stage 2)", () => {
  // Stage 2: the bus command is no longer a broadcast-relay-or-buffer — the server COMMITS it into the live
  // store and appends it durably at commit time, with or without a tab. (Still crash-safe on a bare fsState:
  // getBusClients/getWsClients lazily create their maps — the former BUG-4a `busClients!` crash site.)
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mw-dispatch-"));
  let tracked = 0;
  const fake = {
    fsState: {},
    boards: new Map([["board-x", { boardId: "board-x", repoPath: repo }]]),
    trackEmittedMembership: () => tracked++,
  };
  ctx.setServerContext(fake);
  let event;
  assert.doesNotThrow(() => {
    event = delivery.dispatchBusCommand("board-x", { type: "addNode", payload: { id: "node:z", type: "note" } }, "test");
  });
  // The committed event: one IntentEvent, server-minted seq 1, carrying the diff that added the node.
  assert.ok(event && event.seq === 1, "returns the committed IntentEvent with the authoritative seq");
  assert.ok(event.diff.added["node:z"], "the diff adds the node");
  // DURABLE at commit with zero tabs: one event on disk, and the node in the live server store.
  const persisted = bp.readBoardPersist(repo);
  assert.equal(persisted.events.length, 1, "exactly one IntentEvent appended to events.jsonl");
  assert.equal(persisted.events[0].seq, 1, "the durable event carries the server-minted seq");
  assert.ok(
    engine.boardStoreRecords("board-x", repo).some((r) => r.id === "node:z"),
    "the node is visible in the live server store immediately (no tab, no debounce)",
  );
  // Crash-safety preserved + membership side-effects now fire unconditionally (the board DID change).
  assert.ok(fake.fsState.busClients instanceof Map, "getBusClients lazily created the per-board map on the bare fsState");
  assert.equal(tracked, 1, "trackEmittedMembership fires on every commit now (no longer gated on a live tab)");
  // The persist-gap replay buffer is retired — nothing is buffered.
  assert.equal(fake.fsState.pendingBusReplay, undefined, "no pending-replay buffer (retired in stage 2)");
});

// ── runRoute: the dispatch-seam error boundary (BUG-4b) ──────────────────────────────────────────────
// A minimal ServerResponse double: records the status/body sendJson writes, and mirrors the real
// `headersSent` flag (flips true once end() is called), so the boundary's `!headersSent` guard is exercised.
function fakeRes() {
  return {
    statusCode: 200,
    headersSent: false,
    _headers: {},
    _body: undefined,
    setHeader(k, v) {
      this._headers[k] = v;
    },
    end(body) {
      this.headersSent = true;
      this._body = body;
    },
  };
}
const fakeReq = (method = "POST") => ({ method });
const fakeUrl = (p = "/api/thing") => new URL(p, "http://localhost");
const flush = () => new Promise((r) => setImmediate(r)); // let a rejected promise's .catch microtask run

test("runRoute turns a SYNCHRONOUS handler throw into a logged 500 (BUG-4b)", () => {
  const res = fakeRes();
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a);
  try {
    plugin.runRoute(fakeReq(), res, fakeUrl("/api/boom"), () => {
      throw new Error("sync boom");
    });
  } finally {
    console.error = orig;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res._body), { error: "internal error" });
  assert.ok(errs.some((a) => String(a[0]).includes("/api/boom")), "the error was logged with the method+path");
});

test("runRoute turns an ASYNC handler rejection into a logged 500, NOT an unhandled rejection (BUG-4b)", async () => {
  const rejections = [];
  const onUnhandled = (r) => rejections.push(r);
  process.on("unhandledRejection", onUnhandled);
  const res = fakeRes();
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a);
  try {
    plugin.runRoute(fakeReq(), res, fakeUrl("/api/async-boom"), async () => {
      throw new Error("async boom");
    });
    await flush();
    await flush();
  } finally {
    console.error = orig;
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(res.statusCode, 500, "the parked request got a 500 instead of hanging");
  assert.deepEqual(JSON.parse(res._body), { error: "internal error" });
  assert.equal(rejections.length, 0, "the rejection was caught at the seam — no unhandled rejection escaped");
  assert.ok(errs.some((a) => String(a[0]).includes("/api/async-boom")), "logged with the path");
});

test("runRoute leaves a well-behaved handler untouched (no double-write on success)", async () => {
  const res = fakeRes();
  plugin.runRoute(fakeReq(), res, fakeUrl(), async () => {
    sendJsonLike(res, 200, { ok: true });
  });
  await flush();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res._body), { ok: true });
});

test("runRoute does NOT double-write when a handler that already sent headers later throws", async () => {
  const res = fakeRes();
  const orig = console.error;
  console.error = () => {};
  try {
    plugin.runRoute(fakeReq(), res, fakeUrl("/api/stream"), async () => {
      sendJsonLike(res, 201, { partial: true }); // handler wrote its own response first...
      throw new Error("late boom"); // ...then failed
    });
    await flush();
    await flush();
  } finally {
    console.error = orig;
  }
  assert.equal(res.statusCode, 201, "the boundary honored !headersSent and did not overwrite with a 500");
  assert.deepEqual(JSON.parse(res._body), { partial: true });
});

// A tiny sendJson stand-in matching server-http.sendJson's contract, for the success/already-sent cases.
function sendJsonLike(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

test("threadMemberSids unions edge members with cardless durable members over a fake context", () => {
  // A bare fsState (no durableMembers, no emittedMembers) resolves the member:open EDGE with no crash.
  ctx.setServerContext({ fsState: {} });
  assert.deepEqual(snap.threadMemberSids(RECORDS, "node:thread:t1"), ["s1"], "the member:open edge counts s1");
  assert.deepEqual(snap.threadMemberSids(RECORDS, "node:thread:t2"), [], "a thread with no members is empty");

  // A durable member whose session card was deleted (no edge) still counts — the delete-card-keep-session case.
  ctx.setServerContext({ fsState: { durableMembers: new Map([["node:thread:t1", new Set(["ghost"])]]) } });
  assert.deepEqual(
    snap.threadMemberSids(RECORDS, "node:thread:t1").sort(),
    ["ghost", "s1"],
    "edge member s1 and cardless durable member ghost are both members",
  );
});

// ── ensureCommandId: server-side id minting so a headless-created node/edge is ADDRESSABLE (Bug B/C) ──
test("ensureCommandId mints a node id for an idless addNode, writes it into the payload, and returns it", () => {
  let n = 0;
  const cmd = { type: "addNode", actor: "user", payload: { type: "thread", title: "t" } };
  const id = delivery.ensureCommandId(cmd, () => `uuid${++n}`);
  assert.equal(id, "node:uuid1", "returns the minted node id");
  assert.equal(cmd.payload.id, "node:uuid1", "and injects it into the broadcast payload so the tab uses it");
  assert.equal(cmd.payload.type, "thread", "other payload fields are preserved");
});

test("ensureCommandId mints an edge id for an idless addEdge", () => {
  const cmd = { type: "addEdge", payload: { from: "node:a", to: "node:b", type: "member:open" } };
  const id = delivery.ensureCommandId(cmd, () => "abcd");
  assert.equal(id, "edge:abcd");
  assert.equal(cmd.payload.id, "edge:abcd");
});

test("ensureCommandId takes a node id for addShape too (it delegates to addNode in core)", () => {
  const cmd = { type: "addShape", payload: {} };
  assert.equal(delivery.ensureCommandId(cmd, () => "s1"), "node:s1");
});

test("ensureCommandId echoes a caller-supplied id unchanged and never re-mints", () => {
  const cmd = { type: "addNode", payload: { id: "node:mine", type: "note" } };
  const id = delivery.ensureCommandId(cmd, () => "SHOULD-NOT-BE-USED");
  assert.equal(id, "node:mine");
  assert.equal(cmd.payload.id, "node:mine");
});

test("ensureCommandId synthesizes a payload when a create command omits one entirely", () => {
  const cmd = { type: "addNode" };
  const id = delivery.ensureCommandId(cmd, () => "x1");
  assert.equal(id, "node:x1");
  assert.equal(cmd.payload.id, "node:x1");
});

test("ensureCommandId returns null and leaves the payload untouched for a non-create command", () => {
  const cmd = { type: "removeNode", payload: { id: "node:gone" } };
  assert.equal(delivery.ensureCommandId(cmd, () => "nope"), null, "removeNode has no created id");
  assert.equal(cmd.payload.id, "node:gone", "its payload is not rewritten");
  assert.equal(delivery.ensureCommandId({ type: "moveNode", payload: { id: "node:x" } }, () => "nope"), null);
});

test("sessionStatus resolves a running session with a fsState that has NO pendingPermissions (former ! site)", () => {
  const fake = {
    liveSessions: new Map([["s1", { status: "running", lines: [] }]]),
    fsState: {}, // pendingPermissions absent — pre-P2 the `.values()` read below would throw on undefined
  };
  ctx.setServerContext(fake);
  // No held permission ⇒ not "waiting"; a running process paints "working".
  assert.equal(sess.sessionStatus("/no/such/repo", "s1"), "working");
  assert.ok(fake.fsState.pendingPermissions instanceof Map, "getPendingPermissions lazily created the map");
  // An unknown session with no durable marker resolves to the neutral "ended" band, still no crash.
  assert.equal(sess.sessionStatus("/no/such/repo", "ghost"), "ended");
});

// ── Group D: P2 relative-offset layout (primary thread / anchors / offset capture) ──────────────────
const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "p2-offset-"));
// Records for a session `sid` that is a member of the given thread ids (session card + member:open edges).
const membershipRecords = (sid, threadIds, extra = []) => [
  { typeName: "node", id: `node:live:${sid}`, type: "session", title: sid },
  ...threadIds.map((t) => ({ typeName: "node", id: t, type: "thread", title: t })),
  ...threadIds.map((t, i) => ({ typeName: "edge", id: `e${i}`, from: `node:live:${sid}`, to: t, type: "member:open" })),
  ...extra,
];

test("primaryThreadForSession picks the EARLIEST-joined thread (min joinedAt), across memberships", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {} });
  ledger.addThreadMember(repo, "node:thread:late", "sid-a", 300);
  ledger.addThreadMember(repo, "node:thread:early", "sid-a", 100);
  const records = membershipRecords("sid-a", ["node:thread:late", "node:thread:early"]);
  assert.equal(snap.primaryThreadForSession(repo, records, "sid-a"), "node:thread:early");
  // No memberships → null (nothing to anchor to).
  assert.equal(snap.primaryThreadForSession(repo, membershipRecords("sid-none", []), "sid-none"), null);
});

test("primaryThreadForSession breaks a joinedAt tie on the smaller threadId (stable choice)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {} });
  ledger.addThreadMember(repo, "node:thread:bbb", "sid-a", 100);
  ledger.addThreadMember(repo, "node:thread:aaa", "sid-a", 100); // same joinedAt
  const records = membershipRecords("sid-a", ["node:thread:bbb", "node:thread:aaa"]);
  assert.equal(snap.primaryThreadForSession(repo, records, "sid-a"), "node:thread:aaa", "smaller id wins the tie");
});

test("sessionAnchor returns the primary thread + its stored offset (null offset until captured)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {} });
  ledger.addThreadMember(repo, "node:thread:t1", "sid-a", 100);
  const records = membershipRecords("sid-a", ["node:thread:t1"]);
  assert.deepEqual(snap.sessionAnchor(repo, records, "sid-a"), { primaryThread: "node:thread:t1", offset: null });
  ledger.setMemberOffset(repo, "node:thread:t1", "sid-a", 40, -20);
  assert.deepEqual(snap.sessionAnchor(repo, records, "sid-a"), {
    primaryThread: "node:thread:t1",
    offset: { dx: 40, dy: -20 },
  });
});

test("captureMemberOffsets stores each member's offset from its PRIMARY thread card (from the snapshot)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  ledger.addThreadMember(repo, "node:thread:t1", "sid-a", 100);
  const records = membershipRecords("sid-a", ["node:thread:t1"], [
    { typeName: "layout", nodeId: "node:thread:t1", x: 1000, y: 500 },
    { typeName: "layout", nodeId: "node:live:sid-a", x: 1120, y: 556 }, // 120 right, 56 down
  ]);
  snap.captureMemberOffsets("b1", records);
  assert.deepEqual(ledger.memberOffsetFromMeta(ledger.readThreadMeta(repo, "node:thread:t1"), "sid-a"), {
    dx: 120,
    dy: 56,
  });
});

test("captureMemberOffsets: SECONDARY thread card position never sets the offset (primary only)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  ledger.addThreadMember(repo, "node:thread:primary", "sid-a", 100);
  ledger.addThreadMember(repo, "node:thread:secondary", "sid-a", 200);
  // Only the SECONDARY thread card is on the board (primary is closed) — with no primary card to measure
  // against, the offset must stay uncaptured rather than being taken relative to the secondary.
  const records = membershipRecords("sid-a", ["node:thread:secondary"], [
    { typeName: "layout", nodeId: "node:thread:secondary", x: 0, y: 0 },
    { typeName: "layout", nodeId: "node:live:sid-a", x: 300, y: 300 },
  ]);
  snap.captureMemberOffsets("b1", records);
  assert.equal(
    ledger.memberOffsetFromMeta(ledger.readThreadMeta(repo, "node:thread:primary"), "sid-a"),
    null,
    "primary membership keeps no offset — the secondary card must not seed it",
  );
});

test("captureMemberOffsets is idempotent — a save that moved nothing writes nothing", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  ledger.addThreadMember(repo, "node:thread:t1", "sid-a", 100);
  const records = membershipRecords("sid-a", ["node:thread:t1"], [
    { typeName: "layout", nodeId: "node:thread:t1", x: 100, y: 100 },
    { typeName: "layout", nodeId: "node:live:sid-a", x: 150, y: 130 },
  ]);
  snap.captureMemberOffsets("b1", records);
  const marker1 = fs.readFileSync(path.join(ledger.canvasThreadsDir(repo), encodeURIComponent("node:thread:t1") + ".meta.json"), "utf8");
  snap.captureMemberOffsets("b1", records); // same positions again
  const marker2 = fs.readFileSync(path.join(ledger.canvasThreadsDir(repo), encodeURIComponent("node:thread:t1") + ".meta.json"), "utf8");
  assert.equal(marker1, marker2, "unchanged offset → marker byte-identical (no churn)");
});

// ── P4 reopen-set capture (the twin of offset capture: freeze-on-close from the snapshot) ────────────
// Records for a thread card `tid` with the given open-member sids (thread node + a session card + a
// member:open edge per sid). A member whose sid is NOT listed has no card/edge — display-only closed.
const threadWithOpenMembers = (tid, sids, includeThread = true) => [
  ...(includeThread ? [{ typeName: "node", id: tid, type: "thread", title: tid }] : []),
  ...sids.flatMap((sid, i) => [
    { typeName: "node", id: `node:live:${sid}`, type: "session", title: sid },
    { typeName: "edge", id: `e-${tid}-${i}`, from: `node:live:${sid}`, to: tid, type: "member:open" },
  ]),
];

test("captureReopenSets records the OPEN member set of each present thread card (from the snapshot)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  snap.captureReopenSets("b1", threadWithOpenMembers("node:thread:t1", ["sid-b", "sid-a"]));
  assert.deepEqual(ledger.readReopenSet(ledger.readThreadMeta(repo, "node:thread:t1")), ["sid-a", "sid-b"]);
});

test("captureReopenSets FREEZES the set when the thread card is absent from the snapshot (close preserves it)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  // Thread open with two members → set recorded.
  snap.captureReopenSets("b1", threadWithOpenMembers("node:thread:t1", ["sid-a", "sid-b"]));
  // A later save where the thread card (and its cluster) is GONE — the capture pass must not touch the set.
  snap.captureReopenSets("b1", []);
  assert.deepEqual(
    ledger.readReopenSet(ledger.readThreadMeta(repo, "node:thread:t1")),
    ["sid-a", "sid-b"],
    "closed thread keeps the last-open set = the set to restore on reopen",
  );
});

test("captureReopenSets shrinks the set when a member card is closed while the thread stays open", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  snap.captureReopenSets("b1", threadWithOpenMembers("node:thread:t1", ["sid-a", "sid-b"]));
  // sid-b's card was display-only closed (its node + edge removed); thread + sid-a remain.
  snap.captureReopenSets("b1", threadWithOpenMembers("node:thread:t1", ["sid-a"]));
  assert.deepEqual(ledger.readReopenSet(ledger.readThreadMeta(repo, "node:thread:t1")), ["sid-a"]);
});

test("captureReopenSets: a present thread card with no open members records the empty set (reopen = thread alone)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  snap.captureReopenSets("b1", threadWithOpenMembers("node:thread:t1", []));
  assert.deepEqual(ledger.readReopenSet(ledger.readThreadMeta(repo, "node:thread:t1")), []);
});

test("captureReopenSets is idempotent — an unchanged open-set writes nothing (no marker churn)", () => {
  const repo = tmpRepo();
  ctx.setServerContext({ fsState: {}, boards: new Map([["b1", { repoPath: repo }]]) });
  const records = threadWithOpenMembers("node:thread:t1", ["sid-a", "sid-b"]);
  snap.captureReopenSets("b1", records);
  const marker1 = fs.readFileSync(path.join(ledger.canvasThreadsDir(repo), encodeURIComponent("node:thread:t1") + ".meta.json"), "utf8");
  snap.captureReopenSets("b1", records); // same open-set again
  const marker2 = fs.readFileSync(path.join(ledger.canvasThreadsDir(repo), encodeURIComponent("node:thread:t1") + ".meta.json"), "utf8");
  assert.equal(marker1, marker2, "unchanged reopen-set → marker byte-identical");
});

// ── Group F: BUG-2 — the .ipynb read-edit-write cycle can no longer erase outputs ───────────────────────
// The /api/file file routes driven directly (no live server) against a scratch repo. Proves the whole
// clobber chain is closed: an agent GET returns the lossy projection with a POISONED version, and a POST of
// that projection is REFUSED (422) with the on-disk outputs intact — while a legitimate small edit still
// round-trips and a full-fidelity notebook over 128 KiB no longer 413s. (docs/architecture-review BUG-2.)

// The one route we exercise: GET/POST /api/file. `board` only needs repoPath (reanchor's arg); root == repo.
const fileRoute = filesRoute.fileRootRoutes.find((r) => r.match("/api/file"));

// Drive the route with a minimal req/res. GET is synchronous (sendJson); POST awaits readBody, so `res.done`
// resolves when the handler calls res.end. Returns { status, body } once the response is written.
function driveFile(repo, { method, pathParam, notebook, body }) {
  const req = Readable.from(body != null ? [Buffer.from(body, "utf8")] : []);
  req.method = method;
  let resolveEnd;
  const done = new Promise((r) => (resolveEnd = r));
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(s) { this.statusCode = s; },
    end(chunk) { this._body = chunk; resolveEnd(); },
  };
  const qs = new URLSearchParams({ path: pathParam });
  if (notebook) qs.set("notebook", notebook);
  const url = new URL(`http://x/api/file?${qs.toString()}`);
  fileRoute.run(req, res, url, [], "b1", { repoPath: repo }, repo);
  return done.then(() => ({ status: res.statusCode, body: JSON.parse(res._body) }));
}

// A minimal nbformat-v4 notebook carrying a real (large) base64 image output — the value the clobber erases.
function imageNotebookText(b64) {
  return JSON.stringify({
    cells: [
      { cell_type: "code", execution_count: 1, source: ["plt.plot([1,2,3])\n"], outputs: [{ output_type: "display_data", data: { "image/png": b64, "text/plain": ["<Figure>"] }, metadata: {} }] },
      { cell_type: "markdown", source: ["# Notes\n"] },
    ],
    metadata: { kernelspec: { name: "python3" } }, nbformat: 4, nbformat_minor: 5,
  });
}

test("BUG-2: an agent read-edit-write of an image-bearing .ipynb can no longer erase its outputs", async () => {
  const repo = tmpRepo();
  const rel = "notebooks/plot.ipynb";
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const realB64 = "A".repeat(200_000); // a ~200 KB base64 image — the real output on disk
  const onDisk = imageNotebookText(realB64);
  fs.writeFileSync(abs, onDisk, "utf8");

  // 1) Agent GET returns the LOSSY projection (image elided to a marker) with a POISONED version.
  const read = await driveFile(repo, { method: "GET", pathParam: rel });
  assert.equal(read.status, 200);
  assert.equal(read.body.trimmed, true, "the image output was elided on the agent read");
  assert.equal(read.body.version, null, "a trimmed read stamps a null version — not a valid CAS base");
  assert.ok(!read.body.content.includes(realB64), "the projection does not carry the real base64");

  // 2) POST that projection back — the naive read-edit-write. It MUST be refused, outputs untouched on disk.
  const clobber = await driveFile(repo, { method: "POST", pathParam: rel, body: JSON.stringify({ content: read.body.content }) });
  assert.equal(clobber.status, 422, "a write carrying elision markers is rejected");
  assert.match(clobber.body.error, /elision markers/);
  assert.equal(fs.readFileSync(abs, "utf8"), onDisk, "the real outputs are still on disk, byte-identical");

  // 3) Even a CAS-honest writer that echoes the poisoned version is refused (baseVersion:null vs real hash).
  const casRefused = await driveFile(repo, { method: "POST", pathParam: rel, body: JSON.stringify({ content: read.body.content, baseVersion: read.body.version }) });
  assert.equal(casRefused.status, 422, "marker guard fires before the CAS; either way the write is refused");
  assert.equal(fs.readFileSync(abs, "utf8"), onDisk, "still intact");
});

test("BUG-2: a legitimate small edit of a clean notebook still round-trips (200)", async () => {
  const repo = tmpRepo();
  const rel = "notebooks/clean.ipynb";
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // A small, output-light notebook — the agent read is NOT trimmed, so it carries a real version.
  const original = JSON.stringify({ cells: [{ cell_type: "code", source: ["1+1\n"], outputs: [{ output_type: "stream", name: "stdout", text: ["2\n"] }], execution_count: 1 }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  fs.writeFileSync(abs, original, "utf8");

  const read = await driveFile(repo, { method: "GET", pathParam: rel });
  assert.equal(read.body.trimmed, false, "nothing to elide → not trimmed");
  assert.ok(read.body.version, "an untrimmed read carries a real version (a safe CAS base)");

  // Edit a cell source, keep the real (marker-free) outputs, write back with the read version.
  const edited = JSON.parse(read.body.content);
  edited.cells[0].source = ["2+2\n"];
  const write = await driveFile(repo, { method: "POST", pathParam: rel, body: JSON.stringify({ content: JSON.stringify(edited), baseVersion: read.body.version }) });
  assert.equal(write.status, 200, "a clean edit passes the marker guard AND the CAS");
  assert.ok(write.body.ok);
  assert.match(fs.readFileSync(abs, "utf8"), /2\+2/, "the edit landed on disk");
});

test("BUG-2: a full-fidelity .ipynb write over 128 KiB no longer 413s (write cap keyed on extension)", async () => {
  const repo = tmpRepo();
  const rel = "notebooks/big.ipynb";
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // A marker-free notebook well over the old MAX_BYTES (128 KiB) — a real image-bearing write-back.
  const big = imageNotebookText("A".repeat(400_000)); // ~400 KB, no elision markers
  assert.ok(Buffer.byteLength(big, "utf8") > 128 * 1024, "fixture exceeds the old 128 KiB text cap");
  const write = await driveFile(repo, { method: "POST", pathParam: rel, body: JSON.stringify({ content: big }) });
  assert.equal(write.status, 200, "a >128 KiB .ipynb write is accepted against the notebook ceiling");
  assert.equal(fs.readFileSync(abs, "utf8"), big, "the full notebook is on disk");

  // A same-size NON-notebook text write is still bounded at 128 KiB (the cap is keyed on extension).
  const bigTxt = "x".repeat(200_000);
  const txt = await driveFile(repo, { method: "POST", pathParam: "notes/big.txt", body: JSON.stringify({ content: bigTxt }) });
  assert.equal(txt.status, 413, "a >128 KiB .txt write is still too large");
});

// ── Group I: the inbox read (computeInbox) — default budget + non-consuming recovery (inbox-hardening) ──
// The inbox read 404s on any non-live session and the always-on scratch board REFUSES to spawn one, so the
// http-contract net can only probe the 404 there. The behavioral contract — a self-bounding default byte
// budget, a keep-tail `truncated` flag, and the ?since / ?peek recovery reads that DON'T consume the cursor —
// is exercised here, against a fake ServerContext carrying a live session + an in-memory thread log. This is
// the code-level answer to the footgun the harness leaf only WARNED about: `| head -c` consumes the cursor
// and loses the cut tail; these reads make client-side truncation unnecessary and any loss one-GET recoverable.
const NO_OPTS = { limit: null, bytes: null, since: null, peek: false };
// A fake context: one live session `sid` joined to thread `tid`, whose in-memory log is `msgs`. `read` seeds
// the session's per-thread cursor. Returns the session object + a `persisted` log so a test can assert whether
// the cursor was advanced (a consuming read persists; a recovery read must not). repoPath points at nothing,
// so readThreadLog/readPins (real disk reads) return [] — the in-memory `msgs`/no-pins path is what's tested.
function inboxFake(sid, tid, msgs, read = {}) {
  const session = { repoPath: path.join(os.tmpdir(), "no-such-inbox-repo"), read: { ...read } };
  const records = [{ typeName: "node", id: tid, type: "thread", title: "T" }];
  const persisted = [];
  ctx.setServerContext({
    liveSessions: new Map([[sid, session]]),
    boardIdentity: () => ({ boardId: "b1" }),
    boardSnapshotRecords: () => records,
    sessionThreads: () => [tid],
    threadLog: () => msgs,
    threadNode: () => ({ title: "T" }),
    sessionNameForSid: () => null,
    persistSessionState: (s) => persisted.push(s),
  });
  return { session, persisted };
}
const msg = (seq, text, kind) => ({ seq, ts: 1_700_000_000_000 + seq, from: "human", text, ...(kind ? { kind } : {}) });

test("computeInbox: 400 on missing session, 404 on a non-live one", () => {
  inboxFake("s1", "node:thread:t", [msg(1, "hi")]);
  assert.equal(inbox.computeInbox(null, NO_OPTS).status, 400);
  assert.equal(inbox.computeInbox("ghost", NO_OPTS).status, 404);
});

test("computeInbox: a plain read consumes (advances cursor + persists); card-only entries skip but still advance", () => {
  const tid = "node:thread:t";
  const { session, persisted } = inboxFake("s1", tid, [msg(1, "one"), msg(2, "intent act", "intent"), msg(3, "three")]);
  const { status, body } = inbox.computeInbox("s1", NO_OPTS);
  assert.equal(status, 200);
  assert.deepEqual(body.channels[0].messages.map((m) => m.seq), [1, 3], "the card-only (kind:intent) entry is not inbox content");
  assert.equal(body.count, 2);
  assert.equal(session.read[tid], 3, "cursor advances to the LOG end (incl. the skipped card-only seq), not just the last returned");
  assert.equal(persisted.length, 1, "a consuming read persists the advanced cursor");
});

test("computeInbox: ?since replays from an arbitrary seq, overriding the cursor DOWNWARD, and does NOT consume", () => {
  const tid = "node:thread:t";
  const msgs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => msg(n, `m${n}`));
  const { session, persisted } = inboxFake("s1", tid, msgs, { [tid]: 5 }); // cursor already at 5
  // A normal read from cursor 5 would yield 6..8; ?since=2 re-serves 3..8 REGARDLESS of the cursor.
  const { body } = inbox.computeInbox("s1", { ...NO_OPTS, since: 2 });
  assert.deepEqual(body.channels[0].messages.map((m) => m.seq), [3, 4, 5, 6, 7, 8]);
  assert.equal(session.read[tid], 5, "a ?since recovery read leaves the cursor untouched");
  assert.equal(persisted.length, 0, "nothing persisted — a recovery read mutates no state");
});

test("computeInbox: ?peek serves the unread tail WITHOUT advancing the cursor (a plain re-read then sees it again)", () => {
  const tid = "node:thread:t";
  const msgs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => msg(n, `m${n}`));
  const { session, persisted } = inboxFake("s1", tid, msgs, { [tid]: 5 });
  const peek = inbox.computeInbox("s1", { ...NO_OPTS, peek: true });
  assert.deepEqual(peek.body.channels[0].messages.map((m) => m.seq), [6, 7, 8], "peek shows the current unread tail");
  assert.equal(session.read[tid], 5, "peek did not advance the cursor");
  assert.equal(persisted.length, 0);
  // The very same unread is still there for a subsequent CONSUMING read — peek spent nothing.
  const real = inbox.computeInbox("s1", NO_OPTS);
  assert.deepEqual(real.body.channels[0].messages.map((m) => m.seq), [6, 7, 8]);
  assert.equal(session.read[tid], 8, "the consuming read then advances");
});

test("computeInbox: the DEFAULT byte budget bounds an unbounded read — keeps the TAIL, flags truncated, no client truncation needed", () => {
  const tid = "node:thread:t";
  // Five ~40 KiB messages ⇒ ~200 KiB, over the 128 KiB default. No &bytes passed ⇒ the default must bite.
  const big = "y".repeat(40 * 1024);
  const msgs = [1, 2, 3, 4, 5].map((n) => msg(n, `${n}:${big}`));
  inboxFake("s1", tid, msgs);
  const { body } = inbox.computeInbox("s1", NO_OPTS);
  const ch = body.channels[0];
  assert.ok(ch.truncated && ch.truncated.omitted > 0, "the default budget truncated an over-large backlog");
  // Kept the TAIL (the most recent), never the head — the CLAUDE.md scroll-to-bottom rule.
  const keptSeqs = ch.messages.map((m) => m.seq);
  assert.equal(keptSeqs.at(-1), 5, "the newest message is kept");
  assert.ok(keptSeqs[0] > 1, "the OLDEST messages are the ones dropped (tail kept)");
  // The hint points at the ONE-GET recovery (wider &bytes / &since), not the retired leave+rejoin dance.
  assert.match(ch.truncated.hint, /&bytes=|&since=/);
  assert.doesNotMatch(ch.truncated.hint, /re-join|history/i);
});

test("computeInbox: an explicit &bytes overrides the default, and a small backlog under budget is never flagged", () => {
  const tid = "node:thread:t";
  const msgs = [msg(1, "aaaa"), msg(2, "bbbb"), msg(3, "cccc")];
  // Under the default budget ⇒ everything returned, no truncated flag.
  inboxFake("s1", tid, msgs);
  const full = inbox.computeInbox("s1", NO_OPTS);
  assert.equal(full.body.channels[0].truncated, undefined, "a small backlog under the default budget is not flagged");
  // A tiny explicit &bytes keeps only the tail and flags the omission (always ≥1 message).
  inboxFake("s1", tid, msgs); // fresh cursor
  const tiny = inbox.computeInbox("s1", { ...NO_OPTS, bytes: 5 });
  assert.deepEqual(tiny.body.channels[0].messages.map((m) => m.seq), [3], "the byte budget keeps the newest message");
  assert.equal(tiny.body.channels[0].truncated.omitted, 2);
});

test("dropped-delivery regression: posting while a message from ANOTHER is unread must not swallow it (read tier)", () => {
  // The exact live repro (meta seq 66): session A read up to seq 1; seq 2 (from B, untagged) arrived; then A
  // posts seq 3. The old code jumped A's cursor to 3 on its own post, silently marking seq 2 read though A
  // never saw it. Model the handler's two composed pieces (senderCursorAfterPost + the inbox read) end-to-end.
  const tid = "node:thread:t";
  const log = [msg(1, "from B", undefined), { seq: 2, ts: 2, from: "sess-B", text: "interleaved, untagged" }];
  const { session } = inboxFake("s1", tid, log, { [tid]: 1 }); // A caught up only through seq 1
  // A posts seq 3 — append it and advance A's cursor exactly as handleThreadMessage does.
  log.push({ seq: 3, ts: 3, from: "s1", text: "A's own post" });
  session.read[tid] = casGuard.senderCursorAfterPost(session.read[tid] ?? 0, 3);
  assert.equal(session.read[tid], 1, "cursor HELD at 1 (not jumped to 3) because seq 2 was unread");
  // A's next inbox read still serves the interleaved seq 2 (and re-serves its own seq 3 once — the tradeoff).
  const seqs = inbox.computeInbox("s1", NO_OPTS).body.channels[0].messages.map((m) => m.seq);
  assert.ok(seqs.includes(2), "the interleaved message from B survives — never silently dropped");
  assert.deepEqual(seqs, [2, 3], "seq 2 (B) + seq 3 (own, re-served once); nothing lost");
  // Contrast: had A been caught up (cursor at 2) when it posted, the cursor advances cleanly to 3 (no echo).
  session.read[tid] = casGuard.senderCursorAfterPost(2, 3);
  assert.equal(session.read[tid], 3);
  assert.equal(inbox.computeInbox("s1", NO_OPTS).body.channels.length, 0, "caught-up sender sees no echo of its own post");
});

// ── Group H: scratch-board predicates (phase-2 log-noise fix) ────────────────────────────────────────
// isTmpdirRepo is the ONE definition of "this repo is a throwaway scratch/test board" (server-boards.ts):
// recordBoardOpened refuses to persist one, boot prunes one, and sessionSpawnRefusal/isScratchBoard build on
// it. Tested DIRECTLY (the Coordinator's ask): match at any depth, never a substring of a sibling.
test("isTmpdirRepo matches under the OS tmpdir at any depth but never a substring sibling", () => {
  const tmp = fs.realpathSync(os.tmpdir());
  // A real dir directly under tmpdir → scratch.
  const shallow = fs.mkdtempSync(path.join(tmp, "scratch-shallow-"));
  assert.equal(boardsMod.isTmpdirRepo(shallow), true, "a dir directly under tmpdir is scratch");
  // A real dir nested several levels under tmpdir → still scratch (depth-independent, not a prefix hack).
  const deep = path.join(shallow, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(boardsMod.isTmpdirRepo(deep), true, "a deeply nested dir under tmpdir is scratch");
  // A path that no longer exists but is stored as a tmpdir path → still scratch (the vanished-scratch case:
  // realpath fails, the fallback compares the resolved stored path, which the registry already stored real).
  assert.equal(boardsMod.isTmpdirRepo(path.join(tmp, "canvas-contract-board-gone")), true, "a deleted tmpdir path still prunes");
  // A SIBLING whose name merely shares tmpdir as a string prefix is NOT scratch (the substring-match trap):
  // `${tmp}-evil` is a different tree, guarded by comparing against `tmp + path.sep`.
  assert.equal(boardsMod.isTmpdirRepo(tmp + "-evil/repo"), false, "a `${tmp}-evil` sibling is not scratch");
  // A real repo well outside tmpdir (this checkout) is a real board.
  assert.equal(boardsMod.isTmpdirRepo(process.cwd()), false, "the dev checkout is a real board");
});

test("isScratchBoard is true for a tmpdir repo OR the noSessions flag, false for a real board / unknown", () => {
  const tmpBoard = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-board-"));
  const realBoard = fs.mkdtempSync(path.join(process.cwd(), "hermetic-real-")); // a real dir, NOT under tmpdir
  try {
    ctx.setServerContext({
      boards: new Map([
        ["tmp-b", { boardId: "tmp-b", repoPath: tmpBoard }],
        ["flag-b", { boardId: "flag-b", repoPath: realBoard, noSessions: true }],
        ["real-b", { boardId: "real-b", repoPath: realBoard }],
      ]),
    });
    assert.equal(sess.isScratchBoard("tmp-b"), true, "tmpdir repo → scratch");
    assert.equal(sess.isScratchBoard("flag-b"), true, "noSessions flag → scratch even off tmpdir");
    assert.equal(sess.isScratchBoard("real-b"), false, "a real board off tmpdir with no flag → not scratch");
    assert.equal(sess.isScratchBoard("no-such-board"), false, "an unknown board is not scratch (spawn path surfaces its own error)");
    // sessionSpawnRefusal, its string twin, agrees and names the reason.
    assert.match(sess.sessionSpawnRefusal("tmp-b") ?? "", /tmpdir/, "the refusal reason names the tmpdir backstop");
    assert.match(sess.sessionSpawnRefusal("flag-b") ?? "", /noSessions/, "the refusal reason names the sticky flag");
    assert.equal(sess.sessionSpawnRefusal("real-b"), null, "a real board is spawn-allowed");
  } finally {
    fs.rmSync(realBoard, { recursive: true, force: true });
  }
});

// ── Group H: /api/ws phantom-tab over-count (heartbeat reaper + tabCountFor dedupe) ─────────────────
// Fix for the "[boards] N tabs now live" over-count on board switch: a board switch is a full-page nav,
// so the old page's socket may linger half-open (its close frame lost) filed under the same board id.
// The reaper terminates a socket that missed its ping; tabCountFor dedupes overlap by a stable per-tab id.

test("installWsHeartbeat terminates a socket that missed its ping, pings a live one", () => {
  // A fake ws recording ping/terminate and letting the test fire "pong". The reaper's setInterval never
  // fires under node:test's fake-free clock in-band, so we grab the tick body by stubbing setInterval.
  const calls = { ping: 0, terminate: 0 };
  let pongCb = null;
  const ws = {
    readyState: 1,
    OPEN: 1,
    on(ev, cb) {
      if (ev === "pong") pongCb = cb;
    },
    ping() {
      calls.ping++;
    },
    terminate() {
      calls.terminate++;
    },
  };
  const realSetInterval = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (fn) => {
    tick = fn;
    return 0;
  };
  try {
    plugin.installWsHeartbeat(ws, 25000);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.ok(typeof tick === "function", "the reaper armed an interval");
  assert.ok(typeof pongCb === "function", "the reaper registered a pong handler");

  // First tick: socket was alive (initial arm) → it pings, does NOT terminate, and arms isAlive=false.
  tick();
  assert.equal(calls.ping, 1, "a live socket is pinged");
  assert.equal(calls.terminate, 0, "a live socket is not terminated");

  // No pong arrives → next tick sees the missed ping and terminates (which, in prod, fires ws.on(close)).
  tick();
  assert.equal(calls.terminate, 1, "a socket that missed its ping is terminated");

  // A socket that DOES pong between ticks is kept alive and pinged again, never terminated.
  calls.ping = 0;
  calls.terminate = 0;
  pongCb(); // pong received → re-armed
  tick();
  assert.equal(calls.terminate, 0, "a ponging socket is not terminated");
  assert.equal(calls.ping, 1, "a ponging socket is pinged again");
});

test("tabCountFor dedupes WS clients by stable tab id; untagged legacy sockets count individually", () => {
  const st = globalThis.__canvasFsState;
  const wsSet = ctx.getWsClients(st);
  const busMap = ctx.getBusClients(st);
  wsSet.clear();
  busMap.clear();
  const mk = (boardId, tab) => ({ boardId, tab, watches: new Map(), send() {} });

  // Two sockets from ONE browser tab (board-switch overlap: old page's socket lingers) share a tab id.
  wsSet.add(mk("board-a", "T1"));
  wsSet.add(mk("board-a", "T1"));
  assert.equal(plugin.tabCountFor("board-a"), 1, "same tab id counts once (no phantom over-count)");

  // A genuinely second browser tab has its own sessionStorage id → counts separately.
  wsSet.add(mk("board-a", "T2"));
  assert.equal(plugin.tabCountFor("board-a"), 2, "a distinct tab id adds one");

  // Untagged/legacy sockets (no ?tab=) each count individually — no dedupe, the pre-existing behaviour.
  wsSet.add(mk("board-a", undefined));
  wsSet.add(mk("board-a", undefined));
  assert.equal(plugin.tabCountFor("board-a"), 4, "two untagged sockets add two");

  // Other boards don't leak into the census.
  wsSet.add(mk("board-b", "T3"));
  assert.equal(plugin.tabCountFor("board-a"), 4, "another board's socket is not counted");
  assert.equal(plugin.tabCountFor("board-b"), 1);

  // SSE busClients keep counting per-connection, added on top of the WS census.
  busMap.set("board-a", new Set([{ res: {} }, { res: {} }]));
  assert.equal(plugin.tabCountFor("board-a"), 6, "SSE compat clients add on top of the deduped WS count");

  wsSet.clear();
  busMap.clear();
});
