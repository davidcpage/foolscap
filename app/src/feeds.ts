import type { Subscribable } from "./lib";
import { activeBoardId } from "./board";

// Off-log FEED signals — the clock's pattern generalized (demo §10: each feed is "the clock with a
// fetch in it"). ONE shared WebSocket (/api/ws) carries every named feed — plus the agent-bus command
// stream (onBusCommand) and the per-root file-watch events (subscribeWatch); feedSignal(name) exposes
// a feed as the same Subscribable<T> seam the store's channel-1 handles use, so a feed card's body
// subscribes exactly like a file card subscribes to its node record — and the renderer can't tell
// them apart. Nothing here ever calls editor.commit: a feed value touches no diff, no intent event,
// no persistence, no git. Only the CARD (its existence + position) is authored state.
//
// Why a WebSocket and not the three EventSources this file's consumers used to hold: each standing SSE
// stream occupied one of the browser's SIX per-host HTTP/1.1 connection slots, so ~3 tabs exhausted the
// pool and every later request — the page itself, the template registry's fetches — queued forever with
// no error anywhere (the 2026-07-02 "no template for type …" / forever-Pending bug). WebSockets live in
// a separate, much larger browser budget, so tabs no longer compete with request/response traffic.

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

// Server frames, multiplexed by `ch`: a feed value, a bus command for this tab's board, or a file
// event for a subscribed root.
export interface BusCommand {
  type: string;
  payload?: Record<string, unknown>;
  actor?: string;
}
interface ServerFrame {
  ch: "feed" | "bus" | "watch";
  feed?: string;
  value?: unknown;
  cmd?: BusCommand;
  root?: string;
  ev?: { type: string; path: string };
}

const values = new Map<string, unknown>();
const subs = new Map<string, Set<() => void>>();
const busSubs = new Set<(cmd: BusCommand) => void>();
const watchSubs = new Map<string, Set<(ev: { type: string; path: string }) => void>>();
let ws: WebSocket | null = null;
let connectedOnce = false;

// Fired when the socket RECONNECTS after a drop (not the first connect). Some feeds carry
// server-side state a restart loses and only a client request rebuilds: a session card's file-tail is
// armed by GET /api/session, so after a cold server restart (browser left open) the card goes stale until
// something re-arms it. Listeners (App.tsx, templates.ts) re-run the same re-projection a page reload does.
const reconnectListeners = new Set<() => void>();
export function onFeedsReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

// One socket for the page's life, opened on first subscription. WebSocket doesn't auto-reconnect the
// way EventSource did, so a close schedules a retry (same 2s cadence the SSE `retry:` advertised); the
// server replays feed values on connect, and onopen re-sends the active watch subscriptions.
function ensureConnected(): void {
  if (ws) return;
  const sock = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?board=${activeBoardId()}`,
  );
  ws = sock;
  sock.onmessage = (ev) => {
    const frame = JSON.parse(ev.data as string) as ServerFrame;
    if (frame.ch === "feed" && frame.feed != null) {
      values.set(frame.feed, frame.value);
      for (const fn of subs.get(frame.feed) ?? []) fn();
    } else if (frame.ch === "bus" && frame.cmd) {
      for (const fn of busSubs) fn(frame.cmd);
    } else if (frame.ch === "watch" && frame.root != null && frame.ev) {
      for (const fn of watchSubs.get(frame.root) ?? []) fn(frame.ev);
    }
  };
  // onopen fires on every successful (re)connection; skip the first so only a genuine reconnect — where
  // the server may have restarted with empty feed state — triggers the re-arm.
  sock.onopen = () => {
    for (const root of watchSubs.keys()) sock.send(JSON.stringify({ sub: "watch", root }));
    if (connectedOnce) for (const fn of reconnectListeners) fn();
    connectedOnce = true;
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setTimeout(() => {
      if (!ws && (subs.size || busSubs.size || watchSubs.size)) ensureConnected();
    }, 2000);
  };
}

// The agent-bus command stream (agentBus.ts is the one consumer): every Command an agent POSTs to
// /api/command for this tab's board arrives here, to be run through editor.commit.
export function onBusCommand(fn: (cmd: BusCommand) => void): () => void {
  busSubs.add(fn);
  ensureConnected();
  return () => busSubs.delete(fn);
}

// Per-root file-watch events (loader.watchDataset is the one consumer): {sub:"watch", root} rides the
// shared socket, the server runs one chokidar watcher per (socket, root) and streams {type, path}
// events back. Unsubscribing the last listener of a root closes the server-side watcher.
export function subscribeWatch(root: string, fn: (ev: { type: string; path: string }) => void): () => void {
  let set = watchSubs.get(root);
  const firstForRoot = !set;
  if (!set) watchSubs.set(root, (set = new Set()));
  set.add(fn);
  ensureConnected();
  // A CONNECTING socket is covered by onopen's re-send loop; an OPEN one needs the sub sent now.
  if (firstForRoot && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ sub: "watch", root }));
  return () => {
    set.delete(fn);
    if (set.size === 0) {
      watchSubs.delete(root);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ unsub: "watch", root }));
    }
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
