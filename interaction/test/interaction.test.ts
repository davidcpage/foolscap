import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor, UndoManager, layoutId, type LayoutRecord } from "../src/core.js";
import { InteractionManager } from "../src/manager.js";
import type { InputEvent, ModifierState } from "../src/input.js";
import { vec, type Vec } from "../src/geometry.js";

const NO_MODS: ModifierState = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

// Tiny synthetic-input helpers — the Node tests bypass bindDom and drive the manager directly.
const down = (p: Vec, m: Partial<ModifierState> = {}): InputEvent =>
  ({ type: "pointerdown", point: p, button: 0, ...NO_MODS, ...m });
const move = (p: Vec, m: Partial<ModifierState> = {}): InputEvent =>
  ({ type: "pointermove", point: p, button: 0, ...NO_MODS, ...m });
const up = (p: Vec, m: Partial<ModifierState> = {}): InputEvent =>
  ({ type: "pointerup", point: p, button: 0, ...NO_MODS, ...m });
const esc = (): InputEvent => ({ type: "keydown", key: "Escape", ...NO_MODS });

function setup() {
  const editor = new Editor();
  // a (0..100) and b (200..300) on the x axis, both 100 tall — default camera (z=1, no offset) so
  // screen coords == page coords, keeping the geometry obvious.
  editor.commit({ type: "addNode", payload: { id: "node:a", x: 0, y: 0, w: 100, h: 100 }, actor: "human" });
  editor.commit({ type: "addNode", payload: { id: "node:b", x: 200, y: 0, w: 100, h: 100 }, actor: "human" });
  const m = new InteractionManager({ editor });
  return { editor, m };
}

const x = (editor: Editor, id: string) =>
  (editor.store.get<"layout">(layoutId(id as `node:${string}`)) as LayoutRecord).x;

test("click selects a node; click empty clears", () => {
  const { m } = setup();
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(m.selection.ids(), ["node:a"]);

  m.dispatch(down(vec(150, 50))); // empty gap between a and b
  m.dispatch(up(vec(150, 50)));
  assert.deepEqual(m.selection.ids(), []);
});

test("shift-click toggles membership", () => {
  const { m } = setup();
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50))); // {a}
  m.dispatch(down(vec(250, 50), { shiftKey: true }));
  m.dispatch(up(vec(250, 50), { shiftKey: true })); // {a,b}
  assert.deepEqual(m.selection.ids().sort(), ["node:a", "node:b"]);
  m.dispatch(down(vec(50, 50), { shiftKey: true }));
  m.dispatch(up(vec(50, 50), { shiftKey: true })); // toggle a off → {b}
  assert.deepEqual(m.selection.ids(), ["node:b"]);
});

test("drag moves the selection as ONE gesture: 1 diff on ch2, 1 intent event, type moveNodes", () => {
  const { editor, m } = setup();
  let ch2 = 0;
  editor.store.listen(() => ch2++);
  const logBefore = editor.log.all().length;

  m.dispatch(down(vec(50, 50))); // press on a → selects a
  m.dispatch(move(vec(60, 50))); // +10 crosses threshold → drag begins
  m.dispatch(move(vec(80, 50))); // total delta +30 from origin
  assert.equal(x(editor, "node:a"), 30, "live atom tracked every frame (channel 1)");
  m.dispatch(up(vec(80, 50)));

  assert.equal(x(editor, "node:a"), 30);
  assert.equal(ch2, 1, "the whole drag coalesced into one diff");
  const events = editor.log.all();
  assert.equal(events.length, logBefore + 1, "one intent event for the gesture");
  assert.equal(events[events.length - 1]!.type, "moveNodes");
});

// The camera-aware drag that edge auto-scroll rides on: if the camera pans WHILE a drag is in flight,
// the grabbed node tracks the pointer into the revealed area even though the pointer's SCREEN position
// hasn't moved. (The real edge-scroll loop does panBy + replay-last-move each frame; here we do one
// step by hand, since rAF/viewport aren't wired in Node.)
test("a camera pan mid-drag carries the grabbed node (edge-scroll semantics)", () => {
  const { editor, m } = setup();
  m.dispatch(down(vec(50, 50))); // grab a at page (50,50)
  m.dispatch(move(vec(60, 50))); // drag begins; a.x: 0 → 10
  assert.equal(x(editor, "node:a"), 10);

  m.camera.panBy(-40, 0); // pretend an edge-scroll frame panned the view 40px
  m.dispatch(move(vec(60, 50))); // SAME screen point → re-projected against the new camera
  assert.equal(x(editor, "node:a"), 50, "node followed the 40px pan, not just the screen delta");

  m.dispatch(up(vec(60, 50)));
  assert.equal(x(editor, "node:a"), 50);
});

test("Escape mid-drag cancels: atoms revert, nothing on ch2 / the log", () => {
  const { editor, m } = setup();
  let ch2 = 0;
  editor.store.listen(() => ch2++);
  const logBefore = editor.log.all().length;

  m.dispatch(down(vec(50, 50)));
  m.dispatch(move(vec(90, 50))); // x → 40 live
  assert.equal(x(editor, "node:a"), 40);
  m.dispatch(esc());

  assert.equal(x(editor, "node:a"), 0, "snapped back");
  assert.equal(ch2, 0);
  assert.equal(editor.log.all().length, logBefore);
});

test("dragging an already-selected group moves all of it (no collapse to one)", () => {
  const { editor, m } = setup();
  m.selection.set(["node:a", "node:b"]); // pretend a marquee already selected both
  m.dispatch(down(vec(50, 50))); // press on a, which IS selected → keep the group
  m.dispatch(move(vec(70, 50))); // +20
  m.dispatch(up(vec(70, 50)));
  assert.equal(x(editor, "node:a"), 20);
  assert.equal(x(editor, "node:b"), 220);
});

const z = (editor: Editor, id: string) =>
  (editor.store.get<"layout">(layoutId(id as `node:${string}`)) as LayoutRecord).z;

test("dragging a node lifts it above the others (z), within one gesture", () => {
  const { editor, m } = setup(); // a.z=0, b.z=1 (assigned by addNode order)
  assert.ok(z(editor, "node:a") < z(editor, "node:b"), "a starts below b");
  let ch2 = 0;
  editor.store.listen(() => ch2++);

  m.dispatch(down(vec(50, 50))); // grab a
  m.dispatch(move(vec(60, 50))); // crosses threshold → drag (lift folded in)
  m.dispatch(move(vec(80, 50)));
  m.dispatch(up(vec(80, 50)));

  assert.ok(z(editor, "node:a") > z(editor, "node:b"), "a now on top");
  assert.equal(ch2, 1, "the lift rode the SAME coalesced diff as the move");
});

test("group drag preserves the relative stacking order (nothing else to raise above)", () => {
  const { editor, m } = setup(); // a.z=0, b.z=1
  m.selection.set(["node:a", "node:b"]);
  m.dispatch(down(vec(50, 50))); // press a (in the group) → group drag; the whole board is selected,
  m.dispatch(move(vec(70, 50))); // so there is nothing to lift above → no restack, just the move
  m.dispatch(up(vec(70, 50)));
  assert.ok(z(editor, "node:a") < z(editor, "node:b"), "a still below b");
});

test("a plain click brings the selected card to the front as ONE raiseNodes intent", () => {
  const { editor, m } = setup(); // a.z=0, b.z=1 → a starts behind b
  const logBefore = editor.log.all().length;
  m.dispatch(down(vec(50, 50))); // press a (below b)
  m.dispatch(up(vec(50, 50))); // plain click, no drag
  assert.deepEqual(m.selection.ids(), ["node:a"]);
  assert.ok(z(editor, "node:a") > z(editor, "node:b"), "a lifted above b on the click itself");
  const events = editor.log.all();
  assert.equal(events.length, logBefore + 1, "one intent event for the select-raise");
  assert.equal(events[events.length - 1]!.type, "raiseNodes");
});

test("clicking the already-front card restacks nothing (no log/undo noise)", () => {
  const { editor, m } = setup(); // b.z=1 is already the top card
  const logBefore = editor.log.all().length;
  let ch2 = 0;
  editor.store.listen(() => ch2++);
  m.dispatch(down(vec(250, 50))); // press b — already on top
  m.dispatch(up(vec(250, 50)));
  assert.deepEqual(m.selection.ids(), ["node:b"]);
  assert.equal(editor.log.all().length, logBefore, "no gesture opened → no intent event");
  assert.equal(ch2, 0, "nothing reached channel 2");
});

test("the select-raise is a single undo step (⌘Z lowers the card back)", () => {
  const { editor, m } = setup();
  const undo = new UndoManager(editor.store); // human acts only
  const z0a = z(editor, "node:a");
  m.dispatch(down(vec(50, 50))); // click a → raises it above b
  m.dispatch(up(vec(50, 50)));
  assert.ok(z(editor, "node:a") > z(editor, "node:b"), "raised");
  undo.undo();
  assert.equal(z(editor, "node:a"), z0a, "one undo restores the prior z");
});

test("Escape mid-drag reverts the z lift along with the move", () => {
  const { editor, m } = setup();
  const z0 = z(editor, "node:a");
  m.dispatch(down(vec(50, 50)));
  m.dispatch(move(vec(90, 50))); // dragging: x and z both changed live
  assert.ok(z(editor, "node:a") > z0, "lifted during the drag");
  m.dispatch(esc());
  assert.equal(z(editor, "node:a"), z0, "z restored on cancel");
  assert.equal(x(editor, "node:a"), 0, "x restored on cancel");
});

test("pressing the GAP inside a multi-selection's bounds drags the whole group (not deselect)", () => {
  const { editor, m } = setup();
  m.selection.set(["node:a", "node:b"]); // bounds span x 0..300 (a at 0..100, b at 200..300)
  // (150,50) is empty canvas BETWEEN the cards but inside the selection bounds
  m.dispatch(down(vec(150, 50)));
  assert.deepEqual(m.selection.ids().sort(), ["node:a", "node:b"], "group not collapsed/cleared on press");
  m.dispatch(move(vec(170, 50))); // +20 → drag the group
  m.dispatch(up(vec(170, 50)));
  assert.equal(x(editor, "node:a"), 20);
  assert.equal(x(editor, "node:b"), 220);
  assert.deepEqual(m.selection.ids().sort(), ["node:a", "node:b"], "still selected after the group drag");
});

test("a plain click in the gap inside a multi-selection's bounds keeps the group", () => {
  const { m } = setup();
  m.selection.set(["node:a", "node:b"]);
  m.dispatch(down(vec(150, 50))); // gap inside bounds, no drag
  m.dispatch(up(vec(150, 50)));
  assert.deepEqual(m.selection.ids().sort(), ["node:a", "node:b"], "no-op click leaves the group intact");
});

test("clicking the gap with only ONE node selected still clears (no phantom bounds surface)", () => {
  const { m } = setup();
  m.selection.set(["node:a"]);
  m.dispatch(down(vec(150, 50))); // empty space; single selection's bounds == the card, so this is outside
  m.dispatch(up(vec(150, 50)));
  assert.deepEqual(m.selection.ids(), []);
});

test("marquee selects every node it covers; clears the marquee box on release", () => {
  const { m } = setup();
  m.dispatch(down(vec(350, 150))); // empty corner past both nodes
  m.dispatch(move(vec(150, 80))); // band now covers node:b
  assert.ok(m.marquee.get() !== null, "marquee box is live during the drag");
  assert.deepEqual(m.selection.ids(), ["node:b"]);
  m.dispatch(move(vec(-10, -10))); // extend back across both a and b
  assert.deepEqual(m.selection.ids().sort(), ["node:a", "node:b"]);
  m.dispatch(up(vec(-10, -10)));
  assert.equal(m.marquee.get(), null);
});

test("Escape mid-marquee restores the prior selection", () => {
  const { m } = setup();
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50))); // {a}
  m.dispatch(down(vec(310, 110), { shiftKey: true })); // additive marquee from empty corner
  m.dispatch(move(vec(150, 50), { shiftKey: true }));
  m.dispatch(esc());
  assert.deepEqual(m.selection.ids(), ["node:a"], "restored to the pre-marquee selection");
  assert.equal(m.marquee.get(), null);
});

test("hand tool pans the camera; tool swap is observable", () => {
  const { m } = setup();
  let toolFired = 0;
  m.toolSignal.subscribe(() => toolFired++);
  m.setTool("hand");
  assert.equal(m.currentTool, "hand");
  assert.equal(toolFired, 1);

  m.dispatch(down(vec(100, 100)));
  m.dispatch(move(vec(140, 130))); // +40,+30
  m.dispatch(up(vec(140, 130)));
  assert.deepEqual(m.camera.state, { x: 40, y: 30, z: 1 });
});

test("middle-button drag pans under any tool, never selecting", () => {
  const { m } = setup();
  // Press starts ON node a (0..100): a left press would select it, but the middle button must pan.
  m.dispatch({ type: "pointerdown", point: vec(50, 50), button: 1, ...NO_MODS });
  m.dispatch({ type: "pointermove", point: vec(80, 70), button: 1, ...NO_MODS }); // +30,+20
  assert.deepEqual(m.camera.state, { x: 30, y: 20, z: 1 }, "panned by the screen delta");
  m.dispatch({ type: "pointerup", point: vec(80, 70), button: 1, ...NO_MODS });
  assert.deepEqual(m.selection.ids(), [], "middle drag never touched selection");
  assert.equal(m.marquee.get(), null, "and never started a marquee");
});

test("hold Space switches to the hand tool and restores the prior tool on release", () => {
  const { m } = setup();
  assert.equal(m.currentTool, "select");
  m.dispatch({ type: "keydown", key: " ", ...NO_MODS });
  assert.equal(m.currentTool, "hand", "Space parks select and engages pan");
  m.dispatch({ type: "keydown", key: " ", ...NO_MODS }); // OS key-repeat must be a no-op
  assert.equal(m.currentTool, "hand");
  m.dispatch({ type: "keyup", key: " ", ...NO_MODS });
  assert.equal(m.currentTool, "select", "released back to where we were");
});

test("ctrl+wheel zooms about the pointer; plain wheel pans", () => {
  const { m } = setup();
  const anchor = vec(100, 100);
  const pageBefore = m.camera.screenToPage(anchor);
  m.dispatch({ type: "wheel", point: anchor, deltaX: 0, deltaY: -100, ...NO_MODS, ctrlKey: true });
  assert.ok(m.camera.state.z > 1, "zoomed in");
  const pageAfter = m.camera.screenToPage(anchor);
  assert.ok(Math.hypot(pageBefore.x - pageAfter.x, pageBefore.y - pageAfter.y) < 1e-9, "anchor fixed");

  m.camera.reset();
  m.dispatch({ type: "wheel", point: anchor, deltaX: 30, deltaY: 20, ...NO_MODS });
  assert.deepEqual(m.camera.state, { x: -30, y: -20, z: 1 }, "plain wheel pans opposite the scroll");
});

test("hover tracks the node under the pointer (when subscribed)", () => {
  const { m } = setup();
  // The O(N) hover hit-test only runs when someone is listening — an unsubscribed board pays nothing.
  m.dispatch(move(vec(50, 50)));
  assert.equal(m.hovered.get(), null, "no subscriber → no hit-test");
  const off = m.hovered.subscribe(() => {});
  m.dispatch(move(vec(50, 50)));
  assert.equal(m.hovered.get(), "node:a");
  m.dispatch(move(vec(150, 50)));
  assert.equal(m.hovered.get(), null);
  off();
});

// Regression: a stop()/start() cycle (what React StrictMode's setup→cleanup→setup probe drives, and
// what previously froze the hit-test index) must leave the index live AND re-seeded. After the cycle,
// existing nodes are still hittable and nodes added afterwards are picked up off channel 2.
test("stop()/start() keeps the spatial index live and re-seeded (StrictMode safety)", () => {
  const { editor, m } = setup();
  m.stop();
  m.start();

  // existing node still hittable (re-seeded from the snapshot)
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(m.selection.ids(), ["node:a"], "re-seeded node still selectable");

  // a node added AFTER the cycle is tracked → the channel-2 subscription is live
  editor.commit({ type: "addNode", payload: { id: "node:c", x: 400, y: 0, w: 100, h: 100 }, actor: "human" });
  m.dispatch(down(vec(450, 50)));
  m.dispatch(up(vec(450, 50)));
  assert.deepEqual(m.selection.ids(), ["node:c"], "node added after restart is hittable");
});

// Regression for the frozen-index symptom itself: after dragging a node, clicking its NEW location
// selects it and clicking its OLD (now-empty) location selects nothing.
test("index follows a drag: old location goes empty, new location is hittable", () => {
  const { m } = setup();
  m.dispatch(down(vec(50, 50))); // grab a at 0..100
  m.dispatch(move(vec(60, 50)));
  m.dispatch(move(vec(450, 50))); // drag a to ~400..500
  m.dispatch(up(vec(450, 50)));

  m.dispatch(down(vec(450, 50))); // click a's new spot
  m.dispatch(up(vec(450, 50)));
  assert.deepEqual(m.selection.ids(), ["node:a"], "new location hits the moved node");

  m.dispatch(down(vec(50, 50))); // click a's old spot (now empty)
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(m.selection.ids(), [], "old location no longer hits");
});

test("plain click narrows a multi-selection to the clicked node (on pointer up)", () => {
  const { m } = setup();
  m.selection.set(["node:a", "node:b"]);
  m.dispatch(down(vec(50, 50))); // press a (selected) → keep the group for a possible drag
  assert.deepEqual(m.selection.ids().sort(), ["node:a", "node:b"], "group intact on press");
  m.dispatch(up(vec(50, 50))); // no drag → narrow to just a
  assert.deepEqual(m.selection.ids(), ["node:a"]);
});

test("non-primary button does not select or drag", () => {
  const { m } = setup();
  m.dispatch({ type: "pointerdown", point: vec(50, 50), button: 2, ...NO_MODS }); // right-click on a
  m.dispatch({ type: "pointerup", point: vec(50, 50), button: 2, ...NO_MODS });
  assert.deepEqual(m.selection.ids(), [], "right-click left the selection untouched");
});

// Regression for "cannot begin a gesture inside another change": a second pointerdown arriving
// mid-drag (a stray second pointer that slipped past the input layer) must abort the in-flight
// gesture and recover, not orphan the store buffer and wedge every subsequent drag.
test("a press arriving mid-drag aborts the in-flight gesture and recovers", () => {
  const { editor, m } = setup();
  m.dispatch(down(vec(50, 50))); // grab a
  m.dispatch(move(vec(60, 50))); // → dragging (buffer open)
  m.dispatch(move(vec(90, 50))); // x → 40 live

  // a second press lands before pointerup — must not throw
  assert.doesNotThrow(() => m.dispatch(down(vec(50, 50))));
  assert.equal(x(editor, "node:a"), 0, "the orphaned drag was reverted");

  // and a clean drag still works afterward (the store buffer was closed, not left open)
  m.dispatch(move(vec(70, 50)));
  m.dispatch(up(vec(70, 50)));
  assert.equal(x(editor, "node:a"), 20, "subsequent drag works");
});

test("switching tools mid-drag aborts the gesture instead of orphaning it", () => {
  const { editor, m } = setup();
  m.dispatch(down(vec(50, 50)));
  m.dispatch(move(vec(90, 50))); // dragging, x → 40 live
  m.setTool("hand"); // onExit must close the gesture
  assert.equal(x(editor, "node:a"), 0, "drag reverted on tool switch");

  m.setTool("select");
  m.dispatch(down(vec(50, 50))); // a fresh drag must not throw
  m.dispatch(move(vec(70, 50)));
  m.dispatch(up(vec(70, 50)));
  assert.equal(x(editor, "node:a"), 20);
});

test("hit margin lets a click just outside an edge still land", () => {
  const { m } = setup();
  m.dispatch(down(vec(102, 50))); // 2px right of a's edge (100) — within HIT_MARGIN
  m.dispatch(up(vec(102, 50)));
  assert.deepEqual(m.selection.ids(), ["node:a"], "near-edge click still selects");

  m.dispatch(down(vec(120, 50))); // well into the gap, beyond the margin
  m.dispatch(up(vec(120, 50)));
  assert.deepEqual(m.selection.ids(), [], "clear of the margin hits nothing");
});

test("fitAll frames every node (instant in Node — no rAF), centred at z≤1", () => {
  const { m } = setup();
  m.setViewport(800, 600);
  m.fitAll();
  // a∪b spans x 0..300, y 0..100 → 300×100. Capped at z=1 (fitAll's maxZoom), so it just centres the
  // union: centre (150,50) maps to the viewport centre (400,300).
  assert.equal(m.camera.state.z, 1);
  const c = m.camera.pageToScreen({ x: 150, y: 50 });
  assert.ok(Math.hypot(c.x - 400, c.y - 300) < 1e-9, "union centre sits at viewport centre");
});

test("fitAll is inert before the viewport is measured", () => {
  const { m } = setup();
  const before = m.camera.state;
  m.fitAll(); // viewport still 0×0
  assert.deepEqual(m.camera.state, before);
});

test("flyTo with no rAF (Node) lands exactly on the target pose", () => {
  const { m } = setup();
  m.setViewport(800, 600);
  m.flyTo({ x: 12, y: -34, z: 2 });
  assert.deepEqual(m.camera.state, { x: 12, y: -34, z: 2 });
  m.cancelFly(); // idempotent, safe with nothing in flight
});

test("fitSelection frames the selected node, falling back to fitAll when empty", () => {
  const { m } = setup();
  m.setViewport(800, 600);
  m.selection.set(["node:b"]); // 200..300 × 0..100
  m.fitSelection();
  const c = m.camera.pageToScreen({ x: 250, y: 50 }); // node:b centre → viewport centre
  assert.ok(Math.hypot(c.x - 400, c.y - 300) < 1e-6, "selection centre sits at viewport centre");
  // Empty selection → behaves like fitAll (union centre).
  m.selection.clear();
  m.fitSelection();
  const c2 = m.camera.pageToScreen({ x: 150, y: 50 });
  assert.ok(Math.hypot(c2.x - 400, c2.y - 300) < 1e-6);
});

// ── directed-edge selection rule (P3 cluster-selection, replaces the move-with-thread reactor) ──
// A thread T with two open member cards A, B and an unrelated card X. The host resolver expands a
// thread to its members and NOTHING else (one-way): selecting T grabs its cluster, selecting a member
// never grabs T. Geometry: T 0..100, A 200..300, B 400..500, X 600..700 — all on the x axis, z=1.
function clusterSetup() {
  const editor = new Editor();
  editor.commit({ type: "addNode", payload: { id: "node:thread:T", x: 0, y: 0, w: 100, h: 100 }, actor: "human" });
  editor.commit({ type: "addNode", payload: { id: "node:live:A", x: 200, y: 0, w: 100, h: 100 }, actor: "human" });
  editor.commit({ type: "addNode", payload: { id: "node:live:B", x: 400, y: 0, w: 100, h: 100 }, actor: "human" });
  editor.commit({ type: "addNode", payload: { id: "node:x", x: 600, y: 0, w: 100, h: 100 }, actor: "human" });
  const m = new InteractionManager({
    editor,
    expandSelection: (id) => (id === "node:thread:T" ? ["node:live:A", "node:live:B"] : []),
  });
  return { editor, m };
}
const sel = (m: InteractionManager) => new Set(m.selection.ids());

test("selecting a thread auto-selects its open member cards (directed expansion)", () => {
  const { m } = clusterSetup();
  m.dispatch(down(vec(50, 50))); // press the thread
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(sel(m), new Set(["node:thread:T", "node:live:A", "node:live:B"]));
});

test("selecting a member is one-way — it never pulls in the thread", () => {
  const { m } = clusterSetup();
  m.dispatch(down(vec(250, 50))); // press member A
  m.dispatch(up(vec(250, 50)));
  assert.deepEqual(sel(m), new Set(["node:live:A"]), "just the member, no thread, no sibling");
});

test("plain click on the thread keeps the whole cluster (narrowOnUp carve-out)", () => {
  const { m } = clusterSetup();
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50))); // a plain click must NOT collapse to just the thread
  assert.deepEqual(sel(m), new Set(["node:thread:T", "node:live:A", "node:live:B"]));
  // clicking it again (cluster already selected) still keeps the cluster, not the thread alone
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(sel(m), new Set(["node:thread:T", "node:live:A", "node:live:B"]));
});

test("plain click on ONE member of a selected cluster narrows to just that member", () => {
  const { m } = clusterSetup();
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50))); // cluster selected
  m.dispatch(down(vec(250, 50))); // press member A (already in the multi-selection)
  m.dispatch(up(vec(250, 50))); // plain click → narrow to A (rename / scroll-one)
  assert.deepEqual(sel(m), new Set(["node:live:A"]));
});

test("group-drag: pressing the thread and dragging moves the whole cluster by one delta", () => {
  const { editor, m } = clusterSetup();
  m.dispatch(down(vec(50, 50))); // press thread → cluster selected + gesture opens
  m.dispatch(move(vec(90, 50))); // +40 crosses threshold → drag the group
  m.dispatch(up(vec(90, 50)));
  assert.equal(x(editor, "node:thread:T"), 40, "thread moved +40");
  assert.equal(x(editor, "node:live:A"), 240, "member A moved +40 (offset preserved)");
  assert.equal(x(editor, "node:live:B"), 440, "member B moved +40");
  assert.equal(x(editor, "node:x"), 600, "the unrelated card did not move");
});

test("marquee sweeping over a thread pulls in its members even if off-marquee", () => {
  const { m } = clusterSetup();
  // Rubber-band a box that covers ONLY the thread (0..100), not A/B (>=200).
  m.dispatch(down(vec(-10, -10)));
  m.dispatch(move(vec(110, 110)));
  m.dispatch(up(vec(110, 110)));
  assert.deepEqual(sel(m), new Set(["node:thread:T", "node:live:A", "node:live:B"]));
});

test("no expandSelection resolver → selection behaves exactly as before (thread selects alone)", () => {
  const editor = new Editor();
  editor.commit({ type: "addNode", payload: { id: "node:thread:T", x: 0, y: 0, w: 100, h: 100 }, actor: "human" });
  editor.commit({ type: "addNode", payload: { id: "node:live:A", x: 200, y: 0, w: 100, h: 100 }, actor: "human" });
  const m = new InteractionManager({ editor }); // no resolver wired
  m.dispatch(down(vec(50, 50)));
  m.dispatch(up(vec(50, 50)));
  assert.deepEqual(sel(m), new Set(["node:thread:T"]), "unwired host = plain single-select");
});
