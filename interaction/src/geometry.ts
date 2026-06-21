// Geometry primitives — Vec (point/vector) and Box (axis-aligned bounds).
//
// Owned, not borrowed. tldraw has nice Vec/Mat/Box, but (a) they're trivial, (b) copying tldraw
// source pulls its restrictive licence harder than not, and (c) "own the structural architecture"
// is a stated value. Plain data + free functions (no classes) so a Vec/Box is just serializable JSON
// — the same discipline as the records. If a heavier need ever appears (matrices for skew/rotate),
// gl-matrix is the swap, but a notes canvas only needs translate + uniform zoom, handled in camera.ts.

export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const vecAdd = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const vecSub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const vecScale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const vecLen = (a: Vec): number => Math.hypot(a.x, a.y);
export const vecDist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

// A box is page-space x/y/w/h — the exact shape of a LayoutRecord's spatial fields, so a layout
// record IS a box (plus id/nodeId). hit-testing and marquee both speak Box.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const boxContainsPoint = (b: Box, p: Vec): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

// Overlap test (touching edges count as intersecting) — used by marquee selection.
export const boxIntersects = (a: Box, b: Box): boolean =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

// Normalized box from two corners (drag may go up/left, so w/h must stay positive).
export const boxFromPoints = (a: Vec, b: Vec): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
};

export const boxCenter = (b: Box): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// The four resize handles, by compass corner. The renderer draws a grab dot at each; the select tool
// hit-tests a press against them and drives a resize gesture. Free by default — a notes card has no
// intrinsic ratio, and a session card's interior already scrolls, so any box just reveals more — but a
// card type may pin its ratio (type.yaml `aspect`, e.g. the round clock) via resizeBox's `aspect` arg.
export type Corner = "nw" | "ne" | "sw" | "se";

// A box can't be resized below this (page units): small enough to tuck a card aside, large enough to
// stay grabbable and keep its title legible.
export const MIN_SIZE = { w: 80, h: 60 };

// Page-space position of each corner handle.
export const boxCorners = (b: Box): Record<Corner, Vec> => ({
  nw: { x: b.x, y: b.y },
  ne: { x: b.x + b.w, y: b.y },
  sw: { x: b.x, y: b.y + b.h },
  se: { x: b.x + b.w, y: b.y + b.h },
});

// New box after dragging `corner` by a page-space delta. The two edges meeting at the grabbed corner
// move; the opposite two stay pinned, so the corner diagonally across holds still (tldraw-style). w/h
// clamp to `min`; on a left/top edge the clamp holds the pinned edge in place rather than letting the
// box walk past it. Absolute (start + delta) so a frame is idempotent — same discipline as the drag.
//
// `aspect` (w/h) optionally pins the ratio: a card type that reads as a shape, not a rectangle (the
// round clock), keeps that shape under resize. The corner is driven by whichever axis the pointer
// pushed further past the ratio, so it tracks the cursor on the long edge; then w/h re-clamp to `min`
// with the ratio held, so the locked box has a square-ish floor instead of min.w × min.h.
export const resizeBox = (start: Box, corner: Corner, dx: number, dy: number, min = MIN_SIZE, aspect?: number): Box => {
  const east = corner === "ne" || corner === "se";
  const south = corner === "se" || corner === "sw";
  let w = Math.max(min.w, east ? start.w + dx : start.w - dx);
  let h = Math.max(min.h, south ? start.h + dy : start.h - dy);
  if (aspect) {
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    if (w < min.w) { w = min.w; h = w / aspect; }
    if (h < min.h) { h = min.h; w = h * aspect; }
  }
  // Pin the edges that don't meet the grabbed corner: a west grab holds the right edge in place, a
  // north grab holds the bottom — so the diagonally-opposite corner stays put as w/h change.
  const x = east ? start.x : start.x + start.w - w;
  const y = south ? start.y : start.y + start.h - h;
  return { x, y, w, h };
};

// Union of boxes → the selection's bounding box (null for an empty set).
export const boxUnion = (boxes: Box[]): Box | null => {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};
