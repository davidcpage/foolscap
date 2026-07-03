// Interior interaction for cards (agent-sessions-on-canvas.md — the seam the session card needs and
// the live terminal card forces). The canvas owns the wheel and hit-tests cards geometrically
// (interaction/src/input.ts), so a card interior cannot scroll or be clicked by default — file
// bodies are clipped for exactly this reason. This module adds the narrowest escape hatch: a card
// region that is ACTUALLY scrollable (overflow + content taller than the box) captures the wheel and
// the arrow keys, while everything else still bubbles to the canvas for pan/zoom. The shared
// interaction engine stays untouched; this is a renderer concern — scroll position is ephemeral view
// state in the DOM, never a record, never the log (the disjoint-state split at the interior level).

// ── The wheel-gesture latch ─────────────────────────────────────────────────
// A two-finger pan moves cards UNDER a stationary cursor, so mid-pan a card's scroller can slide
// beneath the pointer — and since each wheel event hit-tests fresh, the card would claim the very
// next event and the pan turns into a card scroll. Never what the gesture meant. The latch scopes
// ownership to one PHYSICAL gesture: wheel events closer than the gap are one gesture (macOS streams
// them at frame rate, momentum tail included), and whoever owned its first event owns the rest.
// The canvas's bindDom element observes every wheel inside its subtree in capture phase
// (observeWheelGesture, wired in App.tsx); interior handlers consult wheelGestureLatchedToCanvas()
// before claiming and declare a claim with claimWheelGesture(). Deliberately re-scrolling a card
// after a pan still works — lifting the fingers and starting again is a new gesture once the
// momentum tail has faded past the gap.
const WHEEL_GESTURE_GAP_MS = 250;
let lastWheelTs = -Infinity;
let firstOfGesture = true;
let claimed = false;

export function observeWheelGesture(e: WheelEvent): void {
  firstOfGesture = e.timeStamp - lastWheelTs > WHEEL_GESTURE_GAP_MS;
  if (firstOfGesture) claimed = false;
  lastWheelTs = e.timeStamp;
}

export function claimWheelGesture(): void {
  claimed = true;
}

// True when a wheel gesture is mid-flight and its first event fell through to the canvas: an
// interior scroller finding itself under the cursor NOW got there by being panned, not pointed at,
// so it must let the event through.
export function wheelGestureLatchedToCanvas(): boolean {
  return !firstOfGesture && !claimed;
}

function isScrollable(el: Element): boolean {
  const oy = getComputedStyle(el).overflowY;
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
}

// The scrollable region under a wheel event's target, searching from the target up to (and
// including) the card host. Null when the wheel is over a non-scrollable card → the event bubbles on
// to the canvas, which keeps zoom-over-a-clock/file/note working exactly as before.
export function scrollableFromTarget(target: EventTarget | null, host: Element): HTMLElement | null {
  let el = target instanceof Element ? target : null;
  const stop = host.parentElement;
  while (el && el !== stop) {
    if (isScrollable(el)) return el as HTMLElement;
    el = el.parentElement;
  }
  return null;
}

// The scrollable region inside a card host (for the arrow-key path, which starts from the selected
// node, not a pointer). Returns the first scrollable element — the host itself or a descendant.
export function scrollableIn(host: Element): HTMLElement | null {
  if (isScrollable(host)) return host as HTMLElement;
  for (const el of host.querySelectorAll("*")) if (isScrollable(el)) return el as HTMLElement;
  return null;
}

// Apply a scroll key to an element. Returns true when the key was a scroll key (so the caller can
// preventDefault and stop the page/canvas from also acting on it).
export function applyScrollKey(el: HTMLElement, key: string): boolean {
  const line = 48;
  const page = el.clientHeight * 0.9;
  switch (key) {
    case "ArrowDown": el.scrollTop += line; return true;
    case "ArrowUp": el.scrollTop -= line; return true;
    case "PageDown": el.scrollTop += page; return true;
    case "PageUp": el.scrollTop -= page; return true;
    case "Home": el.scrollTop = 0; return true;
    case "End": el.scrollTop = el.scrollHeight; return true;
    default: return false;
  }
}
