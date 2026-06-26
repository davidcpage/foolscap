// Carry ephemeral view state across a full page reload (doc §8.4: session tier, the most volatile
// rung — never the document, never the log). The camera already survives a reload via session.ts; this
// covers the rest of what a reload silently drops: which card interiors were scrolled and where, and
// which input was focused (with its caret and any half-typed, uncommitted text). It exists for ONE
// annoyance: editing vite-fs-plugin.ts is a config-dependency change, so Vite restarts the dev server
// and full-reloads the tab — losing your scroll-back position and the message you were typing into a
// session card. An agent iterating on that file triggers this repeatedly. We snapshot on pagehide and
// restore once the board has re-rendered, making the reload near-invisible.
//
// Scope is deliberately narrow and best-effort: sessionStorage (per-tab, cleared on tab close), all
// failures swallowed, and a bounded restore window — cards mount asynchronously (idb hydration, then
// per-type template load), so a target may not exist yet when restore first runs. Keying is by the
// card's logged identity (`data-node-id`, NodeView's host attribute) plus a structural index, so it
// survives the DOM being rebuilt from scratch. Nothing here touches channel 1/2/3 — it's host chrome,
// the same category as scroll position itself.

const KEY = "canvas-notes:viewstate";

// A scrolled card interior: the host's node id, the index of the scroll container among that host's
// overflow:auto/scroll candidates (stable across reload — it's CSS-driven, not content-driven), and
// the offsets to restore. Only non-zero scrolls are recorded.
interface ScrollSnap {
  nodeId: string;
  idx: number;
  top: number;
  left: number;
}

// The focused field, if focus was inside a card interior on an input/textarea (the canvas itself
// re-focuses on its own, so we don't record that). `idx` indexes the host's focusable fields; value +
// caret restore the in-progress message a reload would otherwise drop.
interface FocusSnap {
  nodeId: string;
  idx: number;
  value: string;
  start: number | null;
  end: number | null;
}

interface Snapshot {
  scrolls: ScrollSnap[];
  focus: FocusSnap | null;
}

// The overflow:auto/scroll scroll candidates of a host (the host ITSELF first, then its descendants),
// in document order. The SAME query runs on capture and restore so an index means the same container
// both times — CSS-driven, so identical across a reload even when card content (turn count, file length)
// has grown. The host is included because some cards (e.g. the notebook) scroll on their `[data-node-id]`
// element directly rather than an inner pane; a descendant-only scan silently missed those.
function scrollContainers(host: Element): HTMLElement[] {
  const scrolls = (s: CSSStyleDeclaration) =>
    s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowX === "auto" || s.overflowX === "scroll";
  const out: HTMLElement[] = [];
  if (host instanceof HTMLElement && scrolls(getComputedStyle(host))) out.push(host);
  for (const el of host.querySelectorAll<HTMLElement>("*")) {
    if (scrolls(getComputedStyle(el))) out.push(el);
  }
  return out;
}

function focusFields(host: Element): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>("input, textarea, [contenteditable=''], [contenteditable='true']"),
  );
}

function capture(): Snapshot {
  const scrolls: ScrollSnap[] = [];
  for (const host of document.querySelectorAll<HTMLElement>("[data-node-id]")) {
    const nodeId = host.dataset.nodeId;
    if (!nodeId) continue;
    scrollContainers(host).forEach((el, idx) => {
      if (el.scrollTop > 0 || el.scrollLeft > 0)
        scrolls.push({ nodeId, idx, top: el.scrollTop, left: el.scrollLeft });
    });
  }

  let focus: FocusSnap | null = null;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const host = active.closest<HTMLElement>("[data-node-id]");
    const nodeId = host?.dataset.nodeId;
    if (host && nodeId) {
      const idx = focusFields(host).indexOf(active);
      if (idx >= 0) {
        const field = active as HTMLInputElement | HTMLTextAreaElement;
        focus = {
          nodeId,
          idx,
          value: "value" in field ? field.value : "",
          start: "selectionStart" in field ? field.selectionStart : null,
          end: "selectionEnd" in field ? field.selectionEnd : null,
        };
      }
    }
  }

  return { scrolls, focus };
}

function host(nodeId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
}

// Apply one pending scroll if its container is in the DOM. Returns true once applied (so the caller
// drops it from the pending set and stops retrying it).
function applyScroll(s: ScrollSnap): boolean {
  const h = host(s.nodeId);
  if (!h) return false;
  const el = scrollContainers(h)[s.idx];
  if (!el) return false;
  el.scrollTop = s.top;
  el.scrollLeft = s.left;
  return true;
}

function applyFocus(f: FocusSnap): boolean {
  const h = host(f.nodeId);
  if (!h) return false;
  const el = focusFields(h)[f.idx];
  if (!el) return false;
  // Only restore the typed text into an input/textarea that's still empty — never clobber content the
  // user (or the card) has put there since. lit doesn't bind .value on the session input, so a direct
  // set sticks across its re-renders.
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  if ("value" in field && field.value === "" && f.value) {
    field.value = f.value;
    field.dispatchEvent(new Event("input", { bubbles: true })); // let the card react (slash menu, etc.)
  }
  el.focus({ preventScroll: true });
  if (f.start != null && "setSelectionRange" in field) {
    try {
      field.setSelectionRange(f.start, f.end ?? f.start);
    } catch {
      /* selection unsupported on this input type — focus alone is enough */
    }
  }
  return true;
}

// Restore everything in the snapshot, retrying on each animation frame for a bounded window because
// cards mount asynchronously (idb hydrate → template load). Each item applies at most once; we stop
// when all have landed or the window closes. ~2.5s comfortably covers a cold hydrate without leaving a
// frame loop running if a target card was deleted before the reload.
function restore(snap: Snapshot): void {
  const pendingScrolls = [...snap.scrolls];
  let pendingFocus = snap.focus;
  const deadline = performance.now() + 2500;

  const tick = () => {
    for (let i = pendingScrolls.length - 1; i >= 0; i--) {
      if (applyScroll(pendingScrolls[i])) pendingScrolls.splice(i, 1);
    }
    if (pendingFocus && applyFocus(pendingFocus)) pendingFocus = null;
    if ((pendingScrolls.length || pendingFocus) && performance.now() < deadline)
      requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Wire capture-on-unload + restore-on-boot. Called once from the Board. Returns a teardown that
// removes the listener (for React's effect cleanup / StrictMode double-mount). pagehide fires on a
// dev-server-restart reload where beforeunload can be flaky; we use it as the single capture point.
export function preserveViewState(): () => void {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      sessionStorage.removeItem(KEY); // consume once — a later manual reload starts clean
      restore(JSON.parse(raw) as Snapshot);
    }
  } catch {
    /* unreadable / corrupt storage — nothing to restore */
  }

  const onHide = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(capture()));
    } catch {
      /* unwritable storage (private mode, quota) — a lost viewport is cosmetic */
    }
  };
  window.addEventListener("pagehide", onHide);
  return () => window.removeEventListener("pagehide", onHide);
}
