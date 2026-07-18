import type { RecordsDiff, Subscribable } from "./lib";
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

// Server frames, multiplexed by `ch`: a feed value, a committed board DIFF for this tab's board (design
// §9 stage 2 — the server commits a bus command and pushes the resulting diff + its authoritative seq,
// not the command), or a file event for a subscribed root.
interface ServerFrame {
  ch: "feed" | "bus" | "watch";
  feed?: string;
  value?: unknown;
  diff?: RecordsDiff;
  seq?: number;
  root?: string;
  dir?: string; // a watch frame's directory — the board scopes its watch to (root, dir) pairs, not roots
  ev?: { type: string; path: string };
}
/** A committed diff pushed over the bus: the record changes to apply as a "remote" change + the server's
 *  authoritative seq for the tab's Persistence mirror to adopt (§10). */
export interface BusDiff {
  diff: RecordsDiff;
  seq: number;
}

const values = new Map<string, unknown>();
const subs = new Map<string, Set<() => void>>();
const busSubs = new Set<(diff: RecordsDiff, seq: number) => void>();
// Bus diffs that arrived before a consumer registered. The socket opens on the FIRST subscription of
// ANY kind (a feed card during render), but connectAgentBus — the one bus consumer — registers later, in
// a post-mount effect. Without this queue a diff in that gap is dropped, which is exactly when a peer/agent
// commits while this tab is still booting. Queue when there's no consumer; drained to the first busSub.
// Bounded (generous) against an unbounded no-consumer run.
const pendingBus: BusDiff[] = [];
const MAX_PENDING_BUS = 1000;
// Per-(root, dir) file-watch subscribers, keyed by watchKey below. The board watches DIRECTORIES that hold a
// live dependency, not whole roots (docs/root-watcher-fd-scaling.md), so this map is keyed on the pair and
// refcounts the (usually one) subscriber per directory — first-in sends {sub}, last-out sends {unsub}.
const watchSubs = new Map<string, Set<(ev: { type: string; path: string }) => void>>();
// (root, dir) → one key. NUL can't occur in a path or a root slug (same convention as content.ts / the
// server's watchKey), so it's an unambiguous separator; split() recovers the pair for the reconnect re-send.
const watchKey = (root: string, dir: string): string => root + "\0" + dir;
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

// Is the shared feed socket currently OPEN? A thread post relies on the WS feed echo to render its bubble,
// so the composer checks this at send time: an open socket means the echo is coming; a closed one (a
// dev-server restart just dropped it) means we must show an honest "posted — reconnecting…" instead of a
// bubble that would otherwise only appear on reconnect. A one-shot read, not reactive — pair it with
// onFeedsReconnect to learn when the socket returns.
export function feedsConnected(): boolean {
  return ws != null && ws.readyState === WebSocket.OPEN;
}

// A stable per-tab id sent to the server as ?tab= so tabCountFor dedupes the brief board-switch overlap
// (a board switch is a full-page nav — location.assign — so the old page's socket may linger until the
// server's heartbeat reaper takes it, while the new page's socket is already up). sessionStorage is
// per-tab and survives a same-tab navigation, so both sockets carry the SAME id → counted as one tab; a
// genuinely second tab gets its own sessionStorage → its own id → counted separately. Falls back to a
// fresh random on any storage failure (private-mode quotas) — a fallback tab just isn't deduped, which is
// the pre-existing behaviour, never an over-count crash.
let cachedTabId: string | null = null;
function tabId(): string {
  if (cachedTabId) return cachedTabId;
  const fresh = crypto.randomUUID();
  try {
    let id = sessionStorage.getItem("canvas.tabId");
    if (!id) sessionStorage.setItem("canvas.tabId", (id = fresh));
    return (cachedTabId = id);
  } catch {
    return (cachedTabId = fresh);
  }
}

// One socket for the page's life, opened on first subscription. WebSocket doesn't auto-reconnect the
// way EventSource did, so a close schedules a retry (same 2s cadence the SSE `retry:` advertised); the
// server replays feed values on connect, and onopen re-sends the active watch subscriptions.
function ensureConnected(): void {
  if (ws) return;
  const sock = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?board=${activeBoardId()}&tab=${tabId()}`,
  );
  ws = sock;
  sock.onmessage = (ev) => {
    const frame = JSON.parse(ev.data as string) as ServerFrame;
    if (frame.ch === "feed" && frame.feed != null) {
      values.set(frame.feed, frame.value);
      for (const fn of subs.get(frame.feed) ?? []) fn();
    } else if (frame.ch === "bus" && frame.diff && typeof frame.seq === "number") {
      const busDiff: BusDiff = { diff: frame.diff, seq: frame.seq };
      if (busSubs.size === 0) {
        pendingBus.push(busDiff); // no consumer yet — hold it (see pendingBus above)
        if (pendingBus.length > MAX_PENDING_BUS) pendingBus.shift();
      } else for (const fn of busSubs) fn(busDiff.diff, busDiff.seq);
    } else if (frame.ch === "watch" && frame.root != null && frame.dir != null && frame.ev) {
      for (const fn of watchSubs.get(watchKey(frame.root, frame.dir)) ?? []) fn(frame.ev);
    }
  };
  // onopen fires on every successful (re)connection; skip the first so only a genuine reconnect — where
  // the server may have restarted with empty feed state — triggers the re-arm.
  sock.onopen = () => {
    // Re-arm every live (root, dir) watch — the server lost its per-socket watchers on the drop.
    for (const k of watchSubs.keys()) {
      const sep = k.indexOf("\0");
      sock.send(JSON.stringify({ sub: "watch", root: k.slice(0, sep), dir: k.slice(sep + 1) }));
    }
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

// The agent-bus diff stream (agentBus.ts is the one consumer): the server commits every command an agent
// POSTs to /api/command for this tab's board and pushes the resulting diff + authoritative seq here, to be
// applied via store.applyDiffAsChange(diff, "remote") — never re-committed (design §9 stage 2).
export function onBusDiff(fn: (diff: RecordsDiff, seq: number) => void): () => void {
  const firstConsumer = busSubs.size === 0;
  busSubs.add(fn);
  ensureConnected();
  // Drain anything that arrived before this first consumer (a peer's edit during boot) so it isn't lost —
  // the raison d'être of pendingBus above.
  if (firstConsumer && pendingBus.length) {
    const queued = pendingBus.splice(0, pendingBus.length);
    for (const d of queued) for (const g of busSubs) g(d.diff, d.seq);
  }
  return () => busSubs.delete(fn);
}

// Per-(root, dir) file-watch events (the loader's dependency reconciler is the one consumer): the board
// subscribes the DIRECTORIES that back live cards / loaded listings / annotations, so a giant mounted
// checkout never opens a watcher for a file nobody carded (docs/root-watcher-fd-scaling.md). {sub:"watch",
// root, dir} rides the shared socket; the server runs one depth-0 chokidar watcher per (socket, root, dir)
// and streams {type, path} events (path root-relative) back tagged with (root, dir). Refcounted: the FIRST
// subscriber of a (root, dir) sends the sub, the LAST to leave sends the unsub (closing the server watcher).
export function subscribeWatch(root: string, dir: string, fn: (ev: { type: string; path: string }) => void): () => void {
  const k = watchKey(root, dir);
  let set = watchSubs.get(k);
  const firstForDir = !set;
  if (!set) watchSubs.set(k, (set = new Set()));
  set.add(fn);
  ensureConnected();
  // A CONNECTING socket is covered by onopen's re-send loop; an OPEN one needs the sub sent now.
  if (firstForDir && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ sub: "watch", root, dir }));
  return () => {
    set.delete(fn);
    if (set.size === 0) {
      watchSubs.delete(k);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ unsub: "watch", root, dir }));
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
