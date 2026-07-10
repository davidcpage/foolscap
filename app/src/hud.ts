// The heads-up display: screen-anchored chrome (usage / sessions / clock / channels) toggled as one group
// with the minimap by the Alt tap. Since the pinned-cards-and-HUD unification (P1) a HUD card is just an
// ordinary anchor:"screen" card: it renders in the ScreenLayer through the SAME unified screen-card frame as
// a user-pinned card (NodeView's ScreenCardFrame), and its position/size is its OWN stored layout data — no
// longer a value derived here at render from a corner switch (the retired hudPlacementFor). The default
// positions live in the seed spec (../hud-layout.js), read by seedHud on board load; this module is the
// TS-facing shim over that data plus the render-time chrome descriptor the frame reads.
//
// A HUD card differs from a free pinned card only in the frame: it is corner chrome — locked (not draggable
// yet; drag/resize is a later phase), toggled as a group, and drawn as the neutral translucent HUD panel
// (optionally frameless, or viewport-height-capped so a long list scrolls). A user-PINNED card (the `p` key)
// is NOT a HUD card, so it stays draggable and always visible, unaffected by the HUD toggle.
import { DEFAULT_HUD, HUD_GAP, hudChromeFor, isHudCard as _isHudCard } from "../hud-layout.js";

export { HUD_GAP };
export const HUD_CARDS: string[] = DEFAULT_HUD.map((c) => c.id);
export function isHudCard(id: string): boolean {
  return _isHudCard(id);
}

// How the unified screen frame should present a HUD card. Frame STYLE only — the card's position and size
// come from its stored layout record now (seeded from hud-layout.js), so there is no placement here anymore.
// `frameless` paints the card on transparent ground (the clock, a bare face); `capToViewport` caps the frame
// height to the viewport so a long interior list scrolls inside it instead of overflowing the bottom.
export type HudChrome = { frameless: boolean; capToViewport: boolean };
export function hudChrome(id: string): HudChrome | null {
  return hudChromeFor(id);
}
