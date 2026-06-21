import { layoutId, type Gesture, type Id, type LayoutRecord } from "../core.js";
import { boxContainsPoint, boxCorners, MIN_SIZE, resizeBox, vecDist, type Box, type Corner, type Vec } from "../geometry.js";
import type { PointerInput } from "../input.js";
import { selectionBounds } from "../selection.js";
import { DRAG_THRESHOLD, HANDLE_HIT, HIT_MARGIN, type InteractionContext, type Tool } from "./tool.js";

// The default tool: the bulk of a canvas's feel. Internal sub-states as a discriminated union —
//   idle      → nothing in flight
//   pointing  → pressed on a node; a click unless the pointer crosses the drag threshold
//   dragging  → moving the selection; ONE editor gesture coalesces all frames into one diff/event
//   handle    → pressed on a resize handle of the lone selected node; a resize once threshold crosses
//   resizing  → dragging that corner; ONE gesture coalesces every frame into one diff/resizeNodes event
//   marquee   → rubber-band selecting empty space
//
// Selection-on-press follows the familiar rule so group drags work: shift toggles the hit node;
// otherwise, pressing an UNselected node selects just it, while pressing an already-selected node
// leaves the selection intact (so you can drag the whole group). The pointing/marquee origins are kept
// in SCREEN space so the drag threshold is zoom-independent; the drag itself anchors to a PAGE point
// (`grab`, captured once at drag start) so that if the CAMERA pans mid-drag — e.g. edge auto-scroll as
// you drag a note off the viewport — the node keeps tracking the pointer into the newly revealed area
// (a pinned pointer over a panning camera still yields motion, which a screen-space delta would cancel).
type State =
  | { kind: "idle" }
  | { kind: "pointing"; nodeId: string; originScreen: Vec; narrowOnUp: boolean }
  | { kind: "dragging"; grab: Vec; gesture: Gesture; start: Map<string, Vec> }
  | { kind: "handle"; corner: Corner; nodeId: string; startBox: Box; originScreen: Vec }
  | { kind: "resizing"; corner: Corner; nodeId: string; startBox: Box; grab: Vec; gesture: Gesture }
  | { kind: "marquee"; originScreen: Vec; base: ReadonlySet<string> };

export class SelectTool implements Tool {
  readonly name = "select";
  private state: State = { kind: "idle" };
  constructor(private readonly ctx: InteractionContext) {}

  onPointerDown(e: PointerInput): void {
    if (e.button !== 0) return; // only the primary button selects/drags (right = menu, middle = pan)
    // A press should never arrive mid-gesture — the input layer tracks a single pointer — but if one
    // slips through (a stray second touch, a missed pointerup), abort whatever's in flight so we start
    // clean. Otherwise the orphaned gesture leaves the store's buffer open and the NEXT drag throws
    // "cannot begin a gesture inside another change".
    this.abortInFlight();
    const page = this.ctx.camera.screenToPage(e.point);

    // A resize handle wins over everything: it sits at the lone selected node's corner, drawn on top,
    // and is the smaller target, so a press there means resize even though the node's box is also under
    // the pointer. Geometry-only hit-test (the index doesn't know about handles), gated to a single
    // selection — the only case the renderer draws handles for.
    const handle = this.hitHandle(page);
    if (handle) {
      this.state = { kind: "handle", ...handle, originScreen: e.point };
      return;
    }

    const hit = this.ctx.index.hitPoint(page, HIT_MARGIN / this.ctx.camera.state.z);

    if (hit) {
      if (e.shiftKey) this.ctx.selection.toggle(hit);
      else if (!this.ctx.selection.has(hit)) this.ctx.selection.set([hit]);
      // Pressed on a (now-)selected node → wait to see if this becomes a drag or a click. If it was
      // already part of a multi-selection (non-shift), keep the group so a drag moves all of it, but
      // remember to narrow to just this node if the press turns out to be a plain click (pointer-up).
      const narrowOnUp = !e.shiftKey && this.ctx.selection.has(hit) && this.ctx.selection.size > 1;
      this.state = { kind: "pointing", nodeId: hit, originScreen: e.point, narrowOnUp };
    } else if (!e.shiftKey && this.pointInSelectionBounds(page)) {
      // Inside the multi-selection's bounding box but not on a card (the gap between selected cards) →
      // grab the whole group, tldraw-style: the selection's bounds is a draggable surface. Keep the
      // selection intact (a drag moves all of it; a plain release is a no-op), so it doesn't collapse.
      this.state = { kind: "pointing", nodeId: this.ctx.selection.ids()[0]!, originScreen: e.point, narrowOnUp: false };
    } else {
      // empty space → marquee; non-additive press clears immediately for live feedback
      const base = e.shiftKey ? new Set(this.ctx.selection.ids()) : new Set<string>();
      if (!e.shiftKey) this.ctx.selection.clear();
      this.state = { kind: "marquee", originScreen: e.point, base };
    }
  }

  // True when `page` lands inside the bounding box of a MULTI-selection (≥2). For a single selection
  // the bounds equals the card, which hitPoint already catches — so this only adds the gap-between-
  // cards region, exactly the surface that reads as "the selection" and should drag the group.
  private pointInSelectionBounds(page: Vec): boolean {
    if (this.ctx.selection.size < 2) return false;
    const b = selectionBounds(this.ctx.editor.store, this.ctx.selection.ids());
    return !!b && boxContainsPoint(b, page);
  }

  // Which resize handle (if any) a page point grabs. Only the lone selected node carries handles (the
  // renderer draws them only then), so a multi-selection or empty selection never resizes. The grab
  // radius is a screen-px constant ÷ live zoom, so the hot zone stays the rendered handle's size at any
  // zoom — the same constant-on-screen trick HIT_MARGIN uses.
  private hitHandle(page: Vec): { corner: Corner; nodeId: string; startBox: Box } | null {
    if (this.ctx.selection.size !== 1) return null;
    const nodeId = this.ctx.selection.ids()[0]!;
    const l = this.ctx.editor.store.get<"layout">(layoutId(nodeId as Id<"node">)) as LayoutRecord | undefined;
    if (!l) return null;
    const box: Box = { x: l.x, y: l.y, w: l.w, h: l.h };
    const r = HANDLE_HIT / this.ctx.camera.state.z;
    const corners = boxCorners(box);
    for (const corner of ["nw", "ne", "sw", "se"] as Corner[]) {
      if (vecDist(page, corners[corner]) <= r) return { corner, nodeId, startBox: box };
    }
    return null;
  }

  onPointerMove(e: PointerInput): void {
    const s = this.state;
    switch (s.kind) {
      case "pointing": {
        if (vecDist(e.point, s.originScreen) < DRAG_THRESHOLD) return; // still a click
        this.startDrag(s.originScreen); // threshold crossed → begin the move gesture
        this.applyDrag(e.point); // include the move that crossed the threshold
        break;
      }
      case "dragging":
        this.applyDrag(e.point);
        break;
      case "handle": {
        if (vecDist(e.point, s.originScreen) < DRAG_THRESHOLD) return; // still a click on the handle
        this.startResize(s); // threshold crossed → open the resize gesture
        this.applyResize(e.point); // include the move that crossed the threshold
        break;
      }
      case "resizing":
        this.applyResize(e.point);
        break;
      case "marquee": {
        const box = this.ctx.camera.screenBoxToPage(s.originScreen, e.point);
        this.ctx.marquee.set(box);
        const hits = this.ctx.index.hitTest(box);
        this.ctx.selection.set([...s.base, ...hits]); // base (shift) ∪ rubber-banded
        break;
      }
    }
  }

  onPointerUp(_e: PointerInput): void {
    const s = this.state;
    if (s.kind === "dragging") {
      s.gesture.end({ ids: [...s.start.keys()] }); // one IntentEvent for the whole drag
    } else if (s.kind === "resizing") {
      s.gesture.end({ ids: [s.nodeId] }); // one resizeNodes IntentEvent for the whole resize
    } else if (s.kind === "marquee") {
      this.ctx.marquee.set(null); // selection is already live
    } else if (s.kind === "pointing" && s.narrowOnUp) {
      // Plain click on a node that was part of a multi-selection → narrow to just it (the drag that
      // would have kept the group never started, or we'd be in "dragging").
      this.ctx.selection.set([s.nodeId]);
    }
    // "pointing" without narrowOnUp = a plain click whose selection was already set on press.
    this.state = { kind: "idle" };
  }

  onCancel(): void {
    const s = this.state;
    if (s.kind === "dragging" || s.kind === "resizing") {
      s.gesture.cancel(); // revert the live atoms; nothing reaches channel 2 / the log
    } else if (s.kind === "marquee") {
      this.ctx.marquee.set(null);
      this.ctx.selection.set(s.base); // restore what we had before the rubber-band
    }
    this.state = { kind: "idle" };
  }

  // Switching away mid-drag (e.g. a tool shortcut) must not orphan an open gesture: abort it so the
  // store buffer is closed before the next tool runs.
  onExit(): void {
    this.abortInFlight();
  }

  // Tear down any in-flight gesture/marquee and return to idle WITHOUT the cancel-semantics of
  // restoring a pre-marquee selection (this is the "something interrupted us" path, not Escape):
  // a half-finished drag is reverted (its live atoms snap back), a half-finished marquee just drops
  // its box and keeps the selection it had rubber-banded so far.
  private abortInFlight(): void {
    const s = this.state;
    if (s.kind === "dragging" || s.kind === "resizing") s.gesture.cancel();
    else if (s.kind === "marquee") this.ctx.marquee.set(null);
    this.state = { kind: "idle" };
  }

  // ── drag mechanics ──────────────────────────────────────────────────────────────────
  // Snapshot every selected node's start position, then open ONE gesture. Each frame rewrites the
  // selection's layout atoms to start + pageDelta — coalesced by the store into a single diff and a
  // single "moveNodes" intent at end(). Absolute (start + delta) rather than incremental so the move
  // is idempotent per frame and a dropped move event can't accumulate error.
  private startDrag(originScreen: Vec): void {
    const start = new Map<string, Vec>();
    const zNow = new Map<string, number>();
    for (const nodeId of this.ctx.selection.ids()) {
      const l = this.ctx.editor.store.get<"layout">(layoutId(nodeId as Id<"node">)) as LayoutRecord | undefined;
      if (l) {
        start.set(nodeId, { x: l.x, y: l.y });
        zNow.set(nodeId, l.z);
      }
    }
    // The grab anchor: the page point under the pointer at the instant the drag begins, captured with
    // the camera as it is NOW. Every frame's delta is measured from this fixed page point, so a camera
    // pan during the drag (edge auto-scroll) shifts the node even while the pointer holds still.
    const grab = this.ctx.camera.screenToPage(originScreen);
    const gesture = this.ctx.editor.beginGesture("moveNodes", "human");
    // Lift the grabbed set above everything else, preserving their relative order, FOLDED INTO the
    // move gesture: it rides the one coalesced diff (so it's a single undo step with the move and adds
    // no intent-log noise) and the index/renderer pick up the new stacking via channel 1/2 like any
    // layout change. Grabbing the top card just re-confirms it on top — cheap and harmless.
    const base = this.ctx.index.topZ();
    const ordered = [...zNow.keys()].sort((a, b) => zNow.get(a)! - zNow.get(b)!);
    gesture.update(() => {
      ordered.forEach((nodeId, i) => {
        this.ctx.editor.store.update<LayoutRecord>(layoutId(nodeId as Id<"node">), { z: base + 1 + i });
      });
    });
    this.state = { kind: "dragging", grab, gesture, start };
  }

  private applyDrag(pointScreen: Vec): void {
    if (this.state.kind !== "dragging") return;
    const { grab, gesture, start } = this.state;
    // Convert the pointer to a page point with the LIVE camera, then offset every node by how far that
    // page point has moved from the grab anchor. Going through page space (rather than a screen delta ÷
    // zoom) is what lets a mid-drag camera pan carry the nodes along — see the `grab` note above.
    const cur = this.ctx.camera.screenToPage(pointScreen);
    const dx = cur.x - grab.x;
    const dy = cur.y - grab.y;
    gesture.update(() => {
      for (const [nodeId, p0] of start) {
        this.ctx.editor.store.update<LayoutRecord>(layoutId(nodeId as Id<"node">), { x: p0.x + dx, y: p0.y + dy });
      }
    });
  }

  // ── resize mechanics ────────────────────────────────────────────────────────────────
  // Same shape as the drag: snapshot the box (already captured at press as startBox), anchor the grab
  // page point, open ONE "resizeNodes" gesture. No restack — a resize shouldn't bring a card forward.
  private startResize(s: { corner: Corner; nodeId: string; startBox: Box; originScreen: Vec }): void {
    const grab = this.ctx.camera.screenToPage(s.originScreen);
    const gesture = this.ctx.editor.beginGesture("resizeNodes", "human");
    this.state = { kind: "resizing", corner: s.corner, nodeId: s.nodeId, startBox: s.startBox, grab, gesture };
  }

  private applyResize(pointScreen: Vec): void {
    if (this.state.kind !== "resizing") return;
    const { corner, nodeId, startBox, grab, gesture } = this.state;
    // Page-space delta from the grab anchor (live camera, so a mid-resize pan carries the corner —
    // same reasoning as applyDrag's grab note), fed through the clamped corner math.
    const cur = this.ctx.camera.screenToPage(pointScreen);
    // A card type may pin its resize ratio (the round clock stays square); the host resolves nodeId →
    // ratio, the tool stays card-type-blind. null/absent → free resize, the default for every card.
    const aspect = this.ctx.aspectLock?.(nodeId) ?? undefined;
    const box = resizeBox(startBox, corner, cur.x - grab.x, cur.y - grab.y, MIN_SIZE, aspect);
    gesture.update(() => {
      this.ctx.editor.store.update<LayoutRecord>(layoutId(nodeId as Id<"node">), box);
    });
  }
}
