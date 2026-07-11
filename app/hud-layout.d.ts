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

/** The per-card render scale for a screen card given the reference screen size it was placed on and the live
 *  viewport: min(1, currentW/refW, currentH/refH) — native (1) on a screen at/above its reference, shrinking
 *  only when the viewport is smaller. Absent/degenerate reference → 1. */
export declare function hudCardScale(
  refW: number | undefined,
  refH: number | undefined,
  viewportW: number,
  viewportH: number,
): number;
