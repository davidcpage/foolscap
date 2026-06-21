import type { Subscribable } from "./lib";

// An OFF-LOG reactive value — the complement to the file cards. A clock card is a real `node` in the
// store, so its SPATIAL state (position, existence, z, draggability) rides the same logged path as any
// card: addNode/moveNode go through editor.commit → channel-2 diff → channel-3 intent event. But its
// DISPLAYED VALUE — the ticking time — comes from THIS signal, which never calls commit. The tick touches
// no diff, no intent-log event, no persistence, no git; it just re-renders the one card. That's the
// separation the architecture promises stated in the negative: derived/ephemeral state stays out of
// provenance and sync, while still reaching the view through the IDENTICAL channel-1 Subscribable seam the
// store signals use (useSignal → useSyncExternalStore). The renderer can't tell logged state from this.
//
// In production this would be a signia atom behind core's `toSubscribable`; hand-rolled here so the spike
// keeps its two rules intact — engines untouched, and @tldraw/state never imported directly. The view path
// is byte-for-byte the same either way, which is exactly the point of hiding the substrate behind Subscribable.
export const nowSignal: Subscribable<number> = (() => {
  let now = Date.now();
  const subs = new Set<() => void>();
  setInterval(() => {
    now = Date.now();
    for (const fn of subs) fn();
  }, 1000);
  return {
    get: () => now,
    subscribe(onChange) {
      subs.add(onChange);
      return () => subs.delete(onChange);
    },
  };
})();

// formatClock/handAngles moved into card-types/clock/render.js: the clock's FACE is now data in
// the folder (card-types-as-data.md §7), and a template may import nothing from src/. Only the
// off-log signal stays here, granted to the template as the `now` capability.
