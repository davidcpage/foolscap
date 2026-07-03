import type { Subscribable } from "./core.js";

// Session-tier reactive value (doc §8.4: session = ephemeral state — camera, selection, tool, hover).
//
// Deliberately NOT signia. The drag HOT PATH (per-entity node positions, 60fps) lives in the store's
// signia atoms and is reached through gestures; session state changes are coarse (a selection set, a
// camera pose) and single-writer, so they need a value + listener set, not dependency tracking or
// computeds. Owning this ~20-line primitive keeps the interaction package free of the signals library
// and demonstrates that `Subscribable<T>` (the channel-1 handle interface) is implementable by any
// reactive source — the whole point of hiding the library behind that seam.
export class Observable<T> implements Subscribable<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  // Fires onChange AFTER the value changes (the useSyncExternalStore / Solid `from` contract).
  // Object.is guard → setting an equal value is a no-op; callers pass NEW objects/sets for changes.
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const l of this.listeners) l();
  }

  update(fn: (prev: T) => T): void {
    this.set(fn(this.value));
  }

  /** Whether anyone is subscribed — lets a producer skip computing a value nobody would see. */
  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }
}
