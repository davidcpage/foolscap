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

// Fired when the feed stream RECONNECTS after a drop (not the first connect). Some feeds carry
// server-side state a restart loses and only a client request rebuilds: a session card's file-tail is
// armed by GET /api/session, so after a cold server restart (browser left open) the card goes stale until
// something re-arms it. Listeners (App.tsx) re-run the same re-projection a page reload does.
const reconnectListeners = new Set<() => void>();
export function onFeedsReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

// One connection for all feeds, opened on first subscription and kept for the page's life (a spike,
// not a connection manager — EventSource auto-reconnects, and the server replays last values).
function ensureConnected(): void {
  if (es) return;
  let connectedOnce = false;
  es = new EventSource("/api/feeds");
  es.onmessage = (ev) => {
    const { feed, value } = JSON.parse(ev.data) as FeedFrame;
    values.set(feed, value);
    for (const fn of subs.get(feed) ?? []) fn();
  };
  // onopen fires on every successful (re)connection; skip the first so only a genuine reconnect — where
  // the server may have restarted with empty feed state — triggers the re-arm.
  es.onopen = () => {
    if (connectedOnce) for (const fn of reconnectListeners) fn();
    connectedOnce = true;
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
