// Hold-to-peek navigation (wayfinding's "quick zoom", the hold-to-see-map-release-to-warp gesture
// games use): hold `z` and the camera flies out to frame the whole board; put the cursor on the place
// you want; release and the camera dives back in around that point, to the zoom you left. One
// hold-move-release replaces the zoom-out → pan → zoom-in triple that getting across a busy board
// otherwise costs. The dive targets the CURSOR and stays anchored there — a pointer position is
// precise where "what's in the middle of the screen" is a judgement by eye, and keeping the aimed
// point under the pointer means you're still pointing at it when the dive lands; the centre is only
// the fallback when the pointer has never been over the canvas. Escape (or the window losing focus)
// mid-hold cancels the round trip and
// restores the exact starting pose; so does releasing without having aimed at all — a stray tap of `z`
// bounces home, it doesn't re-centre the board.
//
// While peeked, the LENS makes aiming legible: hovering a card magnifies it in place (`.peeking` +
// `--peek-scale` here; the hover rule and rationale in style.css) — cards are unreadably small from a
// whole-board overview, so the pop answers "is this the one?" without committing the dive. The scale
// tracks the live zoom (a camera-signal subscription held only while peeked) so the hovered card pops
// to roughly the same READABLE on-screen size however far out the overview is. The board makes room
// by PARTING: every other card slides outward along its ray by the pop's border growth (the
// insertion field, applyDisplacement below), preserving all clearances and arrangements exactly.
// While the overview is held the wheel is pure navigation — setPeekNavigationActive stops the
// magnified card's scroller from swallowing the aiming pan (interior.ts).
//
// Renderer-level like the rest of wayfinding (views.ts, the number-row keymap): composed entirely from
// manager primitives (fitAll, flyTo, camera transforms), no engine change. Keys are bound on the canvas
// element, so card interiors that contain their keydown (inputs, textareas) keep the key for typing —
// holding z in a thread post box types "zzz", it doesn't peek.

import { layoutId, type CameraState, type Id, type InteractionManager, type LayoutRecord } from "./lib";
import { setPeekNavigationActive } from "./interior";

const MOVE_THRESHOLD_PX = 4; // cursor travel below this doesn't count as aiming
const LENS_TARGET_Z = 0.55; // magnify a hovered card toward this effective zoom (≈ readable)
const LENS_MAX_SCALE = 8; // …but never more than this, however far out the overview is
const LENS_MAX_FRAC = 0.45; // …and never past this fraction of the viewport per axis — a LARGE card
// needs little magnification to be readable, and an uncapped pop covers the board and rams every
// neighbour to the screen edges ("swallowed"); capped, big cards pop gently and small ones fully
const LENS_HOVER_DELAY_MS = 100; // hover-intent: settle on a card this long before it pops — a cursor
// sweeping across the overview pops nothing (the pop is only visible once the scale var is set, so
// delaying hoverId application gates pop and displacement together). Modest on purpose: the slow-start
// easing (style.css) is the real warning; this only suppresses fast sweeps.
const LENS_SHRINK_MS = 420; // how long .peek-anim outlives release (≥ the transition), so the pop shrinks smoothly

export function bindPeek(
  el: HTMLElement,
  m: InteractionManager,
  opts: {
    /** Excluded from the fit-all bounds (screen-anchored floating cards, same as Shift+1). */
    skipLayout?: (l: LayoutRecord) => boolean;
    /** Called with the pre-peek pose when a dive commits — the app pushes it on the unwind stack. */
    onDive?: (from: CameraState) => void;
  } = {},
): () => void {
  let prePeek: CameraState | null = null; // non-null = a peek is in flight; the pose to return to
  let last: { x: number; y: number } | null = null; // cursor, client coords
  let origin: { x: number; y: number } | null = null; // cursor at peek start, for the tap test
  let navigated = false; // aimed during the peek (cursor moved, or a wheel/drag pan) → dive on release
  let offLens: (() => void) | null = null; // camera subscription feeding --peek-scale while peeked
  let shrinkTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverId: string | null = null; // the card the lens is on (peek mode only)
  let hoverTimer: ReturnType<typeof setTimeout> | null = null; // pending hover-intent (LENS_HOVER_DELAY_MS)
  // The pop's scaling ORIGIN, in page coords — the cursor's position on the card, captured once when
  // the hover-intent fires. Scaling about this point (instead of the card centre) makes the spot under
  // the cursor the FIXED POINT of the pop: however sudden the zoom, the aim never moves. Fixed for the
  // pop's lifetime (camera reruns must not let it drift under a stationary cursor).
  let popOrigin: { x: number; y: number } | null = null;
  const displaced = new Set<HTMLElement>(); // neighbours currently pushed aside, for cheap clearing

  const cancelHoverIntent = () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  };

  // Where on the card the pop should be anchored: the page point under the cursor, clamped into the
  // card's rect (the pointer is over the card when this runs; clamping guards float edges). Falls back
  // to the centre if the pointer has never been seen.
  const originOn = (l: LayoutRecord): { x: number; y: number } => {
    if (!last) return { x: l.x + l.w / 2, y: l.y + l.h / 2 };
    const rect = el.getBoundingClientRect();
    const p = m.camera.screenToPage({ x: last.x - rect.left, y: last.y - rect.top });
    return {
      x: Math.min(l.x + l.w, Math.max(l.x, p.x)),
      y: Math.min(l.y + l.h, Math.max(l.y, p.y)),
    };
  };

  // The pop scale for a given hovered card: toward readable (LENS_TARGET_Z), capped absolutely and by
  // the on-screen footprint the card would reach — so the scale is now PER CARD, not zoom-only.
  const lensScale = (l: LayoutRecord): number => {
    const z = m.camera.state.z;
    const fitW = (el.clientWidth * LENS_MAX_FRAC) / (l.w * z);
    const fitH = (el.clientHeight * LENS_MAX_FRAC) / (l.h * z);
    return Math.max(1, Math.min(LENS_TARGET_Z / z, LENS_MAX_SCALE, fitW, fitH));
  };

  // ── Fisheye displacement (the Dock answer to "the pop covers its neighbours") ──
  // When the lens lands on a card, every world card within an influence radius is pushed radially
  // away, hardest right beside the card and fading to nothing at the rim, so the magnified card opens
  // a clearing instead of covering things. Computed in PAGE units from the layout records (screen
  // motion then scales with the camera like everything else) and applied as --peek-dx/dy on the card
  // hosts — ephemeral DOM state, never a record, and .peek-anim's transition animates both the shove
  // and the glide back. Runs only on hover CHANGE, never per pointermove.
  const clearDisplacement = () => {
    for (const host of displaced) {
      host.style.removeProperty("--peek-dx");
      host.style.removeProperty("--peek-dy");
    }
    displaced.clear();
  };
  const applyDisplacement = () => {
    clearDisplacement();
    const store = m.editor.store;
    const hov = hoverId ? store.get<"layout">(layoutId(hoverId as Id<"node">)) : null;
    if (!hov || hov.anchor === "screen") {
      // Nothing (resolvable) hovered: neutralise the scale var too. A stale value here once made a
      // card whose host lacked data-node-id pop at the PREVIOUS card's scale with no displacement —
      // never let that class of bug back.
      el.style.setProperty("--peek-scale", "1");
      return;
    }
    // The var the .peeking:hover CSS rule picks up — set here (per hover / per camera tick) so the
    // rendered pop and the displacement below can never disagree about the size.
    const scale = lensScale(hov);
    el.style.setProperty("--peek-scale", String(scale));
    if (scale <= 1) return; // already big on screen: no pop, so nothing to part
    // The pop scales about popOrigin — the cursor's spot on the card — so that spot never moves.
    const o = popOrigin ?? { x: hov.x + hov.w / 2, y: hov.y + hov.h / 2 };
    // The pop as an INSERTION into the plane: along each ray from the scaling origin the border grows
    // by (s−1)·t0 (t0 = origin→border distance along that ray, slab exit), and every card slides
    // outward along its own ray by exactly that growth — the whole canvas parts around the pop. This
    // preserves every border↔neighbour clearance EXACTLY (border and neighbour move by the same
    // amount), keeps all shapes, and can't reorder anyone (cards on a ray move identically; equal
    // radial shifts only ever spread points apart) — the failure modes of the earlier minimal-push/
    // sweep versions (buried neighbours, side-by-side flipping to stacked, chain shoves) are
    // impossible by construction. A card overlapping the pop itself (a pile under the lens) instead
    // rides the magnification — dilated by s within the footprint, continuous at the border. One
    // closed form: push = (s−1)·min(r, t0). Push is border growth, independent of distance, so it's
    // bounded by the pop's own growth (which lensScale caps to a viewport fraction).
    for (const host of el.querySelectorAll<HTMLElement>("[data-node-id]")) {
      const id = host.dataset.nodeId;
      if (!id) continue;
      if (id === hoverId) {
        // Stamp the render origin (element-local coords) so the CSS scale pivots where the maths says
        // it does. Left in place after un-pop — inert at scale 1, and the shrink needs it to reverse
        // about the same point.
        host.style.transformOrigin = `${o.x - hov.x}px ${o.y - hov.y}px`;
        continue;
      }
      const l = store.get<"layout">(layoutId(id as Id<"node">));
      if (!l || l.anchor === "screen") continue;
      const dx = l.x + l.w / 2 - o.x;
      const dy = l.y + l.h / 2 - o.y;
      const r = Math.hypot(dx, dy);
      // Radial unit direction; a neighbour centred on the origin has none, shove it upward arbitrarily.
      const ux = r < 1 ? 0 : dx / r;
      const uy = r < 1 ? -1 : dy / r;
      // Origin→border distance along this ray (slab exit; the origin sits inside the card's rect, but
      // not necessarily at its centre, so the two sides of each axis differ).
      const tx = ux > 0 ? (hov.x + hov.w - o.x) / ux : ux < 0 ? (hov.x - o.x) / ux : Infinity;
      const ty = uy > 0 ? (hov.y + hov.h - o.y) / uy : uy < 0 ? (hov.y - o.y) / uy : Infinity;
      const t0 = Math.min(tx, ty);
      const push = (scale - 1) * Math.min(r, t0);
      if (push < 0.5) continue;
      host.style.setProperty("--peek-dx", `${ux * push}px`);
      host.style.setProperty("--peek-dy", `${uy * push}px`);
      displaced.add(host);
    }
  };
  // Delegated hover tracking, live only while peeked: entering a card (or any of its interior)
  // resolves to its host id; entering bare canvas resolves to null and the clearing closes up.
  // Hover-INTENT, not raw hover: leaving the popped card un-pops immediately, but a newly entered
  // card must be settled on for LENS_HOVER_DELAY_MS before it pops — so sweeping the cursor across
  // the overview stays calm instead of popping every card it crosses.
  const onPointerOver = (e: PointerEvent) => {
    if (!prePeek) return;
    const host = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-node-id]") : null;
    const id = host?.dataset.nodeId ?? null;
    if (id === hoverId) {
      cancelHoverIntent(); // back on the already-popped card: abandon any pending switch
      return;
    }
    cancelHoverIntent();
    if (hoverId !== null) {
      hoverId = null;
      popOrigin = null;
      applyDisplacement(); // un-pop now; the replacement (if any) arrives after the intent delay
    }
    if (id !== null) {
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        const l = m.editor.store.get<"layout">(layoutId(id as Id<"node">));
        if (!l || l.anchor === "screen") return;
        hoverId = id;
        popOrigin = originOn(l); // anchor the pop where the cursor is NOW, for its whole lifetime
        applyDisplacement();
      }, LENS_HOVER_DELAY_MS);
    }
  };

  // The lens rides two classes: .peeking gates the hover-magnify rule to the held key, .peek-anim
  // gates the transform transition — kept a beat past release so the magnified card shrinks smoothly
  // instead of snapping (and never left on .node permanently: it would lag every card drag).
  const lensOn = () => {
    if (shrinkTimer) {
      clearTimeout(shrinkTimer);
      shrinkTimer = null;
    }
    hoverId = null; // until the pointer moves, no card is hovered (matches how :hover re-arms)
    el.style.setProperty("--peek-scale", "1"); // inert until a hover computes the real per-card scale
    // Track the live zoom while a card is hovered: the pop's scale and the clearance displacement are
    // both computed from it (applyDisplacement sets the CSS var), so hovering mid-flight or pinching
    // with the lens up keeps pop and cleared neighbours in agreement.
    offLens = m.camera.signal.subscribe(() => {
      if (hoverId) applyDisplacement();
    });
    el.classList.add("peeking", "peek-anim");
    setPeekNavigationActive(true);
  };
  const lensOff = () => {
    offLens?.();
    offLens = null;
    cancelHoverIntent();
    hoverId = null;
    popOrigin = null;
    clearDisplacement(); // vars clear while .peek-anim is still on, so neighbours glide back
    el.classList.remove("peeking");
    setPeekNavigationActive(false);
    shrinkTimer = setTimeout(() => {
      el.classList.remove("peek-anim");
      shrinkTimer = null;
    }, LENS_SHRINK_MS);
  };

  const restore = () => {
    if (!prePeek) return;
    const from = prePeek;
    prePeek = null;
    lensOff();
    m.flyTo(from);
  };

  const onPointerMove = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY };
    if (prePeek && !navigated && origin) {
      navigated = Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_THRESHOLD_PX;
    }
  };

  // Panning with the view (wheel / drag) counts as aiming too — a two-finger scroll moves the board
  // under a stationary cursor, so cursor travel alone would misread it as a tap.
  const onNavigate = () => {
    if (prePeek) navigated = true;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (prePeek && e.key === "Escape") {
      // Cancel: back to exactly where you were. Contain the Escape so the canvas-level Escape action
      // (interrupting a selected live session) doesn't also fire off a navigation abort.
      e.stopPropagation();
      restore();
      return;
    }
    if (e.key !== "z" && e.key !== "Z") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘Z is undo; any modified z isn't ours
    if (e.repeat || prePeek) return;
    prePeek = m.camera.state;
    origin = last;
    navigated = false;
    lensOn();
    m.fitAll(opts.skipLayout); // no-ops on an empty board; keyup then just bounces home
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if ((e.key !== "z" && e.key !== "Z") || !prePeek) return;
    if (!navigated) {
      restore(); // a tap: round-trip to the starting pose
      return;
    }
    const from = prePeek;
    prePeek = null;
    // Dive: zoom in to the zoom you left, ANCHORED at the cursor — the aimed point stays pinned under
    // the pointer (the ctrl-wheel convention), so after the dive you're still pointing at what you
    // aimed at. (Centring it instead would strand the cursor over something arbitrary — a page can't
    // move the OS pointer to follow.) screenToPage reads the camera as currently drawn — mid-flight
    // included — so the target is whatever the eye is on right now.
    const rect = el.getBoundingClientRect();
    const s = last
      ? { x: last.x - rect.left, y: last.y - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 }; // pointer never seen: the centre stands in
    let p = m.camera.screenToPage(s);
    // If the lens is on a card, the cursor is pointing INTO its magnified rendering — a DOM transform
    // the camera math doesn't know. Invert it about the pop's scaling origin so the dive lands on the
    // CONTENT spot aimed at: point at a line in a popped transcript, arrive on it. Must run before
    // lensOff() nulls the hover state.
    if (hoverId && popOrigin) {
      const hovL = m.editor.store.get<"layout">(layoutId(hoverId as Id<"node">));
      if (hovL && hovL.anchor !== "screen") {
        const scale = lensScale(hovL);
        if (scale > 1) {
          p = { x: popOrigin.x + (p.x - popOrigin.x) / scale, y: popOrigin.y + (p.y - popOrigin.y) / scale };
        }
      }
    }
    lensOff();
    const z = from.z;
    m.flyTo({ x: s.x - p.x * z, y: s.y - p.y * z, z });
    opts.onDive?.(from);
  };

  // Cmd-tab / window switch mid-hold: the keyup will never arrive; end the peek where it began.
  const onBlur = () => restore();

  el.addEventListener("pointermove", onPointerMove, { passive: true });
  el.addEventListener("pointerover", onPointerOver, { passive: true });
  el.addEventListener("wheel", onNavigate, { passive: true });
  el.addEventListener("pointerdown", onNavigate);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerover", onPointerOver);
    el.removeEventListener("wheel", onNavigate);
    el.removeEventListener("pointerdown", onNavigate);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    offLens?.();
    if (shrinkTimer) clearTimeout(shrinkTimer);
    cancelHoverIntent();
    clearDisplacement();
    el.classList.remove("peeking", "peek-anim");
    setPeekNavigationActive(false);
  };
}
