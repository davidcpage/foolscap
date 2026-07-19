// S3-b inbound catch-up (design §9 stage 3, D4): the tab-side convergence logic that heals a dropped
// connection — classifyInbound (in-order / gap / already-have) and foldCatchUp (apply a since(watermark)
// range in seq order). Exercised against a REAL core Store + Persistence (no browser), so this is a genuine
// convergence proof: a store that "missed" a range of peer commits catches up to bit-identical state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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

const { classifyInbound, foldCatchUp } = await import("../src/bus-convergence.ts");
const { Store } = await import("../../core/src/store.ts");
const { Persistence } = await import("../../core/src/persist.ts");

// A minimal in-memory EventStore/SnapshotStore pair so Persistence hydrates cleanly (empty board).
const emptyStores = () => ({
  events: { loadAll: async () => [], append: async () => {}, clear: async () => {} },
  snapshots: { load: async () => null, save: async () => {}, clear: async () => {} },
});
const addDiff = (id, x) => ({ added: { [id]: { typeName: "node", id, type: "note", x, y: 0, w: 1, h: 1 } }, updated: {}, removed: {} });
const evt = (seq, id, x) => ({ id: `evt:${id}`, ts: seq, parent: 0, seq, type: "addNode", payload: { id }, actor: "user", diff: addDiff(id, x) });

// ── classifyInbound ─────────────────────────────────────────────────────────────────────────────────
test("classifyInbound: next in-order frame, a gap, and an already-have frame", () => {
  assert.equal(classifyInbound(6, 5), "next", "seq == watermark+1 is the in-order frame");
  assert.equal(classifyInbound(8, 5), "gap", "seq past watermark+1 means frames were missed");
  assert.equal(classifyInbound(5, 5), "have", "seq == watermark is already reflected");
  assert.equal(classifyInbound(3, 5), "have", "an older seq (resend) is already reflected");
});

// ── foldCatchUp converges a store that missed a range ────────────────────────────────────────────────
test("foldCatchUp: a tab that missed peer commits catches up to identical state, in seq order", async () => {
  const stores = emptyStores();
  const persistence = new Persistence(stores);
  const store = new Store();
  await persistence.hydrate(store);
  assert.equal(persistence.watermark(), 0, "fresh tab starts at watermark 0");

  // Simulate: the tab saw the first live frame (seq 1) in order, then the socket DROPPED and it missed 2..4.
  store.applyDiffAsChange(evt(1, "a", 10).diff, "remote");
  persistence.adoptSeq(1);
  assert.equal(persistence.watermark(), 1);

  // A gap detector would fire here (a later frame arrives with seq > watermark+1). The catch-up fetches the
  // since(watermark) range and folds it. foldCatchUp is exactly that fold.
  const missed = [evt(2, "b", 20), evt(3, "c", 30), evt(4, "d", 40)];
  const applied = foldCatchUp(missed, store, persistence);
  assert.equal(applied, 3, "all three missed events applied");
  assert.equal(persistence.watermark(), 4, "watermark advanced to the newest caught-up seq");
  const snap = store.getSnapshot();
  const ids = snap.records.map((r) => r.id).sort();
  assert.deepEqual(ids, ["a", "b", "c", "d"], "the store converged — every missed record is present");

  // Idempotent re-run (a re-fetch overlapping a live frame): nothing new applied, state unchanged.
  assert.equal(foldCatchUp(missed, store, persistence), 0, "re-folding an already-applied range is a no-op");
  assert.equal(persistence.watermark(), 4);
});

test("foldCatchUp: a range that overlaps the watermark applies only the tail past it", () => {
  const store = new Store();
  const wm = { seq: 5, watermark() { return this.seq; }, adoptSeq(s) { this.seq = Math.max(this.seq, s); } };
  // Events 4..7; the tab already has ≤5, so only 6 and 7 are new.
  const applied = foldCatchUp([evt(4, "d", 4), evt(5, "e", 5), evt(6, "f", 6), evt(7, "g", 7)], store, wm);
  assert.equal(applied, 2, "only the two events past the watermark applied");
  assert.equal(wm.seq, 7);
  assert.deepEqual(store.getSnapshot().records.map((r) => r.id).sort(), ["f", "g"]);
});
