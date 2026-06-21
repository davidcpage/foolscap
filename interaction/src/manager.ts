import { Editor, type Subscribable } from "./core.js";
import { Camera } from "./camera.js";
import { Selection } from "./selection.js";
import { BruteForceIndex, syncIndexFromStore, type SpatialIndex } from "./spatial.js";
import { Observable } from "./observable.js";
import type { Box, Vec } from "./geometry.js";
import type { InputEvent, PointerInput } from "./input.js";
import type { InteractionContext, Tool } from "./tools/tool.js";
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
  /** Node under the pointer (renderer hover affordance); updated on every pointer move. */
  readonly hovered = new Observable<string | null>(null);
  /** Per-node resize aspect-ratio lock supplied by the host; see InteractionContext.aspectLock. */
  readonly aspectLock?: (nodeId: string) => number | null;

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
        // hover is tool-independent affordance state, kept fresh on the manager
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
  private onWheel(e: Extract<InputEvent, { type: "wheel" }>): void {
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp((-e.deltaY / 100) * this.zoomSpeed);
      this.camera.zoomBy(factor, e.point);
    } else {
      this.camera.panBy(-e.deltaX, -e.deltaY);
    }
  }

  dispose(): void {
    this.stopEdgeScroll();
    this.stop();
    this.active.onExit?.();
  }
}
