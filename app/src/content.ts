import type { Subscribable } from "./lib";
import { feedSignal } from "./feeds";
import { activeBoardId } from "./board";

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
// ── off-log GONE projection (worktree-activity slice D: tombstones) ───────────────────────────────
// A (root, path) whose backing file/folder no longer exists — the watch reports `unlink`, or a fetch
// 404s/400s (deleted, or an unknown root). A PINNED card for it is kept and shown as a TOMBSTONE rather
// than silently removed (the "never silently drop content" rule, CLAUDE.md) or left hanging on "loading…".
// Off-log, like the content/listing projections: a deletion touches no durable log, only this derived
// state. (Worktree-removal is detected separately + reactively: the card's root drops out of rootsSignal.)
const goneKeys = new Set<string>();
const goneSubs = new Map<string, Set<() => void>>();
export function setGone(root: string, path: string, isGone: boolean): void {
  const k = key(root, path);
  if (isGone === goneKeys.has(k)) return; // no change → no notify (a re-add of a live file is a no-op)
  isGone ? goneKeys.add(k) : goneKeys.delete(k);
  for (const fn of goneSubs.get(k) ?? []) fn();
}
export function goneSignal(root: string, path: string): Subscribable<boolean> {
  const k = key(root, path);
  return {
    get: () => goneKeys.has(k),
    subscribe(onChange) {
      let set = goneSubs.get(k);
      if (!set) goneSubs.set(k, (set = new Set()));
      set.add(onChange);
      return () => set!.delete(onChange);
    },
  };
}

async function fetchContent(root: string, path: string): Promise<void> {
  const k = key(root, path);
  if (inflight.has(k)) return;
  inflight.add(k);
  try {
    const r = await fetch(
      `/api/file?board=${activeBoardId()}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    );
    if (r.ok) {
      setGone(root, path, false);
      setFileContent(root, path, filePreview((await r.json()) as { content: string; truncated: boolean }));
    } else if (r.status === 404 || r.status === 400) {
      setGone(root, path, true); // deleted, or its root is gone — tombstone a pinned card for it
    }
  } catch {
    // offline / gone — leave the cache empty; the card shows an empty body until the next watch event
  } finally {
    inflight.delete(k);
  }
}

// One-shot point READ of a file's content, for a synchronous decision at drop/click time (e.g. "is this
// .html a notebook?"). Returns the warm off-log cache if present, else fetches /api/file ONCE — unlike
// fileContentSignal it never subscribes, so a sniff doesn't pin a live handle to a file we may not card.
export async function readFileOnce(root: string, path: string): Promise<string | undefined> {
  const k = key(root, path);
  if (values.has(k)) return values.get(k);
  await fetchContent(root, path);
  return values.get(k);
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

// WRITE one file's content back to disk (POST /api/file) — the notebook card's serialize-back
// (docs/notebook-card.md §13, the file/git "content lives in files" tier, §4). The browser can't touch
// the filesystem, so this is the write twin of fetchContent's read: the dev-server middleware does the
// actual write (re-checked inside the root + text-ext gates, vite-fs-plugin.ts). On success we update the
// off-log content cache OPTIMISTICALLY so the card reflects the edit at once; the repo watch then fires a
// `change` and re-confirms it (a no-op if identical). Returns false on a failed/blocked write so a caller
// can leave the board unchanged. Note: this is a content-tier write — it never touches the durable intent
// log (only the card's arrangement is on-log); provenance/versioning of the edit is the shadow-git
// ledger's job (shadow-git-ledger.md), independent of this call.
export async function writeFileContent(root: string, path: string, content: string): Promise<boolean> {
  try {
    const r = await fetch(
      `/api/file?board=${activeBoardId()}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) },
    );
    if (r.ok) setFileContent(root, path, content);
    return r.ok;
  } catch {
    return false; // offline / server gone — the caller decides what to do (e.g. skip the card add)
  }
}

// WRITE a binary IMAGE asset to disk (POST /api/asset, raw bytes) — the drop-on-canvas landing for an
// image (image-cards-on-canvas). The binary twin of writeFileContent: a PNG/JPG can't ride the text
// endpoint, so it goes to /api/asset, gated server-side by IMAGE_EXT + a byte cap. The server NEVER
// clobbers — it dedupes the basename and returns the FINAL path — so we resolve to whatever path it
// actually wrote and hand that back for the caller to card (a unique path → a unique node id). Returns the
// stored root-relative path on success, or null on a failed/blocked write so the caller adds no card.
export async function writeAsset(root: string, path: string, bytes: ArrayBuffer): Promise<string | null> {
  try {
    const r = await fetch(
      `/api/asset?board=${activeBoardId()}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes },
    );
    if (!r.ok) return null;
    const out = (await r.json()) as { path?: string };
    return typeof out.path === "string" ? out.path : null;
  } catch {
    return null; // offline / server gone
  }
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
    const r = await fetch(
      `/api/ls?board=${activeBoardId()}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    );
    if (r.ok) {
      setGone(root, path, false);
      const d = (await r.json()) as { dirs?: string[]; files?: string[] };
      listings.set(k, { dirs: d.dirs ?? [], files: d.files ?? [] });
      for (const fn of listingSubs.get(k) ?? []) fn();
    } else if (r.status === 404 || r.status === 400) {
      setGone(root, path, true); // folder deleted, or its root gone — tombstone the directory card
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

// One-shot point READ of a directory's children, for a synchronous decision at create time (e.g. "what's
// the next free notebookN.html?"). Returns the warm cache if present, else fetches /api/ls ONCE — the
// directory twin of readFileOnce; never subscribes, so picking a name doesn't pin a live listing handle.
// An undefined result (offline, or the folder doesn't exist yet) means "no known children".
export async function listDirOnce(root: string, path: string): Promise<DirListing | undefined> {
  const k = key(root, path);
  if (listings.has(k)) return listings.get(k);
  await fetchListing(root, path);
  return listings.get(k);
}

// Re-pull a directory's listing if it has already been loaded (someone expanded that folder) or is being
// watched right now. Called by the repo watch (loader.ts) when a child is added/removed so the in-card
// tree reflects new/removed siblings LIVE, instead of showing whatever it cached at first expand — stale
// children in a reactive canvas are the "where did my file go?" confusion the project warns about.
// No-op for folders never loaded: they fetch fresh on next subscribe, so this never auto-pulls the whole
// repo. fetchListing overwrites the cache and notifies subscribers, so the directory card re-renders.
export function refreshListing(root: string, path: string): void {
  const k = key(root, path);
  if (listings.has(k) || (listingSubs.get(k)?.size ?? 0) > 0) void fetchListing(root, path);
}

// ── off-log SESSION LIST projection (Phase C: the sessions browser card) ──────────────────────────
// The historical agent transcripts on disk (GET /api/sessions), on the SAME lazy-on-subscribe seam as
// dirListingSignal — board-global (not keyed by a path), since the session list IS the disk, not a
// per-card value. The sessions card subscribes to this and drags a row out to open it (loader.openSession,
// the one authored act). Channel-1 / derived: listing transcripts touches no diff, no intent event, no
// persistence — only opening one commits an addNode. A live push (hookSessionsFeed: the server's
// `sessions` feed pings on any transcript add/change/unlink, exactly like the repo watch) keeps an open
// card current; refreshSessionList() stays the manual re-pull, exposed as the `sessionRefresh` capability.

export interface SessionMeta {
  id: string;
  mtime: number;
  bytes: number;
  title?: string | null; // the agent-written ai-title (or a truncated first prompt); absent if unreadable
  turns?: number; // human turns — user messages carrying text, not tool-result envelopes
  messages?: number; // raw user+assistant record count, every tool iteration included
  // The lifecycle band, server-computed (vite-fs-plugin.ts sessionStatus), in the same five categories the
  // session card paints: a live process is working/waiting, an ended one done/crashed/ended. Drives the
  // status indicators (list bar, minimap dot, the move-to-waiting heads-up) off one source.
  status?: "working" | "waiting" | "waiting-agent" | "done" | "crashed" | "ended";
}

let sessionListRaw: SessionMeta[] | undefined; // the unfiltered server list, as fetched
let sessionListValue: SessionMeta[] | undefined; // raw minus the locally-hidden ids — what the card sees
const sessionListSubs = new Set<() => void>();
let sessionListInflight = false;

// Locally-hidden session ids — a CHANNEL-1 view preference, never the durable log. Hiding a junk
// transcript (e.g. a terminal session started and exited at once, whose ai-name is the
// `<local-command-caveat>` placeholder) only drops it from THIS list; the .jsonl stays on disk (it's
// Claude Code's own data, not foolscap's to delete) and is still served by /api/session if reopened by
// id. Board-scoped and stored in localStorage — the same session tier as the camera pose (session.ts),
// with the same swallow-on-failure: a lost hide is cosmetic, never a data-loss event. Reversible by
// clearing the key. Lazily loaded (and memoised) on first use, since a tab is pinned to one board.
const hiddenKey = (boardId: string): string => `foolscap:hidden-sessions:${boardId}`;
let hiddenIds: Set<string> | null = null;
function hidden(): Set<string> {
  if (hiddenIds) return hiddenIds;
  try {
    const raw = localStorage.getItem(hiddenKey(activeBoardId()));
    hiddenIds = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    hiddenIds = new Set(); // unreadable / corrupt storage — start empty, nothing hidden this session
  }
  return hiddenIds;
}

// Re-derive the card-visible list from the raw fetch minus the hidden ids. Cheap, so it runs on every
// fetch AND every hide — dropping a row needs no second network round-trip.
function applyHidden(): void {
  sessionListValue = sessionListRaw?.filter((s) => !hidden().has(s.id));
}

async function fetchSessionList(force = false): Promise<void> {
  if (sessionListInflight && !force) return; // a normal lazy fetch de-dupes; a forced refresh always runs
  sessionListInflight = true;
  try {
    const r = await fetch(`/api/sessions?board=${activeBoardId()}`);
    if (r.ok) {
      const d = (await r.json()) as { sessions?: SessionMeta[] };
      sessionListRaw = d.sessions ?? [];
      applyHidden();
      for (const fn of sessionListSubs) fn();
    }
  } catch {
    // offline — leave it unset; a later subscribe (or a refresh) retries
  } finally {
    sessionListInflight = false;
  }
}

// Hide one session from this board's list — the sessions card's `sessionDelete` action (select a row,
// Shift+Delete). Adds the id to the persisted hidden-set, re-filters the cached list, and notifies, so
// the row vanishes WITHOUT a re-fetch. Off-log and reversible: the transcript on disk is untouched.
export function hideSession(id: string): void {
  hidden().add(id);
  try {
    localStorage.setItem(hiddenKey(activeBoardId()), JSON.stringify([...hidden()]));
  } catch {
    // unwritable storage (private mode / quota) — the hide stays in-memory for this session, harmless
  }
  applyHidden();
  for (const fn of sessionListSubs) fn();
}

// Re-pull the list and notify subscribers — the sessions card's ⟳ refresh button. A live push now
// covers the common case (hookSessionsFeed, below), but this stays as the manual force: an offline
// retry, or a re-pull when you just want to be sure.
export function refreshSessionList(): void {
  void fetchSessionList(true);
}

// Live push for the session list, mirroring the repo watch the file tree gets. The server watches the
// transcripts dir and pings the `sessions` feed on any add/change/unlink (vite-fs-plugin.ts); here we
// re-pull the list ONCE per ping — a module-level hook, not per-card, so N open sessions cards still
// cause a single fetch. Wired lazily on the first subscribe (kept for the page's life, like the feeds'
// own EventSource). This is what makes a newly-started session appear without hitting ⟳ or reloading.
let sessionsFeedHooked = false;
function hookSessionsFeed(): void {
  if (sessionsFeedHooked) return;
  sessionsFeedHooked = true;
  feedSignal<{ ts: number }>("sessions:" + activeBoardId()).subscribe(() => void fetchSessionList(true));
}

// Channel-1 handle for the historical session list — the sessions card's `sessionList` capability
// resolves through this, exactly as the directory card's body resolves through dirListingSignal. First
// subscribe with no cached value lazily fetches /api/sessions.
export const sessionListSignal: Subscribable<SessionMeta[] | undefined> = {
  get: () => sessionListValue,
  subscribe(onChange) {
    sessionListSubs.add(onChange);
    hookSessionsFeed(); // arm the live push (once) so a new session appears without a manual refresh
    if (sessionListValue === undefined) void fetchSessionList();
    return () => sessionListSubs.delete(onChange);
  },
};

// ── off-log ROOTS projection (worktree-activity slice B/C) ────────────────────────────────────────
// A board's roots — its canonical checkout (id "repo") + any git worktrees — on the SAME lazy-fetch +
// live-feed seam as the session list. Board-global (not per path), so it's a plain signal, not a
// callable. The file tree drops one tree card per root; the session card maps an agent's absolute
// tool-call paths onto these roots to colour its activity dots by worktree. Each root carries a stable
// `hue` (a pure function of its id — NOT a canvas property, so a worktree has a colour even with no card
// on the board), the single source of truth shared by the dots, the tree folders, and file headers.
export interface RootInfo {
  id: string;
  name: string;
  path: string; // absolute, realpath'd — the server confines reads to it; the session card prefix-matches it
  branch: string;
  head: string;
  hue: string; // CSS colour derived from id (hueOf)
}

// Deterministic id → CSS hue. A small string hash spread over the colour wheel; mid saturation/lightness
// so the tints read as gentle accents, not alarms. Same id ⇒ same colour across reloads and surfaces.
export function hueOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 55%)`;
}

let rootsValue: RootInfo[] | undefined;
const rootsSubs = new Set<() => void>();
let rootsInflight = false;
async function fetchRoots(force = false): Promise<void> {
  if (rootsInflight && !force) return;
  rootsInflight = true;
  try {
    const r = await fetch(`/api/roots?board=${activeBoardId()}`);
    if (r.ok) {
      const d = (await r.json()) as { roots?: Omit<RootInfo, "hue">[] };
      rootsValue = (d.roots ?? []).map((x) => ({ ...x, hue: hueOf(x.id) }));
      for (const fn of rootsSubs) fn();
    }
  } catch {
    // offline / not a git repo — leave unset; a later subscribe retries. The canonical root still works
    // (the server always reports it), so the board degrades to single-root, never breaks.
  } finally {
    rootsInflight = false;
  }
}
let rootsFeedHooked = false;
function hookRootsFeed(): void {
  if (rootsFeedHooked) return;
  rootsFeedHooked = true;
  feedSignal<{ ts: number }>("roots:" + activeBoardId()).subscribe(() => void fetchRoots(true));
}
export const rootsSignal: Subscribable<RootInfo[] | undefined> = {
  get: () => rootsValue,
  subscribe(onChange) {
    rootsSubs.add(onChange);
    hookRootsFeed();
    if (rootsValue === undefined) void fetchRoots();
    return () => rootsSubs.delete(onChange);
  },
};
