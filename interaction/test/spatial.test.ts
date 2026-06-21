import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/core.js";
import { BruteForceIndex, syncIndexFromStore } from "../src/spatial.js";
import { vec } from "../src/geometry.js";

test("hitPoint returns the topmost (last-added) node at a point", () => {
  const ix = new BruteForceIndex();
  ix.insert("node:a", { x: 0, y: 0, w: 100, h: 100 });
  ix.insert("node:b", { x: 50, y: 50, w: 100, h: 100 }); // overlaps a, added later → on top
  assert.equal(ix.hitPoint(vec(10, 10)), "node:a"); // only a here
  assert.equal(ix.hitPoint(vec(60, 60)), "node:b"); // overlap → topmost
  assert.equal(ix.hitPoint(vec(500, 500)), undefined);
});

test("hitPoint resolves overlaps by z, not insertion order", () => {
  const ix = new BruteForceIndex();
  ix.insert("node:a", { x: 0, y: 0, w: 100, h: 100 }, 5); // added first but higher z
  ix.insert("node:b", { x: 50, y: 50, w: 100, h: 100 }, 1); // added later, lower z
  assert.equal(ix.hitPoint(vec(60, 60)), "node:a", "highest z wins regardless of add order");
  assert.equal(ix.topZ(), 5);
  ix.update("node:b", { x: 50, y: 50, w: 100, h: 100 }, 9); // raise b above a
  assert.equal(ix.hitPoint(vec(60, 60)), "node:b");
  assert.equal(ix.topZ(), 9);
});

test("hitTest returns every node intersecting the box", () => {
  const ix = new BruteForceIndex();
  ix.insert("node:a", { x: 0, y: 0, w: 100, h: 100 });
  ix.insert("node:b", { x: 200, y: 0, w: 100, h: 100 });
  assert.deepEqual(ix.hitTest({ x: -10, y: -10, w: 400, h: 50 }).sort(), ["node:a", "node:b"]);
  assert.deepEqual(ix.hitTest({ x: 0, y: 0, w: 50, h: 50 }), ["node:a"]);
});

test("syncIndexFromStore seeds from snapshot and tracks layout diffs (channel 2)", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0, w: 100, h: 100 }, actor: "human" });
  const ix = new BruteForceIndex();
  const off = syncIndexFromStore(e.store, ix);

  // seeded from the pre-existing node
  assert.equal(ix.hitPoint(vec(10, 10)), "node:a");

  // add → tracked
  e.commit({ type: "addNode", payload: { id: "node:b", x: 200, y: 0, w: 100, h: 100 }, actor: "human" });
  assert.equal(ix.hitPoint(vec(210, 10)), "node:b");

  // move → box follows
  e.commit({ type: "moveNode", payload: { id: "node:a", x: 400, y: 400 }, actor: "human" });
  assert.equal(ix.hitPoint(vec(10, 10)), undefined);
  assert.equal(ix.hitPoint(vec(410, 410)), "node:a");

  // remove → gone
  e.commit({ type: "removeNode", payload: { id: "node:b" }, actor: "human" });
  assert.equal(ix.hitPoint(vec(210, 10)), undefined);

  off();
});
