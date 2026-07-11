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
// leaves the selection intact (so you can drag the whole group).
//
// Bring-to-front rides the SAME press: a non-shift press that selects a card lifts the selection above
// every other card right away (immediate stacking feedback — no need to start dragging first), opening
// ONE gesture. If the press becomes a drag, the move frames ride that same gesture and it settles as a
// "moveNodes" intent; if it stays a plain click, the gesture ends as a "raiseNodes" intent. Either way
// the raise + any move are a single coalesced diff and a single undo step. When the selection is
// already on top (nothing to restack) no gesture opens, so plain clicks don't litter the undo stack.
// The pointing/marquee origins are kept
// in SCREEN space so the drag threshold is zoom-independent; the drag itself anchors to a PAGE point
// (`grab`, captured once at drag start) so that if the CAMERA pans mid-drag — e.g. edge auto-scroll as
// you drag a note off the viewport — the node keeps tracking the pointer into the newly revealed area
// (a pinned pointer over a panning camera still yields motion, which a screen-space delta would cancel).
type State =
  | { kind: "idle" }
  | { kind: "pointing"; nodeId: string; originScreen: Vec; narrowOnUp: boolean; gesture: Gesture | null }
  | { kind: "dragging"; grab: Vec; gesture: Gesture; start: Map<string, Vec> }
  | { kind: "handle"; corner: Corner; nodeId: string; startBox: Box; originScreen: Vec }
  | { kind: "resizing"; corner: Corner; nodeId: string; startBox: Box; grab: Vec; gesture: Gesture }
  | { kind: "connecting"; from: string }
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

    // Alt-drag from a connectable node wires two cards instead of moving one: enter a connect-drag and
    // let the host decide what edge the drop makes (ctx.connect). The engine carries the gesture +
    // preview only — it never learns edge semantics (mirrors aspectLock's card-type-blindness). Checked
    // before the handle/select paths so alt-over-a-node always means "wire", not "resize/move".
    if (e.altKey) {
      const onNode = this.ctx.index.hitPoint(page, HIT_MARGIN / this.ctx.camera.state.z);
      if (onNode && (this.ctx.connectable?.(onNode) ?? true)) {
        this.state = { kind: "connecting", from: onNode };
        this.ctx.connectDraw.set({ from: onNode, to: page, toNode: null });
        return;
      }
    }

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
      // Decided BEFORE the cluster expansion below: narrow only for a card that was ALREADY part of a
      // hand-assembled group (click one member → select just it, so rename / scroll-one works), never
      // for a card that is about to auto-expand a cluster underfoot.
      let narrowOnUp = !e.shiftKey && this.ctx.selection.has(hit) && this.ctx.selection.size > 1;
      // Directed selection-expansion: selecting a card pulls in the cards the host says travel with it
      // (a thread grabs its OPEN member session cards). One-way — a member never grabs its thread — so
      // the seed group-drags the whole cluster with no bespoke follow reactor. Non-shift only: shift is
      // for hand-assembling a set, where an expansion underfoot would surprise. A seed that expands IS
      // the cluster's anchor, so keep the whole cluster on a plain click (don't narrow), so selecting
      // the thread and then dragging moves the group rather than collapsing to the thread alone.
      if (!e.shiftKey) {
        const cluster = this.ctx.expandSelection?.(hit) ?? [];
        if (cluster.length) {
          this.ctx.selection.add(cluster);
          narrowOnUp = false;
        }
      }
      // Lift the selection to the front on the press itself (non-shift only — shift is for assembling a
      // set, where a restack underfoot would surprise). The open gesture is held in the pointing state:
      // a drag reuses it, a plain click ends it (see onPointerUp). null when already on top.
      const gesture = e.shiftKey ? null : this.raiseSelection();
      this.state = { kind: "pointing", nodeId: hit, originScreen: e.point, narrowOnUp, gesture };
    } else if (!e.shiftKey && this.pointInSelectionBounds(page)) {
      // Inside the multi-selection's bounding box but not on a card (the gap between selected cards) →
      // grab the whole group, tldraw-style: the selection's bounds is a draggable surface. Keep the
      // selection intact (a drag moves all of it; a plain release is a no-op), so it doesn't collapse.
      const gesture = this.raiseSelection();
      this.state = { kind: "pointing", nodeId: this.ctx.selection.ids()[0]!, originScreen: e.point, narrowOnUp: false, gesture };
    } else {
      // empty space → marquee; non-additive press clears immediately for live feedback
      const base = e.shiftKey ? new Set(this.ctx.selection.ids()) : new Set<string>();
      if (!e.shiftKey) this.ctx.selection.clear();
      this.state = { kind: "marquee", originScreen: e.point, base };
    }
  }

  // Pull in every card the host says travels with an already-selected one (directed, one-way). Applied
  // after a marquee union so sweeping over a thread grabs its open member cards too, matching a plain
  // thread click. Idempotent — the expansions are additive and re-derived from the live selection each
  // frame (a marquee rewrites the base∪hits set per move, so no stale members accumulate).
  private expandClusterSelection(): void {
    const fn = this.ctx.expandSelection;
    if (!fn) return;
    const extra: string[] = [];
    for (const id of this.ctx.selection.ids()) extra.push(...fn(id));
    if (extra.length) this.ctx.selection.add(extra);
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
        this.startDrag(s.originScreen, s.gesture); // threshold crossed → reuse the raise gesture (or open one)
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
      case "connecting": {
        // Track the loose end and light up a legal drop target (a different, connectable node). No store
        // mutation — the connector is pure channel-1 preview until the drop commits an edge via the host.
        const page = this.ctx.camera.screenToPage(e.point);
        const hit = this.ctx.index.hitPoint(page, HIT_MARGIN / this.ctx.camera.state.z);
        const toNode = hit && hit !== s.from && (this.ctx.connectable?.(hit) ?? true) ? hit : null;
        this.ctx.connectDraw.set({ from: s.from, to: page, toNode });
        break;
      }
      case "marquee": {
        const box = this.ctx.camera.screenBoxToPage(s.originScreen, e.point);
        this.ctx.marquee.set(box);
        const hits = this.ctx.index.hitTest(box);
        this.ctx.selection.set([...s.base, ...hits]); // base (shift) ∪ rubber-banded
        this.expandClusterSelection(); // a swept-in thread brings its open member cards, as a click would
        break;
      }
    }
  }

  onPointerUp(e: PointerInput): void {
    const s = this.state;
    if (s.kind === "dragging") {
      s.gesture.end({ ids: [...s.start.keys()] }, "moveNodes"); // one IntentEvent for the raise+move
    } else if (s.kind === "resizing") {
      s.gesture.end({ ids: [s.nodeId] }); // one resizeNodes IntentEvent for the whole resize
    } else if (s.kind === "connecting") {
      // Drop on a different, connectable node → hand the host the pair; it makes the edge (or not).
      // Released over empty space / the source / a non-target → just cancel the preview. No gesture,
      // so nothing to revert; the edge (if any) is the host's own committed addEdge.
      const page = this.ctx.camera.screenToPage(e.point);
      const hit = this.ctx.index.hitPoint(page, HIT_MARGIN / this.ctx.camera.state.z);
      if (hit && hit !== s.from && (this.ctx.connectable?.(hit) ?? true)) this.ctx.connect?.(s.from, hit);
      this.ctx.connectDraw.set(null);
    } else if (s.kind === "marquee") {
      this.ctx.marquee.set(null); // selection is already live
    } else if (s.kind === "pointing") {
      // A plain click (no drag). If the press lifted the selection, commit that raise as its own one
      // undo step — "raiseNodes", since nothing moved. (No gesture → the selection was already on top.)
      if (s.gesture) s.gesture.end({ ids: this.ctx.selection.ids() }, "raiseNodes");
      // A node that was part of a multi-selection → narrow to just it (the drag that would have kept
      // the group never started, or we'd be in "dragging"). Selection is ephemeral, so this is
      // independent of the committed raise above.
      if (s.narrowOnUp) this.ctx.selection.set([s.nodeId]);
    }
    this.state = { kind: "idle" };
  }

  onCancel(): void {
    const s = this.state;
    if (s.kind === "dragging" || s.kind === "resizing") {
      s.gesture.cancel(); // revert the live atoms; nothing reaches channel 2 / the log
    } else if (s.kind === "pointing") {
      s.gesture?.cancel(); // a raise that opened on press but never committed → revert its lift
    } else if (s.kind === "connecting") {
      this.ctx.connectDraw.set(null); // drop the in-flight connector; no edge committed
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
    else if (s.kind === "pointing") s.gesture?.cancel();
    else if (s.kind === "connecting") this.ctx.connectDraw.set(null);
    else if (s.kind === "marquee") this.ctx.marquee.set(null);
    this.state = { kind: "idle" };
  }

  // Lift the current selection above every OTHER card, as ONE gesture frame, preserving the selection's
  // internal stacking order. Returns the open (un-ended) gesture so the caller can fold a subsequent
  // drag into it, or null when the selection is already entirely on top (nothing to restack — a plain
  // click that opens no gesture leaves the undo stack untouched). The base is the top z among
  // NON-selected cards, so the lift is minimal and idempotent: pressing an already-front card is a no-op.
  private raiseSelection(): Gesture | null {
    const ids = this.ctx.selection.ids();
    if (ids.length === 0) return null;
    const sel = new Set(ids);
    const base = this.ctx.index.topZ(sel); // highest z among cards we are NOT raising (−1 if none)
    const zNow = new Map<string, number>();
    let minSel = Infinity;
    for (const nodeId of ids) {
      const l = this.ctx.editor.store.get<"layout">(layoutId(nodeId as Id<"node">)) as LayoutRecord | undefined;
      if (l) {
        zNow.set(nodeId, l.z);
        if (l.z < minSel) minSel = l.z;
      }
    }
    if (zNow.size === 0 || minSel > base) return null; // already strictly above every other card
    const gesture = this.ctx.editor.beginGesture("raiseNodes", "human");
    const ordered = [...zNow.keys()].sort((a, b) => zNow.get(a)! - zNow.get(b)!);
    gesture.update(() => {
      ordered.forEach((nodeId, i) => {
        this.ctx.editor.store.update<LayoutRecord>(layoutId(nodeId as Id<"node">), { z: base + 1 + i });
      });
    });
    return gesture;
  }

  // ── drag mechanics ──────────────────────────────────────────────────────────────────
  // Snapshot every selected node's start position. The gesture is the one opened at press for the
  // bring-to-front (so the raise + the move coalesce into a single diff / single "moveNodes" intent /
  // single undo step); if the press found nothing to raise none was opened, so open one now. Each frame
  // rewrites the selection's layout atoms to start + pageDelta — absolute (start + delta) rather than
  // incremental so the move is idempotent per frame and a dropped move event can't accumulate error.
  private startDrag(originScreen: Vec, gesture: Gesture | null): void {
    const start = new Map<string, Vec>();
    for (const nodeId of this.ctx.selection.ids()) {
      const l = this.ctx.editor.store.get<"layout">(layoutId(nodeId as Id<"node">)) as LayoutRecord | undefined;
      if (l) start.set(nodeId, { x: l.x, y: l.y });
    }
    // The grab anchor: the page point under the pointer at the instant the drag begins, captured with
    // the camera as it is NOW. Every frame's delta is measured from this fixed page point, so a camera
    // pan during the drag (edge auto-scroll) shifts the node even while the pointer holds still.
    const grab = this.ctx.camera.screenToPage(originScreen);
    this.state = { kind: "dragging", grab, gesture: gesture ?? this.ctx.editor.beginGesture("moveNodes", "human"), start };
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
