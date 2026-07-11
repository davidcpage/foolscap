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
  MIN_HUD_SCALE,
  isHudCard,
  hudChromeFor,
  hudFitScale,
  pinPlacement,
  resolveHudPosition,
} from "../hud-layout.js";

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

test("hudFitScale: a HUD that already fits the viewport renders native (scale 1)", () => {
  // "Native when it fits": the group only shrinks on overflow — a bbox within the viewport (less the margin)
  // is scale 1, so an un-overflowing HUD renders at full/native size exactly as before.
  const boxes = [{ x: 16, y: 16, w: 240, h: 300 }]; // far edge 256×316, comfortably inside 1440×900
  assert.equal(hudFitScale(boxes, 1440, 900), 1);
  // Right at the edge (far edge + margin == viewport) is still native.
  assert.equal(hudFitScale([{ x: 0, y: 0, w: 1424, h: 884 }], 1440, 900), 1); // 1424+16=1440, 884+16=900
});

test("hudFitScale: shrinks the whole group to fit when the bbox overflows, by the binding axis", () => {
  // A card seeded off the right/bottom edge of a narrower viewport drives the group scale below 1 — the
  // SMALLER (binding) of the two axis ratios, so nothing overflows on either axis.
  // bbox far edge 1424 wide; viewport 728 → availW 712 → 712/1424 = 0.5 (width binds).
  assert.equal(hudFitScale([{ x: 0, y: 0, w: 1424, h: 200 }], 728, 900), 0.5);
  // bbox far edge 1784 tall; viewport height 908 → availH 892 → 892/1784 = 0.5 (height binds).
  assert.equal(hudFitScale([{ x: 0, y: 0, w: 200, h: 1784 }], 1440, 908), 0.5);
  // Both axes overflow: the more-binding one wins.
  assert.equal(hudFitScale([{ x: 0, y: 0, w: 1424, h: 1784 }], 728, 908), 0.5);
});

test("hudFitScale: the bbox spans ALL boxes — a single off-screen card pulls the whole group in", () => {
  // The group fit is over the union of every card, so one right-anchored card frozen from a wide seed shrinks
  // the whole HUD to bring it back on-screen (the overflow bug this fixes).
  const boxes = [
    { x: 16, y: 16, w: 240, h: 300 }, // left column, on-screen
    { x: 1184, y: 16, w: 240, h: 180 }, // right-anchored on a 1440 seed → far edge 1424
  ];
  // On a 728-wide viewport: availW 712 / maxX 1424 = 0.5.
  assert.equal(hudFitScale(boxes, 728, 900), 0.5);
});

test("hudFitScale: empty group or a degenerate box/viewport is native (safe default)", () => {
  assert.equal(hudFitScale([], 1024, 768), 1);
  assert.equal(hudFitScale(undefined, 1024, 768), 1);
  assert.equal(hudFitScale([{ x: 0, y: 0, w: 0, h: 0 }], 1024, 768), 1); // zero bbox
  assert.equal(hudFitScale([{ x: 0, y: 0, w: 100, h: 100 }], 0, 0), 1); // zero viewport
});

// The invariant every pinPlacement case must hold: after the group scale it returns is applied around (0,0),
// the placed card's centre lands back on the requested on-screen centre (cx,cy). And — the fixed-point claim —
// that scale equals what hudFitScale actually returns at render for the resulting box set, so there is no
// second correction pass and no oscillation.
function centreOf(box, s) {
  return { cx: (box.x + box.w / 2) * s, cy: (box.y + box.h / 2) * s };
}

test("pinPlacement: keeps the card's on-screen centre fixed (the primary ask)", () => {
  // A modest card pinned in the central area of a wide viewport that the HUD already fits natively.
  const existing = [{ x: 16, y: 16, w: 240, h: 300 }]; // one left-column card, fits at scale 1
  const [cx, cy, w, h] = [700, 400, 300, 200];
  const { x, y, s } = pinPlacement(existing, cx, cy, w, h, 1440, 900);
  // Central pin on a fitting HUD → the group is NOT rescaled (s stays 1) and nothing else shrinks.
  assert.equal(s, 1);
  const c = centreOf({ x, y, w, h }, s);
  assert.ok(Math.abs(c.cx - cx) < 1e-9 && Math.abs(c.cy - cy) < 1e-9, "centre preserved");
});

test("pinPlacement: the returned scale IS the render scale (fixed point, no oscillation)", () => {
  // Whatever s pinPlacement chose, feeding the placed box back through hudFitScale (with the existing group)
  // must return the SAME s — i.e. the card renders at exactly the scale it was placed against. This is the
  // property that makes the placement stable: no re-measure would move it.
  const cases = [
    { existing: [{ x: 16, y: 16, w: 240, h: 300 }], cx: 700, cy: 400, w: 300, h: 200, vw: 1440, vh: 900 },
    // HUD already overflows a narrow viewport → existing scale < 1; a central pin should ride that same scale.
    { existing: [{ x: 0, y: 0, w: 1424, h: 200 }], cx: 300, cy: 300, w: 200, h: 150, vw: 728, vh: 900 },
    // Card pinned near the right edge → its own bound binds and drops s below the existing scale.
    { existing: [{ x: 16, y: 16, w: 240, h: 300 }], cx: 1300, cy: 300, w: 400, h: 200, vw: 1440, vh: 900 },
  ];
  for (const t of cases) {
    const { x, y, s } = pinPlacement(t.existing, t.cx, t.cy, t.w, t.h, t.vw, t.vh);
    const rendered = hudFitScale([...t.existing, { x, y, w: t.w, h: t.h }], t.vw, t.vh);
    assert.ok(Math.abs(rendered - s) < 1e-9, `render scale ${rendered} == placed scale ${s}`);
    const c = centreOf({ x, y, w: t.w, h: t.h }, s);
    assert.ok(Math.abs(c.cx - t.cx) < 1e-6 && Math.abs(c.cy - t.cy) < 1e-6, "centre preserved under render scale");
  }
});

test("pinPlacement: a central pin never rescales the rest of the HUD; an edge pin does (flagged behaviour)", () => {
  const existing = [{ x: 16, y: 16, w: 240, h: 300 }];
  const sExisting = hudFitScale(existing, 1440, 900); // 1 here (fits)
  // Centre well inside → group scale unchanged.
  const central = pinPlacement(existing, 700, 400, 300, 200, 1440, 900);
  assert.equal(central.s, sExisting);
  // Centre close to the right edge → keeping it fixed forces the whole group to shrink (the second-jump case).
  const edge = pinPlacement(existing, 1400, 400, 300, 200, 1440, 900);
  assert.ok(edge.s < sExisting, "edge pin shrinks the group");
});

test("pinPlacement: a degenerate centre in the margin band is floored, never zero/negative, centre still held", () => {
  // cx beyond availW (centre inside the right margin) would make the raw bound negative; the floor guards it.
  const { x, y, s } = pinPlacement([], 1438, 400, 300, 200, 1440, 900);
  assert.equal(s, MIN_HUD_SCALE);
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  // Even clamped, x = cx/s − w/2 uses the SAME s, so the centre still lands on cx (only the size collapses).
  const c = centreOf({ x, y, w: 300, h: 200 }, s);
  assert.ok(Math.abs(c.cx - 1438) < 1e-6, "centre held even when scale is floored");
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
