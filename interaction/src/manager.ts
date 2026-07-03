import { Editor, type Subscribable } from "./core.js";
import { Camera, pageToScreen, screenToPage, type CameraState } from "./camera.js";
import { Selection, selectionBounds, worldBounds } from "./selection.js";
import { BruteForceIndex, syncIndexFromStore, type SpatialIndex } from "./spatial.js";
import { Observable } from "./observable.js";
import type { Box, Vec } from "./geometry.js";
import type { InputEvent, PointerInput } from "./input.js";
import type { ConnectDraw, InteractionContext, Tool } from "./tools/tool.js";
import { SelectTool } from "./tools/select-tool.js";
import { HandTool } from "./tools/hand-tool.js";

export interface InteractionOptions {
  editor?: Editor;
  camera?: Camera;
  index?: SpatialIndex;
  /** Extra tools, keyed by name, merged over the built-ins (select, hand). */
  tools?: (ctx: InteractionContext) => Tool[];
  /** Wheel zoom step per 100px of deltaY (ctrl/⌘ + wheel = pinch zoom). */
  zoomSpeed?: number;
  /** Per-node resize aspect-ratio lock (w/h); see InteractionContext.aspectLock. */
  aspectLock?: (nodeId: string) => number | null;
  /** May a connect-drag start on this node? See InteractionContext.connectable. */
  connectable?: (nodeId: string) => boolean;
  /** The user wired `from`→`to` with a connect-drag; the host makes the edge. See InteractionContext.connect. */
  connect?: (from: string, to: string) => void;
}

// Edge auto-scroll ("infinite canvas" pan-while-dragging): when a drag's pointer comes within
// EDGE_INSET screen-px of a viewport edge, the camera pans toward that edge each frame at up to
// MAX_EDGE_SPEED px/frame, ramped linearly by how far into the band the pointer sits. The camera-aware
// drag in select-tool then carries the grabbed nodes into the freshly revealed area.
const EDGE_INSET = 36;
const MAX_EDGE_SPEED = 14;

// A second, time-based ramp on top of the depth ramp, so the pan EASES IN instead of snapping to full
// speed the instant the pointer crosses into the band. Without it a brief brush near an edge (common
// while nudging a card into place) yanks the view, and a held edge flings the camera across the canvas
// with no governor. Each scroll run starts at RAMP_FLOOR of its depth-implied speed and climbs linearly
// to full over RAMP_MS; leaving the band ends the run (stopEdgeScroll), so re-entering eases in afresh.
const RAMP_MS = 550;
const RAMP_FLOOR = 0.15;

// The façade the app/renderer holds. It owns the session-tier state (camera, selection, marquee,
// hovered), the spatial index (kept in sync off channel 2), and the active tool, and it routes
// normalized InputEvents to that tool. Camera navigation (wheel zoom/pan, Escape) is handled here
// rather than per-tool so it works the same under every tool — tools own object interaction, the
// manager owns viewport + lifecycle. It implements InteractionContext so it can hand itself to tools.
export class InteractionManager implements InteractionContext {
  readonly editor: Editor;
  readonly camera: Camera;
  readonly selection: Selection;
  readonly index: SpatialIndex;
  readonly marquee = new Observable<Box | null>(null);
  /** Live connect-drag preview (alt-drag wiring); null when not connecting. See InteractionContext.connectDraw. */
  readonly connectDraw = new Observable<ConnectDraw | null>(null);
  /** Node under the pointer (renderer hover affordance); updated on every pointer move. */
  readonly hovered = new Observable<string | null>(null);
  /** Per-node resize aspect-ratio lock supplied by the host; see InteractionContext.aspectLock. */
  readonly aspectLock?: (nodeId: string) => number | null;
  /** May a connect-drag start on a node? Supplied by the host; see InteractionContext.connectable. */
  readonly connectable?: (nodeId: string) => boolean;
  /** Connect-drag completion handler supplied by the host; see InteractionContext.connect. */
  readonly connect?: (from: string, to: string) => void;

  private tools = new Map<string, Tool>();
  private active: Tool;
  private offIndex: (() => void) | null = null;
  private readonly zoomSpeed: number;

  // ── edge auto-scroll state ──
  private viewportW = 0;
  private viewportH = 0;
  private pointerActive = false; // primary button held (a drag/marquee may be in flight)
  private lastPointer: PointerInput | null = null; // most recent move, replayed each scroll frame
  private edgeRaf: number | null = null;
  private edgeScrollStartTs: number | null = null; // rAF timestamp of the current run's first frame (ease-in origin)

  // ── manager-level panning (idiomatic, tool-independent) ──
  // Middle-button drag pans under ANY tool; the last screen point we panned from (null = not panning).
  private midPanFrom: Vec | null = null;
  // Hold-space temporarily switches to the hand tool (Figma/tldraw-style), restoring on release. We
  // remember the tool we came from; `spaceDown` de-bounces auto-repeat keydowns.
  private spaceDown = false;
  private toolBeforeSpace: string | null = null;

  constructor(opts: InteractionOptions = {}) {
    this.editor = opts.editor ?? new Editor();
    this.camera = opts.camera ?? new Camera();
    this.index = opts.index ?? new BruteForceIndex();
    this.selection = new Selection();
    this.zoomSpeed = opts.zoomSpeed ?? 0.5;
    this.aspectLock = opts.aspectLock;
    this.connectable = opts.connectable;
    this.connect = opts.connect;

    // Open the channel-2 index subscription via the idempotent start() so a plain (non-React) host
    // and the Node tests get a live index immediately. The lifecycle is also re-entrant: a host can
    // bracket it with stop()/start() (see the App effect), which is what makes it survive React
    // StrictMode's dev-only setup→cleanup→setup probe instead of freezing the hit-test index.
    this.start();

    const builtins: Tool[] = [new SelectTool(this), new HandTool(this)];
    const extra = opts.tools?.(this) ?? [];
    for (const t of [...builtins, ...extra]) this.tools.set(t.name, t);
    this.active = this.tools.get("select")!;
    this.active.onEnter?.();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────
  // start()/stop() bracket the manager's channel-2 subscriptions so the host can pair them with a
  // single effect (`m.start(); return () => m.stop()`). Both are idempotent: start() re-seeds the
  // index from the current snapshot (syncIndexFromStore reads getSnapshot(), not just the live
  // stream), so a StrictMode start→stop→start cycle ends subscribed AND fully seeded.
  /** (Re)attach the channel-2 consumers (the spatial index). Idempotent. */
  start(): void {
    if (this.offIndex) return;
    this.index.clear();
    this.offIndex = syncIndexFromStore(this.editor.store, this.index);
  }
  /** Detach the channel-2 consumers. Idempotent; safe to call when not started. */
  stop(): void {
    this.offIndex?.();
    this.offIndex = null;
  }

  get currentTool(): string {
    return this.active.name;
  }
  /** Active-tool handle for the renderer (e.g. to swap the cursor). */
  get toolSignal(): Subscribable<string> {
    return this.toolObs;
  }
  private toolObs = new Observable<string>("select");

  setTool(name: string): void {
    const next = this.tools.get(name);
    if (!next || next === this.active) return;
    this.active.onExit?.();
    this.active = next;
    this.active.onEnter?.();
    this.toolObs.set(name);
  }

  // ── input routing ─────────────────────────────────────────────────────────────────────
  dispatch(e: InputEvent): void {
    switch (e.type) {
      case "pointerdown":
        this.cancelFly(); // grabbing the canvas takes over any in-flight fly-to
        // Middle button = pan under any tool: intercept before the active tool ever sees it, so it
        // works the same whether you're in select, hand, or a future tool — and never starts a
        // marquee/drag. (The select tool already ignores non-primary buttons; this makes them useful.)
        if (e.button === 1) {
          this.midPanFrom = e.point;
          break;
        }
        if (e.button === 0) this.pointerActive = true;
        this.lastPointer = e;
        this.active.onPointerDown?.(e);
        break;
      case "pointermove":
        if (this.midPanFrom) {
          // Incremental, grab-the-canvas pan (same sign/feel as the hand tool); advance the anchor.
          this.camera.panBy(e.point.x - this.midPanFrom.x, e.point.y - this.midPanFrom.y);
          this.midPanFrom = e.point;
          break;
        }
        this.lastPointer = e;
        // hover is tool-independent affordance state, kept fresh on the manager — but the hit-test is
        // a linear scan over every layout, so only pay it when someone is actually subscribed (today's
        // renderer isn't; an O(N) scan per pointermove for an unread value was pure drag on busy boards)
        if (this.hovered.hasListeners)
          this.hovered.set(this.index.hitPoint(this.camera.screenToPage(e.point)) ?? null);
        this.active.onPointerMove?.(e);
        this.updateEdgeScroll(); // pointer may have entered/left an edge band
        break;
      case "pointerup":
        if (this.midPanFrom) {
          this.midPanFrom = null; // the single tracked pointer is up → end the middle-button pan
          break;
        }
        this.lastPointer = e;
        this.active.onPointerUp?.(e);
        this.pointerActive = false;
        this.stopEdgeScroll();
        break;
      case "wheel":
        this.onWheel(e);
        break;
      case "keydown":
        if (e.key === "Escape") {
          this.active.onCancel?.();
          this.pointerActive = false;
          this.stopEdgeScroll();
        } else if (e.key === " ") {
          this.beginSpacePan();
        } else this.active.onKeyDown?.(e);
        break;
      case "keyup":
        if (e.key === " ") this.endSpacePan();
        break;
    }
  }

  // ── hold-space to pan ────────────────────────────────────────────────────────────────────
  // First Space keydown (auto-repeat de-bounced) parks the current tool and switches to hand; keyup
  // restores it. If we're already on hand (or mid middle-pan) there's nothing to remember. setTool
  // aborts any in-flight select gesture via the tool's onExit, so pressing Space mid-marquee cleanly
  // hands off to panning rather than orphaning a gesture.
  private beginSpacePan(): void {
    if (this.spaceDown) return; // ignore the OS key-repeat stream
    this.spaceDown = true;
    if (this.currentTool === "hand") return;
    this.toolBeforeSpace = this.currentTool;
    this.setTool("hand");
  }
  private endSpacePan(): void {
    if (!this.spaceDown) return;
    this.spaceDown = false;
    if (this.toolBeforeSpace) {
      this.setTool(this.toolBeforeSpace);
      this.toolBeforeSpace = null;
    }
  }

  // ── edge auto-scroll ────────────────────────────────────────────────────────────────────
  /**
   * Tell the manager the canvas's pixel size (its top-left is the screen-coordinate origin). Drives
   * edge auto-scroll; until set (w/h > 0) the feature is inert — so the Node tests, which never call
   * this, behave exactly as before.
   */
  setViewport(w: number, h: number): void {
    this.viewportW = w;
    this.viewportH = h;
  }

  /** Current canvas pixel size (0×0 until setViewport runs) — e.g. to place a floating card in a corner. */
  get viewportSize(): { w: number; h: number } {
    return { w: this.viewportW, h: this.viewportH };
  }

  /**
   * The page-space rectangle currently on screen (camera pose × viewport size) — the inverse of the
   * pan/zoom transform applied to the canvas's screen rect. A placer (e.g. "drop a new card where the
   * user can see it") asks for this so it works in page coordinates the Store understands, without
   * learning the camera maths. Null until the viewport size is known (w/h > 0): the Node tests never
   * set it, so they stay unaffected and callers fall back to their own default placement.
   */
  visibleBox(): Box | null {
    if (this.viewportW <= 0 || this.viewportH <= 0) return null;
    const tl = this.camera.screenToPage({ x: 0, y: 0 });
    const br = this.camera.screenToPage({ x: this.viewportW, y: this.viewportH });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  // ── zoom to fit ─────────────────────────────────────────────────────────────────────────
  // The two wayfinding moves, both expressed as "frame a box" over camera.fitBox: fitAll is the
  // I'm-lost reset, fitSelection the zoom-into-this. They no-op on an empty board / before the
  // viewport is measured (camera.fitBox guards the zero-area cases), so a host can bind them to keys
  // without first checking there's anything to frame. `skipLayout` lets the host exclude content that
  // isn't world-space — screen-anchored (floating) cards — from the all-bounds.

  /** Frame every world node (the "fit all" reset). Won't zoom past 1× — a calm whole-board view. */
  fitAll(skipLayout?: (l: import("./core.js").LayoutRecord) => boolean): void {
    const box = worldBounds(this.editor.store, skipLayout);
    if (!box) return;
    const s = this.camera.fitState(box, this.viewportW, this.viewportH, { pad: 0.08, maxZoom: 1 });
    if (s) this.flyTo(s);
  }

  /** Frame the current selection (the "zoom to this"); falls back to fitAll when nothing is selected. */
  fitSelection(skipLayout?: (l: import("./core.js").LayoutRecord) => boolean): void {
    const ids = this.selection.ids();
    if (ids.length === 0) return this.fitAll(skipLayout);
    const box = selectionBounds(this.editor.store, ids);
    if (!box) return;
    const s = this.camera.fitState(box, this.viewportW, this.viewportH, { pad: 0.15, maxZoom: 2 });
    if (s) this.flyTo(s);
  }

  // ── animated camera moves ────────────────────────────────────────────────────────────────
  // flyTo eases the camera to a target pose so a jump (fit, recall a saved view, step back) preserves
  // spatial orientation instead of teleporting. The point that ends up centred (cEnd) is driven along a
  // STRAIGHT LINE in SCREEN space from where it sits now to the viewport centre, while zoom eases in
  // log space. That straight-screen path is the key: a naive lerp of the focal point in PAGE space,
  // with zoom changing underneath it, makes a peripheral target drift and only snap to centre at the
  // very end (its screen distance scales as (1-k)·z(t), and z grows as you zoom in) — the "curved,
  // centres late" feel. Interpolating the centred point's screen position instead sends it directly to
  // the middle on schedule. Endpoints are exact by construction (k=0 → current pose, k=1 → target).
  // Any manual pan/zoom cancels an in-flight tween (cancelFly in onWheel / pointerdown). Falls back to
  // an instant set when animation can't run (no rAF — Node tests — or the viewport size isn't known).
  private flyRaf: number | null = null;
  flyTo(target: CameraState, opts: { animate?: boolean; durationMs?: number } = {}): void {
    this.cancelFly();
    this.dropPendingWheel(); // a stale frame's wheel deltas must not land on top of the flight
    const animate = opts.animate ?? true;
    if (!animate || typeof requestAnimationFrame !== "function" || this.viewportW <= 0 || this.viewportH <= 0) {
      this.camera.set(target);
      return;
    }
    const dur = Math.max(1, opts.durationMs ?? 300);
    const vc: Vec = { x: this.viewportW / 2, y: this.viewportH / 2 };
    const start = this.camera.state;
    const cEnd = screenToPage(target, vc); // the page point that ends up centred
    const s0 = pageToScreen(start, cEnd); // where that point sits on screen right now
    const zStart = start.z;
    const zEnd = target.z;
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); // easeInOutQuad
    let startTs: number | null = null;
    const tick = (ts: number): void => {
      if (startTs == null) startTs = ts;
      const t = Math.min(1, (ts - startTs) / dur);
      if (t >= 1) {
        this.flyRaf = null;
        this.camera.set(target); // snap to the exact endpoint (avoids log/round drift)
        return;
      }
      const k = ease(t);
      const z = Math.exp(lerp(Math.log(zStart), Math.log(zEnd), k));
      // cEnd should appear at this screen point on this frame; solve the offset that puts it there.
      const sx = lerp(s0.x, vc.x, k);
      const sy = lerp(s0.y, vc.y, k);
      this.camera.set({ x: sx - cEnd.x * z, y: sy - cEnd.y * z, z });
      this.flyRaf = requestAnimationFrame(tick);
    };
    this.flyRaf = requestAnimationFrame(tick);
  }
  /** Stop an in-flight flyTo (a manual pan/zoom taking over, or a new flight). Idempotent. */
  cancelFly(): void {
    if (this.flyRaf != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.flyRaf);
    this.flyRaf = null;
  }

  // The pan velocity (screen px/frame) implied by the pointer's position: zero unless it sits within
  // EDGE_INSET of an edge, then ramped linearly toward the edge up to MAX_EDGE_SPEED.
  private edgeVelocity(p: Vec): Vec {
    const axis = (v: number, size: number): number => {
      if (v < EDGE_INSET) return -((EDGE_INSET - v) / EDGE_INSET) * MAX_EDGE_SPEED;
      if (v > size - EDGE_INSET) return ((v - (size - EDGE_INSET)) / EDGE_INSET) * MAX_EDGE_SPEED;
      return 0;
    };
    return { x: axis(p.x, this.viewportW), y: axis(p.y, this.viewportH) };
  }

  private edgeScrollEnabled(): boolean {
    return (
      this.pointerActive &&
      this.currentTool === "select" && // only object drags / marquee scroll; the hand tool pans itself
      this.viewportW > 0 &&
      this.viewportH > 0 &&
      typeof requestAnimationFrame === "function"
    );
  }

  // Start the rAF loop if the pointer is in an edge band and a select drag is live; otherwise stop it.
  private updateEdgeScroll(): void {
    if (!this.edgeScrollEnabled() || !this.lastPointer) return this.stopEdgeScroll();
    const v = this.edgeVelocity(this.lastPointer.point);
    if (v.x === 0 && v.y === 0) return this.stopEdgeScroll();
    if (this.edgeRaf == null) this.edgeRaf = requestAnimationFrame(this.edgeTick);
  }

  // The time-based ease-in factor (RAMP_FLOOR → 1) for a scroll run whose first frame landed at
  // `edgeScrollStartTs`. rAF hands each frame a monotonic timestamp, so we drive the ramp off that with
  // no extra clock. The first frame of a run (start unset) is pinned to the floor.
  private edgeRamp(ts: number): number {
    if (this.edgeScrollStartTs == null) {
      this.edgeScrollStartTs = ts;
      return RAMP_FLOOR;
    }
    const t = Math.min(1, (ts - this.edgeScrollStartTs) / RAMP_MS);
    return RAMP_FLOOR + (1 - RAMP_FLOOR) * t;
  }

  // One auto-scroll frame: pan the camera toward the edge, then replay the last pointer move so the
  // active tool re-projects against the new camera (the drag's grab anchor carries nodes along; a
  // marquee grows into the revealed region). A positive velocity means "reveal content past this
  // edge", which is a NEGATIVE camera offset delta — hence panBy(-v). The depth-implied velocity is
  // scaled by the time-based ease-in so a freshly-entered band creeps rather than lunges.
  private edgeTick = (ts: number): void => {
    this.edgeRaf = null;
    if (!this.edgeScrollEnabled() || !this.lastPointer) return;
    const v = this.edgeVelocity(this.lastPointer.point);
    if (v.x === 0 && v.y === 0) return;
    const ramp = this.edgeRamp(ts);
    this.camera.panBy(-v.x * ramp, -v.y * ramp);
    this.active.onPointerMove?.(this.lastPointer);
    this.edgeRaf = requestAnimationFrame(this.edgeTick);
  };

  private stopEdgeScroll(): void {
    if (this.edgeRaf != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = null;
    this.edgeScrollStartTs = null; // next run eases in from rest
  }

  // ctrl/⌘ + wheel = zoom about the pointer; plain wheel = two-finger pan (trackpad scroll deltas).
  //
  // COALESCED to one camera write per animation frame: unlike pointermove, wheel events are NOT
  // vsync-aligned by the browser — a trackpad/precision wheel can deliver several per frame, and each
  // camera.set fires every subscriber synchronously (a full render pass). So a wheel event only
  // ACCUMULATES (pan deltas sum; zoom factors multiply, anchored at the latest pointer position — the
  // pointer moves sub-pixel within one frame, so folding the anchors is invisible), and one rAF applies
  // the lot. Without rAF (the Node tests) it applies inline, so synchronous dispatch→assert still holds.
  private wheelRaf: number | null = null;
  private wheelPanX = 0;
  private wheelPanY = 0;
  private wheelZoom = 1;
  private wheelZoomAnchor: Vec | null = null;

  private onWheel(e: Extract<InputEvent, { type: "wheel" }>): void {
    this.cancelFly(); // a manual zoom/pan takes over any in-flight fly-to
    if (e.ctrlKey || e.metaKey) {
      this.wheelZoom *= Math.exp((-e.deltaY / 100) * this.zoomSpeed);
      this.wheelZoomAnchor = e.point;
    } else {
      this.wheelPanX -= e.deltaX;
      this.wheelPanY -= e.deltaY;
    }
    if (typeof requestAnimationFrame !== "function") return this.flushWheel();
    if (this.wheelRaf == null) this.wheelRaf = requestAnimationFrame(() => this.flushWheel());
  }

  private flushWheel(): void {
    this.wheelRaf = null;
    if (this.wheelZoom !== 1 && this.wheelZoomAnchor) this.camera.zoomBy(this.wheelZoom, this.wheelZoomAnchor);
    if (this.wheelPanX !== 0 || this.wheelPanY !== 0) this.camera.panBy(this.wheelPanX, this.wheelPanY);
    this.wheelZoom = 1;
    this.wheelZoomAnchor = null;
    this.wheelPanX = 0;
    this.wheelPanY = 0;
  }

  // Discard accumulated-but-unapplied wheel input (a fly-to starting, or teardown) so a stale frame's
  // deltas don't land on top of the new camera motion.
  private dropPendingWheel(): void {
    if (this.wheelRaf != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.wheelRaf);
    this.wheelRaf = null;
    this.wheelZoom = 1;
    this.wheelZoomAnchor = null;
    this.wheelPanX = 0;
    this.wheelPanY = 0;
  }

  dispose(): void {
    this.stopEdgeScroll();
    this.dropPendingWheel();
    this.stop();
    this.active.onExit?.();
  }
}
