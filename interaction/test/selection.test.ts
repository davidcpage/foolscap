import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/core.js";
import { Selection, resizeTargetId, selectionBounds, worldBounds } from "../src/selection.js";

test("set / add / remove / toggle / clear", () => {
  const sel = new Selection();
  sel.set(["node:a", "node:b"]);
  assert.deepEqual(sel.ids().sort(), ["node:a", "node:b"]);
  sel.add(["node:c"]);
  assert.equal(sel.size, 3);
  sel.remove(["node:a"]);
  assert.ok(!sel.has("node:a"));
  sel.toggle("node:b"); // present → removed
  sel.toggle("node:d"); // absent → added
  assert.deepEqual(sel.ids().sort(), ["node:c", "node:d"]);
  sel.clear();
  assert.equal(sel.size, 0);
});

test("signal fires on real changes only (Object.is guard)", () => {
  const sel = new Selection();
  let fired = 0;
  const off = sel.signal.subscribe(() => fired++);
  sel.set(["node:a"]);
  sel.clear();
  sel.clear(); // already empty → no fire
  assert.equal(fired, 2);
  off();
});

test("selectionBounds is the union of selected layout boxes (page space)", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0, w: 100, h: 100 }, actor: "human" });
  e.commit({ type: "addNode", payload: { id: "node:b", x: 200, y: 50, w: 100, h: 100 }, actor: "human" });
  assert.deepEqual(selectionBounds(e.store, ["node:a", "node:b"]), { x: 0, y: 0, w: 300, h: 150 });
  assert.equal(selectionBounds(e.store, []), null);
});

test("worldBounds unions every node, and `skip` drops excluded layouts", () => {
  const e = new Editor();
  assert.equal(worldBounds(e.store), null, "empty board → null");
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0, w: 100, h: 100 }, actor: "human" });
  e.commit({ type: "addNode", payload: { id: "node:float", x: 999, y: 999, w: 50, h: 50 }, actor: "human" });
  // Without a skip, the far-out node stretches the bounds.
  assert.deepEqual(worldBounds(e.store), { x: 0, y: 0, w: 1049, h: 1049 });
  // Skipping it (as the renderer does for screen-anchored cards) leaves just node:a's box.
  assert.deepEqual(
    worldBounds(e.store, (l) => l.nodeId === "node:float"),
    { x: 0, y: 0, w: 100, h: 100 },
  );
});

test("resizeTargetId: lone node, cluster seed, and ambiguous/plain multi-selections", () => {
  // A thread's expansion pulls in its open members — the shape App.expandSelection returns.
  const expand = (id: string) => (id === "node:thread" ? ["node:m1", "node:m2"] : []);
  // Single selection → that node, expansion or not.
  assert.equal(resizeTargetId(["node:a"], expand), "node:a");
  assert.equal(resizeTargetId(["node:a"], undefined), "node:a");
  // A cluster (seed + exactly its members) → the seed carries the handles.
  assert.equal(resizeTargetId(["node:thread", "node:m1", "node:m2"], expand), "node:thread");
  assert.equal(resizeTargetId(["node:m1", "node:thread"], expand), "node:thread", "order-independent");
  // Seed + a subset of its members still covers the selection → still the seed.
  assert.equal(resizeTargetId(["node:thread", "node:m1"], expand), "node:thread");
  // A multi-selection the seed does NOT cover (an unrelated card swept in) → no target.
  assert.equal(resizeTargetId(["node:thread", "node:m1", "node:x"], expand), null);
  // Plain multi-selections: no expansion anywhere → no target; no expand fn → no target.
  assert.equal(resizeTargetId(["node:a", "node:b"], expand), null);
  assert.equal(resizeTargetId(["node:a", "node:b"], undefined), null);
  // Two seeds that each cover the whole selection → ambiguous, no target.
  const both = (id: string) => (id === "node:s1" ? ["node:s2"] : id === "node:s2" ? ["node:s1"] : []);
  assert.equal(resizeTargetId(["node:s1", "node:s2"], both), null);
  // Empty selection → null.
  assert.equal(resizeTargetId([], expand), null);
});
