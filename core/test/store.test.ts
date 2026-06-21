import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import type { LayoutRecord, NodeRecord } from "../src/records.js";

const node = (id: string, title = ""): NodeRecord => ({ typeName: "node", id: `node:${id}`, type: "note", title, text: "", color: "yellow" });
const layout = (id: string, x = 0, y = 0): LayoutRecord => ({ typeName: "layout", id: `layout:node:${id}`, nodeId: `node:${id}`, x, y, w: 1, h: 1, z: 0 });

test("put emits one diff with added; version bumps once", () => {
  const s = new Store();
  const seen: number[] = [];
  s.listen((d) => seen.push(Object.keys(d.added).length));
  s.put([node("a"), layout("a")]);
  assert.deepEqual(seen, [2]); // one emission, two added
  assert.equal(s.version, 1);
});

test("update emits one diff with from/to", () => {
  const s = new Store();
  s.put([node("a", "v1")]);
  let captured: readonly [NodeRecord, NodeRecord] | undefined;
  s.listen((d) => {
    captured = d.updated["node:a"] as readonly [NodeRecord, NodeRecord];
  });
  s.update<NodeRecord>("node:a", { title: "v2" });
  assert.equal(captured![0].title, "v1");
  assert.equal(captured![1].title, "v2");
});

test("transact batches many mutations into ONE diff", () => {
  const s = new Store();
  let emissions = 0;
  let lastAddedCount = 0;
  s.listen((d) => {
    emissions++;
    lastAddedCount = Object.keys(d.added).length;
  });
  s.transact(() => {
    s.put([node("a")]);
    s.put([node("b")]);
    s.put([layout("a")]);
  });
  assert.equal(emissions, 1);
  assert.equal(lastAddedCount, 3);
  assert.equal(s.version, 1);
});

test("channel 1 is per-entity: mutating B does not fire A's handle", () => {
  const s = new Store();
  s.put([layout("a", 0), layout("b", 0)]);
  let aFires = 0;
  const sig = s.getSignal<"layout">("layout:node:a");
  const off = sig.subscribe(() => aFires++);

  s.update<LayoutRecord>("layout:node:b", { x: 5 }); // different entity
  assert.equal(aFires, 0);

  s.update<LayoutRecord>("layout:node:a", { x: 9 }); // this entity
  assert.equal(aFires, 1);
  assert.equal((sig.get() as LayoutRecord).x, 9);
  off();
});

test("semantic/layout split: a title edit does not fire the layout handle", () => {
  const s = new Store();
  s.put([node("a", "t1"), layout("a", 0)]);
  let layoutFires = 0;
  const off = s.getSignal<"layout">("layout:node:a").subscribe(() => layoutFires++);
  s.update<NodeRecord>("node:a", { title: "t2" }); // semantic edit
  assert.equal(layoutFires, 0);
  off();
});

test("snapshot round-trips records and version", () => {
  const s = new Store();
  s.put([node("a", "hello"), layout("a", 3, 4)]);
  s.update<LayoutRecord>("layout:node:a", { x: 7 });
  const snap = s.getSnapshot();

  const s2 = new Store();
  s2.loadSnapshot(snap);
  assert.equal(s2.version, snap.version);
  assert.equal((s2.get<"node">("node:a") as NodeRecord).title, "hello");
  assert.equal((s2.get<"layout">("layout:node:a") as LayoutRecord).x, 7);
});

test("remove emits a removed diff and drops the record", () => {
  const s = new Store();
  s.put([node("a")]);
  let removedIds: string[] = [];
  s.listen((d) => (removedIds = Object.keys(d.removed)));
  s.remove(["node:a"]);
  assert.deepEqual(removedIds, ["node:a"]);
  assert.equal(s.get("node:a"), undefined);
});
