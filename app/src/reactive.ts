import { useCallback, useSyncExternalStore } from "react";
import type { Subscribable } from "./lib";

// The channel-1 handle → React bridge, verbatim from app/src/reactive.ts: Subscribable<T> IS the
// useSyncExternalStore contract, so a component re-renders only when the entity it reads changes. The
// closures preserve `this` for handles that are our Observable instances (camera, selection, marquee).
export function useSignal<T>(s: Subscribable<T>): T {
  const subscribe = useCallback((onChange: () => void) => s.subscribe(onChange), [s]);
  const get = useCallback(() => s.get(), [s]);
  return useSyncExternalStore(subscribe, get);
}

// Subscribe to a PROJECTION of a handle's value: the component re-renders only when the selected
// slice changes (useSyncExternalStore compares snapshots with Object.is). This is how a component
// that needs just `camera.z` sleeps through every pan tick — the camera fires per frame, but the
// projected snapshot is unchanged so React bails before render. Pass a stable (module-level) selector.
export function useSignalValue<T, V>(s: Subscribable<T>, select: (v: T) => V): V {
  const subscribe = useCallback((onChange: () => void) => s.subscribe(onChange), [s]);
  const get = useCallback(() => select(s.get()), [s, select]);
  return useSyncExternalStore(subscribe, get);
}
