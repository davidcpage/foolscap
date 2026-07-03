// Hold-to-peek navigation (wayfinding's "quick zoom"): hold `z` and the camera flies out to frame the
// whole board; move the cursor over where you want to be; release and it dives back in, centring that
// point at the zoom you left. One hold-move-release replaces the zoom-out → pan → zoom-in triple that
// getting across a busy board otherwise costs. Escape (or the window losing focus) mid-hold cancels
// the round trip and restores the exact starting pose; so does releasing without having moved the
// cursor — a stray tap of `z` bounces home, it doesn't re-centre underneath you.
//
// Renderer-level like the rest of wayfinding (views.ts, the number-row keymap): composed entirely from
// manager primitives (fitAll, flyTo, camera transforms), no engine change. Keys are bound on the canvas
// element, so card interiors that contain their keydown (inputs, textareas) keep the key for typing —
// holding z in a thread post box types "zzz", it doesn't peek.

import type { CameraState, InteractionManager, LayoutRecord } from "./lib";

const MOVE_THRESHOLD_PX = 4; // cursor travel below this = a tap → restore, not dive

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
  let moved = false;

  const restore = () => {
    if (!prePeek) return;
    const from = prePeek;
    prePeek = null;
    m.flyTo(from);
  };

  const onPointerMove = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY };
    if (prePeek && origin && !moved) {
      moved = Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_THRESHOLD_PX;
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
    moved = false;
    m.fitAll(opts.skipLayout); // no-ops on an empty board; keyup then just bounces home
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if ((e.key !== "z" && e.key !== "Z") || !prePeek) return;
    if (!moved || !last) {
      restore(); // a tap, or the cursor was never seen: round-trip to the starting pose
      return;
    }
    const from = prePeek;
    prePeek = null;
    // Dive: centre the page point under the cursor at the zoom you left. screenToPage reads the camera
    // as currently drawn — mid-flight included — so the target is whatever the eye is on right now.
    const rect = el.getBoundingClientRect();
    const p = m.camera.screenToPage({ x: last.x - rect.left, y: last.y - rect.top });
    const z = from.z;
    m.flyTo({ x: rect.width / 2 - p.x * z, y: rect.height / 2 - p.y * z, z });
    opts.onDive?.(from);
  };

  // Cmd-tab / window switch mid-hold: the keyup will never arrive; end the peek where it began.
  const onBlur = () => restore();

  el.addEventListener("pointermove", onPointerMove, { passive: true });
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
