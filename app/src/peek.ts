// Hold-to-peek navigation (wayfinding's "quick zoom", the hold-to-see-map-release-to-warp gesture
// games use): hold `z` and the camera flies out to frame the whole board; put the cursor on the place
// you want; release and the camera dives back in around that point, to the zoom you left. One
// hold-move-release replaces the zoom-out → pan → zoom-in triple that getting across a busy board
// otherwise costs. The dive targets the CURSOR and stays anchored there — a pointer position is
// precise where "what's in the middle of the screen" is a judgement by eye, and keeping the aimed
// point under the pointer means you're still pointing at it when the dive lands; the centre is only
// the fallback when the pointer has never been over the canvas. Escape (or the window losing focus)
// mid-hold cancels the round trip and restores the exact starting pose; so does releasing without
// having aimed at all — a stray tap of `z` bounces home, it doesn't re-centre the board.
//
// While peeked, settling the cursor on a card PREVIEWS the dive with the camera itself: the camera
// flies most of the way (PREVIEW_DEPTH of the log-zoom gap) toward the final pose, anchored so the
// aimed point never leaves the cursor. No DOM trickery — it's the real render en route to the real
// destination, so wires, selection, stacking and hit-testing are all simply correct, and release just
// completes the remaining zoom. Settling on another card re-anchors the preview there (cards are
// bigger mid-preview, so refining the aim gets easier as you go); parking on bare canvas for a beat
// flies back out to the overview to re-aim globally. This replaced a family of DOM-transform lenses
// (single-card pop, insertion-field parting, a focus+context scale model) that all fought overlap,
// fold and staleness artifacts — the camera IS the preview, there's nothing to fake. While the
// overview is held the wheel stays pure navigation — setPeekNavigationActive stops a hovered card's
// scroller from swallowing the aiming pan (interior.ts).
//
// Renderer-level like the rest of wayfinding (views.ts, the number-row keymap): composed entirely from
// manager primitives (flyTo, camera transforms, worldBounds/fitState), no engine change. Keys are
// bound on the canvas element, so card interiors that contain their keydown (inputs, textareas) keep
// the key for typing — holding z in a thread post box types "zzz", it doesn't peek.

import { layoutId, worldBounds, type CameraState, type Id, type InteractionManager, type LayoutRecord } from "./lib";
import { setPeekNavigationActive } from "./interior";

const MOVE_THRESHOLD_PX = 4; // cursor travel below this doesn't count as aiming
const PREVIEW_DEPTH = 1; // how far toward the final pose a hover flies (log-zoom fraction). 1 = the
// preview IS the final view and releasing z is motionless confirmation — a partial depth (0.65 was
// tried) left a residual zoom on release that read as unexpected movement, not context
const HOVER_DELAY_MS = 60; // settle on a card this long before the preview flies — kept short: the
// real sweep-calming is the LONG gentle flight (below), whose slow first beats are cancellable warning
const PREVIEW_FLIGHT_MS = 450; // the preview flight, deliberately slower than flyTo's default 300 —
// its eased start doubles as the hover warning, so the delay above could shrink
const BACKOUT_DELAY_MS = 120; // off every card this long → fly back out to the overview. Short on
// purpose: at full preview depth the rest of the board is out of view, so leaving the card's border
// must return the overview promptly or there's no way to aim at the next card

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
  let overview: CameraState | null = null; // the fit-all pose this peek flew out to (backout target)
  let last: { x: number; y: number } | null = null; // cursor, client coords
  let origin: { x: number; y: number } | null = null; // cursor at peek start, for the tap test
  let navigated = false; // aimed during the peek (cursor/wheel/drag/preview) → dive on release
  let hoverId: string | null = null; // the card the preview is currently anchored on
  let pendingId: string | null = null; // where a running settle/backout timer is headed (null = out)
  let hoverTimer: ReturnType<typeof setTimeout> | null = null; // pending settle → preview flight
  let backTimer: ReturnType<typeof setTimeout> | null = null; // pending bare-canvas → overview flight

  const clearTimers = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    if (backTimer) clearTimeout(backTimer);
    hoverTimer = backTimer = null;
    pendingId = null;
  };

  const cursorPoint = (): { x: number; y: number } => {
    const rect = el.getBoundingClientRect();
    return last
      ? { x: last.x - rect.left, y: last.y - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 }; // pointer never seen: the centre stands in
  };

  // The camera pose at zoom `z` that keeps the page point under the cursor exactly there — the one
  // formula behind overview→preview→dive: they're all the same anchored dilation, just deeper.
  const anchoredPose = (z: number): CameraState => {
    const s = cursorPoint();
    const p = m.camera.screenToPage(s);
    return { x: s.x - p.x * z, y: s.y - p.y * z, z };
  };

  // Nudge a pose by the minimal pan that brings a card fully on-screen (margin `pad`); an axis the
  // card simply doesn't fit on is centred instead. The preview flies to framedPose(anchoredPose(z)):
  // from the overview that's the cursor-anchored dilation plus a small correction (so aiming at a
  // card's corner doesn't leave half of it off-screen), and while ALREADY at preview depth the
  // anchored pose is the identity — the frame nudge is then the whole move, a clean sideways pan to
  // the next card. (Without it, deep retargeting was a flight to nowhere: anchoring the point under
  // the cursor at the zoom you're already at is exactly where the camera stands.)
  const framedPose = (pose: CameraState, l: LayoutRecord): CameraState => {
    // The margin is a generous fraction of the viewport, not a sliver: "framed" means COMFORTABLY in
    // view. With a thin margin a card hugging the screen edge counted as already framed and hover
    // moved nothing — technically correct, felt dead. Cards already inside the comfort zone still
    // draw no motion (they're where focus would put them), which is the natural no-op.
    const axis = (start: number, size: number, view: number): number => {
      const pad = view * 0.12;
      if (size > view - 2 * pad) return (view - size) / 2 - start; // doesn't fit: centre it
      if (start < pad) return pad - start;
      if (start + size > view - pad) return view - pad - (start + size);
      return 0;
    };
    const dx = axis(l.x * pose.z + pose.x, l.w * pose.z, el.clientWidth);
    const dy = axis(l.y * pose.z + pose.y, l.h * pose.z, el.clientHeight);
    return { x: pose.x + dx, y: pose.y + dy, z: pose.z };
  };

  const endPeek = () => {
    clearTimers();
    hoverId = null;
    overview = null;
    setPeekNavigationActive(false);
    el.classList.remove("peeking");
  };

  const restore = () => {
    if (!prePeek) return;
    const from = prePeek;
    prePeek = null;
    endPeek();
    m.flyTo(from);
  };

  const onPointerMove = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY };
    if (prePeek && !navigated && origin) {
      navigated = Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_THRESHOLD_PX;
    }
  };

  // Wheel / drag pan while peeked: manual aiming. It counts for the tap test, and it clears any
  // pending preview/backout flight — the user has taken the camera; don't fight them for it.
  const onNavigate = () => {
    if (!prePeek) return;
    navigated = true;
    clearTimers();
    hoverId = null; // whatever they settle on next re-previews from wherever they panned to
  };

  // Delegated hover tracking with settle-intent: a card held under the cursor for HOVER_DELAY_MS
  // flies the preview to it; bare canvas held for BACKOUT_DELAY_MS flies back to the overview.
  // Crossing cards or gaps quickly does nothing — the camera only moves for a settled aim.
  const onPointerOver = (e: PointerEvent) => {
    if (!prePeek) return;
    // Not armed until the user has actually AIMED (cursor travel past the tap threshold, or a pan):
    // the cursor is often already sitting on a card when z goes down, and the tiniest jitter fires
    // pointerover on it — without this gate the overview flight would immediately U-turn back in.
    if (!navigated) return;
    const host = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-node-id]") : null;
    const id = host?.dataset.nodeId ?? null;
    // Compare against where we're already HEADED, not just where we are: pointerover fires on every
    // child boundary inside a card, and resetting the settle timer on each of those meant a cursor
    // kept moving across a busy card never acquired focus (and background layers likewise kept
    // resetting the backout). Same destination → let the running timer run.
    const heading = hoverTimer || backTimer ? pendingId : hoverId;
    if (id === heading) return;
    clearTimers();
    if (id === hoverId) return; // back on the focused card: cancel any pending move, stay put
    pendingId = id;
    if (id !== null) {
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        pendingId = null;
        if (!prePeek || !overview) return;
        const l = m.editor.store.get<"layout">(layoutId(id as Id<"node">));
        if (!l || l.anchor === "screen") return;
        hoverId = id;
        // Fly PREVIEW_DEPTH of the log-zoom way from the overview to the dive, anchored at the
        // cursor and framed so the settled card is fully in view. Depth is measured pose-to-pose
        // (not from wherever the camera currently is), so retargeting card-to-card holds a
        // consistent altitude — and at that altitude the move is framedPose's pan (see above).
        const z = Math.exp(
          Math.log(overview.z) + (Math.log(prePeek.z) - Math.log(overview.z)) * PREVIEW_DEPTH,
        );
        m.flyTo(framedPose(anchoredPose(z), l), { durationMs: PREVIEW_FLIGHT_MS });
      }, HOVER_DELAY_MS);
    } else {
      backTimer = setTimeout(() => {
        backTimer = null;
        pendingId = null;
        if (!prePeek || !overview || hoverId === null) return;
        hoverId = null;
        // Same unhurried pace as the way in — the fast default read as a lurch.
        m.flyTo(overview, { durationMs: PREVIEW_FLIGHT_MS });
      }, BACKOUT_DELAY_MS);
    }
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
    hoverId = null;
    // Compute the overview pose ourselves (rather than m.fitAll) so backout knows where "out" is.
    const box = worldBounds(m.editor.store, opts.skipLayout);
    overview = box ? m.camera.fitState(box, el.clientWidth, el.clientHeight, { pad: 0.08, maxZoom: 1 }) : null;
    if (overview) m.flyTo(overview); // empty board / unmeasured viewport: keyup just bounces home
    setPeekNavigationActive(true);
    el.classList.add("peeking");
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if ((e.key !== "z" && e.key !== "Z") || !prePeek) return;
    if (!navigated) {
      restore(); // a tap: round-trip to the starting pose
      return;
    }
    const from = prePeek;
    prePeek = null;
    endPeek();
    // Dive: complete the zoom to the level you left, anchored at the cursor — from the overview or
    // from a preview mid-flight alike, it's the same dilation, just carried to full depth. The
    // camera is the only geometry, so what's under the cursor is exactly what you land on.
    m.flyTo(anchoredPose(from.z));
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
    clearTimers();
    el.classList.remove("peeking");
    setPeekNavigationActive(false);
  };
}
