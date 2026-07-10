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
const delivery = await import("../server-delivery.ts");

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

// ── Group B: server-snapshot pure record resolvers (no context) ─────────────────────────────────────
const RECORDS = [
  { typeName: "node", id: "node:live:s1", type: "session", title: "s1", name: "Coordinator.s1" },
  { typeName: "node", id: "node:live:s2", type: "session", title: "s2" }, // a session card with no display name
  { typeName: "node", id: "node:thread:t1", type: "thread", title: "T1" },
  { typeName: "node", id: "node:thread:t2", type: "channel", title: "Legacy" }, // carried-over legacy type
  { typeName: "node", id: "node:doc:d1", type: "doc", title: "A doc" },
  { typeName: "edge", id: "e1", from: "node:live:s1", to: "node:thread:t1", type: "member:open" },
];

test("server-snapshot sidFromSessionNode maps a live-session node id to its sid", () => {
  assert.equal(snap.sidFromSessionNode("node:live:abc-123"), "abc-123");
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
