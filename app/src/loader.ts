import {
  nodeId,
  layoutId,
  type Editor,
  type Id,
  type InteractionManager,
  type NodeRecord,
  type LayoutRecord,
  type EdgeRecord,
  type AnyRecord,
} from "./lib";
import { fileKind } from "./fileTypes";
import { filePreview, setFileContent, setGone, refreshListing, writeFileContent, writeAsset, readFileOnce, listDirOnce } from "./content";
import { annotationsWatchEvent } from "./annotations";
import { activeBoardId } from "./board";
import { subscribeWatch } from "./feeds";

// The bridge between the Node middleware and the canvas. Goes through the public Editor (the one
// mutation API — "one mutation API, three clients"): the human draws nothing here, the LOADER and the
// filesystem WATCH both speak the same addNode/removeNode commands an agent or a gesture would. A file
// card is just a node with type "file"; the durable log holds only its ARRANGEMENT (it exists, where it
// sits) and its (root, path) REFERENCE (the title). Its CONTENT is off-log — a channel-1 projection of
// the file on disk (content.ts), fetched + kept live by the watch — so content churn never touches the
// log (the clock rule applied to file bodies). addFolder/watchDataset push content into that signal
// instead of committing setText.

// A root is the canonical checkout ("repo") OR a git worktree (its dir-basename slug). The id is part
// of every file/dir card's node id (`node:<root>:<path>`), so the roots never collide on the board.
export type RootId = string;

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
// Markdown opens as PROSE (card-types/file/render.js renders kind "md" through the markdown codec, every
// other kind as a raw <pre>), so it wants real reading room — the bare-preview footprint above is far too
// cramped for a rendered document. A wide, tall default that gives prose a comfortable measure out of the
// box; you still resize from there.
const PROSE_CARD_W = 560;
const PROSE_CARD_H = 620;
// A session card streams a transcript (often wide turn text / tables / code) plus its input row, and a
// live working session is something you settle into — so it opens GENEROUS by default rather than at a
// cramped footprint you have to resize every time. The shape is a landscape ~3:2 (wider than tall): width
// is what stops long lines wrapping to ribbons, and that aspect matches a comfortably-sized working card
// on a wide screen. Shared by opening a historical session and spawning a live one, so both land at the
// same footprint; resize from there for the rest.
const SESSION_CARD_W = 800;
const SESSION_CARD_H = 520;
// An image card opens at the image's OWN aspect ratio (measured at drop, fitImageBox below), so there's
// no letterbox gap to begin with, and resizing stays aspect-locked (type.yaml `aspect: auto`) so the gap
// never reappears. The fallback footprint is only used when the bytes can't be decoded. Dropped images
// land under `.canvas/images/` — the canvas's own filesystem (docs/canvas-home.md): human-gitignored,
// shadow-versioned, served by /api/asset (which excludes only the shadow git-dirs under `.canvas/roots/`,
// so this content path is reachable).
const IMAGE_CARD_W = 320;
const IMAGE_CARD_H = 260;
// The bounding box a dropped image's card is fitted into: the longer side caps here, the shorter scales to
// keep aspect, and MIN_SIZE (80×60, the resize floor) is the lower clamp. Generous per the size-cap norm —
// a one-time card footprint, not a memory bound.
const IMAGE_MAX = 420;
const IMAGE_MIN_W = 80;
const IMAGE_MIN_H = 60;
const IMAGE_DIR = ".canvas/images";
const COL_GAP = 36;
const ORIGIN_X = 48;
const ORIGIN_Y = 48;

// Node id derived from (root, path) so it's STABLE and idempotent: re-loading or a change event addresses
// the same card without any path→id bookkeeping, and the two datasets never collide.
function fileNodeId(root: RootId, p: string): Id<"node"> {
  return `node:${root}:${p}` as Id<"node">;
}

// The PARENT folder of a root-relative path ("a/b/c" → "a/b", "a" → "" = the root listing). Paths are
// POSIX-style — the server emits path.relative joined with "/", and the root directory is keyed by "".
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

// Register the file-card commands the loader commits through `editor.commit` (kept here, next to the
// (root, path) id scheme they depend on, rather than in core/ which is path-blind). Called once at engine
// construction (App.createEngine). Today that's just `remapFileNodes` — the atomic re-key behind an in-app
// rename/move (see renameFileNodes). The payload is a fully-resolved put/remove pair computed browser-side,
// so the handler stays dumb: remove the old (node, layout, edge) records, put the new ones, in ONE
// transaction → one diff → one IntentEvent.
export function registerFileCommands(editor: Editor): void {
  editor.register(
    "remapFileNodes",
    (store, p: { put?: AnyRecord[]; remove?: Id<string>[] }) => {
      if (p.remove?.length) store.remove(p.remove);
      if (p.put?.length) store.put(p.put);
    },
  );
}

// Referential integrity for an in-app rename/move: the fs endpoint has already moved the bytes from→to on
// disk; this re-keys any PINNED card backing that path so it survives in place instead of tombstoning. A
// file/dir/notebook card's node id ENCODES its (root, path) (fileNodeId), so a rename would otherwise strand
// the card at the old id — the watch's unlink(from) marks it `gone` and a card for `to` never appears. So we
// find the card at `from` AND (for a folder rename) every descendant under it, and re-commit them at the new
// (root, path): same geometry/type/colour, new id + retargeted title, edges carried across to the new
// endpoints. ONE transaction, attributed actor "system" — like the loader's own adds and UNLIKE a hand
// gesture, it is NOT user-undoable: ⌘Z can't reverse the disk move, so a card-only undo would just desync the
// card onto a path that no longer exists. If nothing is pinned, it's a no-op — the directory card's in-card
// view self-heals from the watch's listing refresh regardless.
export function renameFileNodes(editor: Editor, root: RootId, from: string, to: string): void {
  const records = editor.store.getSnapshot().records;
  const oldId = fileNodeId(root, from);
  const descPrefix = oldId + "/"; // "node:root:from/…" — descendants of a renamed FOLDER
  const idMap = new Map<Id<"node">, Id<"node">>();
  const put: AnyRecord[] = [];
  const remove: Id<string>[] = [];

  // 1) the card at `from`, plus every descendant (folder rename) → new id + retargeted title. `from` is a
  //    prefix of each matched path (equal for the file itself), so the suffix carries over unchanged.
  for (const r of records) {
    if (r.typeName !== "node") continue;
    if (r.id !== oldId && !r.id.startsWith(descPrefix)) continue;
    const n = r as NodeRecord;
    const newPath = to + n.title.slice(from.length);
    const newId = fileNodeId(root, newPath);
    idMap.set(n.id, newId);
    put.push({ ...n, id: newId, title: newPath });
    remove.push(n.id);
  }
  if (idMap.size === 0) return; // nothing pinned for this path — the watch alone keeps the listing honest

  // 2) their layouts → re-keyed to the new node id, geometry (x/y/w/h/z) preserved.
  for (const r of records) {
    if (r.typeName !== "layout") continue;
    const l = r as LayoutRecord;
    const newNode = idMap.get(l.nodeId);
    if (!newNode) continue;
    put.push({ ...l, id: layoutId(newNode), nodeId: newNode });
    remove.push(l.id);
  }

  // 3) edges touching a remapped node → carried across to the new endpoints. File cards rarely carry a wire,
  //    but one must never be left dangling at a stale id (removeNode's cascade would otherwise drop it).
  for (const r of records) {
    if (r.typeName !== "edge") continue;
    const e = r as EdgeRecord;
    const nf = idMap.get(e.from);
    const nt = idMap.get(e.to);
    if (!nf && !nt) continue;
    put.push({ ...e, from: nf ?? e.from, to: nt ?? e.to });
    remove.push(e.id);
  }

  editor.commit({ type: "remapFileNodes", actor: "system", payload: { put, remove } });
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

// Where a DOUBLE-CLICK open lands (the sessions / directory browser's quick-open — the keyboard-free
// twin of the drag-out, for when you don't want to carry the card to a spot by hand): a small down-right
// nudge off the BROWSER card's TOP-LEFT, so the opened card lands SUBSTANTIALLY OVERLAPPING the list,
// right where you clicked. That overlap is deliberate: a card that mostly covers the browser is impossible
// to miss and a flick away from where you want it — strictly better than nudging it far enough to clear
// the browser, which risks landing off-screen or somewhere you don't notice. Repeated double-clicks
// cascade past any card already sitting there (the same step as spawnAt) so they fan out instead of
// stacking into one pile. Falls back to spawnAt (viewport-centre cascade) when the browser card's layout
// isn't on the board — e.g. a headless caller — so it degrades to the ordinary Add placement.
const OPEN_OFFSET = 144; // ~half the browser card stays uncovered (and > CASCADE_STEP, so the FIRST open isn't bumped by the cascade)
export function cascadeFrom(m: InteractionManager, anchorId: Id<"node">, w: number, h: number): Pos {
  const records = m.editor.store.getSnapshot().records;
  const anchor = records.find(
    (r): r is LayoutRecord => r.typeName === "layout" && r.nodeId === anchorId,
  );
  if (!anchor) return spawnAt(m, w, h);
  // A small offset off the browser's top-left → the new card sits over the list (substantial overlap),
  // then cascades down-right off any card already there for the next double-click.
  let x = anchor.x + OPEN_OFFSET;
  let y = anchor.y + OPEN_OFFSET;
  const occupied = (px: number, py: number): boolean =>
    records.some(
      (r) => r.typeName === "layout" && Math.abs(r.x - px) < CASCADE_STEP && Math.abs(r.y - py) < CASCADE_STEP,
    );
  for (let i = 0; i < 16 && occupied(x, y); i++) {
    x += CASCADE_STEP;
    y += CASCADE_STEP;
  }
  return { x: Math.round(x), y: Math.round(y) };
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
// Is this file an Observable Notebooks 2.0 notebook? We SNIFF the `<notebook>` root marker rather than
// trust the path, so a notebook opens as a reactive card wherever it lives — `notebooks/` today, and a
// `.canvas/artefacts` artefact once that folder is reachable (shadow-git-ledger.md §8). Only `.html` files
// are read; every other file short-circuits with no fetch. A plain `.html` (no marker) stays a file view.
async function isNotebookFile(root: RootId, path: string): Promise<boolean> {
  if (!path.toLowerCase().endsWith(".html")) return false;
  const content = await readFileOnce(root, path);
  return !!content && /<notebook\b/i.test(content);
}

export async function materializeAt(
  m: InteractionManager,
  root: RootId,
  path: string,
  kind: "file" | "dir",
  x: number,
  y: number,
): Promise<void> {
  const id = fileNodeId(root, path);
  if (kind === "dir") {
    m.editor.commit({
      type: "addNode",
      actor: "user",
      payload: { id, type: "directory", title: path, text: "", color: "purple", x, y, w: DIR_CARD_W, h: DIR_CARD_H },
    });
  } else if (await isNotebookFile(root, path)) {
    // A notebook-format `.html` opens as a REACTIVE notebook card (not a plain file view), wherever it
    // lives — the same node id/path as a file card, just the `notebook` type + its larger footprint. This
    // is the "open an existing notebook" path: addNotebookCard mints new ones, a drag-out/row-click reopens
    // any on disk. No write — the file already exists; we card the path as-is.
    m.editor.commit({
      type: "addNode",
      actor: "user",
      payload: { id, type: "notebook", title: path, text: "", color: "green", x, y, w: NOTEBOOK_CARD_W, h: NOTEBOOK_CARD_H },
    });
  } else {
    const kindInfo = fileKind(path);
    // Markdown renders as prose (not a <pre>), so it opens at the larger reading footprint; code/data/etc.
    // keep the compact preview size. Both still freely resize once on the board.
    const prose = kindInfo.kind === "md";
    m.editor.commit({
      type: "addNode",
      actor: "user",
      payload: {
        id,
        type: "file",
        title: path,
        text: "",
        color: kindInfo.color,
        x,
        y,
        w: prose ? PROSE_CARD_W : CARD_W,
        h: prose ? PROSE_CARD_H : CARD_H,
      },
    });
  }
  m.selection.set([id]);
}

// Sanitise a dropped file's name into a safe root-relative path under IMAGE_DIR: keep the extension, slug
// the stem (so spaces/odd chars/path separators can't escape the dir or break the URL), and fall back to a
// neutral name for an empty stem. The server dedupes the basename and returns the FINAL path, so this only
// needs to be safe, not unique.
function imageDestPath(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  const stemRaw = (dot > 0 ? name.slice(0, dot) : name).trim();
  const stem = stemRaw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "image";
  return `${IMAGE_DIR}/${stem}${ext}`;
}

// Fit a dropped image's natural pixel size into a card box that PRESERVES its aspect ratio: scale the
// longer side down to IMAGE_MAX (never up — a small image stays its own size), then clamp to the resize
// floor aspect-preserving (mirrors resizeBox's min logic so the card and the lock agree). An extreme
// panorama/strip hits a min on one axis and lets the other run a touch over aspect — the documented edge.
function fitImageBox(natW: number, natH: number): { w: number; h: number } {
  const aspect = natW > 0 && natH > 0 ? natW / natH : IMAGE_CARD_W / IMAGE_CARD_H;
  const down = Math.min(1, IMAGE_MAX / natW, IMAGE_MAX / natH);
  let w = natW * down;
  let h = natH * down;
  if (w < IMAGE_MIN_W) {
    w = IMAGE_MIN_W;
    h = w / aspect;
  }
  if (h < IMAGE_MIN_H) {
    h = IMAGE_MIN_H;
    w = h * aspect;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

// Decode a dropped image's bytes just far enough to read its intrinsic dimensions, then fit a card box to
// them. Falls back to the fixed thumbnail footprint if the browser can't decode (corrupt/unsupported) —
// the card still lands, just at the generic size. createImageBitmap is the cheap path (no DOM <img>).
async function imageCardBox(file: File): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const box = fitImageBox(bmp.width, bmp.height);
    bmp.close();
    return box;
  } catch {
    return { w: IMAGE_CARD_W, h: IMAGE_CARD_H };
  }
}

// Drop an IMAGE file onto the canvas (image-cards-on-canvas): write its bytes to a real repo file under
// `.canvas/images/` (POST /api/asset, which dedupes the name and returns the path actually written), then
// card THAT path as an `image` node at the drop point. Same (root, path) → node-id addressing as a file card,
// so the dropped image is a first-class, peer-readable, shadow-git-versioned artefact — not an ephemeral paste.
// Returns the node id on success, or null if the write was blocked (then no card is added).
export async function materializeImageAt(
  m: InteractionManager,
  file: File,
  x: number,
  y: number,
): Promise<Id<"node"> | null> {
  const bytes = await file.arrayBuffer();
  // Measure before writing so the card lands at the image's own aspect (no letterbox); a decode failure
  // falls back to the generic footprint. The two awaits are independent, but the decode is cheap and the
  // write dominates, so keeping them sequential keeps the flow readable.
  const box = await imageCardBox(file);
  const stored = await writeAsset("repo", imageDestPath(file.name), bytes);
  if (!stored) return null;
  const id = fileNodeId("repo", stored);
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "image", title: stored, text: "", color: "blue", x, y, w: box.w, h: box.h },
  });
  m.selection.set([id]);
  return id;
}

// Add a directory CARD for a folder — the "File tree" widget (path "" = the repo root) and the engine
// behind any folder add. Same authored addNode as a drag-out; placed at `at` (the right-click point) when
// the menu supplies it, else centred in the viewport (spawnAt). From here you drill INSIDE the card and
// drag the level you want out onto the canvas.
export function addFolderCard(m: InteractionManager, path: string, at?: Pos): void {
  // The "File tree" button (path "") drops ONE combined card (the "roots" sentinel root) whose top level
  // is every root — canonical + git worktrees — read reactively off rootsSignal, so a worktree appearing
  // or vanishing updates the card in place. You drill into a worktree inside the card, and drag a root
  // (or any folder/file) row OUT to pin it as its own single-root card. A specific sub-folder add
  // (non-empty path) stays a single canonical card.
  const root = path === "" ? "roots" : "repo";
  const { x, y } = at ?? spawnAt(m, DIR_CARD_W, DIR_CARD_H);
  void materializeAt(m, root, path, "dir", x, y); // dir branch commits synchronously (no await before it)
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

// The channels browser card (card-types/channels) — the sessions card's twin: a persistent on-canvas list of
// this board's channels; drag a row out (or double-click) to REOPEN that channel as a card (openChannel). Its
// body reads the off-log `channelList` projection (content.ts, /api/channels), so this addNode is the only
// thing it ever logs — the list churns off-log like the sessions card. A stable singleton id (node:channels) →
// idempotent: re-adding is a no-op rather than littering the board. actor "user" + selected, like addSessionsCard.
export function addChannelsCard(m: InteractionManager, at?: Pos): void {
  const w = 280;
  const h = 360;
  const id = "node:channels" as Id<"node">;
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "channels", title: "", text: "", color: "purple", ...(at ?? spawnAt(m, w, h)), w, h },
  });
  m.selection.set([id]);
}

// The roles browser card (card-types/roles, agent-roles.md) — the channels/sessions card's twin: a persistent
// on-canvas list of this board's roles; LAUNCH a session under a role from a row's button, or (phase 2b) open a
// role to edit its charter. Its body reads the off-log `rolesList` projection (content.ts, /api/roles), so this
// addNode is the only thing it ever logs — the list churns off-log like the sessions/channels cards. A stable
// singleton id (node:roles) → idempotent: re-adding is a no-op rather than littering the board. actor "user" +
// selected, like addChannelsCard.
export function addRolesCard(m: InteractionManager, at?: Pos): void {
  const w = 280;
  const h = 360;
  const id = "node:roles" as Id<"node">;
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "roles", title: "", text: "", color: "orange", ...(at ?? spawnAt(m, w, h)), w, h },
  });
  m.selection.set([id]);
}

// A NOTEBOOK card (docs/notebook-card.md). A notebook is a file-backed card like any file
// card: write a starter `.html` (Observable Notebooks 2.0 format) to a path under the canonical root, then
// add the node via the file-card path so the card VIEWS that file — source on disk, body off the off-log
// `fileContent` signal, never node.text (§4). So this is two acts: a content-tier file write (off the
// log) + the one on-log addNode (the card's arrangement + its path reference). NOT a singleton — a fresh
// timestamped name per Add, so notebooks are multiple and re-adds never collide; selected so it's live at
// once. Default dir is `notebooks/`, NOT `.canvas/artefacts/`: `.canvas` is read- and watcher-excluded
// (EXCLUDE_DIRS — the shadow-git echo-loop guard), so the file-card view path can't see it yet; serving
// artefacts under `.canvas` is a later step (shadow-git-ledger.md §8). The `notebooks/` default is the
// promote case that path already named.
const NOTEBOOK_CARD_W = 460;
const NOTEBOOK_CARD_H = 520;
// A fresh notebook opens NEARLY EMPTY — one blank markdown cell, no demo. The five-cell tour that used to
// ship here (x/y/interpolation/manual) read as the notebook's own content rather than a scratch surface, and
// there was no way to clear it but hand-delete. The card now grows cells from its own +code/+markdown footer
// and a per-cell md↔code toggle, so a single click-to-edit prose cell is the right starting point: a target
// to type into that says "this is yours", not a demo to undo.
const STARTER_NOTEBOOK = `<!doctype html>
<notebook>
  <title></title>
  <script id="a1" type="text/markdown">
  </script>
</notebook>
`;

// Pick the next notebook filename — `notebook1`, `notebook2`, … rather than a long timestamp, so the path
// (which is also the cross-card IMPORT handle, §11.2 — `data-in="x=./notebook1"`) is short and legible.
// Uses MAX+1, not lowest-free, across BOTH the files already in `notebooks/` (disk) and the notebook cards
// on the board: never reuses a number, so a name that was deleted but is still imported elsewhere can't be
// resurrected onto a different notebook. Falls back to scanning only the board if the dir read fails.
async function nextNotebookName(m: InteractionManager): Promise<string> {
  const N = /(?:^|\/)notebook(\d+)\.html$/;
  let max = 0;
  const consider = (name: string): void => {
    const hit = N.exec(name);
    if (hit) max = Math.max(max, Number(hit[1]));
  };
  const listing = await listDirOnce("repo", "notebooks");
  for (const f of listing?.files ?? []) consider(f);
  for (const n of m.editor.store.query({ typeName: "node" }).get())
    if ((n as { type?: string }).type === "notebook") consider((n as { title?: string }).title ?? "");
  return `notebook${max + 1}`;
}

export async function addNotebookCard(m: InteractionManager, at?: Pos): Promise<void> {
  const path = `notebooks/${await nextNotebookName(m)}.html`;
  // Write the file FIRST (off-log content tier): if the write-back endpoint is unavailable, leave the
  // board unchanged rather than dropping a card over a file that doesn't exist.
  if (!(await writeFileContent("repo", path, STARTER_NOTEBOOK))) return;
  const id = fileNodeId("repo", path);
  const { x, y } = at ?? spawnAt(m, NOTEBOOK_CARD_W, NOTEBOOK_CARD_H);
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "notebook", title: path, text: "", color: "green", x, y, w: NOTEBOOK_CARD_W, h: NOTEBOOK_CARD_H },
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
  const res = await fetch(
    `/api/session?board=${activeBoardId()}${id ? `&id=${encodeURIComponent(id)}` : ""}`,
  );
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
      ...(at ?? spawnAt(m, SESSION_CARD_W, SESSION_CARD_H)),
      w: SESSION_CARD_W,
      h: SESSION_CARD_H,
    },
  });
}

// Reopen a thread as a card from the rail (the sessions card's twin, card-types/channels). Unlike
// openSession there's NO server round-trip: a thread's node id IS the thread id (`node:thread:<short>`, or
// a carried-over `node:chan:<short>`), and its message log already lives server-side (seeded from
// `.canvas/threads/` at boot, streamed on thread:<id>), so reopening is purely a canvas act — re-add the
// node with the SAME id and the card's NodeView re-subscribes to the feed and shows the restored backlog.
// The reopened node is typed "thread" regardless of the id's vintage (both types render the same card). If
// a card for this thread is already on the board, FLY to it (select + fitSelection) instead of littering a
// duplicate; otherwise add it (at the drop point, else viewport-centred) and select it. actor "user" (like
// createThread / addSessionsCard) so a reopen is an undoable, attributed act.
const THREAD_CARD_W = 460;
const THREAD_CARD_H = 420;
export function openChannel(m: InteractionManager, threadId: string, title: string, text: string, at?: Pos): void {
  const id = threadId as Id<"node">;
  if (m.editor.store.get<"node">(id)) {
    m.selection.set([id]);
    m.fitSelection();
    return;
  }
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: {
      id,
      type: "thread",
      title: title || "thread",
      text: text ?? "",
      color: "purple",
      ...(at ?? spawnAt(m, THREAD_CARD_W, THREAD_CARD_H)),
      w: THREAD_CARD_W,
      h: THREAD_CARD_H,
    },
  });
  m.selection.set([id]);
}

// An IN-CANVAS link target, resolved from a markdown link's href (Channel UI: clickable charter links). The
// rule: an http(s) href is an ordinary EXTERNAL link; ANY OTHER href names a card ON the canvas. A literal
// `node:…` id IS that card; anything else is a repo-relative PATH → its file card (`node:repo:<path>`, the
// fileNodeId scheme) — matching the notebook relative-path convention. The renderer presents external links
// as <a target=_blank> and canvas links as a click-to-focus affordance (openCanvasLink below).
export type CanvasLink =
  | { external: true; href: string }
  | { external: false; nodeId: Id<"node">; path?: string };
export function resolveCanvasLink(href: string): CanvasLink {
  if (/^https?:\/\//i.test(href)) return { external: true, href };
  if (href.startsWith("node:")) return { external: false, nodeId: href as Id<"node"> };
  const path = href.replace(/^\.?\//, ""); // tolerate a leading ./ or / on a repo-relative path
  return { external: false, nodeId: fileNodeId("repo", path), path };
}

// Open/focus a repo FILE card by its root-relative PATH — the canvas-link click action. Mirrors openChannel's
// "fly to it if it's already on the board" (select + fitSelection), except a file card may not exist yet, so
// we materialize it first (same path→id scheme, materializeAt, which also detects notebook/prose footprints)
// and then focus. Exported so any in-canvas link affordance can reuse it.
export async function openFileByPath(m: InteractionManager, path: string): Promise<void> {
  const clean = path.replace(/^\.?\//, "");
  const id = fileNodeId("repo", clean);
  if (!m.editor.store.get<"node">(id)) {
    const { x, y } = spawnAt(m, CARD_W, CARD_H);
    await materializeAt(m, "repo", clean, "file", x, y);
  }
  m.selection.set([id]);
  m.fitSelection();
}

// Act on a clicked in-canvas link: external → open a new tab; a repo-relative path → materialize-and-focus
// its file card; a literal node id → focus that card if it's on the board (we can't synthesize a non-file
// card from an id alone, so an absent target is a quiet no-op rather than a broken card).
export async function openCanvasLink(m: InteractionManager, href: string): Promise<void> {
  const link = resolveCanvasLink(href);
  if (link.external) { window.open(link.href, "_blank", "noopener,noreferrer"); return; }
  if (link.path !== undefined) { await openFileByPath(m, link.path); return; }
  if (m.editor.store.get<"node">(link.nodeId)) { m.selection.set([link.nodeId]); m.fitSelection(); }
}

// Resolve a markdown link's href against the DOC's OWN location — a relative link in a file means
// "relative to this file's directory" (`board-decisions.md` inside `.canvas/memory/MEMORY.md` →
// `.canvas/memory/board-decisions.md`), and a leading-slash href is repo-root-relative. This is the
// piece resolveCanvasLink lacks (it only ever resolves against the repo root). Returns the target
// (root, path) for an in-repo file link, or null for links that keep their default browser behavior:
// external (any URL scheme — http:, https:, mailto:, node: — or protocol-relative `//host`) and in-page
// anchors (`#section`). Query/hash suffixes are stripped before resolving. Same root as the source card,
// so a link opens within the same checkout/worktree.
export function resolveDocLink(root: RootId, baseDir: string, href: string): { root: RootId; path: string } | null {
  const h = href.trim();
  if (!h || h.startsWith("#")) return null; // empty or in-page anchor
  if (h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // protocol-relative or any scheme → external
  const clean = h.replace(/[?#].*$/, ""); // drop ?query / #fragment
  const joined = clean.startsWith("/") ? clean.slice(1) : baseDir ? baseDir + "/" + clean : clean;
  const path = normalizeRelPath(joined);
  return path ? { root, path } : null;
}

// Collapse `.`/`..`/empty segments of a POSIX-style relative path (browser-side — no node:path). A leading
// `..` that escapes the root just pops nothing, so the result stays within the root.
function normalizeRelPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return out.join("/");
}

// Open the file a DOC-card link points at, placed cascaded off the SOURCE card so it lands right by the
// link you clicked. The (root, path) → id scheme makes a repeat click on the same link re-select the
// existing card instead of duplicating it; materializeAt picks the prose vs preview footprint. Deliberately
// does NOT move the camera (no fitSelection): the source card is already in view and the target cascades
// off it, so holding the current view keeps both visible — flying would be disorienting for a near hop.
// A link to a file that doesn't exist still cards the path — the file card then shows its own
// missing/tombstone state, which reads as "this link is broken" rather than failing silently.
export async function openDocLink(m: InteractionManager, sourceId: Id<"node">, root: RootId, path: string): Promise<void> {
  const id = fileNodeId(root, path);
  if (!m.editor.store.get<"node">(id)) {
    const prose = /\.(md|markdown)$/i.test(path);
    const { x, y } = cascadeFrom(m, sourceId, prose ? PROSE_CARD_W : CARD_W, prose ? PROSE_CARD_H : CARD_H);
    await materializeAt(m, root, path, "file", x, y);
  }
  m.selection.set([id]);
}

// Open a ROLE's charter card to EDIT it (agent-roles.md phase 2b) — the channels card's edit-twin. A role is
// authored as `.canvas/roles/<roleId>/role.md` (frontmatter {name, colour} + charter prose); this card is a
// VIEW over that real file, exactly the file/notebook content/record split. So its node title carries the
// role.md PATH (the `roleDoc` capability reads + parses that file off-log via the shared role-format codec,
// host-side; `roleSave` serialises edits back through the same file write path). The node id is stable per
// role (`node:role:<roleId>`) → idempotent: re-opening flies to the existing card rather than duplicating.
// actor "user" (an undoable, attributed placement), like openChannel.
const ROLES_DIR = ".canvas/roles";
const ROLE_CARD_W = 460;
const ROLE_CARD_H = 480;
export function roleDocPath(roleId: string): string {
  return `${ROLES_DIR}/${roleId}/role.md`;
}
export function openRole(m: InteractionManager, roleId: string, at?: Pos): void {
  const id = `node:role:${roleId}` as Id<"node">;
  if (m.editor.store.get<"node">(id)) {
    m.selection.set([id]);
    m.fitSelection();
    return;
  }
  m.editor.commit({
    type: "addNode",
    actor: "user",
    payload: {
      id,
      type: "role",
      title: roleDocPath(roleId), // the role.md path: the `roleDoc`/`roleSave` capabilities key off it
      text: "",
      color: "orange",
      ...(at ?? spawnAt(m, ROLE_CARD_W, ROLE_CARD_H)),
      w: ROLE_CARD_W,
      h: ROLE_CARD_H,
    },
  });
  m.selection.set([id]);
}

// Spawn a NEW live Claude Code session (agent-sessions §8 / slice 2) and drop a card showing it. The
// server-side registry owns the process (decoupled from this card's lifecycle); we just mint a card
// titled with the new session id, which subscribes to its `session:<id>` feed and can prompt it back
// through `sessionInput`. The one addNode is the only thing on the intent log — the session's prompts
// and turns stay in its own file/feed, REFERENCED, never replicated (session-timelines §3/§4). The
// process writing files would arrive separately via the commit-watcher, attributed to that session.
// A role the user can spawn a session "as" (agent-roles.md). A role is a folder under `.canvas/roles/`
// authored as role.md (frontmatter {name, colour} + charter prose); the server reads them and lists them
// here. The frontend only needs the id (to spawn under), the display name, and a colour to swatch in the
// picker — the charter never reaches the browser (the server appends it to the spawned session's prompt).
export interface Role {
  roleId: string;
  name: string;
  colour?: string; // a NOTE_COLORS key or a CSS colour — the picker treats it as a swatch background
}

// The roles available to spawn under (GET /api/roles). Returns [] on any failure (endpoint not yet live,
// no claude, a parse error), so the picker degrades cleanly to just the "No role" option rather than erroring.
export async function fetchRoles(): Promise<Role[]> {
  try {
    const res = await fetch(`/api/roles?board=${activeBoardId()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { roles?: Role[] };
    return Array.isArray(data.roles) ? data.roles : [];
  } catch {
    return [];
  }
}

export async function spawnLiveSession(m: InteractionManager, at?: Pos, roleId?: string): Promise<void> {
  // When spawning UNDER a role, the server reads that role's role.md, appends the charter to the system
  // prompt, stamps roleId/roleName on the session marker, and returns the role's display name so the card
  // can carry a friendly handle. A bare spawn (no roleId) behaves exactly as before.
  const res = await fetch(`/api/session/spawn?board=${activeBoardId()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(roleId ? { roleId } : {}),
  });
  if (!res.ok) return; // no claude on PATH, or the spawn failed — leave the board unchanged
  const { id, roleName } = (await res.json()) as { id: string; roleName?: string };
  // The card's display NAME = "<RoleName>.<short-sid>" when spawned under a role, so two instances of the
  // same role stay distinguishable (and @RoleName prefix-matching can disambiguate by the sid suffix). The
  // title MUST stay the raw session id — the template keys its `session` feed + `sessionInput` off it — so
  // the name rides as a SEPARATE field (NodeRecord.name) the head/list render in preference to the title.
  const name = roleName ? `${roleName}.${id.slice(0, 8)}` : undefined;
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
      ...(name ? { name } : {}),
      ...(at ?? spawnAt(m, SESSION_CARD_W, SESSION_CARD_H)),
      w: SESSION_CARD_W,
      h: SESSION_CARD_H,
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
      fetch(`/api/session?board=${activeBoardId()}&id=${encodeURIComponent(n.title)}`).catch(
        () => undefined,
      ),
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
// Gated to known cards for CARD-LEVEL effects: a single repo watch backs whatever folders the user has
// added, but a content change / unlink to a path with NO card touches no card — we don't auto-spawn cards
// for the whole repo (the pre-palette behaviour). The in-card directory TREE is the exception and updates
// LIVE: an add/unlink re-pulls its parent folder's off-log listing (refreshListing), so a file created or
// removed on disk appears in / disappears from the tree at once — only PROMOTING a path to its own card
// stays a deliberate drag-out. Returns an unsubscribe fn.
export function watchDataset(
  m: InteractionManager,
  root: RootId,
  onEvent?: (e: WatchEvent) => void,
): () => void {
  // Rides the tab's shared WebSocket (feeds.subscribeWatch) rather than its own EventSource — a standing
  // SSE stream per root was one of the three per-tab streams that starved the browser's six-per-host
  // connection pool. Reconnect + re-subscribe live in feeds.ts; the server closes its watcher with the sub.
  return subscribeWatch(root, (ev) => void onWatchEvent(m, root, ev as WatchEvent, onEvent));
}

async function onWatchEvent(
  m: InteractionManager,
  root: RootId,
  msg: WatchEvent,
  onEvent?: (e: WatchEvent) => void,
): Promise<void> {
  // Keep the in-card directory tree live FIRST, independent of whether a card exists for this path: an
  // add/unlink changes the PARENT folder's children, so re-pull that one cached listing (no-op unless
  // the folder was actually loaded). A `change` only touches file content, not membership, so skip it.
  if (msg.type !== "change") refreshListing(root, parentDir(msg.path));

  // Doc annotations ride the same watch (before the card gate — a ledger file under
  // `.canvas/annotations/` never has a card of its own): a ledger append or an edit to an annotated
  // file re-pulls that path's annotation projection (no-op unless some card has loaded it).
  annotationsWatchEvent(root, msg.path);

  const id = fileNodeId(root, msg.path);
  if (!m.editor.store.get<"node">(id)) return; // no card for this (root, path) → no card-level effect

  if (msg.type === "unlink") {
    // TOMBSTONE, don't remove (slice D): a pinned card is the user's spatial memory — silently
    // deleting it on a disk unlink is the "where did my content go?" failure. Mark it gone so the
    // template shows a tombstone the user dismisses deliberately; a re-add (below) clears it.
    setGone(root, msg.path, true);
  } else {
    setGone(root, msg.path, false); // re-created on disk → clear any tombstone
    const r = await fetch(
      `/api/file?board=${activeBoardId()}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(msg.path)}`,
    );
    if (!r.ok) return; // a directory event (no file body) or transient — its listing refreshes on re-subscribe
    setFileContent(root, msg.path, filePreview((await r.json()) as TreeFile));
  }
  onEvent?.(msg);
}
