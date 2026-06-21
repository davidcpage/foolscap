import { layoutId, nodeId, NOTE_COLORS, type Gesture, type Id, type LayoutRecord, type NodeRecord } from "../core.js";
import { boxFromPoints, vecDist, type Box, type Vec } from "../geometry.js";
import type { PointerInput } from "../input.js";
import { DRAG_THRESHOLD, type InteractionContext, type Tool } from "./tool.js";

// A create-by-drag tool: press-drag-release stamps a new SHAPE node sized to the dragged box; a plain
// click stamps a default-sized one. The whole point of this tool is how LITTLE it needs: a rect/ellipse
// is an ordinary NodeRecord (type "rect" | "ellipse") + LayoutRecord pair, still an axis-aligned box, so
// once created it drags, selects, marquees, stacks, persists and undoes through the EXACT paths a note
// does — the spatial index, hit-test and drag mechanics need zero changes. The only new surface is
// creation, and even that rides ONE gesture (the same coalescing the drag uses): put the pair on the
// first frame, rewrite its layout each move, end() → one diff → one IntentEvent → one undo step (the add
// at final size). This is the cheap half of the shapes/freehand split; freehand is the half that would
// actually push on the box-shaped assumptions baked into the layer.
//
// Internal sub-states mirror select-tool's idle → pointing → (threshold) → drawing, so the click-vs-drag
// distinction is zoom-independent (the threshold is measured in SCREEN px) and a plain click never leaves
// a zero-size sliver.
type State =
  | { kind: "idle" }
  | { kind: "pointing"; originScreen: Vec; originPage: Vec }
  | { kind: "drawing"; id: Id<"node">; originPage: Vec; gesture: Gesture; color: string };

// Default footprint (page units) for a click with no drag — a shape you can immediately see and grab.
const DEFAULT_W = 140;
const DEFAULT_H = 100;
// Below this (page units) in BOTH dims at release, treat the gesture as a click and stamp the default
// size instead of leaving a sliver that's awkward to select.
const MIN_DRAW = 8;

export class ShapeTool implements Tool {
  readonly name: string;
  private state: State = { kind: "idle" };
  private colorTick = 0; // cycles the palette per shape created, like addNode's pickColor

  // `kind` doubles as the tool name AND the NodeRecord.type the renderer switches on ("rect"|"ellipse").
  constructor(
    private readonly ctx: InteractionContext,
    private readonly kind: "rect" | "ellipse",
  ) {
    this.name = kind;
  }

  onPointerDown(e: PointerInput): void {
    if (e.button !== 0) return; // primary only; middle/right keep their manager-level meanings (pan/menu)
    this.abortInFlight();
    this.state = { kind: "pointing", originScreen: e.point, originPage: this.ctx.camera.screenToPage(e.point) };
  }

  onPointerMove(e: PointerInput): void {
    const s = this.state;
    if (s.kind === "pointing") {
      if (vecDist(e.point, s.originScreen) < DRAG_THRESHOLD) return; // still a click
      this.startDraw(s.originPage); // threshold crossed → begin the live shape
      this.applyDraw(e.point); // include the move that crossed it
    } else if (s.kind === "drawing") {
      this.applyDraw(e.point);
    }
  }

  onPointerUp(e: PointerInput): void {
    const s = this.state;
    if (s.kind === "drawing") {
      // Snap a too-small drag up to the default box (centered on where it started) so a near-click still
      // yields a usable shape, then commit the single gesture as the add at its final size.
      const box = boxFromPoints(s.originPage, this.ctx.camera.screenToPage(e.point));
      const final = box.w < MIN_DRAW && box.h < MIN_DRAW ? centeredDefault(s.originPage) : box;
      this.writeLayout(s.id, final, s.gesture);
      // Carry the full box + colour so the recorded "addShape" intent is replayable through
      // editor.commit (the addShape handler reconstructs the same pair) — not just undoable.
      s.gesture.end({ id: s.id, type: this.kind, color: s.color, x: final.x, y: final.y, w: final.w, h: final.h });
      this.finish(s.id);
    } else if (s.kind === "pointing") {
      // Plain click → stamp a default-sized shape centered on the click as one atomic add command.
      this.finish(this.stampDefault(s.originPage));
    }
    this.state = { kind: "idle" };
  }

  onCancel(): void {
    this.abortInFlight(); // Escape mid-draw reverts the half-drawn shape (gesture.cancel inverts the add)
  }
  // Switching tools mid-draw (a shortcut) must not orphan the open gesture buffer.
  onExit(): void {
    this.abortInFlight();
  }

  // ── mechanics ──────────────────────────────────────────────────────────────────────
  // Open ONE gesture and put the node+layout pair at zero size on the first frame; the new atom + ids
  // update fire the node query live (channel 1), so the shape appears and tracks each resize frame
  // exactly like a dragged note. The spatial index (channel 2) stays silent until end() — correct: you
  // don't hit-test the shape you're still drawing.
  private startDraw(originPage: Vec): void {
    const id = nodeId();
    const z = this.ctx.index.topZ() + 1;
    const color = this.nextColor();
    const gesture = this.ctx.editor.beginGesture("addShape", "human");
    gesture.update(() => {
      this.ctx.editor.store.put([
        { typeName: "node", id, type: this.kind, title: "", text: "", color } as NodeRecord,
        { typeName: "layout", id: layoutId(id), nodeId: id, x: originPage.x, y: originPage.y, w: 0, h: 0, z } as LayoutRecord,
      ]);
    });
    this.state = { kind: "drawing", id, originPage, gesture, color };
  }

  private applyDraw(pointScreen: Vec): void {
    if (this.state.kind !== "drawing") return;
    const { id, originPage, gesture } = this.state;
    // Normalize through boxFromPoints so dragging up/left keeps w/h positive (the box flips around origin).
    this.writeLayout(id, boxFromPoints(originPage, this.ctx.camera.screenToPage(pointScreen)), gesture);
  }

  private writeLayout(id: Id<"node">, box: Box, gesture: Gesture): void {
    gesture.update(() => {
      this.ctx.editor.store.update<LayoutRecord>(layoutId(id), { x: box.x, y: box.y, w: box.w, h: box.h });
    });
  }

  // The click path: a single addNode command through the Editor (the "one mutation API" surface), so it's
  // one undoable event just like the drag path, no gesture needed.
  private stampDefault(originPage: Vec): Id<"node"> {
    const id = nodeId();
    const box = centeredDefault(originPage);
    this.ctx.editor.commit({
      type: "addNode",
      actor: "human",
      payload: { id, type: this.kind, color: this.nextColor(), x: box.x, y: box.y, w: box.w, h: box.h },
    });
    return id;
  }

  // Select what you just drew and drop back to select (tldraw-style "draw one, then manipulate it").
  private finish(id: Id<"node">): void {
    this.ctx.selection.set([id]);
    this.ctx.setTool("select");
  }

  private nextColor(): string {
    return NOTE_COLORS[this.colorTick++ % NOTE_COLORS.length]!;
  }

  private abortInFlight(): void {
    if (this.state.kind === "drawing") this.state.gesture.cancel(); // no-op if already ended
    this.state = { kind: "idle" };
  }
}

const centeredDefault = (p: Vec): Box => ({ x: p.x - DEFAULT_W / 2, y: p.y - DEFAULT_H / 2, w: DEFAULT_W, h: DEFAULT_H });
