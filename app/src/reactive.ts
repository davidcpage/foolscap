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
