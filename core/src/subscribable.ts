import { react, type Signal } from "@tldraw/state";

// Channel 1 (doc §8.1.1) — the reactive-handle channel: pull-shaped, per-entity.
// The ONE interface the view layer sees. The signals *library* (@tldraw/state / signia)
// is hidden behind this, so it can be swapped (TC39 signals, preact, …) without touching
// renderers. Proven end-to-end through React (useSyncExternalStore) and Solid (`from`) in
// ../browser-spike. Copied verbatim from there on purpose: this is a settled seam.
export interface Subscribable<T> {
  get(): T;
  // Fires onChange AFTER the value changes (useSyncExternalStore / Solid `from` contract).
  subscribe(onChange: () => void): () => void;
}

export function toSubscribable<T>(signal: Signal<T>): Subscribable<T> {
  return {
    get: () => signal.get(),
    subscribe(onChange) {
      let primed = false;
      return react("subscribable", () => {
        signal.get(); // establish the dependency
        if (!primed) {
          primed = true; // signia's react() runs once immediately; skip that priming run
          return;
        }
        onChange();
      });
    },
  };
}
