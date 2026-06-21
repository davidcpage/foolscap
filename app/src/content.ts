import type { Subscribable } from "./lib";

// Off-log FILE CONTENT projection — feeds.ts's pattern applied to disk. A file card's body reads its
// content HERE, never from node.text, so the durable intent log holds only the card's ARRANGEMENT (it
// exists, where it sits) and its (root, path) REFERENCE — content churn (an agent hammering a watched
// file) writes nothing to the IndexedDB log. The file on disk is the one source of truth: content is
// fetched on first subscribe and refreshed by the repo watch (loader.ts's watchDataset pushes change
// events here). Like a feed value, a content value touches no diff, no intent event, no persistence,
// no git — nothing here ever calls editor.commit. The clock and the feeds proved this seam for
// generated/external values; this brings the file cards' own bodies onto it too.

// A (root, path) pair flattened to one map key. NUL can't occur in a path, so it's an unambiguous
// separator — the two datasets (and any future root) never collide.
const key = (root: string, path: string): string => root + "\0" + path;

const values = new Map<string, string>();
const subs = new Map<string, Set<() => void>>();
const inflight = new Set<string>(); // paths whose lazy fetch is in progress — de-dupe concurrent subs
const signals = new Map<string, Subscribable<string | undefined>>();

function notify(k: string): void {
  for (const fn of subs.get(k) ?? []) fn();
}

// The file preview projection: the server caps big files, so mark a clipped body honestly. Shared with
// the loader (addFolder/watchDataset seed and refresh the same string shape), so the content a card
// shows is identical whether it came from the initial tree fetch, the watch, or a lazy boot fetch.
export function filePreview(f: { content: string; truncated: boolean }): string {
  return f.truncated ? f.content + "\n…" : f.content;
}

// Push a content value (or clear it on unlink). The INGEST side — called by the loader's folder-add and
// watch; the card side only ever reads. A no-op when unchanged, so a redundant watch event re-renders
// nothing (the same "setText only when changed" bound reprojectContent used to need, now structural).
export function setFileContent(root: string, path: string, content: string | undefined): void {
  const k = key(root, path);
  if (content === undefined) {
    if (!values.has(k)) return;
    values.delete(k);
  } else if (values.get(k) === content) {
    return;
  } else {
    values.set(k, content);
  }
  notify(k);
}

// Pull the current content from disk and cache it. Used to lazily populate a card on first render: a
// returning board hydrates its cards from persistence, but content is off-log, so it isn't in the store
// yet — re-derive it from the one source rather than restoring it from the log. Idempotent across the
// concurrent subscribes a single card's mount can trigger.
async function fetchContent(root: string, path: string): Promise<void> {
  const k = key(root, path);
  if (inflight.has(k)) return;
  inflight.add(k);
  try {
    const r = await fetch(`/api/file?root=${root}&path=${encodeURIComponent(path)}`);
    if (r.ok) setFileContent(root, path, filePreview((await r.json()) as { content: string; truncated: boolean }));
  } catch {
    // offline / gone — leave the cache empty; the card shows an empty body until the next watch event
  } finally {
    inflight.delete(k);
  }
}

// Channel-1 handle for one file's content, keyed by (root, path) — the SAME Subscribable<T> seam the
// store's per-entity handles and the feed signals expose, so a file card subscribes to its content
// exactly as it would to any signal, and the renderer can't tell them apart. First subscribe with no
// cached value triggers a lazy fetch (an already-seeded card — addFolder pre-fills it — skips it).
export function fileContentSignal(root: string, path: string): Subscribable<string | undefined> {
  const k = key(root, path);
  let s = signals.get(k);
  if (!s) {
    s = {
      get: () => values.get(k),
      subscribe(onChange) {
        let set = subs.get(k);
        if (!set) subs.set(k, (set = new Set()));
        set.add(onChange);
        if (!values.has(k)) void fetchContent(root, path);
        return () => set!.delete(onChange);
      },
    };
    signals.set(k, s);
  }
  return s;
}

// ── off-log DIRECTORY LISTING projection (file-trees-on-canvas.md §9) ─────────────────────────────
// The directory card's children, keyed by (root, path), on the EXACT seam fileContentSignal uses: the
// immediate children (sub-dirs + files) are a channel-1 projection of the filesystem, lazily fetched on
// first subscribe (/api/ls — no content), never logged. Browsing inside a directory card touches no
// diff, no intent event, no persistence — it is "derived by default": only DRAGGING a row onto the
// canvas promotes that one path to an authored addNode (loader.materializeAt). A separate value/sub map
// from the file-content one (different value shape), same lazy-on-subscribe mechanics.

export interface DirListing {
  dirs: string[];
  files: string[];
}

const listings = new Map<string, DirListing>();
const listingSubs = new Map<string, Set<() => void>>();
const listingInflight = new Set<string>();
const listingSignals = new Map<string, Subscribable<DirListing | undefined>>();

async function fetchListing(root: string, path: string): Promise<void> {
  const k = key(root, path);
  if (listingInflight.has(k)) return;
  listingInflight.add(k);
  try {
    const r = await fetch(`/api/ls?root=${root}&path=${encodeURIComponent(path)}`);
    if (r.ok) {
      const d = (await r.json()) as { dirs?: string[]; files?: string[] };
      listings.set(k, { dirs: d.dirs ?? [], files: d.files ?? [] });
      for (const fn of listingSubs.get(k) ?? []) fn();
    }
  } catch {
    // offline / gone — leave it unset; the card shows "loading…" until a later subscribe retries
  } finally {
    listingInflight.delete(k);
  }
}

// Channel-1 handle for one directory's immediate children, keyed by (root, path) — the directory card's
// `dirListing` capability resolves through this, exactly as a file card's body resolves through
// fileContentSignal. First subscribe with no cached value lazily fetches /api/ls.
export function dirListingSignal(root: string, path: string): Subscribable<DirListing | undefined> {
  const k = key(root, path);
  let s = listingSignals.get(k);
  if (!s) {
    s = {
      get: () => listings.get(k),
      subscribe(onChange) {
        let set = listingSubs.get(k);
        if (!set) listingSubs.set(k, (set = new Set()));
        set.add(onChange);
        if (!listings.has(k)) void fetchListing(root, path);
        return () => set!.delete(onChange);
      },
    };
    listingSignals.set(k, s);
  }
  return s;
}

// ── off-log SESSION LIST projection (Phase C: the sessions browser card) ──────────────────────────
// The historical agent transcripts on disk (GET /api/sessions), on the SAME lazy-on-subscribe seam as
// dirListingSignal — board-global (not keyed by a path), since the session list IS the disk, not a
// per-card value. The sessions card subscribes to this and drags a row out to open it (loader.openSession,
// the one authored act). Channel-1 / derived: listing transcripts touches no diff, no intent event, no
// persistence — only opening one commits an addNode. The list doesn't have a live push (unlike the repo
// watch), so a card can re-pull it through refreshSessionList(), exposed as the `sessionRefresh` capability.

export interface SessionMeta {
  id: string;
  mtime: number;
  bytes: number;
  title?: string | null; // the agent-written ai-title (or a truncated first prompt); absent if unreadable
  turns?: number; // human turns — user messages carrying text, not tool-result envelopes
  messages?: number; // raw user+assistant record count, every tool iteration included
}

let sessionListValue: SessionMeta[] | undefined;
const sessionListSubs = new Set<() => void>();
let sessionListInflight = false;

async function fetchSessionList(force = false): Promise<void> {
  if (sessionListInflight && !force) return; // a normal lazy fetch de-dupes; a forced refresh always runs
  sessionListInflight = true;
  try {
    const r = await fetch("/api/sessions");
    if (r.ok) {
      const d = (await r.json()) as { sessions?: SessionMeta[] };
      sessionListValue = d.sessions ?? [];
      for (const fn of sessionListSubs) fn();
    }
  } catch {
    // offline — leave it unset; a later subscribe (or a refresh) retries
  } finally {
    sessionListInflight = false;
  }
}

// Re-pull the list and notify subscribers — the sessions card's refresh button. There's no disk-watch
// push for the sessions dir, so this is how a long-open card picks up newly-written transcripts.
export function refreshSessionList(): void {
  void fetchSessionList(true);
}

// Channel-1 handle for the historical session list — the sessions card's `sessionList` capability
// resolves through this, exactly as the directory card's body resolves through dirListingSignal. First
// subscribe with no cached value lazily fetches /api/sessions.
export const sessionListSignal: Subscribable<SessionMeta[] | undefined> = {
  get: () => sessionListValue,
  subscribe(onChange) {
    sessionListSubs.add(onChange);
    if (sessionListValue === undefined) void fetchSessionList();
    return () => sessionListSubs.delete(onChange);
  },
};
