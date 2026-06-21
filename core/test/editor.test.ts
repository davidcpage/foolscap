import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.js";
import { UndoManager } from "../src/undo.js";
import type { LayoutRecord, NodeRecord } from "../src/records.js";

test("commit(addNode) writes node+layout, appends ONE intent event carrying the diff", () => {
  const e = new Editor();
  const evt = e.commit({ type: "addNode", payload: { id: "node:a", x: 1, y: 2 }, actor: "human" });

  assert.equal((e.store.get<"node">("node:a") as NodeRecord).typeName, "node");
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 1);
  assert.equal(e.log.all().length, 1);
  assert.equal(evt.parent, 0); // based on version 0
  assert.equal(Object.keys(evt.diff.added).length, 2);
  assert.equal(e.store.version, 1);
});

test("commit(addShape) is replayable: the shape tool's gesture intent reconstructs the node+layout", () => {
  // The shape tool records its draw as an `addShape` IntentEvent with the final box+colour in the
  // payload. "One mutation API, three clients" means an agent can replay that intent via commit — so
  // addShape must have a handler that rebuilds the same pair (it delegates to addNode).
  const e = new Editor();
  const evt = e.commit({
    type: "addShape",
    payload: { id: "node:s", type: "rect", color: "#abc", x: 10, y: 20, w: 140, h: 100 },
    actor: "human",
  });
  const node = e.store.get<"node">("node:s") as NodeRecord;
  const layout = e.store.get<"layout">("layout:node:s") as LayoutRecord;
  assert.equal(node.type, "rect");
  assert.equal(node.color, "#abc");
  assert.deepEqual([layout.x, layout.y, layout.w, layout.h], [10, 20, 140, 100]);
  assert.equal(evt.type, "addShape");
  assert.equal(Object.keys(evt.diff.added).length, 2);
});

test("gesture coalescing: channel 1 fires per frame, channel 2 + log fire ONCE", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0 }, actor: "human" });

  let ch1 = 0;
  const off = e.store.getSignal<"layout">("layout:node:a").subscribe(() => ch1++);
  let ch2 = 0;
  e.store.listen(() => ch2++);
  const logBefore = e.log.all().length;

  const g = e.beginGesture("moveNode", "human");
  for (let i = 1; i <= 5; i++) {
    const x = i;
    g.update(() => e.store.update<LayoutRecord>("layout:node:a", { x }));
  }
  const evt = g.end();

  assert.equal(ch1, 5, "renderer saw every frame");
  assert.equal(ch2, 1, "persistence/undo saw exactly one coalesced diff");
  assert.equal(e.log.all().length, logBefore + 1, "one intent event for the whole gesture");
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 5);
  // the coalesced diff's from = frame 0 value, to = final value
  assert.equal((evt.diff.updated["layout:node:a"]![0] as LayoutRecord).x, 0);
  assert.equal((evt.diff.updated["layout:node:a"]![1] as LayoutRecord).x, 5);
  off();
});

test("gesture cancel reverts live atoms and emits nothing", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0 }, actor: "human" });
  const versionBefore = e.store.version;
  let ch2 = 0;
  e.store.listen(() => ch2++);

  const g = e.beginGesture("moveNode", "human");
  g.update(() => e.store.update<LayoutRecord>("layout:node:a", { x: 99 }));
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 99); // live mid-gesture
  g.cancel();

  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 0); // snapped back
  assert.equal(ch2, 0);
  assert.equal(e.store.version, versionBefore);
});

test("tryCommit rejects a stale base (optimistic concurrency)", () => {
  const e = new Editor();
  const base = e.store.version;
  e.commit({ type: "addNode", payload: { id: "node:a" }, actor: "human" }); // moves version past base
  const rejected = e.tryCommit({ type: "setTitle", payload: { id: "node:a", title: "x" }, actor: "claude" }, base);
  assert.equal(rejected, null);

  const ok = e.tryCommit({ type: "setTitle", payload: { id: "node:a", title: "y" }, actor: "claude" }, e.store.version);
  assert.notEqual(ok, null);
  assert.equal((e.store.get<"node">("node:a") as NodeRecord).title, "y");
});

test("UndoManager: one gesture = one undo step; undo/redo round-trips", () => {
  const e = new Editor();
  const undo = new UndoManager(e.store);
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0 }, actor: "human" });

  const g = e.beginGesture("moveNode", "human");
  for (let i = 1; i <= 10; i++) {
    const x = i;
    g.update(() => e.store.update<LayoutRecord>("layout:node:a", { x }));
  }
  g.end();
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 10);

  undo.undo(); // undoes the whole drag in one step
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 0);

  undo.undo(); // undoes the addNode
  assert.equal(e.store.get("node:a"), undefined);

  undo.redo(); // re-add
  assert.equal((e.store.get<"node">("node:a") as NodeRecord).typeName, "node");
  undo.redo(); // re-drag
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 10);
});

test("UndoManager is selective: undo pops MY last act, not the agent's or a remote ingest's", () => {
  const e = new Editor();
  const undo = new UndoManager(e.store); // source "user" — actor "human" maps to it
  e.commit({ type: "addNode", payload: { id: "node:mine", x: 0, y: 0 }, actor: "human" });
  // foreign writers land between my acts: an agent's card and a remote (watcher-ingest) edit
  e.commit({ type: "addNode", payload: { id: "node:claude", x: 50, y: 0 }, actor: "claude" });
  e.commit({ type: "setText", payload: { id: "node:mine", text: "from disk" }, actor: "remote" });
  e.commit({ type: "moveNode", payload: { id: "node:mine", x: 9, y: 9 }, actor: "human" });

  undo.undo(); // my move reverts…
  assert.equal((e.store.get<"layout">("layout:node:mine") as LayoutRecord).x, 0);
  // …but the agent's card and the remote's text edit are untouched (not mine to undo)
  assert.equal((e.store.get<"node">("node:claude") as NodeRecord).typeName, "node");
  assert.equal((e.store.get<"node">("node:mine") as NodeRecord).text, "from disk");

  undo.undo(); // my addNode — now the stack is empty even though foreign diffs exist
  assert.equal(e.store.get("node:mine"), undefined);
  assert.equal(undo.canUndo, false);
  assert.equal((e.store.get<"node">("node:claude") as NodeRecord).typeName, "node");
});

test("moveNodes command: absolute moves and {ids,dx,dy} translate, each one diff", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0 }, actor: "human" });
  e.commit({ type: "addNode", payload: { id: "node:b", x: 100, y: 0 }, actor: "human" });

  let ch2 = 0;
  e.store.listen(() => ch2++);

  // absolute form (what the drag gesture emits) → one coalesced diff
  e.commit({ type: "moveNodes", payload: { moves: [{ id: "node:a", x: 5, y: 5 }, { id: "node:b", x: 105, y: 5 }] }, actor: "human" });
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 5);
  assert.equal((e.store.get<"layout">("layout:node:b") as LayoutRecord).x, 105);
  assert.equal(ch2, 1);

  // translate form (agent ergonomics) → one more diff
  e.commit({ type: "moveNodes", payload: { ids: ["node:a", "node:b"], dx: 10, dy: -5 }, actor: "claude" });
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).x, 15);
  assert.equal((e.store.get<"layout">("layout:node:a") as LayoutRecord).y, 0);
  assert.equal((e.store.get<"layout">("layout:node:b") as LayoutRecord).x, 115);
  assert.equal(ch2, 2);
});

test("resizeNodes command: absolute boxes coalesce into one diff (the resize gesture's agent twin)", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0, w: 200, h: 120 }, actor: "human" });
  e.commit({ type: "addNode", payload: { id: "node:b", x: 300, y: 0, w: 200, h: 120 }, actor: "human" });

  let ch2 = 0;
  e.store.listen(() => ch2++);

  e.commit({
    type: "resizeNodes",
    payload: { resizes: [{ id: "node:a", x: 0, y: 0, w: 260, h: 180 }, { id: "node:b", x: 280, y: -20, w: 240, h: 160 }] },
    actor: "claude",
  });
  const a = e.store.get<"layout">("layout:node:a") as LayoutRecord;
  const b = e.store.get<"layout">("layout:node:b") as LayoutRecord;
  assert.deepEqual({ x: a.x, y: a.y, w: a.w, h: a.h }, { x: 0, y: 0, w: 260, h: 180 });
  assert.deepEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: 280, y: -20, w: 240, h: 160 });
  assert.equal(ch2, 1); // one coalesced diff for the whole multi-resize
});

test("intent log describe() is compact and attributed", () => {
  const e = new Editor();
  e.commit({ type: "addNode", payload: { id: "node:a" }, actor: "human" });
  e.commit({ type: "setTitle", payload: { id: "node:a", title: "hi" }, actor: "claude" });
  const text = e.log.describe();
  assert.match(text, /human addNode/);
  assert.match(text, /claude setTitle/);
});
