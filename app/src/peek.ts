// Hold-to-peek navigation (wayfinding's "quick zoom"): hold `z` and the camera flies out to frame the
// whole board; pan/scroll until the place you want sits at the middle of the screen; release and the
// camera dives straight in around the centre, back at the zoom you left. One hold-move-release
// replaces the zoom-out → pan → zoom-in triple that getting across a busy board otherwise costs.
// (The dive targets the screen CENTRE, not the cursor — a two-finger scroll never moves the cursor, so
// the centre is the only spot the eye and the gesture agree on.) Escape (or the window losing focus)
// mid-hold cancels the round trip and restores the exact starting pose; so does releasing without
// having panned or zoomed at all — a stray tap of `z` bounces home, it doesn't re-centre the board.
//
// Renderer-level like the rest of wayfinding (views.ts, the number-row keymap): composed entirely from
// manager primitives (fitAll, flyTo, camera transforms), no engine change. Keys are bound on the canvas
// element, so card interiors that contain their keydown (inputs, textareas) keep the key for typing —
// holding z in a thread post box types "zzz", it doesn't peek.

import type { CameraState, InteractionManager, LayoutRecord } from "./lib";

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
  let navigated = false; // any wheel/drag while peeked = the user aimed somewhere → dive on release

  const restore = () => {
    if (!prePeek) return;
    const from = prePeek;
    prePeek = null;
    m.flyTo(from);
  };

  // The tap test: a wheel (two-finger pan / pinch) or a pointer press (drag pan) during the peek means
  // the user moved the view toward a target. No such input → the release just bounces home.
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
    // Dive: zoom in around the screen centre to the zoom you left. screenToPage reads the camera as
    // currently drawn — mid-flight included — so the target is whatever sits in the middle right now.
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const p = m.camera.screenToPage({ x: cx, y: cy });
    const z = from.z;
    m.flyTo({ x: cx - p.x * z, y: cy - p.y * z, z });
    opts.onDive?.(from);
  };

  // Cmd-tab / window switch mid-hold: the keyup will never arrive; end the peek where it began.
  const onBlur = () => restore();

  el.addEventListener("wheel", onNavigate, { passive: true });
  el.addEventListener("pointerdown", onNavigate);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    el.removeEventListener("wheel", onNavigate);
    el.removeEventListener("pointerdown", onNavigate);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
