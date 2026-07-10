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

// Viewport-FIT for the whole HUD group. HUD positions are concrete screen coordinates resolved ONCE against
// the seed-time viewport (resolveHudPosition) and then frozen in the store — and, since P2, movable by hand —
// so they don't reflow on resize: a layout seeded on a wide/tall screen pushes the right column off the right
// edge and overflows the bottom on a smaller one. Rather than re-resolve (which would clobber a user's drag
// and pollute undo), the render layer keeps the stored positions and shrinks the group as ONE unit to fit.
//
// Given the shown cards' boxes ({x,y,w,h}, top-left origin) and the live viewport, return the uniform scale a
// `transform: scale(s)` with `transform-origin: top left` should apply. It's the largest s ≤ 1 that brings the
// content's right and bottom edges inside the viewport less a `margin` of breathing room — so at the seed
// viewport s is exactly 1 (no scaling, cards untouched), and it only ever shrinks, never enlarges. Scaling
// from the top-left corner pulls the right/bottom columns inward together, keeping every card fully on-screen
// and the columns' relative arrangement intact. Empty/degenerate input → 1 (nothing to fit).
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
