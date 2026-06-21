import type { Editor } from "../core.js";
import type { Camera } from "../camera.js";
import type { Selection } from "../selection.js";
import type { SpatialIndex } from "../spatial.js";
import type { Observable } from "../observable.js";
import type { Box } from "../geometry.js";
import type { KeyInput, PointerInput, WheelInput } from "../input.js";

// What a tool is given to do its job. This is the seam between the manager (input routing + shared
// session state) and the individual tools (the actual gesture grammars). A tool reads hit results
// from `index`, mutates `selection`/`camera`, and drives `editor` gestures — it never touches the
// store or signals directly, so the same tool works under any renderer.
export interface InteractionContext {
  readonly editor: Editor;
  readonly camera: Camera;
  readonly selection: Selection;
  readonly index: SpatialIndex;
  /** Live marquee rectangle in PAGE space (a renderer draws it); null when not marquee-selecting. */
  readonly marquee: Observable<Box | null>;
  /**
   * Optional per-node aspect-ratio lock (w/h) for resize. When wired and it returns a ratio for the
   * node being resized, the resize keeps that ratio (the round clock stays square); null/absent = free
   * resize. Lets a card type pin its shape without the engine learning card types — the app supplies
   * the resolver from its template registry, the select tool just asks.
   */
  readonly aspectLock?: (nodeId: string) => number | null;
  /** Switch the active tool by name (e.g. a tool that finishes returns to "select"). */
  setTool(name: string): void;
}

// A tool is a state machine over the pointer/key lifecycle. Every hook is optional; the manager calls
// whichever exist. This mirrors tldraw's tool state-chart as a *pattern* (referenced, not copied):
// pointer down → move (with a drag threshold) → up, plus cancel (Escape). Internal sub-states live
// inside each tool as a private discriminated union (see select-tool.ts).
export interface Tool {
  readonly name: string;
  onEnter?(): void;
  onExit?(): void;
  onPointerDown?(e: PointerInput): void;
  onPointerMove?(e: PointerInput): void;
  onPointerUp?(e: PointerInput): void;
  onWheel?(e: WheelInput): void;
  onKeyDown?(e: KeyInput): void;
  /** Escape / interruption: abort any in-flight gesture and return to a clean state. */
  onCancel?(): void;
}

// Pointer movement (screen px) beyond this starts a drag; below it, a down→up pair is a click.
export const DRAG_THRESHOLD = 4;

// Screen-px slop added around a node's bounds when hit-testing a point, so clicks just outside an
// edge still land (tldraw's hitTestMargin). Divided by the live zoom before it reaches the index so
// it stays constant on screen. Keep small — too large and adjacent notes start fighting for clicks.
export const HIT_MARGIN = 3;

// Screen-px radius around a resize handle's corner within which a press grabs that handle. Divided by
// the live zoom so the grab zone stays constant on screen, like HIT_MARGIN. Roughly half the rendered
// handle plus slop, so the visible dot and its hot zone line up.
export const HANDLE_HIT = 8;
