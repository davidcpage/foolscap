import type { Editor } from "../core.js";
import type { Camera } from "../camera.js";
import type { Selection } from "../selection.js";
import type { SpatialIndex } from "../spatial.js";
import type { Observable } from "../observable.js";
import type { Box, Vec } from "../geometry.js";
import type { KeyInput, PointerInput, WheelInput } from "../input.js";

/**
 * The live connect-drag preview (alt-drag from one card toward another to wire them). PAGE space; a
 * renderer draws a connector from the source node's centre to `to`, solid-ish once `toNode` names a
 * valid drop target. The engine carries the gesture and the geometry; what edge (if any) the drop
 * makes is the host's call (InteractionContext.connect) — the engine never learns edge semantics.
 */
export interface ConnectDraw {
  /** Source node id the drag began on. */
  from: string;
  /** Current pointer position in page space (the loose end of the preview). */
  to: Vec;
  /** Node currently under the pointer if it's a legal drop target (≠ from, connectable), else null. */
  toNode: string | null;
}

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
  /**
   * Live connect-drag preview (null when not connecting). The select tool sets it during an alt-drag so
   * a renderer can draw the in-flight connector; like `marquee`, it's session-tier channel-1 chrome.
   */
  readonly connectDraw: Observable<ConnectDraw | null>;
  /**
   * Optional: may a connect-drag START on this node? Lets the host restrict wiring to the cards it has
   * a relationship model for (e.g. session↔session attention-edges) without the engine learning card
   * types — same shape as aspectLock. Absent ⇒ any node is connectable.
   */
  readonly connectable?: (nodeId: string) => boolean;
  /**
   * Optional: the user completed a connect-drag from `from` to `to` (two distinct nodes). The host
   * decides what edge to create (or to ignore it) — the engine carries the gesture, not the meaning.
   */
  readonly connect?: (from: string, to: string) => void;
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
