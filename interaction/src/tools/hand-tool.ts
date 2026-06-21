import type { Vec } from "../geometry.js";
import type { PointerInput } from "../input.js";
import type { InteractionContext, Tool } from "./tool.js";

// The hand/pan tool — the minimal second tool that proves the tool seam is real (it touches the
// camera, never the store/selection). Drag pans the camera by the incremental screen delta; `last`
// advances each frame so panning is relative and never accumulates against a stale origin.
export class HandTool implements Tool {
  readonly name = "hand";
  private last: Vec | null = null;
  constructor(private readonly ctx: InteractionContext) {}

  onPointerDown(e: PointerInput): void {
    this.last = e.point;
  }

  onPointerMove(e: PointerInput): void {
    if (!this.last) return;
    this.ctx.camera.panBy(e.point.x - this.last.x, e.point.y - this.last.y);
    this.last = e.point;
  }

  onPointerUp(): void {
    this.last = null;
  }
  onCancel(): void {
    this.last = null;
  }
}
