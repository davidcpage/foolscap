import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor, layoutId, type LayoutRecord, type NodeRecord } from "../src/core.js";
import { InteractionManager } from "../src/manager.js";
import { ShapeTool } from "../src/tools/shape-tool.js";
import type { InputEvent, ModifierState } from "../src/input.js";
import { vec, type Vec } from "../src/geometry.js";

const NO_MODS: ModifierState = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
const down = (p: Vec): InputEvent => ({ type: "pointerdown", point: p, button: 0, ...NO_MODS });
const move = (p: Vec): InputEvent => ({ type: "pointermove", point: p, button: 0, ...NO_MODS });
const up = (p: Vec): InputEvent => ({ type: "pointerup", point: p, button: 0, ...NO_MODS });
const esc = (): InputEvent => ({ type: "keydown", key: "Escape", ...NO_MODS });

// A fresh board (no nodes) with the rect/ellipse tools registered. Default camera (z=1, no offset) so
// screen coords == page coords, keeping the drawn-box geometry obvious.
function setup() {
  const editor = new Editor();
  const m = new InteractionManager({
    editor,
    tools: (ctx) => [new ShapeTool(ctx, "rect"), new ShapeTool(ctx, "ellipse")],
  });
  return { editor, m };
}

const nodesOf = (editor: Editor) =>
  editor.store.getSnapshot().records.filter((r) => r.typeName === "node") as NodeRecord[];
const layoutOf = (editor: Editor, id: string) =>
  editor.store.get<"layout">(layoutId(id as `node:${string}`)) as LayoutRecord;
const xywh = (l: LayoutRecord) => ({ x: l.x, y: l.y, w: l.w, h: l.h });

test("dragging the rect tool stamps one sized shape as ONE gesture, selects it, returns to select", () => {
  const { editor, m } = setup();
  m.setTool("rect");
  let ch2 = 0;
  editor.store.listen(() => ch2++);
  const logBefore = editor.log.all().length;

  m.dispatch(down(vec(50, 60)));
  m.dispatch(move(vec(60, 70))); // crosses the drag threshold → the shape begins
  m.dispatch(move(vec(150, 160))); // final corner
  assert.equal(nodesOf(editor).length, 1, "the shape appears live during the draw (channel 1)");
  assert.equal(ch2, 0, "channel 2 stays silent for the whole draw (one gesture)");
  m.dispatch(up(vec(150, 160)));

  const nodes = nodesOf(editor);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.type, "rect");
  assert.deepEqual(xywh(layoutOf(editor, nodes[0]!.id)), { x: 50, y: 60, w: 100, h: 100 });
  assert.equal(ch2, 1, "the draw coalesced into a single diff at the end");
  const events = editor.log.all();
  assert.equal(events.length, logBefore + 1, "one intent event for the draw");
  assert.equal(events.at(-1)!.type, "addShape");
  assert.deepEqual(m.selection.ids(), [nodes[0]!.id], "the new shape is selected");
  assert.equal(m.currentTool, "select", "dropped back to select after drawing");
});

test("dragging up-left normalizes the box to positive w/h (and keeps the tool's kind)", () => {
  const { editor, m } = setup();
  m.setTool("ellipse");
  m.dispatch(down(vec(200, 200)));
  m.dispatch(move(vec(150, 150))); // threshold, dragging back toward the origin
  m.dispatch(up(vec(140, 130)));
  const n = nodesOf(editor)[0]!;
  assert.equal(n.type, "ellipse");
  assert.deepEqual(xywh(layoutOf(editor, n.id)), { x: 140, y: 130, w: 60, h: 70 });
});

test("a plain click stamps a default-sized shape centered on the point, as one addNode", () => {
  const { editor, m } = setup();
  m.setTool("rect");
  const logBefore = editor.log.all().length;
  m.dispatch(down(vec(300, 300)));
  m.dispatch(up(vec(300, 300))); // no move → click
  const nodes = nodesOf(editor);
  assert.equal(nodes.length, 1);
  assert.deepEqual(xywh(layoutOf(editor, nodes[0]!.id)), { x: 230, y: 250, w: 140, h: 100 });
  const events = editor.log.all();
  assert.equal(events.length, logBefore + 1);
  assert.equal(events.at(-1)!.type, "addNode", "the click path is a plain add command");
  assert.equal(m.currentTool, "select");
});

test("Escape mid-draw removes the half-drawn shape; nothing reaches ch2 / the log", () => {
  const { editor, m } = setup();
  m.setTool("rect");
  let ch2 = 0;
  editor.store.listen(() => ch2++);
  const logBefore = editor.log.all().length;

  m.dispatch(down(vec(50, 50)));
  m.dispatch(move(vec(120, 120))); // drawing live
  assert.equal(nodesOf(editor).length, 1, "shape present live");
  m.dispatch(esc());

  assert.equal(nodesOf(editor).length, 0, "cancel reverted the add");
  assert.equal(ch2, 0);
  assert.equal(editor.log.all().length, logBefore);
  assert.equal(m.currentTool, "rect", "cancel doesn't switch tools");
});

test("a drawn shape behaves like any node afterward: hit-testable and draggable", () => {
  const { editor, m } = setup();
  m.setTool("rect");
  m.dispatch(down(vec(0, 0)));
  m.dispatch(move(vec(10, 10))); // threshold
  m.dispatch(move(vec(100, 100)));
  m.dispatch(up(vec(100, 100))); // rect spanning 0..100
  const id = nodesOf(editor)[0]!.id;

  // now back on select: clicking the shape's center selects it (index picked it up on gesture end)
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(m.selection.ids(), [id], "the drawn shape is hit-testable");

  // and it drags through the ordinary select-tool path
  m.dispatch(down(vec(50, 50)));
  m.dispatch(move(vec(60, 50)));
  m.dispatch(move(vec(90, 50)));
  m.dispatch(up(vec(90, 50)));
  assert.equal(layoutOf(editor, id).x, 40, "moved like a note");
});
