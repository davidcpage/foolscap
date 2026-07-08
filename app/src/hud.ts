// The heads-up display: chrome pinned to the top-LEFT viewport corner and toggled as one group with
// the minimap (which stays top-RIGHT) by the Alt tap. A HUD card is an ordinary anchor:"screen" card (so
// it keeps its card-type render and lives in the ScreenLayer like any floating card) but it is corner-
// LOCKED, not free-floating: its screen position is DERIVED from the top-left corner and the stack order,
// so it tracks a window resize for free (CSS top/left on the full-viewport .screen-layer) and can't be
// dragged. The set is fixed and known — the usage + clock cards; a user-PINNED floating card (the `p` key)
// is NOT a HUD card, so it stays draggable and always visible, unaffected by the HUD toggle.

// The ordered HUD stack: first entry sits at the top-left corner, each next below the one before. The
// usage card leads (the primary read); the clock stacks under it.
export const HUD_CARDS = ["node:usage", "node:clock"];

export function isHudCard(id: string): boolean {
  return HUD_CARDS.includes(id);
}

// Corner geometry. The stack hugs the top-left corner (the minimap owns the top-right), so it starts at
// the top with no minimap to clear. Kept here rather than measured so the layout is deterministic without
// a DOM read.
export const HUD_TOP = 16; // matches .minimap-hud top, so both corners align vertically
export const HUD_LEFT = 16; // mirror of .minimap-hud right on the opposite corner
export const HUD_GAP = 12; // vertical gap between each stacked card

// The top offset (viewport px) of the Nth HUD card, given the heights of the cards stacked above it.
// heightsAbove is in stack order; the running sum places each card below its predecessors from the corner.
export function hudTopFor(heightsAbove: number[]): number {
  let top = HUD_TOP;
  for (const h of heightsAbove) top += h + HUD_GAP;
  return top;
}
