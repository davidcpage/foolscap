// The heads-up display: chrome pinned to the top-right viewport corner and toggled as one group with
// the minimap by the Alt tap. A HUD card is an ordinary anchor:"screen" card (so it keeps its card-type
// render and lives in the ScreenLayer like any floating card) but it is corner-LOCKED, not free-floating:
// its screen position is DERIVED from the top-right corner and the stack order below the minimap, so it
// tracks a window resize for free (CSS top/right on the full-viewport .screen-layer) and can't be dragged.
// The set is fixed and known — the usage + clock cards; a user-PINNED floating card (the `p` key) is NOT a
// HUD card, so it stays draggable and always visible, unaffected by the HUD toggle.

// The ordered HUD stack: first entry sits directly below the minimap, each next below the one before.
export const HUD_CARDS = ["node:usage", "node:clock"];

export function isHudCard(id: string): boolean {
  return HUD_CARDS.includes(id);
}

// Corner geometry, mirrored from .minimap-hud in style.css (top/right/height). The stack begins one gap
// below the minimap's bottom edge. Kept here rather than measured so the layout is deterministic without a
// DOM read; if the minimap's CSS box changes, update MINIMAP_H to match.
export const HUD_TOP = 16; // .minimap-hud top
export const HUD_RIGHT = 16; // .minimap-hud right
export const MINIMAP_H = 180; // .minimap-hud height
export const HUD_GAP = 12; // vertical gap between the minimap and each stacked card

// The top offset (viewport px) of the Nth HUD card, given the heights of the cards stacked above it.
// heightsAbove is in stack order; the running sum places each card below the minimap and its predecessors.
export function hudTopFor(heightsAbove: number[]): number {
  let top = HUD_TOP + MINIMAP_H + HUD_GAP;
  for (const h of heightsAbove) top += h + HUD_GAP;
  return top;
}
