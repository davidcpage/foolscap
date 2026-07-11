// The default HUD layout — the initial screen-anchored chrome cards and where each sits by default. This is
// the SEED SPEC and the single source of truth for "what the HUD is": the singleton cards that make up the
// heads-up display (usage / sessions / clock / channels), their default screen positions, sizes, and frame
// style. seedHud (App.tsx) reads it to create and normalize each card's STORED screen x/y/w/h on board load,
// so HUD positions are real, persisted layout data now — not values derived at render from a corner switch
// (the retired hud.ts hudPlacementFor). One model with user-pinned cards: both are ordinary anchor:"screen"
// cards whose position is their own stored data (records.ts §63), drawn through the same screen-card frame.
//
// Placement is expressed in the same corner vocabulary the old switch used — a `top` plus ONE horizontal
// anchor (left | right | centreX) and a size — and resolveHudPosition() turns it into concrete screen
// x/y/w/h against a viewport width (the right/centre cards depend on it; the left column doesn't). The
// `frameless` and `capToViewport` flags are RENDER hints the unified frame reads (hud.ts hudChrome), not
// stored layout fields. Plain ESM at the app root (the thread-state.js / work-intent.js convention) so it
// runs under node --test and the browser app imports the SAME data the test asserts against.

export const HUD_MARGIN = 16; // viewport inset shared by the corner cards (mirrors .minimap-hud top/right)
export const HUD_GAP = 12; // vertical gap between stacked chrome

// The fine grid step drag/resize snap to while a HUD card is being edited (Alt-held edit mode). Deliberately
// FINER than the 24px visual dot grid (CanvasView BASE) so the human gets pixel-level alignment control with
// no granularity UI — an 8px lattice divides the 24px grid evenly (every third snap lands on a grid line) and
// divides HUD_MARGIN (16) and the column width (240), so the default cards already sit on the lattice.
export const HUD_SNAP = 8;

// Corner geometry the stacked cards derive from — kept here, deterministic, not DOM-measured. The minimap
// is now an ORDINARY HUD card (id node:minimap) whose size IS this data: MINIMAP_WIDTH/HEIGHT are its own
// stored w/h, and the right column stacks flush beneath it (channels one gap down, File Tree below that),
// both columns matching its width. No longer mirrored into `.minimap-hud` in style.css — that shell is gone;
// this is the single source of the minimap's geometry.
const MINIMAP_WIDTH = 240;
const MINIMAP_HEIGHT = 180;
const COLUMN_WIDTH = MINIMAP_WIDTH; // left + right columns both match the minimap width
const USAGE_HEIGHT = 300; // left column: the usage card on top …
const LIST_HEIGHT = 300; // … the sessions/channels/files lists below it, compact; their interiors scroll
const CLOCK_SIZE = 72; // the top-centre clock renders compact and frameless

// The HUD card set + default placement, in seed/paint order. `id` is the stable singleton id (so seeding is
// idempotent across reloads + StrictMode); `type` is the card type its seeder mints. `left`/`right`/`centreX`
// is the one horizontal anchor resolveHudPosition resolves against the viewport. Two columns: the LEFT stacks
// usage → sessions → File Tree; the RIGHT stacks minimap → Threads; the clock floats top-centre.
export const DEFAULT_HUD = [
  { id: "node:usage", type: "usage", top: HUD_MARGIN, left: HUD_MARGIN, w: COLUMN_WIDTH, h: USAGE_HEIGHT },
  {
    id: "node:sessions",
    type: "sessions",
    top: HUD_MARGIN + USAGE_HEIGHT + HUD_GAP, // flush beneath the usage card
    left: HUD_MARGIN,
    w: COLUMN_WIDTH,
    h: LIST_HEIGHT,
    capToViewport: true,
  },
  {
    // The File Tree singleton (the "roots" sentinel directory card): stable id node:roots: (root=roots,
    // path="" — the same deterministic id a File-tree drag-out mints), so seeding never duplicates it. Left
    // column, flush beneath the sessions browser; its interior tree scrolls inside a viewport-capped frame.
    id: "node:roots:",
    type: "directory",
    top: HUD_MARGIN + USAGE_HEIGHT + HUD_GAP + LIST_HEIGHT + HUD_GAP, // beneath the sessions card
    left: HUD_MARGIN,
    w: COLUMN_WIDTH,
    h: LIST_HEIGHT,
    capToViewport: true,
  },
  { id: "node:clock", type: "clock", top: HUD_MARGIN, centreX: true, w: CLOCK_SIZE, h: CLOCK_SIZE, frameless: true },
  // The minimap — an ordinary HUD card now (was separate DOM chrome). Top-right, its own stored geometry.
  { id: "node:minimap", type: "minimap", top: HUD_MARGIN, right: HUD_MARGIN, w: MINIMAP_WIDTH, h: MINIMAP_HEIGHT },
  {
    id: "node:channels",
    type: "channels",
    top: HUD_MARGIN + MINIMAP_HEIGHT + HUD_GAP, // flush beneath the minimap, top-right
    right: HUD_MARGIN,
    w: COLUMN_WIDTH,
    h: LIST_HEIGHT,
    capToViewport: true,
  },
];

const BY_ID = new Map(DEFAULT_HUD.map((c) => [c.id, c]));

/** The stable singleton ids of the default HUD cards, in seed/paint order. */
export const HUD_CARD_IDS = DEFAULT_HUD.map((c) => c.id);

/** Is this node id one of the HUD chrome cards? */
export function isHudCard(id) {
  return BY_ID.has(id);
}

// The render-time chrome descriptor for a HUD card — how the unified screen frame presents it. Frame STYLE
// only: position/size come from the card's stored layout record now. `frameless` paints on transparent
// ground (the clock); `capToViewport` caps the frame height so a long interior list scrolls inside the
// viewport instead of overflowing the bottom. Returns null for a non-HUD id (so a caller can filter).
export function hudChromeFor(id) {
  const c = BY_ID.get(id);
  if (!c) return null;
  return { frameless: !!c.frameless, capToViewport: !!c.capToViewport };
}

// Resolve a card's default placement to concrete screen x/y/w/h for a viewport width: left column → fixed
// x; centreX → centred at this width; right → offset in from the right edge. y/w/h are as specified. Rounded
// to whole pixels, matching the integer layout coordinates used everywhere else. The two viewport-relative
// cards (clock centre, channels right) are resolved ONCE against the current viewport at seed time and then
// stored as concrete data — they no longer reflow live on resize the way the CSS-anchored switch did; that
// (and drag/resize) is a later phase.
export function resolveHudPosition(card, viewportW) {
  let x;
  if (card.centreX) x = Math.round(viewportW / 2 - card.w / 2);
  else if (card.right != null) x = Math.round(viewportW - card.right - card.w);
  else x = card.left ?? 0;
  return { x, y: card.top, w: card.w, h: card.h };
}

// GROUP fit-to-screen scale. HUD card positions are frozen at seed-time viewport width and don't reflow, so a
// layout seeded on a wide screen falls off the right/bottom edge of a narrower one — and scaling each card
// around its OWN corner (the retired per-card model) can't fix that, because scaling in place never moves a
// card's position. So the whole HUD renders inside ONE wrapper under `transform: scale(s)` with
// `transform-origin: top left` (CanvasView), and `s` shrinks the group as a unit — every card's POSITION and
// SIZE together — until the entire HUD lands on-screen. All screen cards go through this one scale: the HUD
// singletons AND the user-pinned (`free`) cards, so a pinned card stays mutually consistent with the HUD
// cards beside it (they scale by the same factor).
//
// s = min(1, availW/maxX, availH/maxY) over the group's bounding box (maxX/maxY = the far edge of the
// furthest card) against the viewport less a margin: the binding (smaller) axis ratio, capped at 1 so the HUD
// renders NATIVE (scale 1) whenever it already fits — it only ever shrinks, and only on overflow. Empty group
// or a degenerate box/viewport → 1 (native). `boxes` are the cards' stored (unscaled) screen x/y/w/h.
export function hudFitScale(boxes, viewportW, viewportH, margin = HUD_MARGIN) {
  if (!boxes || boxes.length === 0) return 1;
  let maxX = 0;
  let maxY = 0;
  for (const b of boxes) {
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  const availW = viewportW - margin;
  const availH = viewportH - margin;
  if (maxX <= 0 || maxY <= 0 || availW <= 0 || availH <= 0) return 1;
  return Math.min(1, availW / maxX, availH / maxY);
}

// The smallest scale a pin will ever collapse the group to — a floor so a pathological pin (a card whose
// on-screen centre sits IN the margin band, cx > availW) can't drive the scale to zero or negative and mint a
// NaN/huge layout. It's a guard, not a target: the non-degenerate placement below never reaches it.
export const MIN_HUD_SCALE = 0.05;

// Placement for a card being PINNED (world → screen), keeping its on-screen CENTRE fixed as it joins the HUD
// group. The group renders under `transform: scale(s)` from (0,0) (CanvasView `.hud-fit`), so a stored box
// (x,y,w,h) paints at (x·s, y·s, w·s, h·s). Adding the card can itself change s — it may extend the group
// bounding box — so placing against the PRE-pin scale still lands the centre off; we solve for the scale the
// card will ACTUALLY render under and place against that. The fixed point has a closed form: solved as a
// fixed point the new card's own fit bound is 2·(avail − centre)/size on each axis (its scaled half-body must
// clear the margin), and the existing-bbox term is just hudFitScale over the other cards — both constants — so
//   s = min( hudFitScale(existing…) , 2(availW−cx)/w , 2(availH−cy)/h )   (clamped to (0,1])
// and then x = cx/s − w/2, y = cy/s − h/2 lands the centre back on (cx,cy). Stable — no iteration, no
// oscillation: s equals the scale hudFitScale returns at render for the resulting box set (fixed-point
// equality). In the common case (a card pinned in the central area) the new-card term exceeds the existing
// scale, so s == the existing scale and NOTHING else rescales; the group only shrinks further when the centre
// sits near enough to an edge that keeping it fixed geometrically forces the bbox out.
//   existingBoxes — the OTHER shown screen cards (HUD singletons + already-pinned); the new card is excluded.
//   (cx,cy)       — the card's on-screen centre now (screen px), preserved across the pin.
//   (w,h)         — the card's intended on-screen (stored/unscaled) size.
// Returns { x, y, s }: the stored top-left to commit and the resulting group scale (for the caller/tests).
export function pinPlacement(existingBoxes, cx, cy, w, h, viewportW, viewportH, margin = HUD_MARGIN) {
  const sExisting = hudFitScale(existingBoxes, viewportW, viewportH, margin);
  const availW = viewportW - margin;
  const availH = viewportH - margin;
  const cardW = w > 0 ? (2 * (availW - cx)) / w : Infinity; // the card's own right-edge fit bound …
  const cardH = h > 0 ? (2 * (availH - cy)) / h : Infinity; // … and bottom-edge bound
  const s = Math.min(1, Math.max(MIN_HUD_SCALE, Math.min(sExisting, cardW, cardH)));
  return { x: cx / s - w / 2, y: cy / s - h / 2, s };
}
