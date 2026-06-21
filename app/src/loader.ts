import {
  nodeId,
  type Id,
  type InteractionManager,
  type NodeRecord,
  type LayoutRecord,
  type EdgeRecord,
  type AnyRecord,
} from "./lib";
import { fileKind } from "./fileTypes";
import { filePreview, setFileContent } from "./content";

// The bridge between the Node middleware and the canvas. Goes through the public Editor (the one
// mutation API — "one mutation API, three clients"): the human draws nothing here, the LOADER and the
// filesystem WATCH both speak the same addNode/removeNode commands an agent or a gesture would. A file
// card is just a node with type "file"; the durable log holds only its ARRANGEMENT (it exists, where it
// sits) and its (root, path) REFERENCE (the title). Its CONTENT is off-log — a channel-1 projection of
// the file on disk (content.ts), fetched + kept live by the watch — so content churn never touches the
// log (the clock rule applied to file bodies). addFolder/watchDataset push content into that signal
// instead of committing setText.

export type RootId = "repo";

export interface TreeFile {
  path: string;
  content: string;
  truncated: boolean;
}
export interface WatchEvent {
  type: "add" | "change" | "unlink";
  path: string;
}

// Default card geometry + placement spacing. CARD_W/CARD_H are a file card's footprint (materializeAt);
// COL_GAP is the gutter nextX leaves past the existing board; ORIGIN_X/ORIGIN_Y are the empty-board /
// headless fallback origin (spawnAt has no viewport to centre in).
const CARD_W = 250;
const CARD_H = 180;
const COL_GAP = 36;
const ORIGIN_X = 48;
const ORIGIN_Y = 48;

// Node id derived from (root, path) so it's STABLE and idempotent: re-loading or a change event addresses
// the same card without any path→id bookkeeping, and the two datasets never collide.
function fileNodeId(root: RootId, p: string): Id<"node"> {
  return `node:${root}:${p}` as Id<"node">;
}

// Where to drop newly-added content so it lands to the RIGHT of whatever's already on the board, instead
// of overlapping it. The board is the source of layout truth now (cards are added/removed by the user,
// not rebuilt from code), so each "Add …" reads the current extent rather than assuming an empty canvas.
function nextX(m: InteractionManager): number {
  let max = -Infinity;
  for (const r of m.editor.store.getSnapshot().records) {
    if (r.typeName === "layout") max = Math.max(max, r.x + r.w);
  }
  return max === -Infinity ? ORIGIN_X : max + COL_GAP * 2;
}

// Where to drop a newly-CREATED single card (a sticky, a session, a widget) so it lands where the user
// is actually looking. nextX walks off to the right of ALL existing content, which is fine for a folder
// block laid out once but lands off-screen the instant you've panned away — a new card you then have to
// hunt for. Instead centre it in the current viewport (m.visibleBox(), page space), then CASCADE
// down-right past any card already sitting at that spot so a burst of Adds fans out instead of stacking
// into one pile. Falls back to nextX/ORIGIN_Y when the viewport size isn't known yet (the headless
// path / tests, where visibleBox() is null), so non-DOM callers behave exactly as before.
// A page-space drop point. When an Add comes from the right-click canvas menu, the menu hands the
// click location here so the new card lands under the cursor instead of the viewport-centre cascade.
export interface Pos {
  x: number;
  y: number;
}

const CASCADE_STEP = 28;
function spawnAt(m: InteractionManager, w: number, h: number): { x: number; y: number } {
  const view = m.visibleBox();
  if (!view) return { x: nextX(m), y: ORIGIN_Y };
  let x = Math.round(view.x + (view.w - w) / 2);
  let y = Math.round(view.y + (view.h - h) / 2);
  const records = m.editor.store.getSnapshot().records;
  const occupied = (px: number, py: number): boolean =>
    records.some(
      (r) => r.typeName === "layout" && Math.abs(r.x - px) < CASCADE_STEP && Math.abs(r.y - py) < CASCADE_STEP,
    );
  for (let i = 0; i < 16 && occupied(x, y); i++) {
    x += CASCADE_STEP;
    y += CASCADE_STEP;
  }
  return { x, y };
}

// The directory card's footprint — taller than a file card since it lists children.
const DIR_CARD_W = 240;
const DIR_CARD_H = 300;

// Materialize ONE filesystem node at a page point — the directory card's DRAG-OUT promotion
// (file-trees-on-canvas.md §9). Browsing inside a directory card is off-log (the `dirListing`
// projection, content.ts); dragging a row onto the canvas is the single deliberate act that earns a
// channel-3 event, so THIS is the only place a tree node is committed. A sub-folder becomes a fresh
// directory card (showing ITS level — you go deeper by dragging out again, the tree growing spatially);
// a file becomes a file card, coloured by kind like the picker's adds. actor "user" — unlike the
// picker's `system` adds, a drag-out is a hand gesture, so ⌘Z undoes it. Deterministic (root, path) id →
// idempotent: re-dragging the same path refreshes its card in place rather than duplicating. The new
// card is selected so it's immediately live where you dropped it.
export function materializeAt(
  m: InteractionManager,
  root: RootId,
  path: string,
  kind: "file" | "dir",
  x: number,
  y: number,
): void {
  const id = fileNodeId(root, path);
  if (kind === "dir") {
    m.editor.commit({
      type: "addNode",
      actor: "user",
      payload: { id, type: "directory", title: path, text: "", color: "purple", x, y, w: DIR_CARD_W, h: DIR_CARD_H },
    });
  } else {
    const kindInfo = fileKind(path);
    m.editor.commit({
      type: "addNode",
      actor: "user",
      payload: { id, type: "file", title: path, text: "", color: kindInfo.color, x, y, w: CARD_W, h: CARD_H },
    });
  }
  m.selection.set([id]);
}

// Add a directory CARD for a folder — the "File tree" widget (path "" = the repo root) and the engine
// behind any folder add. Same authored addNode as a drag-out; placed at `at` (the right-click point) when
// the menu supplies it, else centred in the viewport (spawnAt). From here you drill INSIDE the card and
// drag the level you want out onto the canvas.
export function addFolderCard(m: InteractionManager, path: string, at?: Pos): void {
  const { x, y } = at ?? spawnAt(m, DIR_CARD_W, DIR_CARD_H);
  materializeAt(m, "repo", path, "dir", x, y);
}

// Drop a single clock card on the board. It's an ordinary node (logged spatial state, draggable like any
// card) whose CONTENT is not stored — NodeView reads the time from the off-log `nowSignal` instead of
// node.text. So this addNode is the ONLY thing the clock ever puts on the log; the per-second ticks never
// commit. Stable id → idempotent across reloads/StrictMode, same as the file cards.
export function addClock(m: InteractionManager, at?: Pos): void {
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: "node:clock" as Id<"node">,
      type: "clock",
      title: "clock",
      text: "",
      color: "purple",
      ...(at ?? spawnAt(m, 180, 210)),
      w: 180,
      h: 210,
    },
  });
}

// Feed cards: ordinary nodes whose BODIES read off-log feed signals (feeds.ts) instead of node.text —
// the clock generalized to live external sources. Same deal as the clock: this addNode is the only
// thing each feed card ever logs; the churning values never commit. Stable ids → idempotent. Git HEAD
// and HN are SEPARATE widgets (each its own Add item) — they were briefly added as a pair for the demo,
// but that coupling was incidental, and one card per source is the cleaner unit.
export function addGitHeadCard(m: InteractionManager, at?: Pos): void {
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: "node:feed:githead" as Id<"node">,
      type: "githead",
      title: "git HEAD",
      text: "",
      color: "green",
      ...(at ?? spawnAt(m, 250, 210)),
      w: 250,
      h: 210,
    },
  });
}
export function addHnCard(m: InteractionManager, at?: Pos): void {
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: "node:feed:hn" as Id<"node">,
      type: "hn",
      title: "HN top story",
      text: "",
      color: "orange",
      ...(at ?? spawnAt(m, 250, 210)),
      w: 250,
      h: 210,
    },
  });
}

// The computed card (demo §10 step 2): "time since last commit" = clock × git HEAD. The SPLIT is the
// point — the card and its two input EDGES are authored state (three commits: logged, undoable,
// snapshot-able wiring), while the flowing value is derived in the view from the two off-log signals
// and never enters the log. EdgeRecords are the dependency graph, so deleting/undoing a wire visibly
// unplugs an input (ComputedView degrades to "missing input"). Stable ids → idempotent, as ever.
export function addComputedCard(m: InteractionManager, at?: Pos): void {
  const id = "node:computed:since" as Id<"node">;
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id,
      type: "computed",
      title: "time since last commit",
      text: "",
      color: "pink",
      ...(at ?? spawnAt(m, 250, 210)),
      w: 250,
      h: 210,
    },
  });
  m.editor.commit({
    type: "addEdge",
    actor: "system",
    payload: { id: "edge:wire:clock" as Id<"edge">, from: "node:clock" as Id<"node">, to: id, type: "input" },
  });
  m.editor.commit({
    type: "addEdge",
    actor: "system",
    payload: { id: "edge:wire:githead" as Id<"edge">, from: "node:feed:githead" as Id<"node">, to: id, type: "input" },
  });
}

// The provenance card (demo §10 step 3): channel 3 rendered live ON the canvas. Its body is the
// intent-log tail (via provenance.ts's logSignal), so the channel discipline demos itself: feeds
// churn, the clock ticks, the computed card counts — and this card does not move. Drag a card or
// let the agent commit, and one new line appears. The card itself is one more ordinary node.
export function addProvenanceCard(m: InteractionManager, at?: Pos): void {
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: "node:provenance" as Id<"node">,
      type: "provenance",
      title: "intent log",
      text: "",
      color: "purple",
      ...(at ?? spawnAt(m, 360, 210)),
      w: 360,
      h: 210,
    },
  });
}

// A sticky note (card-types/sticky) — a brief memo / todo pad you type INTO, unlike the demo widgets
// whose bodies are read-only projections. Each Add mints a FRESH random id (not a stable singleton id
// like the clock): sticky notes are multiple by nature, so two Adds make two notes. The addNode is the
// only thing seeded here; the note's own content arrives later as the user's setTitle/setText commits
// from the card's editable interior (granted through the sticky type's WRITE capabilities). Yellow by
// default — the canonical sticky colour — but recolourable like any card.
export function addStickyNote(m: InteractionManager, at?: Pos): void {
  const w = 240;
  const h = 220;
  const id = nodeId();
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "sticky", title: "", text: "", color: "yellow", ...(at ?? spawnAt(m, w, h)), w, h },
  });
  // Select the new note so its inputs are immediately live (they're pointer-transparent until the
  // card is selected — the "select the card before its text" rule, style.css): Add then type, in one
  // gesture, without the click-to-select step a fresh card would otherwise need.
  m.selection.set([id]);
}

// The usage card (card-types/usage) — the canvas mirror of /usage. Its body reads the off-log `usage`
// feed (account plan windows, polled server-side) plus, if titled with a live session id, that
// session's token gauge. Like the clock/feed cards, this addNode is the only thing it ever logs; the
// polled values never commit. A stable singleton id → idempotent: re-adding is a no-op rather than
// littering the board. Left untitled so it shows the plan bars alone.
export function addUsageCard(m: InteractionManager, at?: Pos): void {
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: "node:usage" as Id<"node">,
      type: "usage",
      title: "",
      text: "",
      color: "green",
      ...(at ?? spawnAt(m, 300, 320)),
      w: 300,
      h: 320,
    },
  });
}

// The sessions browser card (card-types/sessions, Phase C) — a persistent on-canvas list of historical
// agent sessions; drag a row out to OPEN that session as a card (the directory card's drag-out, applied to
// sessions). Its body reads the off-log `sessionList` projection (content.ts, /api/sessions), so this
// addNode is the only thing it ever logs — the list churns off-log like the clock/feeds. A stable
// singleton id → idempotent: re-adding is a no-op rather than littering the board. actor "user" + selected,
// matching the directory browser card it's modelled on (a deliberate placement the user's ⌘Z can undo).
export function addSessionsCard(m: InteractionManager, at?: Pos): void {
  const w = 280;
  const h = 360;
  const id = "node:sessions" as Id<"node">;
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "sessions", title: "", text: "", color: "blue", ...(at ?? spawnAt(m, w, h)), w, h },
  });
  m.selection.set([id]);
}

// The weather card (card-types/weather) — current local weather for a typed location. Its body reads
// the off-log `weather` capability (Open-Meteo, polled server-side, keyed by the card's title) and
// commits its location through setTitle. Like the clock/feed cards, this addNode is the only thing it
// logs; the polled conditions never commit. NOT a singleton — you can pin several cities — so a fresh
// node id each time, and selected so its location input is immediately live (the sticky's "Add then
// type in one gesture" pattern). Untitled, so it opens on the "type a city" hint.
export function addWeatherCard(m: InteractionManager, at?: Pos): void {
  const w = 240;
  const h = 240;
  const id = nodeId();
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "weather", title: "", text: "", color: "blue", ...(at ?? spawnAt(m, w, h)), w, h },
  });
  m.selection.set([id]);
}

// Open a HISTORICAL agent session as a card (agent-sessions-on-canvas.md §12). Pure existing
// architecture — a file-backed card like any other. The server reads a real Claude Code `.jsonl`
// transcript (`id` omitted → the most recent), and the content rides in `text` exactly as a file card's
// does; the jsonl → turns codec lives in the template (card-types/session/render.js), not here. One
// addNode is the only thing this puts on the log — the session's prompts/turns stay in the jsonl,
// REFERENCED, never replicated onto the canvas log (§7). The node id carries the session id, so each
// distinct session is its own card and re-opening the same one (e.g. from the dropdown) is idempotent;
// deleting the card never touches the .jsonl, so it reopens from the same list later.
export async function openSession(m: InteractionManager, id?: string, at?: Pos): Promise<void> {
  const res = await fetch(`/api/session${id ? `?id=${encodeURIComponent(id)}` : ""}`);
  if (!res.ok) return; // no transcripts on this machine, or bad id — just skip the card
  // This GET does two off-log jobs: it RESOLVES the session id (omitted → most recent) and ARMS the
  // server-side file-tail (handleSession → ensureSessionFeed) that publishes session:<id>. The card
  // reads that live feed for its content — the transcript stays REFERENCED, never copied onto the log
  // — so we keep nothing from the body here; text:"" is a pure reference card.
  const { id: sid } = (await res.json()) as { id: string };
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: `node:session:${sid}` as Id<"node">,
      type: "session",
      title: sid, // the FULL session id — the template both displays (truncated) and keys its live
      // feed off (the `session` capability subscribes to session:<title>); it live-tails whatever
      // that session is (slice 1), and resumes in place if you recommence it.
      text: "",
      color: "blue",
      ...(at ?? spawnAt(m, 400, 360)),
      w: 400,
      h: 360,
    },
  });
}

// Spawn a NEW live Claude Code session (agent-sessions §8 / slice 2) and drop a card showing it. The
// server-side registry owns the process (decoupled from this card's lifecycle); we just mint a card
// titled with the new session id, which subscribes to its `session:<id>` feed and can prompt it back
// through `sessionInput`. The one addNode is the only thing on the intent log — the session's prompts
// and turns stay in its own file/feed, REFERENCED, never replicated (session-timelines §3/§4). The
// process writing files would arrive separately via the commit-watcher, attributed to that session.
export async function spawnLiveSession(m: InteractionManager, at?: Pos): Promise<void> {
  const res = await fetch("/api/session/spawn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) return; // no claude on PATH, or the spawn failed — leave the board unchanged
  const { id } = (await res.json()) as { id: string };
  // Placed in the current viewport (spawnAt). Node id carries the session id, so each spawn is its own
  // card (and idempotent if somehow committed twice).
  m.editor.commit({
    type: "addNode",
    actor: "system",
    payload: {
      id: `node:live:${id}` as Id<"node">,
      type: "session",
      title: id, // the session id: the template keys its `session` feed + `sessionInput` off it
      text: "",
      color: "blue",
      ...(at ?? spawnAt(m, 400, 360)),
      w: 400,
      h: 360,
    },
  });
}

// Interrupt the live Claude session shown in the SELECTED session card (the Escape binding). Reads the
// single selected node; if it's a session card, fires the session-internal interrupt for its id. Like
// sessionInput/sessionResume this is a plain POST, never the canvas log. A no-op unless the selection is
// exactly one session card; the server 409s (ignored here) when that session isn't a live process.
export function interruptSelectedSession(m: InteractionManager): void {
  const ids = m.selection.ids();
  if (ids.length !== 1) return;
  const node = m.editor.store
    .getSnapshot()
    .records.find((r): r is NodeRecord => r.typeName === "node" && r.id === ids[0]);
  if (!node || node.type !== "session") return;
  void fetch(`/api/session/${encodeURIComponent(node.title)}/interrupt`, { method: "POST" });
}

// After hydrate (Phase 2 persistence), cards come back with their arrangement + reference but NO
// content — content is off-log now, so nothing is restored from the log. Re-arm each SESSION card's
// live tail: the GET re-fires handleSession → ensureSessionFeed, which a server restart dropped, so the
// card lights up from session:<id> again. FILE cards need nothing here — their `fileContent` signal
// lazily fetches from disk on first render (content.ts), pull-based and per visible card. Nothing
// commits: content is a projection off the one source, never the durable log.
export async function reprojectContent(m: InteractionManager): Promise<void> {
  const sessions = m.editor.store
    .getSnapshot()
    .records.filter((r): r is NodeRecord => r.typeName === "node" && r.type === "session");
  await Promise.all(
    sessions.map((n) =>
      fetch(`/api/session?id=${encodeURIComponent(n.title)}`).catch(() => undefined),
    ),
  );
}

// Tear down the current board (the Clear button). Goes through removeNode/removeEdge like everything
// else — edges first, so no wire ever dangles mid-teardown.
export function clearBoard(m: InteractionManager): void {
  const records = m.editor.store.getSnapshot().records;
  for (const r of records) {
    if (r.typeName === "edge") m.editor.commit({ type: "removeEdge", actor: "system", payload: { id: r.id } });
  }
  for (const r of records) {
    if (r.typeName === "node") m.editor.commit({ type: "removeNode", actor: "system", payload: { id: r.id } });
  }
  m.selection.clear();
}

// ── board export / import (a plain-JSON backup of the whole board) ──────────────────────────────
// The durable store is the ONLY home for some cards' data: a sticky note's title/text/colour lives
// nowhere else (file/session bodies re-derive from disk — content.ts — but a memo does not). So a
// one-click snapshot download is the board's backup. getSnapshot() is the same document the
// persistence tier caches; we serialize it to a file you can keep, move between machines, or re-import.

export function exportBoard(m: InteractionManager): void {
  const snapshot = m.editor.store.getSnapshot();
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.download = `canvas-board-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

interface BoardSnapshot {
  records: AnyRecord[];
  version: number;
}

// Replace the board with a previously-exported snapshot. Each card is re-created from its node+layout
// record pair (joined by id), each edge from its record, all through editor.commit (actor "system") —
// so the restore rides channel 2 into persistence and the spatial index, with no store surgery and no
// renderer special-casing. Node ids are PRESERVED, so file/session cards re-bind their off-log content
// (keyed by the node's title/path) on first render. Returns false on an unreadable / non-snapshot file.
export async function importBoard(m: InteractionManager, file: File): Promise<boolean> {
  let snap: BoardSnapshot;
  try {
    snap = JSON.parse(await file.text()) as BoardSnapshot;
  } catch {
    return false;
  }
  if (!snap || !Array.isArray(snap.records)) return false;

  const layouts = new Map<string, LayoutRecord>();
  const nodes: NodeRecord[] = [];
  const edges: EdgeRecord[] = [];
  for (const r of snap.records) {
    if (r.typeName === "node") nodes.push(r);
    else if (r.typeName === "layout") layouts.set(r.nodeId, r);
    else if (r.typeName === "edge") edges.push(r);
  }

  clearBoard(m);
  for (const n of nodes) {
    const l = layouts.get(n.id);
    m.editor.commit({
      type: "addNode",
      actor: "system",
      payload: {
        id: n.id,
        type: n.type,
        title: n.title,
        text: n.text,
        color: n.color,
        x: l?.x,
        y: l?.y,
        w: l?.w,
        h: l?.h,
        z: l?.z,
      },
    });
  }
  for (const e of edges) {
    m.editor.commit({ type: "addEdge", actor: "system", payload: { id: e.id, from: e.from, to: e.to, type: e.type } });
  }
  return true;
}

// Subscribe to the repo-wide change stream and reflect each filesystem edit onto cards ALREADY on the
// board. THIS is the reactive-ingest payoff: an out-of-band edit (your editor, an agent, a git pull)
// arrives as an event and updates a card. A content CHANGE refreshes the card's off-log content signal
// (content.ts) — channel-1, no setText, so a file churning never grows the durable log. An UNLINK is
// arrangement (the card goes away), so it stays on the log as a removeNode (actor "remote" — the
// provenance reads as "an external writer changed this", the channel-3 story for an agent editing a file).
//
// Gated to known cards: a single repo watch backs whatever folders the user has added, but a change to a
// path with NO card is ignored — we don't auto-spawn cards for the whole repo (the pre-palette behaviour).
// A genuinely-new file under an added folder therefore appears on the next "Add files" of that folder,
// not live; that re-add is idempotent, so it just fills in the gap. Returns an unsubscribe fn.
export function watchDataset(
  m: InteractionManager,
  root: RootId,
  onEvent?: (e: WatchEvent) => void,
): () => void {
  const es = new EventSource(`/api/watch?root=${root}`);

  es.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data) as WatchEvent;
    const id = fileNodeId(root, msg.path);
    if (!m.editor.store.get<"node">(id)) return; // no card for this path → not on the board, ignore

    if (msg.type === "unlink") {
      setFileContent(root, msg.path, undefined); // drop the off-log content with the card
      m.editor.commit({ type: "removeNode", actor: "remote", payload: { id } });
    } else {
      const r = await fetch(`/api/file?root=${root}&path=${encodeURIComponent(msg.path)}`);
      if (!r.ok) return;
      setFileContent(root, msg.path, filePreview((await r.json()) as TreeFile));
    }
    onEvent?.(msg);
  };

  return () => es.close();
}
