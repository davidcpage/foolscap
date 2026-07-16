import type { Editor, IntentEvent, Subscribable } from "./lib";

// Channel 3, as a channel-1 handle — the provenance card's data source. The intent log is pull-only
// (by design: append/since/all/describe), so this adapter listens on channel 2 — every log append
// coincides with a channel-2 diff, since both are emitted by the same Editor.commit/Gesture.end —
// and re-pulls the log tail when it has actually GROWN. The growth check is what makes the demo
// honest: channel-2 traffic that appends no intent event (an undo write) and off-log churn (clock
// ticks, feed values — which never reach channel 2 at all) leave the card visibly still. One cached
// snapshot per editor, stable identity until the log moves, so useSyncExternalStore doesn't spin.
//
// ── the lazy history prefix ───────────────────────────────────────────────────────────────────────
// The boot payload ships only the POST-watermark event tail (fast first paint — the absorbed prefix
// hydrates nothing), so `editor.log.all()` starts out holding only that tail plus this session's own
// appends. The FULL log — what the provenance card's tail and the who-touched-this actor badges want —
// is fetched once after first paint and seeded here via seedHistory(). fullLog() then splices that
// immutable historical prefix onto the live mirror, deduped on seq: every live event with a seq the
// history already covers is dropped (it IS in the prefix), and only genuinely newer events (this
// session's edits, made after the fetch) are appended. Until the fetch lands, history is empty and
// fullLog() is just the live mirror — the provenance surface shows the recent tail, then fills in.

interface History {
  events: IntentEvent[]; // the full log as of the lazy fetch, in commit order
  maxSeq: number; // the highest seq it covers — the dedup boundary against the live mirror
}
const HISTORY = new WeakMap<Editor, History>();
// Signals register an invalidator so seedHistory can force a re-pull: the backfill grows the log
// without any channel-2 diff, so the store.listen growth check alone would never notice it.
const INVALIDATORS = new WeakMap<Editor, Set<() => void>>();

/** The full intent log for provenance: the lazily-fetched historical prefix + the live mirror's
 *  genuinely-newer tail (deduped on seq). Just the live mirror until seedHistory() lands. */
function fullLog(editor: Editor): IntentEvent[] {
  const h = HISTORY.get(editor);
  const live = editor.log.all();
  if (!h) return live;
  return [...h.events, ...live.filter((e) => e.seq > h.maxSeq)];
}

function onInvalidate(editor: Editor, fn: () => void): void {
  let set = INVALIDATORS.get(editor);
  if (!set) INVALIDATORS.set(editor, (set = new Set()));
  set.add(fn);
}

/** Seed the full intent log fetched after first paint (App.tsx's lazy /api/board/persist/log read).
 *  Splices in as the history prefix and re-pulls every provenance signal so the card + actor badges
 *  fill in the pre-watermark past the boot tail omitted. Idempotent-ish: a later, longer fetch simply
 *  replaces the prefix. */
export function seedProvenanceHistory(editor: Editor, events: IntentEvent[]): void {
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  HISTORY.set(editor, { events, maxSeq });
  const set = INVALIDATORS.get(editor);
  if (set) for (const fn of set) fn();
}

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
      const all = fullLog(editor);
      return { events: all.slice(-TAIL).reverse(), total: all.length };
    };
    let cached = snap();
    const subs = new Set<() => void>();
    const recompute = () => {
      const next = snap();
      if (next.total === cached.total) return; // log didn't grow (ch2 undo, or an off-log-only diff)
      cached = next;
      for (const fn of subs) fn();
    };
    editor.store.listen(recompute);
    onInvalidate(editor, recompute); // the lazy history backfill grows the log with no ch2 diff
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
    const snap = (all: IntentEvent[]) => {
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
    cached = snap(fullLog(editor));
    const subs = new Set<() => void>();
    const recompute = () => {
      const all = fullLog(editor);
      if (all.length === total) return; // cheap length check FIRST — never re-fold the whole log on an undo/off-log diff
      cached = snap(all);
      for (const fn of subs) fn();
    };
    editor.store.listen(recompute);
    onInvalidate(editor, recompute); // the lazy history backfill grows the log with no ch2 diff
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
