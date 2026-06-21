import type { Editor, IntentEvent, Subscribable } from "./lib";

// Channel 3, as a channel-1 handle — the provenance card's data source. The intent log is pull-only
// (by design: append/since/all/describe), so this adapter listens on channel 2 — every log append
// coincides with a channel-2 diff, since both are emitted by the same Editor.commit/Gesture.end —
// and re-pulls the log tail when it has actually GROWN. The growth check is what makes the demo
// honest: channel-2 traffic that appends no intent event (an undo write) and off-log churn (clock
// ticks, feed values — which never reach channel 2 at all) leave the card visibly still. One cached
// snapshot per editor, stable identity until the log moves, so useSyncExternalStore doesn't spin.

export interface LogView {
  events: IntentEvent[]; // newest first
  total: number;
}

const PER_EDITOR = new WeakMap<Editor, Subscribable<LogView>>();
const TAIL = 9;

export function logSignal(editor: Editor): Subscribable<LogView> {
  let s = PER_EDITOR.get(editor);
  if (!s) {
    const snap = (): LogView => {
      const all = editor.log.all();
      return { events: all.slice(-TAIL).reverse(), total: all.length };
    };
    let cached = snap();
    const subs = new Set<() => void>();
    editor.store.listen(() => {
      if (editor.log.all().length === cached.total) return; // ch2 moved, the log didn't (e.g. undo)
      cached = snap();
      for (const fn of subs) fn();
    });
    s = {
      get: () => cached,
      subscribe(onChange) {
        subs.add(onChange);
        return () => subs.delete(onChange);
      },
    };
    PER_EDITOR.set(editor, s);
  }
  return s;
}

export function formatEventTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

// Who-touched-this, off the log: nodeId → the actor of the last intent event whose diff touched the
// node (its layout record counts as the node — a drag is a touch). Same growth-cached fold as
// logSignal; O(log) per rebuild, spike-cheap. The view decides which actors are badge-worthy.
const ACTORS = new WeakMap<Editor, Subscribable<Map<string, string>>>();

export function actorsSignal(editor: Editor): Subscribable<Map<string, string>> {
  let s = ACTORS.get(editor);
  if (!s) {
    let total = -1;
    let cached = new Map<string, string>();
    const snap = () => {
      const all = editor.log.all();
      total = all.length;
      const map = new Map<string, string>();
      for (const e of all) {
        for (const id of [
          ...Object.keys(e.diff.added),
          ...Object.keys(e.diff.updated),
          ...Object.keys(e.diff.removed),
        ]) {
          const nodeId = id.startsWith("layout:") ? id.slice("layout:".length) : id;
          if (nodeId.startsWith("node:")) map.set(nodeId, e.actor);
        }
      }
      return map;
    };
    cached = snap();
    const subs = new Set<() => void>();
    editor.store.listen(() => {
      if (editor.log.all().length === total) return;
      cached = snap();
      for (const fn of subs) fn();
    });
    s = {
      get: () => cached,
      subscribe(onChange) {
        subs.add(onChange);
        return () => subs.delete(onChange);
      },
    };
    ACTORS.set(editor, s);
  }
  return s;
}
