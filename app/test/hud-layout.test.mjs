// The default HUD layout (pinned-cards-and-HUD unification, P1): the seed spec that makes HUD positions
// REAL, PERSISTED layout data instead of values derived at render from a corner switch. seedHud (App.tsx)
// reads this same module to seat each chrome card's stored screen x/y/w/h, so the numbers the browser seeds
// are exactly the ones asserted here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HUD,
  HUD_CARD_IDS,
  HUD_MARGIN,
  HUD_GAP,
  HUD_SNAP,
  isHudCard,
  hudChromeFor,
  hudFitScale,
  resolveHudPosition,
} from "../hud-layout.js";

// The default HUD boxes as seeded against a reference width, for the viewport-fit tests below.
function seedBoxes(viewportW) {
  return DEFAULT_HUD.map((c) => resolveHudPosition(c, viewportW));
}

test("the HUD card set is the stable singletons, in seed/paint order", () => {
  // Left column (usage → sessions → File Tree), then the centred clock, then the right column
  // (minimap → Threads). File Tree (the roots sentinel) and the minimap joined the set in P3.
  assert.deepEqual(HUD_CARD_IDS, [
    "node:usage",
    "node:sessions",
    "node:roots:",
    "node:clock",
    "node:minimap",
    "node:channels",
  ]);
  for (const id of HUD_CARD_IDS) assert.ok(isHudCard(id), `${id} is a HUD card`);
  // Stable ids are what make seeding idempotent across reloads + StrictMode.
  assert.equal(isHudCard("node:roles"), false);
  assert.equal(isHudCard("node:usageX"), false);
  // A NON-root directory card (a dragged-out sub-folder) is an ordinary world card, never HUD chrome.
  assert.equal(isHudCard("node:repo:src"), false);
});

test("every card carries a type its seeder mints, and a sound placement", () => {
  for (const c of DEFAULT_HUD) {
    assert.ok(c.type, `${c.id} has a card type`);
    assert.ok(c.w > 0 && c.h > 0, `${c.id} has a positive size`);
    // Exactly ONE horizontal anchor (left | right | centreX) — the corner vocabulary resolveHudPosition reads.
    const anchors = [c.left != null, c.right != null, !!c.centreX].filter(Boolean).length;
    assert.equal(anchors, 1, `${c.id} has exactly one horizontal anchor`);
  }
});

test("chrome descriptor is frame-STYLE only, and null for a non-HUD id", () => {
  // The clock is the only frameless card; the scrolling lists (sessions, Threads, File Tree) are the
  // viewport-capped ones. The minimap takes the plain panel frame — neither frameless nor capped.
  assert.deepEqual(hudChromeFor("node:clock"), { frameless: true, capToViewport: false });
  assert.deepEqual(hudChromeFor("node:usage"), { frameless: false, capToViewport: false });
  assert.deepEqual(hudChromeFor("node:sessions"), { frameless: false, capToViewport: true });
  assert.deepEqual(hudChromeFor("node:channels"), { frameless: false, capToViewport: true });
  assert.deepEqual(hudChromeFor("node:roots:"), { frameless: false, capToViewport: true });
  assert.deepEqual(hudChromeFor("node:minimap"), { frameless: false, capToViewport: false });
  assert.equal(hudChromeFor("node:roles"), null);
});

test("resolveHudPosition: left column is viewport-independent, centre/right track the width", () => {
  const W = 1440;
  const byId = Object.fromEntries(DEFAULT_HUD.map((c) => [c.id, c]));

  // Left column — fixed at the margin, one gap below each other, viewport-independent.
  assert.deepEqual(resolveHudPosition(byId["node:usage"], W), { x: HUD_MARGIN, y: HUD_MARGIN, w: 240, h: 300 });
  const sessions = resolveHudPosition(byId["node:sessions"], W);
  assert.equal(sessions.x, HUD_MARGIN);
  assert.equal(sessions.y, HUD_MARGIN + 300 + HUD_GAP); // flush beneath the usage card

  // File Tree — left column, flush beneath the sessions browser (usage + sessions + a gap each).
  const filetree = resolveHudPosition(byId["node:roots:"], W);
  assert.equal(filetree.x, HUD_MARGIN);
  assert.equal(filetree.y, HUD_MARGIN + 300 + HUD_GAP + 300 + HUD_GAP);

  // Clock — centred at this width.
  const clock = resolveHudPosition(byId["node:clock"], W);
  assert.equal(clock.x, Math.round(W / 2 - clock.w / 2));
  assert.equal(clock.y, HUD_MARGIN);

  // Minimap — top-right, offset in from the right edge.
  const minimap = resolveHudPosition(byId["node:minimap"], W);
  assert.equal(minimap.x, W - HUD_MARGIN - minimap.w);
  assert.equal(minimap.y, HUD_MARGIN);

  // Channels — offset in from the right edge (flush under the minimap).
  const channels = resolveHudPosition(byId["node:channels"], W);
  assert.equal(channels.x, W - HUD_MARGIN - channels.w);
  assert.equal(channels.y, HUD_MARGIN + 180 + HUD_GAP);
});

test("HUD_SNAP is a fine step (P2 edit-mode grid) that the default layout already sits on", () => {
  // Finer than the 24px visual dot grid (CanvasView BASE) so a drag/resize gives pixel-level control, yet a
  // divisor of it (every third snap lands on a grid line) — so 8 is the sweet spot the human validated by feel.
  assert.equal(HUD_SNAP, 8);
  assert.equal(24 % HUD_SNAP, 0, "an even divisor of the 24px visual grid");
  // The shared corner constants land on the lattice, so the seeded default cards start perfectly aligned and a
  // snapped drag keeps them there — dragging one card to another's edge lines them up to the pixel.
  assert.equal(HUD_MARGIN % HUD_SNAP, 0, "the viewport inset is on the lattice");
  for (const c of DEFAULT_HUD) {
    // A snapped drag quantizes x/y to the lattice; a left-anchored card already starts there.
    if (c.left != null) assert.equal(c.left % HUD_SNAP, 0, `${c.id} left edge is on the lattice`);
    assert.equal(c.w % HUD_SNAP, 0, `${c.id} width is on the lattice`);
  }
});

test("hudFitScale: never enlarges — a viewport at/above the seed size gives scale 1", () => {
  const boxes = seedBoxes(1440);
  // At the seed viewport (or larger) the layout already fits: no scaling, cards untouched.
  assert.equal(hudFitScale(boxes, 1440, 1080), 1);
  assert.equal(hudFitScale(boxes, 2560, 1440), 1);
  // Empty / degenerate input is a no-op (nothing to fit).
  assert.equal(hudFitScale([], 400, 300), 1);
  assert.equal(hudFitScale(boxes, 0, 0), 1);
});

test("hudFitScale: shrinks to fit a narrower viewport so the right column stays on-screen", () => {
  // A layout seeded on a 1440 screen, opened on a 1024-wide one: the right column (minimap/channels) sits at
  // x = 1440 - 16 - 240 = 1184, so its right edge is 1424 — off a 1024 viewport. The fit scale must bring it in.
  const boxes = seedBoxes(1440);
  const maxRight = Math.max(...boxes.map((b) => b.x + b.w)); // 1424
  const s = hudFitScale(boxes, 1024, 2000, HUD_MARGIN); // tall enough that width binds
  assert.ok(s < 1, "narrower viewport shrinks the HUD");
  // The scaled right edge lands within the viewport (at the margin-inset available width).
  assert.ok(maxRight * s <= 1024 - HUD_MARGIN + 0.5, "right column pulled fully on-screen");
  assert.equal(s, (1024 - HUD_MARGIN) / maxRight);
});

test("hudFitScale: shrinks to fit a shorter viewport so the columns don't overflow the bottom", () => {
  const boxes = seedBoxes(1440);
  const maxBottom = Math.max(...boxes.map((b) => b.y + b.h)); // left column: 16+300+12+300+12+300 = 940
  const s = hudFitScale(boxes, 4000, 700, HUD_MARGIN); // wide enough that height binds
  assert.ok(s < 1, "shorter viewport shrinks the HUD");
  assert.ok(maxBottom * s <= 700 - HUD_MARGIN + 0.5, "bottom of the columns pulled on-screen");
  assert.equal(s, (700 - HUD_MARGIN) / maxBottom);
});

test("hudFitScale: takes the binding (smaller) of the width and height fits", () => {
  const boxes = seedBoxes(1440);
  const both = hudFitScale(boxes, 1024, 700, HUD_MARGIN);
  const widthOnly = hudFitScale(boxes, 1024, 4000, HUD_MARGIN);
  const heightOnly = hudFitScale(boxes, 4000, 700, HUD_MARGIN);
  assert.equal(both, Math.min(widthOnly, heightOnly));
});

test("resolveHudPosition is deterministic per width — same width in, same box out (seed idempotency)", () => {
  const channels = DEFAULT_HUD.find((c) => c.id === "node:channels");
  const a = resolveHudPosition(channels, 1600);
  const b = resolveHudPosition(channels, 1600);
  assert.deepEqual(a, b);
  // A different width re-places the right-anchored card (the only reason a same-board reload would re-seat it).
  assert.notDeepEqual(resolveHudPosition(channels, 1200), a);
  // Integer coordinates everywhere (odd widths don't leak sub-pixels into the layout record).
  const clock = DEFAULT_HUD.find((c) => c.id === "node:clock");
  const odd = resolveHudPosition(clock, 1281);
  assert.ok(Number.isInteger(odd.x) && Number.isInteger(odd.y));
});
