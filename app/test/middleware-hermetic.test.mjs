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
const delivery = await import("../server-delivery.ts");
const ledger = await import("../thread-ledger.js");
const filesRoute = await import("../routes/files.ts");

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

test("allSessionAnchors maps every durable member to its primary thread, board-wide (marker-only)", () => {
  const repo = tmpRepo();
  ledger.addThreadMember(repo, "node:thread:t1", "sid-a", 100); // sid-a primary
  ledger.addThreadMember(repo, "node:thread:t2", "sid-a", 200); // sid-a secondary
  ledger.addThreadMember(repo, "node:thread:t2", "sid-b", 50); // sid-b only here
  const anchors = snap.allSessionAnchors(repo);
  assert.equal(anchors["sid-a"], "node:thread:t1", "earliest join is primary");
  assert.equal(anchors["sid-b"], "node:thread:t2");
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
