// The heads-up display: chrome anchored to the viewport corners and toggled as one group with the minimap
// (top-RIGHT) by the Alt tap. A HUD card is an ordinary anchor:"screen" card (so it keeps its card-type
// render and lives in the ScreenLayer like any floating card) but it is corner-LOCKED, not free-floating:
// its screen position is DERIVED per card (not a logged x/y), so it tracks a window resize for free (CSS
// on the full-viewport .screen-layer) and can't be dragged. A user-PINNED floating card (the `p` key) is
// NOT a HUD card, so it stays draggable and always visible, unaffected by the HUD toggle.
//
// The three HUD cards no longer share one top-left column (that stack overflowed the viewport). Each now
// has its OWN corner (hudPlacementFor):
//   • usage    — top-LEFT, the primary read.
//   • clock    — top-CENTRE, frameless (a bare face, not a boxed card).
//   • channels — top-RIGHT, directly under the minimap at matching width, a viewport-capped scrolling list
//                (the Threads indicator: unread counts + waiting highlights, click-to-open).
export const HUD_CARDS = ["node:usage", "node:clock", "node:channels"];

export function isHudCard(id: string): boolean {
  return HUD_CARDS.includes(id);
}

// Corner geometry, kept here (not DOM-measured) so the layout is deterministic. The minimap constants MIRROR
// `.minimap-hud` in style.css (top/right/width/height) — change one, change both — so the Threads card can
// sit flush beneath the minimap at matching width.
export const HUD_TOP = 16; // matches .minimap-hud top, so both corners align vertically
export const HUD_LEFT = 16; // mirror of .minimap-hud right on the opposite corner
export const HUD_GAP = 12; // vertical gap between stacked chrome
const MINIMAP_RIGHT = 16; // .minimap-hud right
const MINIMAP_WIDTH = 240; // .minimap-hud width — the Threads card matches it
const MINIMAP_HEIGHT = 180; // .minimap-hud height — the Threads card starts one gap below its bottom edge
const THREADS_TOP = HUD_TOP + MINIMAP_HEIGHT + HUD_GAP; // top of the Threads card, flush under the minimap
const CLOCK_SIZE = 72; // the top-centre clock renders compact (its stored 180×210 would dominate frameless)

// The screen placement of a HUD card: a `top` plus ONE horizontal anchor (left | right | centreX), with
// optional size overrides (the Threads card matches the minimap's width; the clock renders compact) and a
// `frameless` flag (the clock paints as a bare face, no HUD box). `maxHeight` is a CSS length that caps the
// card so a long interior scrolls inside the viewport instead of overflowing the bottom.
export type HudPlacement = {
  top: number;
  left?: number;
  right?: number;
  centreX?: boolean;
  width?: number;
  height?: number;
  maxHeight?: string;
  frameless?: boolean;
};

// The derived placement for each HUD card. Returns null for an id that isn't a known HUD card (so a caller
// can filter). The Threads card's maxHeight leaves a HUD_GAP margin at the viewport bottom; its interior
// (.dir-body) is already a scroll container, so a capped frame height makes a long thread list scroll.
export function hudPlacementFor(id: string): HudPlacement | null {
  switch (id) {
    case "node:usage":
      return { top: HUD_TOP, left: HUD_LEFT };
    case "node:clock":
      return { top: HUD_TOP, centreX: true, width: CLOCK_SIZE, height: CLOCK_SIZE, frameless: true };
    case "node:channels":
      return {
        top: THREADS_TOP,
        right: MINIMAP_RIGHT,
        width: MINIMAP_WIDTH,
        maxHeight: `calc(100vh - ${THREADS_TOP + HUD_GAP}px)`,
      };
    default:
      return null;
  }
}
