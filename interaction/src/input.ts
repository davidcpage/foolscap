import { vec, type Vec } from "./geometry.js";

// The framework- and DOM-agnostic input vocabulary. Tools and the manager speak ONLY these; the one
// place that touches the DOM is bindDom() at the bottom. Points are SCREEN coordinates relative to
// the canvas element's top-left (the camera turns them into page coordinates). Keeping this vocabulary
// tiny and synthetic is what lets the whole interaction layer be unit-tested in Node with no browser
// (mirroring the core's node:test suites) — the renderer choice (React/Solid) stays orthogonal.

export interface ModifierState {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface PointerInput extends ModifierState {
  type: "pointerdown" | "pointermove" | "pointerup";
  point: Vec;
  button: number; // 0 = primary/left, 1 = middle, 2 = right
}

export interface WheelInput extends ModifierState {
  type: "wheel";
  point: Vec;
  deltaX: number;
  deltaY: number;
}

export interface KeyInput extends ModifierState {
  type: "keydown" | "keyup";
  key: string;
}

export type InputEvent = PointerInput | WheelInput | KeyInput;

const mods = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): ModifierState => ({
  shiftKey: e.shiftKey,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  altKey: e.altKey,
});

/**
 * Bind native pointer/wheel/key events on a canvas element and normalize them into InputEvents fed to
 * `dispatch`. The ONLY DOM-coupled code in the package; the Node tests bypass it and call
 * `manager.dispatch(...)` with synthetic events directly. Uses Pointer Events (one stream for
 * mouse/touch/pen) + setPointerCapture so a drag that leaves the element still reports moves/up.
 * Returns a cleanup that removes every listener.
 */
export function bindDom(el: HTMLElement, dispatch: (e: InputEvent) => void): () => void {
  // The element's client rect, CACHED. getBoundingClientRect on every pointermove/wheel forces a
  // layout flush right after the previous event's DOM mutation (the .page transform) — classic
  // read-after-write thrashing on the two hottest events. The rect only changes when the canvas
  // element moves or resizes, so read it lazily once and invalidate on the things that move it
  // (resize, any ancestor scroll) plus every gesture start as a cheap catch-all.
  let rect: DOMRect | null = null;
  const invalidateRect = () => {
    rect = null;
  };
  const toLocal = (clientX: number, clientY: number): Vec => {
    if (!rect) rect = el.getBoundingClientRect();
    return vec(clientX - rect.left, clientY - rect.top);
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(invalidateRect) : null;
  ro?.observe(el);

  // Track ONE active pointer through a gesture. A second pointer (a stray trackpad/touch contact
  // during a drag) is ignored entirely — otherwise its pointerdown would re-enter the active tool
  // mid-gesture and orphan the open gesture buffer. `lastPoint` is the last position seen, used to
  // close the gesture at a sane place if the pointer is cancelled.
  let activeId: number | null = null;
  let lastPoint: Vec = vec(0, 0);

  const onPointerDown = (e: PointerEvent) => {
    if (activeId !== null) return; // already mid-gesture with another pointer → ignore this one
    invalidateRect(); // one fresh rect per gesture — catches layout moves no listener below saw
    activeId = e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    lastPoint = toLocal(e.clientX, e.clientY);
    dispatch({ type: "pointerdown", point: lastPoint, button: e.button, ...mods(e) });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (activeId !== null && e.pointerId !== activeId) return; // secondary pointer mid-gesture
    lastPoint = toLocal(e.clientX, e.clientY); // hover moves (activeId null) still update + dispatch
    dispatch({ type: "pointermove", point: lastPoint, button: e.button, ...mods(e) });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (activeId !== null && e.pointerId !== activeId) return;
    activeId = null;
    el.releasePointerCapture?.(e.pointerId);
    dispatch({ type: "pointerup", point: toLocal(e.clientX, e.clientY), button: e.button, ...mods(e) });
  };
  // The OS/browser interrupted the gesture (touch stolen, pointer invalidated): no pointerup will
  // come. Synthesize one at the last known point so the active tool finalizes its gesture (committing
  // the drag where it visibly is) instead of leaving the store buffer open and wedging the next drag.
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    dispatch({ type: "pointerup", point: lastPoint, button: e.button, ...mods(e) });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault(); // we own zoom/pan; stop the page from scrolling
    // Normalize to PIXELS. Many mice (and some browsers) report wheel deltas in LINES (deltaMode 1,
    // ~±3/notch) or PAGES (deltaMode 2); feeding those raw made one wheel notch a ~0.4% zoom step,
    // which read as "zoom barely does anything". Scale lines by a nominal line height and pages by the
    // element's height so downstream pan/zoom speak one unit (CSS pixels) regardless of device.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight || 800 : 1;
    dispatch({
      type: "wheel",
      point: toLocal(e.clientX, e.clientY),
      deltaX: e.deltaX * scale,
      deltaY: e.deltaY * scale,
      ...mods(e),
    });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Space is the hold-to-pan key (handled in the manager); swallow its default so the page doesn't
    // scroll and a focused control doesn't get "clicked" while you're panning.
    if (e.key === " ") e.preventDefault();
    dispatch({ type: "keydown", key: e.key, ...mods(e) });
  };
  const onKeyUp = (e: KeyboardEvent) => dispatch({ type: "keyup", key: e.key, ...mods(e) });
  // Middle button = pan; preventing its default mousedown stops the browser's middle-click autoscroll
  // (the four-way scroll puck) from hijacking the gesture. The pointerdown still fires (focus intact).
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("mousedown", onMouseDown);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", invalidateRect);
  window.addEventListener("scroll", invalidateRect, { capture: true, passive: true });

  return () => {
    ro?.disconnect();
    window.removeEventListener("resize", invalidateRect);
    window.removeEventListener("scroll", invalidateRect, { capture: true });
    el.removeEventListener("mousedown", onMouseDown);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
  };
}
