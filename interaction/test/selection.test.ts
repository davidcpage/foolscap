import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/core.js";
import { Selection, selectionBounds } from "../src/selection.js";

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
