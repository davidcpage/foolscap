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
// Renderer-level like the rest of wayfinding (views.ts, the number-row keymap): composed entirely from
// manager primitives (fitAll, flyTo, camera transforms), no engine change. Keys are bound on the canvas
// element, so card interiors that contain their keydown (inputs, textareas) keep the key for typing —
// holding z in a thread post box types "zzz", it doesn't peek.

import type { CameraState, InteractionManager, LayoutRecord } from "./lib";

const MOVE_THRESHOLD_PX = 4; // cursor travel below this doesn't count as aiming

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

  const restore = () => {
    if (!prePeek) return;
    const from = prePeek;
    prePeek = null;
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
    const p = m.camera.screenToPage(s);
    const z = from.z;
    m.flyTo({ x: s.x - p.x * z, y: s.y - p.y * z, z });
    opts.onDive?.(from);
  };

  // Cmd-tab / window switch mid-hold: the keyup will never arrive; end the peek where it began.
  const onBlur = () => restore();

  el.addEventListener("pointermove", onPointerMove, { passive: true });
  el.addEventListener("wheel", onNavigate, { passive: true });
  el.addEventListener("pointerdown", onNavigate);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("wheel", onNavigate);
    el.removeEventListener("pointerdown", onNavigate);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
