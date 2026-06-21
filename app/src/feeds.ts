import type { Subscribable } from "./lib";

// Off-log FEED signals — the clock's pattern generalized (demo §10: each feed is "the clock with a
// fetch in it"). One shared EventSource on /api/feeds carries every named feed; feedSignal(name)
// exposes one as the same Subscribable<T> seam the store's channel-1 handles use, so a feed card's
// body subscribes exactly like a file card subscribes to its node record — and the renderer can't
// tell them apart. Nothing here ever calls editor.commit: a feed value touches no diff, no intent
// event, no persistence, no git. Only the CARD (its existence + position) is authored state.

export interface GitHead {
  sha: string;
  author: string;
  message: string;
  ts: number; // commit time, epoch ms
}

export interface HnStory {
  id: number;
  title: string;
  by: string;
  score: number;
}

interface FeedFrame {
  feed: string;
  value: unknown;
}

const values = new Map<string, unknown>();
const subs = new Map<string, Set<() => void>>();
let es: EventSource | null = null;

// One connection for all feeds, opened on first subscription and kept for the page's life (a spike,
// not a connection manager — EventSource auto-reconnects, and the server replays last values).
function ensureConnected(): void {
  if (es) return;
  es = new EventSource("/api/feeds");
  es.onmessage = (ev) => {
    const { feed, value } = JSON.parse(ev.data) as FeedFrame;
    values.set(feed, value);
    for (const fn of subs.get(feed) ?? []) fn();
  };
}

const signals = new Map<string, Subscribable<unknown>>();

export function feedSignal<T>(name: string): Subscribable<T | undefined> {
  let s = signals.get(name);
  if (!s) {
    s = {
      get: () => values.get(name),
      subscribe(onChange) {
        ensureConnected();
        let set = subs.get(name);
        if (!set) subs.set(name, (set = new Set()));
        set.add(onChange);
        return () => set!.delete(onChange);
      },
    };
    signals.set(name, s);
  }
  return s as Subscribable<T | undefined>;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// "how long ago", coarse and friendly — for the HEAD card's meta line.
export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
