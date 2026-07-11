// Types for hud-layout.js (plain ESM, runs under node --test). Hand-written so the browser app can import
// it without allowJs. Keep in sync with the exports in hud-layout.js.

/** A HUD card's default placement in the seed spec: a stable id + type, a `top`, ONE horizontal anchor
 *  (left | right | centreX), a size, and optional render-style flags. */
export interface HudCardSpec {
  id: string;
  type: string;
  top: number;
  left?: number;
  right?: number;
  centreX?: boolean;
  w: number;
  h: number;
  frameless?: boolean;
  capToViewport?: boolean;
}

export declare const HUD_MARGIN: number;
export declare const HUD_GAP: number;
export declare const HUD_SNAP: number;
export declare const DEFAULT_HUD: readonly HudCardSpec[];
export declare const HUD_CARD_IDS: readonly string[];

export declare function isHudCard(id: string): boolean;

/** The render-time chrome descriptor (frame style only) for a HUD card, or null for a non-HUD id. */
export declare function hudChromeFor(
  id: string,
): { frameless: boolean; capToViewport: boolean } | null;

/** Resolve a card spec's placement to concrete screen x/y/w/h against a viewport width. */
export declare function resolveHudPosition(
  card: HudCardSpec,
  viewportW: number,
): { x: number; y: number; w: number; h: number };

/** The GROUP fit-to-screen scale for the whole HUD: min(1, (viewportW-margin)/maxX, (viewportH-margin)/maxY)
 *  over the bounding box of `boxes` (all screen cards' stored x/y/w/h). Native (1) when the HUD already fits,
 *  shrinking the group as a unit only on overflow. Empty/degenerate → 1. */
export declare function hudFitScale(
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  viewportW: number,
  viewportH: number,
  margin?: number,
): number;

/** The floor a pin's group scale is clamped to — guards a pathological centre-in-the-margin pin. */
export declare const MIN_HUD_SCALE: number;

/** Placement for a card being PINNED (world → screen) that keeps its on-screen CENTRE fixed as it joins the
 *  HUD group. `existingBoxes` are the OTHER shown screen cards (the new card excluded); (cx,cy) its on-screen
 *  centre now; (w,h) its intended on-screen (stored/unscaled) size. Returns the stored top-left {x,y} to commit
 *  and the resulting group scale `s` the card will render under (== hudFitScale at render — a stable fixed
 *  point, no iteration). */
export declare function pinPlacement(
  existingBoxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  cx: number,
  cy: number,
  w: number,
  h: number,
  viewportW: number,
  viewportH: number,
  margin?: number,
): { x: number; y: number; s: number };
