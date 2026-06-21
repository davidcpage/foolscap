// @canvas/interaction — the interaction layer (open follow-up #2).
//
// Sits between raw input and @canvas/core's Editor: camera (screen↔page), spatial index / hit-test,
// selection, drag mechanics, and a tool state machine. It is a *client* of the core's three channels
// — it drives GESTURES/COMMANDS in (channel 3) and reads reactive HANDLES out (channel 1); it keeps
// its spatial index in sync off the DIFF stream (channel 2). DOM-agnostic except input.ts's bindDom.
//
// Design stance (per the design docs): the canvas IS the product, so the interaction logic is owned;
// OSS is borrowed only at the primitive level behind swappable interfaces — SpatialIndex has a
// brute-force default with rbush as the documented drop-in. The signals library is never imported
// here: session-tier state uses our own Observable, proving Subscribable<T> is library-agnostic.

export { Observable } from "./observable.js";

export type { Vec, Box, Corner } from "./geometry.js";
export {
  vec, vecAdd, vecSub, vecScale, vecLen, vecDist,
  boxContainsPoint, boxIntersects, boxFromPoints, boxCenter, boxUnion,
  boxCorners, resizeBox, MIN_SIZE,
} from "./geometry.js";

export type { CameraState } from "./camera.js";
export { Camera, pageToScreen, screenToPage } from "./camera.js";

export type { SpatialIndex } from "./spatial.js";
export { BruteForceIndex, syncIndexFromStore } from "./spatial.js";

export { Selection, selectionBounds } from "./selection.js";

export type { InputEvent, PointerInput, WheelInput, KeyInput, ModifierState } from "./input.js";
export { bindDom } from "./input.js";

export type { Tool, InteractionContext } from "./tools/tool.js";
export { DRAG_THRESHOLD } from "./tools/tool.js";
export { SelectTool } from "./tools/select-tool.js";
export { HandTool } from "./tools/hand-tool.js";
export { ShapeTool } from "./tools/shape-tool.js";

export type { InteractionOptions } from "./manager.js";
export { InteractionManager } from "./manager.js";
