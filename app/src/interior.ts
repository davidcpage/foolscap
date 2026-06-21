// Interior interaction for cards (agent-sessions-on-canvas.md — the seam the session card needs and
// the live terminal card forces). The canvas owns the wheel and hit-tests cards geometrically
// (interaction/src/input.ts), so a card interior cannot scroll or be clicked by default — file
// bodies are clipped for exactly this reason. This module adds the narrowest escape hatch: a card
// region that is ACTUALLY scrollable (overflow + content taller than the box) captures the wheel and
// the arrow keys, while everything else still bubbles to the canvas for pan/zoom. The shared
// interaction engine stays untouched; this is a renderer concern — scroll position is ephemeral view
// state in the DOM, never a record, never the log (the disjoint-state split at the interior level).

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
