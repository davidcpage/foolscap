// Board-engine stage 1 (design §9): the server-materialized store. These tests prove the two
// guarantees the design turns on:
//   1. FOLD EQUIVALENCE — a live-store read equals a snapshot+tail fold over the SAME inputs, and the
//      incremental per-event fold equals a from-scratch hydrate. The reference is core's real
//      Persistence.hydrate (core/src/persist.ts), so we prove "same computation", not "similar".
//   2. REHYDRATE — dropping the store and rebuilding from files yields identical records (the §10
//      module-identity-doubt recovery: cheap and bit-identical).
//
// Importing board-engine.ts here also exercises core's Store (→ @tldraw/state/signia) under the app's
// plain `node --test` runner — the server process's own module context — the §10 behavioural probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolve core's `.js`-suffixed relative imports to the `.ts` sources under the app's tsx-less runner
// (the membership-hermetic.test.mjs pattern).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const ctx = await import("../server-context.ts");
const engine = await import("../board-engine.ts");
const bp = await import("../board-persist.js");
const { Store } = await import("../../core/src/store.ts");
const { Persistence, MemoryEventStore, MemorySnapshotStore } = await import("../../core/src/persist.ts");

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const node = (id, extra = {}) => ({ typeName: "node", id, type: "note", ...extra });
const diffAdd = (r) => ({ added: { [r.id]: r }, updated: {}, removed: {} });
const diffUpdate = (from, to) => ({ added: {}, updated: { [to.id]: [from, to] }, removed: {} });
const diffRemove = (r) => ({ added: {}, updated: {}, removed: { [r.id]: r } });

const A0 = node("node:A", { title: "A" });
const A1 = node("node:A", { title: "A2" }); // A retitled
const B = node("node:B", { title: "B" });

// event 1 (add A) is baked into the snapshot at seq 1; events 2..4 are the post-snapshot tail.
const EVENTS = [
  { type: "addNode", payload: {}, actor: "t", id: "e1", ts: 1, seq: 1, parent: 0, diff: diffAdd(A0) },
  { type: "addNode", payload: {}, actor: "t", id: "e2", ts: 2, seq: 2, parent: 1, diff: diffAdd(B) },
  { type: "setTitle", payload: {}, actor: "t", id: "e3", ts: 3, seq: 3, parent: 2, diff: diffUpdate(A0, A1) },
  { type: "removeNode", payload: {}, actor: "t", id: "e4", ts: 4, seq: 4, parent: 3, diff: diffRemove(B) },
];
const SNAP_AT_1 = { records: [A0], version: 1, seq: 1 };

const byId = (recs) => [...recs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "board-engine-"));

// The canonical reference: core's own hydrate over the same snapshot + full event log.
async function coreHydrate(snapshot, events) {
  const es = new MemoryEventStore();
  for (const e of events) await es.append(e);
  const ss = new MemorySnapshotStore();
  if (snapshot) await ss.save(snapshot);
  const store = new Store();
  const p = new Persistence({ events: es, snapshots: ss });
  const res = await p.hydrate(store);
  return { records: store.getSnapshot().records, version: store.version, hydrate: res };
}

// A minimal wired ServerContext so the stateful engine functions reach fsState (the pinned store map)
// and a boardId→repoPath registry. (The fold/read functions take (boardId, repoPath) explicitly.)
const BOARD = "board-x";
function wire(repoPath) {
  const fsState = {};
  ctx.setServerContext({ fsState, boards: new Map([[BOARD, { boardId: BOARD, repoPath }]]) });
  return fsState;
}

// ── 1. pure fold == core hydrate (snapshot + tail) ───────────────────────────────────────────────────
test("foldSnapshotAndEvents == core Persistence.hydrate (records, version, watermark)", async () => {
  const ref = await coreHydrate(SNAP_AT_1, EVENTS);
  const got = engine.foldSnapshotAndEvents(SNAP_AT_1, EVENTS);
  assert.deepEqual(byId(got.records), byId(ref.records), "records match core hydrate");
  assert.equal(got.version, ref.version, "version matches core hydrate");
  assert.equal(got.watermark, 4, "watermark = highest seq reflected");
  // Sanity on the fixture: A retitled survives, B added-then-removed nets to absence.
  assert.deepEqual(byId(got.records), [A1], "A2 present, B absent");
});

test("foldSnapshotAndEvents from a fresh log (no snapshot) == core hydrate", async () => {
  const ref = await coreHydrate(null, EVENTS);
  const got = engine.foldSnapshotAndEvents(null, EVENTS);
  assert.deepEqual(byId(got.records), byId(ref.records), "records match with no base snapshot");
  assert.equal(got.version, ref.version, "version matches with no base snapshot");
});

// ── 2. SEAM TEST: the live store's incremental fold == a from-scratch hydrate over the same files ──────
test("seam: incremental live-store fold (hydrate@seq1 → fold e2..e4) == batch hydrate over all files", async () => {
  const repo = tmpRepo();
  // On disk: snapshot at seq 1 + ONLY event 1 (the snapshot's own event). The board first touches here.
  bp.writeBoardSnapshot(repo, SNAP_AT_1);
  bp.appendBoardEvent(repo, EVENTS[0]);
  wire(repo);

  // First read hydrates the live store from files (snapshot@1, no tail).
  assert.deepEqual(byId(engine.boardStoreRecords(BOARD, repo)), [A0], "hydrated to snapshot state");

  // Now the post-snapshot events arrive one at a time (the echo path): append to the log, then fold.
  for (const e of EVENTS.slice(1)) {
    bp.appendBoardEvent(repo, e);
    engine.foldBoardEvent(BOARD, repo, e);
  }

  const live = engine.boardStoreRecords(BOARD, repo);
  const ref = await coreHydrate(SNAP_AT_1, EVENTS); // batch hydrate over the identical files
  assert.deepEqual(byId(live), byId(ref.records), "incremental live store == batch hydrate");
  assert.deepEqual(byId(live), [A1], "final state: A2 present, B gone");

  // /api/canvas payload shape: records + version + watermark seq.
  const canvas = engine.boardStoreCanvasSnapshot(BOARD, repo);
  assert.equal(canvas.version, ref.version, "canvas version matches hydrate");
  assert.equal(canvas.seq, 4, "canvas seq = watermark");
});

// A re-delivered / already-hydrated event must not double-apply (watermark dedup).
test("seam: folding an event already reflected (seq <= watermark) is a no-op", async () => {
  const repo = tmpRepo();
  for (const e of EVENTS) bp.appendBoardEvent(repo, e);
  wire(repo);
  const before = byId(engine.boardStoreRecords(BOARD, repo)); // hydrates with all 4 events
  for (const e of EVENTS) engine.foldBoardEvent(BOARD, repo, e); // re-deliver every one
  assert.deepEqual(byId(engine.boardStoreRecords(BOARD, repo)), before, "no change on re-delivery");
});

// ── 3. REHYDRATE: drop the store, rebuild from files → identical records (§10 recovery) ───────────────
test("rehydrate: drop the store then rebuild from files yields identical records", async () => {
  const repo = tmpRepo();
  for (const e of EVENTS) bp.appendBoardEvent(repo, e);
  bp.writeBoardSnapshot(repo, SNAP_AT_1);
  wire(repo);

  const first = byId(engine.boardStoreRecords(BOARD, repo));
  engine.dropBoardEngine(BOARD); // module-identity doubt after a plugin reload
  const rehydrated = byId(engine.boardStoreRecords(BOARD, repo));
  assert.deepEqual(rehydrated, first, "rehydrated store == pre-drop store");

  // rehydrateBoardEngine is the explicit form and equally faithful.
  const explicit = byId(engine.rehydrateBoardEngine(BOARD, repo).store.getSnapshot().records);
  assert.deepEqual(explicit, first, "explicit rehydrate == original");
});

// ── 3b. snapshot reconcile: a directly-authored snapshot (records never folded via an event) shows up ──
// This is the path the http-contract tests exercise: POST /api/board/persist/snapshot with records and
// no events. A store hydrated BEFORE such a save would otherwise never see those records.
test("reconcile: a direct snapshot save (records, no events) becomes visible on an already-hydrated store", () => {
  const repo = tmpRepo();
  wire(repo);
  // Board first touched empty → store resident with watermark 0.
  assert.equal(engine.boardStoreRecords(BOARD, repo), null, "empty board reads null");
  // A client writes a snapshot directly (a thread node), no event echo.
  const direct = { records: [node("node:T", { type: "thread", title: "T" })], version: 3, seq: 40 };
  bp.writeBoardSnapshot(repo, direct);
  engine.reconcileBoardEngineOnSnapshot(BOARD, repo, direct);
  assert.deepEqual(byId(engine.boardStoreRecords(BOARD, repo)), byId(direct.records), "direct-saved records visible");
  const canvas = engine.boardStoreCanvasSnapshot(BOARD, repo);
  assert.equal(canvas.seq, 40, "watermark adopts the snapshot seq");
});

test("reconcile: an ordinary debounced save (seq <= watermark) does NOT discard newer folded state", () => {
  const repo = tmpRepo();
  for (const e of EVENTS) bp.appendBoardEvent(repo, e);
  wire(repo);
  const live = engine.boardStoreRecords(BOARD, repo); // watermark 4 (all events folded)
  // A stale-ish snapshot save at seq 4 (== watermark) carrying the SAME state must be a no-op, not a
  // rehydrate that could regress if the snapshot lagged. State stays == the folded store.
  const save = { records: [A1], version: 4, seq: 4 };
  bp.writeBoardSnapshot(repo, save);
  engine.reconcileBoardEngineOnSnapshot(BOARD, repo, save);
  assert.deepEqual(byId(engine.boardStoreRecords(BOARD, repo)), byId(live), "no change on an at-watermark save");
});

// ── STAGE 2: command authority server-side (write authority, design §9 stage 2 / §10) ────────────────
// commitBoardCommand is the single append point for a bus command; appendTabEvent is the tab-echo path
// that reassigns the authoritative seq. Together they prove this thread's headline: a headless commit is
// durable + visible before the call returns, exactly one IntentEvent per command, and no seq can collide.

test("commit: a headless addNode with ZERO tabs is durable + live-store visible + ONE server-minted event", () => {
  const repo = tmpRepo();
  wire(repo);
  assert.equal(engine.boardStoreRecords(BOARD, repo), null, "fresh board reads null");

  const ev = engine.commitBoardCommand(BOARD, repo, { type: "addNode", payload: { id: "node:h", type: "note" }, actor: "claude" });

  // The committed event: server-minted seq 1, carrying the diff addNode materialized (node + layout pair).
  assert.equal(ev.seq, 1, "server minted seq 1");
  assert.ok(ev.diff.added["node:h"] && ev.diff.added["layout:node:h"], "diff adds the node + its layout");
  // DURABLE at commit, no tab: exactly one line in events.jsonl.
  const persisted = bp.readBoardPersist(repo);
  assert.equal(persisted.events.length, 1, "exactly one IntentEvent appended");
  assert.equal(persisted.events[0].seq, 1, "the durable event carries the server seq");
  // VISIBLE to server reads immediately (the design headline): the live store + the /api/canvas payload.
  assert.ok(byId(engine.boardStoreRecords(BOARD, repo)).some((r) => r.id === "node:h"), "node visible in the live store");
  assert.equal(engine.boardStoreCanvasSnapshot(BOARD, repo).seq, 1, "canvas watermark advanced to the commit seq");
});

test("commit: one IntentEvent per command — two commits append two events with seqs 1,2 (no double-append)", () => {
  const repo = tmpRepo();
  wire(repo);
  const a = engine.commitBoardCommand(BOARD, repo, { type: "addNode", payload: { id: "node:h", type: "note" }, actor: "claude" });
  const b = engine.commitBoardCommand(BOARD, repo, { type: "setColor", payload: { id: "node:h", color: "red" }, actor: "claude" });
  assert.deepEqual([a.seq, b.seq], [1, 2], "seqs are consecutive and server-minted");
  const events = bp.readBoardPersist(repo).events;
  assert.equal(events.length, 2, "exactly two events — one per command, no tab re-echo doubling them");
  assert.equal(engine.boardStoreRecords(BOARD, repo).find((r) => r.id === "node:h").color, "red", "the second commit's effect is live");
});

test("commit: an unknown command type throws and leaves the store + files untouched", () => {
  const repo = tmpRepo();
  wire(repo);
  assert.throws(() => engine.commitBoardCommand(BOARD, repo, { type: "frobnicate", payload: {}, actor: "claude" }), /no handler/);
  assert.equal(bp.readBoardPersist(repo).events.length, 0, "nothing appended on a validation reject");
  assert.equal(engine.boardStoreRecords(BOARD, repo), null, "store never left the unpersisted (null) state");
});

test("seq handover (§10): appendTabEvent REASSIGNS the server seq — a bus commit + a tab echo never collide", () => {
  const repo = tmpRepo();
  wire(repo);
  // A bus command commits server-side at seq 1.
  const bus = engine.commitBoardCommand(BOARD, repo, { type: "addNode", payload: { id: "node:a", type: "note" }, actor: "claude" });
  assert.equal(bus.seq, 1, "bus commit → seq 1");
  // A tab echoes a human gesture carrying a STALE provisional seq 1 (its mirror hadn't seen the bus commit).
  // The server ignores it and assigns the next authoritative seq (2), folding the diff into the live store.
  const tabSeq = engine.appendTabEvent(BOARD, repo, { type: "addNode", payload: {}, actor: "human", id: "e-tab", ts: 9, seq: 1, parent: 1, diff: diffAdd(B) });
  assert.equal(tabSeq, 2, "the tab's provisional seq 1 is reassigned to the authoritative 2 — no collision");
  // A second bus command continues the single sequence at 3.
  const bus2 = engine.commitBoardCommand(BOARD, repo, { type: "setColor", payload: { id: "node:a", color: "red" }, actor: "claude" });
  assert.equal(bus2.seq, 3, "the one server counter continues across both paths");
  const seqs = bp.readBoardPersist(repo).events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3], "the durable log holds a single, gapless, non-colliding seq sequence");
  // The tab-echoed record (B) folded into the live store too.
  assert.ok(engine.boardStoreRecords(BOARD, repo).some((r) => r.id === "node:B"), "the tab gesture folded into the live store");
});

test("§3.3 dedup ring: a RESENT tab event (same id) returns the assigned seq, never a duplicate durable append", () => {
  const repo = tmpRepo();
  wire(repo);
  const ev = { type: "addNode", payload: {}, actor: "human", id: "e-resend", ts: 9, seq: 1, parent: 0, diff: diffAdd(B) };
  const first = engine.appendTabEvent(BOARD, repo, ev);
  assert.equal(first, 1, "first sighting → seq 1");
  // A lost-ack resend (the tab never saw the first ack, re-POSTs the same event id).
  const second = engine.appendTabEvent(BOARD, repo, ev);
  assert.equal(second, 1, "the resend returns the ALREADY-assigned seq (idempotent by id)");
  const seqs = bp.readBoardPersist(repo).events.map((e) => e.seq);
  assert.deepEqual(seqs, [1], "the durable log holds ONE event — no duplicate append on resend");
  // A genuinely new event still advances the sequence normally.
  const third = engine.appendTabEvent(BOARD, repo, { type: "addNode", payload: {}, actor: "human", id: "e-new", ts: 10, parent: 1, diff: diffAdd({ id: "node:C", type: "note", x: 0, y: 0, w: 1, h: 1 }) });
  assert.equal(third, 2, "a fresh id advances to seq 2");
});

// ── 4. null contract preserved: a brand-new (unpersisted) board reads null, not [] ───────────────────
test("boardStoreRecords is null for an unpersisted board, an array once anything is folded", async () => {
  const repo = tmpRepo(); // no .canvas/board files yet
  wire(repo);
  assert.equal(engine.boardStoreRecords(BOARD, repo), null, "fresh board → null (old snapshot-null contract)");
  assert.equal(engine.boardStoreCanvasSnapshot(BOARD, repo), null, "fresh board → null canvas snapshot");

  bp.appendBoardEvent(repo, EVENTS[0]);
  engine.foldBoardEvent(BOARD, repo, EVENTS[0]);
  assert.deepEqual(byId(engine.boardStoreRecords(BOARD, repo)), [A0], "after first event → records array");
});
