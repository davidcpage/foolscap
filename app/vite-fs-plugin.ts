import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { commitRoot, watchRoot } from "./shadow-git.js";
import { isCanvasSession, listSessions, markCanvasSession, readCanvasSession, recordSessionEnd } from "./session-ledger.js";
import { appendThreadLine, canvasThreadsDir, fillSeat, listThreads, migrateChannelLedger, readThreadLog, readThreadMeta, seatForSid, upsertThreadMeta } from "./thread-ledger.js";
import { resolveTags } from "./channel-tags.js";
import { isWorkIntent, intentLine, WORK_INTENTS, type WorkIntent } from "./work-intent.js";
import { canvasRolesDir, createRole, listRoles, readRole, seedDefaultRole } from "./role-ledger.js";
import chokidar from "chokidar";

// The Node backbone of the spike — a dev-server middleware (no separate process) that exposes a real
// folder's text files to the browser and pushes live change events. This is the seam the design note
// calls "files are the source of truth for content": the canvas holds spatial state (records/log), the
// FILES hold the content, and this middleware is the bridge. It does the two jobs the browser can't:
// read the filesystem, and (phase 2) tail it for out-of-band edits. Phase 3 (write-back + git commit)
// would add a PUT handler here; deliberately not built yet.
//
//   GET /api/ls?root=<id>&path=…     → { path, dirs: [rel], files: [rel] } — immediate children, no content
//   GET /api/file?root=<id>&path=…   → { path, content, truncated }
//   GET /api/watch?root=<id>         → text/event-stream of { type: add|change|unlink, path }
//   GET /api/weather?q=<place>       → { resolved, name, current:{…}, error } — Open-Meteo, polled server-side, no root
//
// `root` is an ALLOW-LISTED id (never a caller-supplied path), and every file read is re-checked to be
// inside that root — the middleware runs with the dev server's full fs privileges, so both guards matter.

const here = path.dirname(fileURLToPath(import.meta.url));

// The one allow-listed root: the canvas repo itself, derived from the dev-server location so it tracks
// whatever machine this runs on (no hardcoded user path). Folders are added per-canvas now (the Add-files
// menu picks a SUBDIR of this root, server-validated by safeResolve) rather than a fixed dataset enum.
const ROOTS: Record<string, string> = {
  repo: path.resolve(here, ".."),
};

// Board identity (Phase 1 of multi-canvas). A board is a target repo plus a STABLE id derived from that
// repo's realpath — port-independent and restart-stable, so persistence keyed on it survives the dev
// server bouncing to a different port. `<slug(basename)>-<sha256(realpath)[:8]>` stays human-legible for
// debugging while the hash keeps two same-named repos apart. The browser fetches this via /api/boards and
// keys its IndexedDB + camera on the boardId. Phase 2 makes the set of boards dynamic (mount on demand,
// unify with ROOTS); for now there is exactly one — the dev repo — flagged `default`.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "board";
}
function boardIdentity(repoPath: string): { boardId: string; name: string; repoPath: string } {
  let real = repoPath;
  try {
    real = fs.realpathSync(repoPath);
  } catch {
    /* unresolvable (deleted/permission) — hash the path as given so the id is still stable */
  }
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  const name = path.basename(real);
  return { boardId: `${slug(name)}-${hash}`, name, repoPath: real };
}

const DEFAULT_BOARD = boardIdentity(ROOTS.repo!);
// boardId → its served root + metadata. Pinned on globalThis (like fsState below) so mounts made through
// /api/boards SURVIVE a dev-server re-eval (a plugin edit re-runs this module in the same process) — an
// open non-default tab would otherwise 400 on its boardId until the browser re-mounted. The default board
// (the dev repo) is always present.
interface BoardInfo {
  root: string;
  name: string;
  repoPath: string;
}
const boards: Map<string, BoardInfo> = ((globalThis as { __canvasBoards?: Map<string, BoardInfo> })
  .__canvasBoards ??= new Map());
if (!boards.has(DEFAULT_BOARD.boardId))
  boards.set(DEFAULT_BOARD.boardId, { root: ROOTS.repo!, name: DEFAULT_BOARD.name, repoPath: DEFAULT_BOARD.repoPath });
// boardIds whose repo-scoped feeds (githead + sessions-list) are already running — also pinned, since the
// surviving watchers from before a re-eval keep publishing (they close over the pinned feedClients/Values).
const boardFeedsStarted: Set<string> = ((globalThis as { __canvasBoardFeeds?: Set<string> })
  .__canvasBoardFeeds ??= new Set());

// A board's Claude Code transcripts dir: ~/.claude/projects/<repoPath with / → ->. Per board now (was a
// single module constant) so a canvas over another repo lists THAT repo's sessions, not the dev repo's.
function sessionsDir(repoPath: string): string {
  return path.join(os.homedir(), ".claude", "projects", repoPath.replace(/\//g, "-"));
}

// Resolve the board a request targets (?board=<id>, default board if omitted), or null if unknown.
function reqBoard(url: URL): (BoardInfo & { boardId: string }) | null {
  const id = url.searchParams.get("board") ?? DEFAULT_BOARD.boardId;
  const b = boards.get(id);
  return b ? { boardId: id, ...b } : null;
}

function boardJson(boardId: string, b: { name: string; repoPath: string }): {
  boardId: string;
  name: string;
  repoPath: string;
  default: boolean;
} {
  return { boardId, name: b.name, repoPath: b.repoPath, default: boardId === DEFAULT_BOARD.boardId };
}

function handleBoards(res: ServerResponse): void {
  sendJson(res, 200, { boards: [...boards.entries()].map(([id, b]) => boardJson(id, b)) });
}

// ── worktrees as ROOTS (worktree-activity slice B) ────────────────────────────────────────────────
// A board is a workspace that can serve MORE THAN ONE root: its canonical checkout (rootId "repo") plus
// every linked git worktree of that repo. Worktrees are DISCOVERED, never mounted: `git worktree list`
// sees whatever an agent or a human created via the CLI, so a new tree appears on its own (and the
// watcher below re-discovers on `.git/worktrees/` churn). Node ids are already `node:<root>:<path>`, so
// the extra roots' file cards never collide; the rootId is the slug of the worktree's dir basename.
interface RootInfo {
  id: string; // "repo" for the canonical checkout; slug(basename) for a worktree
  name: string;
  path: string; // absolute, realpath'd — the confined dir every read of this root is re-checked against
  branch: string;
  head: string;
}
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p; // unresolvable — compare/serve the path as given
  }
}
function listWorktrees(canonicalPath: string): RootInfo[] {
  let out: string;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: canonicalPath, encoding: "utf8" });
  } catch {
    return []; // not a git repo / git absent — no worktrees, just the canonical root
  }
  const raw: { path?: string; branch?: string; head?: string }[] = [];
  let cur: { path?: string; branch?: string; head?: string } = {};
  const flush = (): void => {
    if (cur.path) raw.push(cur);
    cur = {};
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) (flush(), (cur.path = line.slice(9)));
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "detached") cur.branch = "(detached)";
  }
  flush();
  // EXCLUDE this board's OWN checkout — it's already the canonical "repo" root (added by boardRoots). It
  // isn't necessarily the first entry: `git worktree list` always prints the MAIN checkout first, so a
  // board rooted at a LINKED worktree must drop the matching entry by realpath, not by position. Every
  // other entry (the main checkout included, seen from a worktree board) becomes a sibling root.
  const canon = realpath(canonicalPath);
  return raw
    .map((r) => ({ real: realpath(r.path!), branch: r.branch ?? "", head: r.head ?? "" }))
    .filter((r) => r.real !== canon)
    .map((r) => {
      let id = slug(path.basename(r.real));
      if (id === "repo") id = "repo-wt"; // never shadow the canonical id (a worktree dir literally named "repo")
      return { id, name: path.basename(r.real), path: r.real, branch: r.branch, head: r.head };
    });
}

// Roots per board (canonical first). `git worktree list` is AUTHORITATIVE for both add and remove, so the
// cache is only a short-lived memo to avoid spawning git on every file read — it REVALIDATES past a small
// TTL and, when the set actually changed, pings `roots:<board>` so open boards refetch and their file-tree
// card drops/adds the root live. This self-heals even when the filesystem watcher misses an event — which
// is exactly what bit us: removing the last worktree deletes `.git/worktrees/` out from under chokidar, so
// the watcher never fired and a removed worktree stayed stuck in the card. The watcher (startWorktreesFeed)
// is now just a best-effort prompt push on top of this guarantee. Pinned on globalThis like `boards`; a
// fresh global KEY (not the old `__canvasRoots`) so a server restart discards the old-shaped cache.
interface RootsCacheEntry {
  roots: RootInfo[];
  at: number;
}
const rootsCache: Map<string, RootsCacheEntry> = ((globalThis as { __canvasRootsCache?: Map<string, RootsCacheEntry> })
  .__canvasRootsCache ??= new Map());
const ROOTS_TTL_MS = 2000;
// Membership identity — id+path, NOT head/branch: a commit inside a worktree shouldn't force a refetch,
// only a worktree appearing or disappearing should.
function rootsChanged(a: RootInfo[], b: RootInfo[]): boolean {
  return a.length !== b.length || a.some((r, i) => r.id !== b[i].id || r.path !== b[i].path);
}
function boardRoots(boardId: string): RootInfo[] {
  const cached = rootsCache.get(boardId);
  if (cached && Date.now() - cached.at < ROOTS_TTL_MS) return cached.roots;
  const b = boards.get(boardId);
  if (!b) return cached?.roots ?? [];
  const roots: RootInfo[] = [{ id: "repo", name: b.name, path: b.root, branch: "", head: "" }, ...listWorktrees(b.repoPath)];
  rootsCache.set(boardId, { roots, at: Date.now() });
  if (cached && rootsChanged(cached.roots, roots)) publishFeed("roots:" + boardId, { ts: Date.now() });
  return roots;
}
// Resolve a caller's rootId to its absolute dir, confined to this board's known roots — NEVER a
// caller-supplied path (same guarantee as the single `board.root` before). Missing/"" → canonical.
function rootDir(boardId: string, rootId: string | null): string | null {
  const r = boardRoots(boardId).find((x) => x.id === (rootId || "repo"));
  return r ? r.path : null;
}

// Mount a target repo as a board (POST /api/boards { repoPath }). Idempotent: the boardId is a pure
// function of the realpath, so re-mounting the same repo returns the same id without duplicating. The dev
// server runs with full fs privileges and is 127.0.0.1-only, but we still validate the path exists and is
// a directory before adding it — the canvas serves a real folder, not an arbitrary string.
async function handleBoardMount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { repoPath?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.repoPath !== "string" || !body.repoPath)
    return sendJson(res, 400, { error: "missing repoPath" });
  let real: string;
  try {
    real = fs.realpathSync(body.repoPath);
  } catch {
    return sendJson(res, 404, { error: "path not found" });
  }
  if (!fs.statSync(real).isDirectory()) return sendJson(res, 400, { error: "not a directory" });
  const id = boardIdentity(real);
  if (!boards.has(id.boardId)) {
    boards.set(id.boardId, { root: real, name: id.name, repoPath: id.repoPath });
    console.log(`[boards] mounted ${id.boardId} → ${real}`);
  }
  startBoardFeeds(id.boardId, id.repoPath); // git HEAD + sessions-list feeds for this repo
  sendJson(res, 200, boardJson(id.boardId, boards.get(id.boardId)!));
}

// Claude Code's transcripts live in ~/.claude/projects/<slug> — resolved PER BOARD by sessionsDir(repoPath)
// above (the session handlers thread the board's dir), so the cards serve the right repo's history.
const MAX_SESSION_BYTES = 4 * 1024 * 1024; // whole sessions, bounded against a pathological one. The
// card scrolls, so we serve the full transcript; the cap only guards an extreme outlier (and the
// card flags it honestly when it bites — the codec marks a partial tail). In-memory spike, so a few
// MB in node.text is fine.

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".vite", ".cache", "coverage",
  // `.canvas` is the canvas's own filesystem (docs/canvas-home.md): images, channel logs, artefacts, and the
  // shadow ledger all live here. It stays in this set for the BROWSE LISTING (handleLs / Rule A) so the
  // file-tree card isn't cluttered with canvas internals — `.canvas` content is addressed directly by
  // (root, path), not browsed. The WATCHERS and CONTENT ENDPOINTS instead use isInternalPath (Rule B) below,
  // which treats only the shadow git-dirs under `.canvas/roots/` as off-limits (the one feedback-loop hazard)
  // and lets the rest of `.canvas/` through — so a dropped image / file-backed body is watched and servable.
  ".canvas",
]);
// Rule B (docs/canvas-home.md §3/§5): is this path INTERNAL to the watchers + content endpoints? Excluded if
// any segment is a generated/internal dir — EXCEPT `.canvas`, whose CONTENT must be reachable; under `.canvas`
// only the shadow git-dirs (`.canvas/roots/<id>/git`) are internal (a commit writes objects there, so a
// watcher seeing them would re-commit forever — the feedback loop). Path-aware: the `.canvas/roots` boundary
// is two adjacent segments, which a bare basename Set can't express. Accepts absolute or root-relative paths.
function isInternalPath(p: string): boolean {
  const segs = p.split(/[\\/]/);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === ".canvas") {
      if (segs[i + 1] === "roots") return true; // the shadow object store — never watched/served
      continue; // every other `.canvas/<content>` is reachable
    }
    if (EXCLUDE_DIRS.has(s)) return true;
  }
  return false;
}
// Text files only — the cards render content inline, so binaries are skipped at the listing.
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".css", ".html", ".py", ".yaml", ".yml", ".toml", ".sh",
]);
const MAX_BYTES = 128 * 1024; // a file card shows a preview, not the whole file — but 128KB shows the
// great majority of real source files IN FULL (6KB cut almost everything mid-file). Head-kept: a file
// reads top-down, so the start is the part you want (unlike a transcript). Flagged `truncated` when it
// bites; raised here because every too-stingy cap in this app has cost more in debugging than memory.

// IMAGE assets (the image card, image-cards-on-canvas). Binaries can't ride the text file endpoints
// (TEXT_EXT-gated, utf8) so they get their OWN /api/asset read/write, with a parallel extension gate and
// a mime map for the read's Content-Type. Drag-and-drop lands a screenshot/photo as a repo file here, then
// the image card views it by (root, path) — same addressing as a file card, different transport.
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
const MAX_ASSET_BYTES = 12 * 1024 * 1024; // images are heavier than source — a generous cap (a high-res
// screenshot or photo fits comfortably); the byte read is the one bound, per CLAUDE.md's size-cap rule.

// Resolve a caller-supplied relative path against a root and refuse anything that escapes it.
function safeResolve(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

function readText(abs: string): { content: string; truncated: boolean } | null {
  try {
    const buf = fs.readFileSync(abs);
    return { content: buf.subarray(0, MAX_BYTES).toString("utf8"), truncated: buf.length > MAX_BYTES };
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// The IMMEDIATE children of one directory (root-relative paths, no content) — the lazy primitive the
// in-card file tree navigates one level at a time, the off-log `dirListing` projection on the client
// (content.ts). Same exclusions/text-filter as the file read. Scoped to a SUBDIR of root (`sub`,
// validated to sit inside root — "" = the repo root); paths returned relative to ROOT so node ids stay
// (root, path)-stable and the watch stream addresses the same cards.
function handleLs(res: ServerResponse, root: string, sub: string): void {
  const base = safeResolve(root, sub);
  if (!base) return sendJson(res, 400, { error: "bad path" });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    const rel = path.relative(root, path.join(base, e.name));
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) dirs.push(rel);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      files.push(rel);
    }
  }
  dirs.sort();
  files.sort();
  sendJson(res, 200, { path: sub, dirs, files });
}

function handleFile(res: ServerResponse, root: string, rel: string): void {
  const abs = safeResolve(root, rel);
  // Apply the SAME gates handleLs uses, so a card can only read what the listing would have shown:
  // inside the root (safeResolve), not under an excluded dir (.git, node_modules, …), and only a
  // known text extension. Without this, /api/file would read any non-listed file in the root — a
  // secret with no text ext (.env, *.pem → blocked here), or anything under .git. 404, not 403, so
  // the endpoint never confirms a blocked file exists.
  const allowed =
    !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  const r = allowed ? readText(abs!) : null;
  if (!r) return sendJson(res, 404, { error: "not found" });
  sendJson(res, 200, { path: rel, content: r.content, truncated: r.truncated });
}

// WRITE a file's content (POST /api/file) — Phase-3 write-back, first consumer the notebook card's
// serialize-back (docs/notebook-card.md §13). Scoped to the SAME gates as the read (handleFile): inside
// the root (safeResolve), not internal (isInternalPath — .git, node_modules, and the shadow git-dirs under
// .canvas/roots/), and a known text extension — so a card can only write what the listing would have shown,
// and never into the shadow-git ledger's object store. Creates the parent dir if missing (the first notebook
// mints `notebooks/`). The repo watch then fires a `change`, refreshing the off-log content signal on every
// card viewing this path. (A file-backed `.canvas/` body — a sticky, a channel log — writes here too.)
async function handleFileWrite(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  rel: string,
): Promise<void> {
  const abs = safeResolve(root, rel);
  const allowed =
    !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  if (!allowed) return sendJson(res, 404, { error: "not found" }); // 404, like the read — never confirm a blocked path
  let body: { content?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  if (typeof body.content !== "string") return sendJson(res, 400, { error: "content required" });
  // Bound the write at the one place a byte cap belongs (CLAUDE.md): the same MAX_BYTES the read previews
  // at — a card's editable view is preview-sized, so a write larger than that is out of this path's scope.
  if (Buffer.byteLength(body.content, "utf8") > MAX_BYTES) return sendJson(res, 413, { error: "too large" });
  try {
    fs.mkdirSync(path.dirname(abs!), { recursive: true });
    fs.writeFileSync(abs!, body.content, "utf8");
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { path: rel, ok: true });
}

// Shared confinement gate for IMAGE asset paths — the same envelope as the text read/write (inside the
// root, not internal per isInternalPath) but with the IMAGE_EXT gate instead of TEXT_EXT. Returns the
// absolute path or null. Both /api/asset read and write route through here, so neither can touch a non-image
// path; `.canvas/images/<name>` is the drop home (docs/canvas-home.md), reachable because isInternalPath
// excludes only `.canvas/roots/`.
function assetGate(root: string, rel: string): string | null {
  const abs = safeResolve(root, rel);
  if (!abs) return null;
  if (isInternalPath(rel)) return null; // Rule B: serves `.canvas/images`, refuses the shadow git-dirs
  return IMAGE_EXT.has(path.extname(rel).toLowerCase()) ? abs : null;
}

// READ a raw image asset (GET /api/asset) — streams the bytes with a mime'd Content-Type so an <img src>
// the image card renders resolves straight to the file on disk. 404 (never confirm a blocked path) when the
// gate refuses or the file is missing; the card shows its own broken-image tombstone on a failed load.
function handleAssetRead(res: ServerResponse, root: string, rel: string): void {
  const abs = assetGate(root, rel);
  if (!abs) return sendJson(res, 404, { error: "not found" });
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "Content-Type": IMAGE_MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store", // the (root, path) is stable but its bytes can be re-dropped; never stale
  });
  res.end(buf);
}

// WRITE an image asset (POST /api/asset, raw binary body) — the drop-on-canvas landing. Gated like the
// read; bounded at MAX_ASSET_BYTES (the one byte cap). NEVER clobbers: if the basename is taken it appends
// `-1`, `-2`, … and returns the FINAL path, so the client cards that path (a unique (root, path) → a unique
// node id). Creates the parent dir if missing (the first drop mints `.canvas/images/`).
async function handleAssetWrite(req: IncomingMessage, res: ServerResponse, root: string, rel: string): Promise<void> {
  if (!assetGate(root, rel)) return sendJson(res, 404, { error: "not found" });
  let buf: Buffer;
  try {
    buf = await readBodyBuffer(req);
  } catch {
    return sendJson(res, 400, { error: "bad body" });
  }
  if (buf.length === 0) return sendJson(res, 400, { error: "empty" });
  if (buf.length > MAX_ASSET_BYTES) return sendJson(res, 413, { error: "too large" });
  // Resolve a non-clobbering path: keep the dropped name, else `name-1.ext`, `name-2.ext`, …
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let finalRel = rel;
  let abs = assetGate(root, finalRel)!;
  for (let n = 1; fs.existsSync(abs); n++) {
    finalRel = `${stem}-${n}${ext}`;
    abs = assetGate(root, finalRel)!;
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { path: finalRel, ok: true });
}

// Shared confinement gate for the MUTATING fs endpoints (rename/delete). Same envelope as the read/write:
// inside the root (safeResolve), not internal (isInternalPath — .git, node_modules, and the shadow git-dirs
// under .canvas/roots/) — and NEVER the root directory itself (`rel === ""` would resolve to the checkout/
// worktree root, deleting or moving which is categorically out of a card's scope). Returns the absolute path
// or null. The TEXT_EXT gate is applied per-endpoint instead of here, because it only constrains FILES — a
// directory has no extension but is a legitimate rename/delete target (the listing shows folders too).
function fsMutGate(root: string, rel: string): string | null {
  if (!rel) return null; // the root dir itself is never a target
  const abs = safeResolve(root, rel);
  if (!abs || abs === root) return null;
  return isInternalPath(rel) ? null : abs;
}

// RENAME / MOVE a file or directory (POST /api/file/rename, body { from, to }) — the file-tree card's
// in-app rename (and move, since `rename ≡ move` at the fs layer: a `to` under a different parent moves it,
// and the parent is created if missing). Both ends pass fsMutGate; a FILE additionally requires a text
// extension on BOTH ends (a card only lists/edits text files, so it can't rename one into a hidden binary).
// Refuses to clobber: a pre-existing destination is 409, never an overwrite. The repo watch then fires
// unlink(from)+add(to), refreshing the off-log listings; the browser that issued the rename re-keys any
// PINNED card from the old (root, path) to the new one (loader.renameFileNodes) so it survives in place
// rather than tombstoning — the referential-integrity win an external Finder rename can't deliver.
async function handleFileRename(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  let body: { from?: unknown; to?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const src = fsMutGate(root, from);
  const dst = fsMutGate(root, to);
  if (!src || !dst) return sendJson(res, 404, { error: "not found" }); // 404, like the read — never confirm a blocked path
  let st: fs.Stats;
  try {
    st = fs.statSync(src);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (st.isFile()) {
    const ok = TEXT_EXT.has(path.extname(from).toLowerCase()) && TEXT_EXT.has(path.extname(to).toLowerCase());
    if (!ok) return sendJson(res, 404, { error: "not found" });
  }
  if (fs.existsSync(dst)) return sendJson(res, 409, { error: "destination exists" });
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true }); // a `to` in a new sub-folder is a move-into-folder
    fs.renameSync(src, dst);
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { ok: true, from, to, kind: st.isDirectory() ? "dir" : "file" });
}

// DELETE a file or directory (POST /api/file/delete?path=…) — the file-tree card's Shift+Delete. Gated by
// fsMutGate (and TEXT_EXT for a file, mirroring rename), then `fs.rm` (recursive for a directory). This is a
// real disk delete: a pinned card for the path is left to the watch's unlink → `gone` TOMBSTONE (slice D),
// which the user dismisses deliberately — the same "don't silently vanish a card" rule the loader follows.
// (No shadow-ledger restore yet — that ledger is still a design, docs/shadow-git-ledger.md — so a delete is
// presently as durable as `rm`; the undo story lands when the ledger does.)
function handleFileDelete(res: ServerResponse, root: string, rel: string): void {
  const abs = fsMutGate(root, rel);
  if (!abs) return sendJson(res, 404, { error: "not found" });
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (st.isFile() && !TEXT_EXT.has(path.extname(rel).toLowerCase()))
    return sendJson(res, 404, { error: "not found" }); // a non-text file is in no listing — out of scope
  try {
    fs.rmSync(abs, { recursive: st.isDirectory(), force: false });
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { ok: true, path: rel, kind: st.isDirectory() ? "dir" : "file" });
}

// Real Claude Code transcripts in the board's transcripts `dir`: `*.jsonl` minus the `*.usage.jsonl` sidecars (those
// are a separate usage-logging stream, not conversations). Returned newest-first by mtime so a
// caller with no id gets the most recent session.
// GET /api/session?id=<sessionId>  → { id, content, truncated }: one transcript's raw jsonl, bounded.
// No `id` → the most recent session. The id is an allow-listed shape (no dots/slashes) AND the
// resolved path is re-checked to sit in the board's transcripts dir — same two guards as the file reads, since this
// also runs with the dev server's fs privileges. Content is served raw; the jsonl → turns codec is
// the card's (render.js), keeping the format understood in exactly one place.
function readSessionFile(dir: string, id: string): { content: string; truncated: boolean } | null {
  const abs = path.resolve(dir, id + ".jsonl");
  if (!abs.startsWith(dir + path.sep)) return null; // id re-checked to sit in the board's transcripts dir
  try {
    const buf = fs.readFileSync(abs);
    // Keep the TAIL when capping, never the head: a transcript is append-only and the card reads it
    // bottom-up (auto-scroll-to-bottom), so the bytes you want are the most RECENT — where you left off.
    // Head-slicing here would have hidden the live end behind the old opening, the same class of bug as
    // the card's old turn-slice. The codec tolerates the ragged first line a tail leaves. (The live feed
    // bounds itself the same way, MAX_SESSION_FEED_BYTES.) `truncated` flags it so the card says so.
    const over = buf.length > MAX_SESSION_BYTES;
    return {
      content: (over ? buf.subarray(buf.length - MAX_SESSION_BYTES) : buf).toString("utf8"),
      truncated: over,
    };
  } catch {
    return null;
  }
}

function handleSession(res: ServerResponse, dir: string, id: string | null, repoPath: string): void {
  let chosen = id;
  if (!chosen) chosen = listSessions(dir, repoPath)[0]?.id ?? null;
  if (!chosen) return sendJson(res, 404, { error: "no sessions found" });
  if (!/^[\w-]+$/.test(chosen)) return sendJson(res, 400, { error: "bad session id" });
  const r = readSessionFile(dir, chosen);
  if (!r) return sendJson(res, 404, { error: "not found" });
  // Backfill the ledger: a card asked for this transcript, so it's ON the board — that makes it canvas-
  // owned by adoption (whether we spawned it or it predates the ledger). Marking on first serve is what
  // migrates existing cards in (so they list again) without a client change, and keeps the list filtered
  // to externals nobody has placed. Write-once: a real spawn already wrote a richer marker; don't clobber it.
  if (!isCanvasSession(repoPath, chosen)) markCanvasSession(repoPath, chosen, { adoptedAt: Date.now() });
  ensureSessionFeed(dir, chosen, repoPath); // a card asked for this transcript → start live-tailing it (below)
  sendJson(res, 200, { id: chosen, content: r.content, truncated: r.truncated });
}

// A human-legible label + counts for the dropdown, parsed from a transcript. The label prefers the
// agent-written `ai-title` record (a clean summary the session already produces, refined as it grows
// — so we keep the LAST one); failing that, the first human prompt, truncated. Two counts, both shown:
// `turns` is user messages carrying actual text (things you typed, not the tool-result envelopes that
// also ride the `user` channel); `messages` is the raw user+assistant record count (every tool
// iteration included). Cached by mtime so the dropdown parses each transcript at most once.
const summaryCache = new Map<
  string,
  { mtime: number; title: string | null; turns: number; messages: number }
>();

function userText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p): p is { type?: unknown; text?: unknown } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => (p.text as string).trim())
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

function sessionSummary(
  abs: string,
  mtime: number,
): { title: string | null; turns: number; messages: number } {
  const hit = summaryCache.get(abs);
  if (hit && hit.mtime === mtime)
    return { title: hit.title, turns: hit.turns, messages: hit.messages };
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let turns = 0;
  let messages = 0;
  try {
    const text = fs.readFileSync(abs, "utf8").slice(0, MAX_SESSION_BYTES);
    for (const line of text.split("\n")) {
      if (!line) continue;
      let o: { type?: string; aiTitle?: unknown; message?: { content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) {
        aiTitle = o.aiTitle.trim();
      } else if (o.type === "user" || o.type === "assistant") {
        messages++;
        if (o.type === "user") {
          const t = userText(o.message?.content);
          if (t) {
            turns++;
            if (firstPrompt === null) firstPrompt = t;
          }
        }
      }
    }
  } catch {
    // unreadable transcript → no summary; the client falls back to the bare id
  }
  const title = aiTitle ?? (firstPrompt ? firstPrompt.slice(0, 80) : null);
  summaryCache.set(abs, { mtime, title, turns, messages });
  return { title, turns, messages };
}

// The lifecycle BAND a session reads, in the SAME categories the session card paints
// (card-types/session/render.js `frameState`): a live process is `working` (running) or `waiting` (idle,
// the loud "your turn") — except an idle session that named a peer in a channel @-tag reads `waiting-agent`
// (blue, "waiting on an agent, not you"); an ended one reads its recorded reason — `done` / `crashed` / a
// neutral `ended` (terminate or unknown). One server-side source so every view (the sessions list bar, the
// minimap dot, the heads-up) agrees with the card instead of re-deriving it.
type SessionBand =
  | "working" | "waiting" | "waiting-agent" | "scheduled" | "done" | "crashed" | "ended";
function endReasonBand(reason: string | undefined): SessionBand {
  return reason === "done" ? "done" : reason === "crashed" ? "crashed" : "ended";
}
function sessionStatus(repoPath: string, id: string): SessionBand {
  const live = liveSessions.get(id);
  if (live) {
    if (live.status === "running") return "working";
    // Idle: blocked on a peer (blue) > asleep on the loop heartbeat (calm teal `scheduled`, a looping role
    // between ticks — no human demand) > the default loud amber "your turn".
    if (live.status === "idle") {
      return live.waitingOn?.length ? "waiting-agent" : live.loops ? "scheduled" : "waiting";
    }
    if (live.endReason) return endReasonBand(live.endReason); // exited process with a recorded reason
  }
  // not live (or exited with no in-memory reason) → the durable marker is the only surviving source
  return endReasonBand(readCanvasSession(repoPath, id)?.endReason as string | undefined);
}

// GET /api/sessions → every historical transcript (newest-first), for the Open-session dropdown. The
// list IS the disk: a session card deleted from the canvas still appears here, so "reopen it later"
// needs no canvas persistence — the .jsonl is the source of truth. listSessions() stays a cheap
// readdir+stat (handleSession leans on it too); the per-transcript title/turn parse is added only here.
function handleSessions(res: ServerResponse, dir: string, repoPath: string): void {
  const sessions = listSessions(dir, repoPath).map((s) => {
    const marker = readCanvasSession(repoPath, s.id);
    return {
      ...s,
      ...sessionSummary(path.join(dir, s.id + ".jsonl"), s.mtime),
      status: sessionStatus(repoPath, s.id),
      // The role this session instantiates, if any — lets the list/minimap render `<RoleName>.<short-sid>`,
      // with roleColour so a historical row's role chip tints the same as the live picker swatch.
      roleId: (marker?.roleId as string | undefined) ?? null,
      roleName: (marker?.roleName as string | undefined) ?? null,
      roleColour: (marker?.roleColour as string | undefined) ?? null,
    };
  });
  sendJson(res, 200, { sessions });
}

// ── sessions-list feed (the sessions browser card's live push) ──────────────────────────────────
// The session list is built by readdir+parse ON DEMAND (handleSessions); unlike the file tree it had
// no live push, so a sessions card only refreshed on mount or the ⟳ button — a newly-started session
// didn't appear until then. Watch the board's transcripts dir and PING the `sessions:<boardId>` feed on any transcript
// add/change/unlink; the client re-pulls /api/sessions (content.ts, one pull regardless of how many
// cards are open). A bare ping (just a ts), NOT the list itself — handleSessions stays the single place
// the list is built, and its parse runs only when a card is actually listening to re-pull. No startup
// seed: the feed carries nothing until a real change, so a fresh subscriber triggers no redundant pull.
// Debounced — Claude Code writes a live transcript repeatedly, so a burst of appends (and the
// `*.usage.jsonl` sidecar landing alongside) coalesces to one ping. `change` is watched too, so an
// open list also keeps a running session's turn/message counts and title live, not just its arrival.
// (Like the git/HN/cardtypes feeds, the watcher isn't pinned on fsState — the boardFeedsStarted guard
// stops a server reload from stacking a second one per board, and a surviving watcher keeps publishing.)
function startSessionsFeed(boardId: string, dir: string): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  chokidar.watch(dir, { ignoreInitial: true, depth: 0 }).on("all", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("sessions:" + boardId, { ts: Date.now() }), 200);
  });
}

// GET /api/threads (alias: /api/channels) → every thread this board has on disk (newest activity first),
// for the list rail (the threads browser card, the sessions card's twin). Mirrors handleSessions: a cheap
// readdir of the `.canvas/threads/` markers, NOT the message logs — the rail wants title/brief/activity,
// not the conversation (the card reads that off the thread:<id> feed once opened). `messages` is the last
// seq, the monotonic count of everything posted; a thread deleted from the canvas still lists here, so
// "reopen it later" needs no canvas persistence — the marker is the source of truth (the sessions list's
// .jsonl rationale). Each entry carries the id under BOTH `threadId` (canonical) and `chanId` (what the
// pre-rename rail card reads), and the response under both `threads` and `channels` — transition aliases.
function handleThreads(res: ServerResponse, repoPath: string): void {
  const threads = listThreads(repoPath).map((m) => ({
    threadId: m.threadId,
    chanId: m.threadId,
    title: typeof m.title === "string" ? m.title : "",
    text: typeof m.text === "string" ? m.text : "",
    messages: typeof m.lastSeq === "number" ? m.lastSeq : 0,
    mtime: (m.lastTs ?? m.createdAt ?? 0) as number,
    // Latest declared work-intent per participant (threads-as-cards §6; keyed by seat handle where the
    // declarer holds one, else sid) — the raw material the step-3 thread-state projection derives from.
    intents: m.intents ?? {},
    // The §5 seat records: the durable per-thread participants (role posts), 1:1 with roles until labels.
    seats: m.seats ?? {},
  }));
  sendJson(res, 200, { threads, channels: threads });
}

// GET /api/roles → every role this board has on disk (by name), for the role-picker on "new session".
// Mirrors handleThreads: a cheap read of the `.canvas/roles/` markers, NOT the charters — the picker
// wants name/colour, the charter is read only when a role is actually instantiated (handleSessionSpawn).
function handleRoles(res: ServerResponse, repoPath: string): void {
  sendJson(res, 200, { roles: listRoles(repoPath) });
}

// POST /api/roles { name, charter?, colour? } → create a role (writes `.canvas/roles/<roleId>/role.md`).
// 400 on a bad/missing name, 409 if a role with that id already exists. Returns the created role.
async function handleRolesCreate(req: IncomingMessage, res: ServerResponse, repoPath: string): Promise<void> {
  let body: { name?: unknown; charter?: unknown; colour?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.name !== "string" || !body.name) return sendJson(res, 400, { error: "missing name" });
  try {
    const role = createRole(repoPath, {
      name: body.name,
      charter: typeof body.charter === "string" ? body.charter : "",
      colour: typeof body.colour === "string" ? body.colour : undefined,
    });
    publishFeed("roles:" + boardIdentity(repoPath).boardId, { ts: Date.now() }); // nudge any open picker to re-pull
    sendJson(res, 200, { role });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    return sendJson(res, /already exists/.test(msg) ? 409 : 400, { error: msg });
  }
}

// ── channels-list feed (the channels browser card's live push) ──────────────────────────────────
// The channels-list mirror of startSessionsFeed: watch `.canvas/channels/` and PING the `channels:<boardId>`
// feed on any marker add/change (a channel gaining its first message, or a title/activity update); the client
// re-pulls /api/channels once per ping (content.ts). A bare ping, not the list — handleThreads stays the one
// place the list is built. mkdir first so chokidar has a directory to watch even before any channel has been
// persisted (a fresh board). Not pinned on fsState — boardFeedsStarted stops a reload from stacking a second.
function startThreadsFeed(boardId: string, repoPath: string): void {
  const dir = canvasThreadsDir(repoPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort — the watch tolerates a missing dir */ }
  let t: ReturnType<typeof setTimeout> | null = null;
  chokidar.watch(dir, { ignoreInitial: true, depth: 0 }).on("all", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("threads:" + boardId, { ts: Date.now() }), 200);
  });
}

// ── roles-list feed (the roles browser card's live push) ─────────────────────────────────────────
// The roles-list mirror of startThreadsFeed: watch `.canvas/roles/` and PING the `roles:<boardId>` feed on
// any role create OR edit, so the roles-list card re-pulls /api/roles. POST /api/roles already pings on
// create, but a role.md edited THROUGH the file write path (/api/file, the role card's save) wouldn't —
// the watcher generalises it to any change. depth:1 because a role.md sits one level down (roles/<id>/role.md),
// unlike the flat channel markers. mkdir first so chokidar has a dir to watch on a fresh board; not pinned on
// fsState — boardFeedsStarted stops a reload from stacking a second.
function startRolesFeed(boardId: string, repoPath: string): void {
  const dir = canvasRolesDir(repoPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort — the watch tolerates a missing dir */ }
  let t: ReturnType<typeof setTimeout> | null = null;
  chokidar.watch(dir, { ignoreInitial: true, depth: 1 }).on("all", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("roles:" + boardId, { ts: Date.now() }), 200);
  });
}

// Server-Sent Events: hold the connection open and forward chokidar add/change/unlink as JSON frames.
// This is the reactive ingest path — an out-of-band edit (your editor, an agent, git pull) becomes a
// live event the canvas turns into a card update, with no polling.
function handleWatch(req: IncomingMessage, res: ServerResponse, root: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);

  const emit = (type: string) => (abs: string) =>
    res.write(`data: ${JSON.stringify({ type, path: path.relative(root, abs) })}\n\n`);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // Rule B (docs/canvas-home.md §5): watch `.canvas/` CONTENT (so a dropped image / file-backed body
    // refreshes its card) but never the shadow git-dirs under `.canvas/roots/` (the feedback loop).
    ignored: (p: string) => isInternalPath(p),
  });
  // Forward DIR add/remove too (mapped to the generic add/unlink), so a directory card whose folder is
  // deleted on disk gets tombstoned rather than hanging on "loading…" (worktree-activity slice D). The
  // client gates every event to a card that actually exists, so forwarding dir events is harmless noise
  // otherwise.
  watcher
    .on("add", emit("add"))
    .on("addDir", emit("add"))
    .on("change", emit("change"))
    .on("unlink", emit("unlink"))
    .on("unlinkDir", emit("unlink"));

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000); // keep proxies from closing the stream
  req.on("close", () => {
    clearInterval(ping);
    void watcher.close();
  });
}

// ── feeds (demo §10: "the clock with a fetch in it") ────────────────────────────────────────────
// A tiny server-side feed registry, multiplexed onto ONE SSE stream (/api/feeds). Each feed is a
// named source that publishes its latest value; the client turns each name into an off-log signal
// (the clock's pattern, fed from here instead of setInterval). Values are channel-1-only on the
// canvas — nothing a feed emits ever touches the log/persistence/git. New connections get every
// feed's last value immediately, so cards render without waiting for the next tick.

interface SseClient {
  res: ServerResponse;
}

// Vite restarts the dev server on a plugin-file edit by RE-EVALUATING this module in the SAME node
// process (a server.restart, not a process exit). Module-level state would therefore reset while the
// spawned session children keep running — orphaning them: the new registry has no handle, so a
// POST /input 409s and the live feed goes silent, and the process-exit kill hook never fires (the
// process never exited). That is the exact failure that lost a live session on a server edit. Pin the
// load-bearing state on globalThis (one object, shared across re-evals in the process) so a
// re-evaluated module ADOPTS the surviving children, watchers and SSE plumbing instead of leaking
// them. Identity is the point: a surviving child's stdout closure still calls the OLD publishFeed,
// which reads these SAME Set/Map objects — so the reconnected browser (re-registered in the shared
// feedClients) keeps receiving its output, and sendSessionInput finds the live child to write to.
// Pinning feedsStarted also stops configureServer's startFeeds() from stacking a second git/HN
// watcher on every reload.
// One channel's off-log message log (4e): the durable-for-the-process record of a channel's conversation,
// the source for both the channel:<id> feed (the card's conversation view) and the agent's GET /api/inbox.
interface ThreadMsg {
  seq: number; // monotonic per channel — a session's read cursor is "last seq pulled"
  ts: number;
  from: string; // sender session id, or "human" / "system"
  text: string;
  // CARD-ONLY entries: the card renders them but inbox/nudge skip them (they wake no one). "ask" is the
  // §16 Q→A legibility echo; "intent" is the work-intent typed act (threads-as-cards §6) with the declared
  // intent in `intent` (the machine truth — `text` is just its legible face, see intentLine).
  kind?: "ask" | "intent";
  intent?: WorkIntent;
}
// A card-only entry never wakes a member and never counts as inbox content — the shared gate for every
// unread filter (an agent's own bookkeeping must not wake the room).
const cardOnly = (m: ThreadMsg): boolean => m.kind != null;
// §16 ask/reply: a synchronous consultation held in memory, keyed by askId (NOT a persisted recipient —
// the durable log stays broadcast-only). The HTTP response is parked until reply or timeout. Pinned in
// fsState so the queue survives a hot re-eval; the held `res`/`timer` are process-bound (a restart times
// them out, which is the correct degradation).
interface PendingAsk {
  askId: string;
  threadId: string;
  from: string; // asker sid (its /ask connection is held open)
  to: string; // answerer sid
  text: string;
  ts: number;
  res: ServerResponse; // the asker's parked connection, resolved on reply/timeout
  timer: ReturnType<typeof setTimeout>;
}
interface CanvasFsState {
  feedClients: Set<SseClient>;
  feedValues: Map<string, unknown>;
  feedsStarted: boolean;
  liveSessions: Map<string, LiveSession>;
  sessionWatchers: Map<string, ReturnType<typeof chokidar.watch>>;
  sessionCleanupHooked: boolean;
  shuttingDown?: boolean; // set by killAll so the exit handler tells a clean server shutdown from a real crash
  threadLogs: Map<string, ThreadMsg[]>; // threadId → its message log (pinned so it survives a hot re-eval)
  pendingAsks?: Map<string, PendingAsk>; // §16 askId → held consultation (added via ??= for old pinned state)
}
const fsState: CanvasFsState = ((globalThis as { __canvasFsState?: CanvasFsState }).__canvasFsState ??= {
  feedClients: new Set<SseClient>(),
  feedValues: new Map<string, unknown>(),
  feedsStarted: false,
  liveSessions: new Map<string, LiveSession>(),
  sessionWatchers: new Map<string, ReturnType<typeof chokidar.watch>>(),
  sessionCleanupHooked: false,
  threadLogs: new Map<string, ThreadMsg[]>(),
});
// Reference-typed collections aliased by identity so the rest of the file is untouched; the two
// boolean guards are read/written through fsState (a primitive can't be aliased and still survive).
const feedClients = fsState.feedClients;
const feedValues = fsState.feedValues;
const liveSessions = fsState.liveSessions;
const sessionWatchers = fsState.sessionWatchers;
// `??=` so a fsState pinned BEFORE this field existed (a hot re-eval) gets the map added in place rather
// than reading `undefined` and crashing — the object initializer above only runs when fsState is absent.
const threadLogs = (fsState.threadLogs ??= new Map<string, ThreadMsg[]>());
const pendingAsks = (fsState.pendingAsks ??= new Map<string, PendingAsk>());

function publishFeed(feed: string, value: unknown): void {
  feedValues.set(feed, value);
  const frame = `data: ${JSON.stringify({ feed, value })}\n\n`;
  for (const c of feedClients) c.res.write(frame);
}

// Open an SSE stream and add it to a client set, with the keep-alive ping + close bookkeeping all
// the streams here share. Returns the client handle.
function openSse(req: IncomingMessage, res: ServerResponse, clients: Set<SseClient>): SseClient {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);
  const client: SseClient = { res };
  clients.add(client);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
  return client;
}

function handleFeeds(req: IncomingMessage, res: ServerResponse): void {
  openSse(req, res, feedClients);
  for (const [feed, value] of feedValues) res.write(`data: ${JSON.stringify({ feed, value })}\n\n`);
}

// Feed: the repo's HEAD commit. chokidar on .git/HEAD (branch switches) + .git/logs/HEAD (every
// commit/amend/pull — the reflog is the one file that always moves); on either, ask git for the
// tip. The walk/watch above EXCLUDE .git wholesale, so this is its own deliberate watch — the
// file-card pipeline and the commit feed stay separate ingest paths.
function startGitHeadFeed(boardId: string, repo: string): void {
  const feed = "githead:" + boardId;
  const read = () =>
    execFile(
      "git",
      ["log", "-1", "--format=%H%x1f%an%x1f%ct%x1f%s"],
      { cwd: repo },
      (err, stdout) => {
        if (err) return; // e.g. empty repo — keep the previous value
        const [sha, author, ct, message] = stdout.trim().split("\x1f");
        if (sha) publishFeed(feed, { sha, author, message, ts: Number(ct) * 1000 });
      },
    );

  let t: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (t) clearTimeout(t);
    t = setTimeout(read, 150); // a commit touches several .git files; coalesce to one read
  };
  chokidar
    .watch([path.join(repo, ".git/HEAD"), path.join(repo, ".git/logs/HEAD")], { ignoreInitial: true })
    .on("all", debounced);
  read();
}

// ── live session feed (agent-sessions-on-canvas.md §3, slice 1: live-tail) ──────────────────────
// A session card asked for transcript `id` (handleSession), so watch that `.jsonl` and republish its
// content on the feed `session:<id>` whenever it changes — the SAME channel-1 seam the clock and git
// HEAD use. A live Claude Code session you're working in then re-renders its card as you go, with NO
// setText: the transcript is derived/channel-1, never the canvas intent log (the clock rule, §9.1;
// session-timelines.md §1/§5 — the file is the one source, the canvas only projects it).
//
// Slice-1 cost, accepted (§9.4): it republishes the WHOLE file (bounded by MAX_SESSION_BYTES) on each
// change, not a per-turn delta — fine for the spike; a real impl streams appended turns into a ring
// buffer. Debounced so a burst of appends is one publish. Idempotent per id, kept for the server's
// life like the other feeds (the registry/lifecycle of agent-sessions §8 is the live-terminal step,
// not this one — here the process is your own Claude Code, running out-of-band).
// (sessionWatchers lives on fsState — aliased at the top — so it survives a server reload.)

function ensureSessionFeed(dir: string, id: string, repoPath: string): void {
  // A registry-OWNED, still-LIVE session (slice 2: we spawned the process) publishes session:<id> from
  // the live PROCESS stream (finer, token-level) — don't also tail its .jsonl, or two publishers fight on
  // one feed and the turn-granular file would clobber the token-granular stdout. But once that process has
  // EXITED — a canvas session whose dev server was cold-restarted (the kill-hook ends the child), or one
  // that simply finished — the entry no longer publishes, so its transcript card would be stuck on the
  // last live frame with no way to show what's on disk. Fall through to the file-tail then, so the card
  // shows the full, current transcript (where you left off) until you Resume it. (An ABSENT entry — the
  // common cold-restart case, registry empty in the fresh process — falls through too.) The feed name is
  // board-free (session ids are globally-unique UUIDs); the file lives in this board's transcripts `dir`.
  const owned = liveSessions.get(id);
  if (owned && owned.status !== "exited") return; // a live process owns the feed — don't double-publish
  if (sessionWatchers.has(id) || !/^[\w-]+$/.test(id)) return;
  const feed = "session:" + id;
  const publish = () => {
    const r = readSessionFile(dir, id);
    // Stamp `ended:true`: by construction this file-tail path only runs for a session with NO live process
    // (the early return above bows out for a live-owned one), and externals are filtered out entirely, so a
    // tail here is always a dead canvas transcript — no mtime heuristic needed. The card reads this to paint
    // the muted "inactive" band instead of guessing "live" from a status-less feed. Phase 2: carry the
    // durable end REASON off the marker too, so a post-restart card still splits "✓ done" from "✕ crashed"
    // (the in-memory s.endReason is gone after a restart — the marker on disk is the only surviving source).
    const endReason = readCanvasSession(repoPath, id)?.endReason as string | undefined;
    if (r) publishFeed(feed, { ...r, ended: true, endReason });
  };
  let t: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (t) clearTimeout(t);
    // Small coalescing window only — just enough to batch a multi-write flush into one publish. The
    // card's perceived lag is NOT here: Claude Code writes the .jsonl per COMPLETED message/turn, not
    // per token (measured: the file sits flat for seconds mid-turn while the terminal streams), so a
    // file-tail is turn-granular by nature. Token-level liveness needs the in-flight PROCESS stream as
    // a channel-1 feed (the spawn+duplex slice / agent-sessions §6), not this file watch.
    t = setTimeout(publish, 80);
  };
  const watcher = chokidar
    .watch(path.resolve(dir, id + ".jsonl"), { ignoreInitial: true })
    .on("all", debounced);
  sessionWatchers.set(id, watcher);
  publish(); // seed the feed so a fresh subscriber renders immediately (replayed on SSE connect too)
}

// Stop the out-of-band file-tail for `id`. Called when the registry takes the session live (resume):
// `--resume` appends to the SAME .jsonl, so a surviving turn-granular file watch would clobber the
// registry's token-granular stream on the shared feed — the "two publishers fight" the comment above
// warns about. The startup guard only prevents a NEW watch; this closes an EXISTING one.
function stopSessionFeed(id: string): void {
  const w = sessionWatchers.get(id);
  if (w) {
    void w.close();
    sessionWatchers.delete(id);
  }
}

// ── live session registry (agent-sessions-on-canvas.md §8; session-timelines.md §5) ─────────────
// The one genuinely-NEW piece the docs name (§8): a server-side registry that SPAWNS and OWNS a real
// Claude Code process, decoupled from card lifecycle. A live session is a real process; the card is a
// VIEW of it (closing the card never kills the process — there is no card→kill wire). This is the
// load-bearing complexity, kept here on the server, OUT of the canvas channels.
//
// The duplex (agent-sessions §3, corrected by session-timelines §3/§4):
//   • OUT: the process's stream-json stdout → republished on the SAME channel-1 feed `session:<id>`
//     the card already reads. Token-level: `--include-partial-messages` deltas are accumulated into an
//     in-flight synthetic assistant turn, so text appears as it streams (finer than slice 1's
//     turn-granular file tail). Channel-1 only — a streaming token NEVER touches the log/git (§9.1).
//   • IN: POST /api/session/<id>/input writes a stream-json user message to the process stdin. This is
//     SESSION-INTERNAL — it gets NO canvas-log entry and rides NO editor.commit (session-timelines §4
//     corrected agent-sessions §3 here): a prompt to a session is a session act the canvas points at,
//     not one it absorbs. The process writes its own `.jsonl` (the referenced one-source file, §5).
//
// PERMISSIONS (agent-sessions §9.3 — "the terminal runs code"). The spawned agent runs as you, in the
// repo, with this mode. A canvas session has no TTY to approve at, so "default" would STALL any
// tool-using turn (text-only answers still stream, but the §8 payoff — agent edits files → commits →
// the commit-watcher re-renders the cards live — never fires). "auto" lets it act unattended so a
// canvas session is genuinely a working agent; local-only solo, as §9.3 accepts. Dial to "default"
// (text only) or up to "bypassPermissions" (skip every check) here if that balance ever changes.
const SESSION_PERMISSION_MODE = "auto";

// BASELINE permission allow-list, ADDED to every spawn on top of `--permission-mode auto`. Allow-rules
// are ADDITIVE: we only ever grant explicit allows; anything without a rule still flows through the
// classifier exactly as before, so routine session changes never need hand-permissioning. The principle
// (see docs/agent-roles.md): capability is a UNIFORM baseline, NOT a second axis of role identity — a
// role is knowledge + memory + charter, not a permission set. So self-commit and spawning are normal for
// ANY session (ad-hoc sessions are the norm); only the RED LINE stays gated by the classifier — `git
// push`, destructive ops, out-of-scope or large/costly fan-out. `git commit` is decoupled from `push`.
// (A role may NARROW this in the rare case via a role.md override — deferred; not how roles normally
// differ.) Spawning rides the `scripts/canvas` wrapper so the gated /api/session/spawn curl is reachable
// without allowing `Bash(curl:*)` wholesale.
const BASELINE_ALLOWED_TOOLS = [
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(scripts/canvas:*)",
  "Bash(./scripts/canvas:*)",
].join(",");

// AskUserQuestion is auto-cancelled in `-p` headless mode (VERIFIED: the CLI synthesises an
// is_error="Answer questions?" tool_result and continues — it never waits for an answer on stdin, so
// there's no tool_result loop to hook). So we DISALLOW it (below) and steer the session to a convention
// the card CAN render+answer over the existing input duplex: a fenced ```ask block (same JSON shape as
// AskUserQuestion's input) that render.js turns into clickable options and answers as a normal user
// message. The disallow is the backstop; this prompt is the replacement. See askuserquestion memory.
const ASK_CONVENTION =
  "INTERACTIVE QUESTIONS: The AskUserQuestion tool is unavailable in this environment. When you need " +
  "the user to choose between options, do NOT call AskUserQuestion and do NOT ask in prose — instead " +
  "emit a fenced code block whose info string is `ask` and whose body is a single JSON object shaped " +
  "exactly like AskUserQuestion's input:\n\n" +
  "```ask\n" +
  '{"questions":[{"question":"<the question>","header":"<≤12 char label>","multiSelect":false,' +
  '"options":[{"label":"<short choice>","description":"<what it means / the tradeoff>"}]}]}\n' +
  "```\n\n" +
  "`questions` is an ARRAY: to ask more than one thing at once, put every question as its own object in " +
  "that SAME array inside ONE ```ask block — do NOT emit a second ```ask block (only the first is " +
  "interactive; later ones render as dead text). They are then answered together. Example with two:\n\n" +
  "```ask\n" +
  '{"questions":[' +
  '{"question":"Which color?","header":"Color","multiSelect":false,"options":[{"label":"red"},{"label":"blue"}]},' +
  '{"question":"Which size?","header":"Size","multiSelect":false,"options":[{"label":"S"},{"label":"L"}]}' +
  "]}\n" +
  "```\n\n" +
  "The app renders this as clickable buttons and sends the user's selection back as their next message. " +
  "Emit the ```ask block as the LAST thing in your turn, then stop and wait for the reply. Keep option " +
  "labels short and put the rationale in `description`. Use it whenever the answer is a choice among options.";

// The CANVAS COLLABORATION BRIEF: an appended system-prompt block that tells a canvas-spawned session
// where it is running and how to coordinate with peers through THREADS (threads-as-cards.md — the per-task
// container that replaced the long-lived channel; the machinery is identical). The agent learns its own
// identity (board id, session id, server origin) — all known at spawn — so the protocol is concrete, not
// "discover the port yourself". Two jobs: TEACH the mechanics (read the board, join/post/read a thread) and
// SET NORMS (coordinate & propose; don't execute large/irreversible work without a human nod). The agent
// works in thread ids + its own sid — the server handles node/edge ids.
function collabBrief(boardId: string, sessionId: string, origin: string): string {
  const base = `http://${origin}`;
  return [
    "CANVAS ENVIRONMENT. You are a Claude session running as a live card on a foolscap board — a shared,",
    "infinite-canvas workspace. Other Claude sessions may be cards on the SAME board, and the board is",
    "shared memory you all read and write. Your identity here:",
    `  • board id: ${boardId}`,
    `  • your session id: ${sessionId}`,
    `  • server: ${base}`,
    "",
    "READ THE BOARD (pull — you learn board state by asking; nothing is pushed except thread messages):",
    `  GET ${base}/api/canvas?board=${boardId}  → { snapshot: { records: [...] } }. Records are nodes`,
    '  (cards) and edges. A session card is {type:"session"} titled with its session id. A THREAD is a card',
    '  {type:"thread"} (legacy boards may still carry {type:"channel"} — same thing) whose `text` is the task',
    '  BRIEF; sessions join it via {type:"member:open"} edges (from session card → thread card).',
    "",
    "THREADS are how you talk to peers: a thread is a TASK with a conversation attached — born when work",
    "starts, closed when it resolves. You work in THREAD IDS + your own session id; the server resolves the",
    "rest. A post is always LOGGED for everyone, but it only WAKES the members you @-tag — so name who you",
    "need. Tag a member by a prefix of their session id (`@a927e694`, or any unambiguous shorter prefix like",
    "`@a9`); `@all` wakes the whole room; an UNTAGGED post wakes no one (it's ambient — peers see it when they",
    "next read, but you won't interrupt them). If you tag a specific peer and then go idle, your card shows",
    "\"waiting on an agent\" (not \"waiting on a human\"), so untag-and-broadcast only when you really mean it.",
    `  • post:   POST ${base}/api/thread/<threadId>/message?board=${boardId}  { from:"${sessionId}", text }  (put @tags in text)`,
    `  • join / accept an invite:  POST ${base}/api/thread/<threadId>/join?board=${boardId}   { from:"${sessionId}" }`,
    `  • leave / decline:          POST ${base}/api/thread/<threadId>/leave?board=${boardId}  { from:"${sessionId}" }`,
    `  • invite another session:   POST ${base}/api/thread/<threadId>/invite?board=${boardId} { from:"${sessionId}", target:"<their sid>" }`,
    "    (join/invite take an optional history:\"full\"|\"future\" — default full replays the backlog on first read)",
    `  • ASK one member (consult & BLOCK for the answer): POST ${base}/api/thread/<threadId>/ask?board=${boardId}`,
    `      { from:"${sessionId}", to:"<their sid>", text, timeoutMs? } — the call HANGS until they reply (or it`,
    "      times out, ≤60s): { reply:{from,text,ts} } or { timedOut:true }. Use this when you NEED an answer to",
    "      continue (e.g. asking an oracle session); use /message for fire-and-forget. Only the two of you are woken.",
    "  When you JOIN, the server messages you the thread's brief, its members, and these recipes — so you",
    "  don't need to memorise them. To start a fresh thread, addNode {type:\"thread\", title:<the task>, text:<brief>}",
    `  via POST ${base}/api/command?board=${boardId} { type, actor:"${sessionId}", payload }, then invite peers.`,
    "  One task, one thread: put new work in a new thread rather than piggybacking on an old one.",
    "",
    "RECEIVING. Thread messages do NOT arrive as your input — they are recorded in the thread. When a peer",
    "posts, you get a short nudge line `[canvas] new thread messages: ...`. READ the actual messages with a",
    "tool call (a normal GET — the result comes back as tool output, any time you like):",
    `  GET ${base}/api/inbox?session=${sessionId}  → { channels:[{ channel:<threadId>, title, messages:[{seq,t,from,text}] }] } (from = a short @-taggable handle; t = MM-DD HH:MM)`,
    "  It returns only what is new since your last read and marks it read. Call it when nudged, or proactively",
    "during a long task to check for updates without waiting for a nudge. For a LONG backlog, window the recent",
    `  tail with ?limit=N (last N messages) and/or ?bytes=K (text-byte budget) — e.g. ${base}/api/inbox?session=${sessionId}&bytes=20000;`,
    "  the response carries a `truncated` note when older messages were windowed out (re-join history:\"full\" to replay all).",
    "",
    "ANSWERING ASKS. If a peer /asks you, the nudge says `N pending question(s)`. Read them (they HANG waiting):",
    `  GET ${base}/api/asks?session=${sessionId}  → { asks:[{ askId, channel:<threadId>, from, text, ts }] }`,
    `  then answer each: POST ${base}/api/thread/<threadId>/reply?board=${boardId} { from:"${sessionId}", askId, text }`,
    "  — which unblocks the asker. A consulting (oracle-style) session lives in this loop: be quick, answer in file:line.",
    "",
    "DECLARE YOUR WORK-INTENT. From the outside, idle-but-working, blocked-on-a-human, and finished look",
    "IDENTICAL (a silent process) — only you know which, so SAY it. Post a typed status into the thread your",
    "work belongs to (card-only: it wakes no one, it just keeps the board honest about whose turn it is):",
    `  POST ${base}/api/thread/<threadId>/intent?board=${boardId}  { from:"${sessionId}", intent, note? }`,
    '  intent ∈ "working" | "blocked:human" | "blocked:peer" | "done". Declare "blocked:human" whenever you ask',
    '  the human something and stop; "blocked:peer" while you wait on another session; "done" when your part of',
    "  the work is finished (then wind down, below). A short note says what you're blocked on / what you finished.",
    "",
    "WINDING DOWN. Every idle session is treated as WAITING-FOR-A-HUMAN by default (its card glows a loud",
    "amber \"waiting\" band), so when your work is genuinely finished and you don't need the human again, end",
    "your OWN session — its card then settles into a calm \"✓ done\" instead of nagging for attention:",
    `  POST ${base}/api/session/${sessionId}/done   → records this session done and terminates it.`,
    "  Do this only AFTER you've reported your result / posted any handoff to the thread — it ends the turn.",
    "  A session is EPHEMERAL: its durable trace is the thread log + any handoff/write-up you leave, NOT the",
    "  process. To continue this work later, a FRESH session is spawned with the task as its first turn — don't",
    "  rely on being resumed; a revived session can't tell new instructions from replayed backlog and will just re-finish.",
    "",
    "NORMS. Read the board, talk in threads, and claim work before racing a peer on the same file. Stay within",
    "your thread's task/brief. Doing the work you were spawned for — editing files, running tests, and",
    "COMMITTING your work to the local repo — is in bounds and needs no nod: a local commit is a normal act, and",
    "it is NOT a push (they are separate — committing never reaches a remote). What DOES need a human nod first is",
    "the RED LINE: pushing to a remote, anything externally-visible or hard to reverse, deleting another agent's",
    "work, changing a thread's task/brief, or spawning a large/costly fan-out of sessions. When one of those is",
    "warranted, surface a short plan and wait — otherwise just do the work.",
  ].join("\n");
}

const MAX_SESSION_FEED_BYTES = 512 * 1024; // bound the live buffer — a derived stream stays bounded
// (§9.4). Keep the most-recent tail; older completed turns drop off (the card scrolls live output).

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface LiveSession {
  id: string;
  repoPath: string; // the board's repo — the process's cwd, and how seedFromTranscript finds its .jsonl
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  lines: string[]; // completed transcript-shaped events (codec-ready: {type:"user"|"assistant",message})
  inflight: ContentBlock[] | null; // the assistant message being built from partial deltas, or null
  status: "running" | "idle" | "exited";
  // How the session WOUND DOWN (Phase 2), set the moment we end it and mirrored onto the durable `.canvas/`
  // marker by recordSessionEnd. Splits the muted exited band into a calm "✓ done" (work declared finished
  // via /done), a neutral "terminated" (clean /terminate teardown to free a slot), and a loud "crashed"
  // (the process died on its own — not a /done, /terminate, or clean server shutdown). null while live.
  endReason?: "done" | "terminated" | "crashed";
  skills: string[] | null; // slash-invocable skills the harness advertised this session (for /-completion)
  verb: string | null; // what the live turn is doing now ("Thinking"/"Running"/…) — channel-1 chrome, null when idle
  usage: { input: number; output: number } | null; // this turn's tokens: input = latest context size, output = accrued
  turnOut: number; // output tokens from this turn's COMPLETED messages; the live output adds the streaming delta on top
  // Channel delivery (4e): message CONTENT is never injected as user text — it lives in the off-log channel
  // log and the agent READS it by tool call (GET /api/inbox). The session only tracks, per channel, the
  // last seq it has read (so a read returns just what's new), plus whether a content-free "you have mail"
  // nudge is owed (fired idle-immediate / at turn-end, coalesced — §9). `origin` is the host:port this
  // session was reached on, kept so a nudge fired without a request can still build absolute URLs.
  read: Record<string, number>; // threadId → last seq this session has pulled
  nudge: boolean; // a wake nudge is owed (new unread arrived since the last one)
  // Waiting-on-an-agent (channel @-tag): the peer sid(s) this session named in its last channel post and
  // is now waiting on. While set AND idle, the card/status reads blue "waiting on an agent" instead of the
  // loud orange "waiting on a human" (default-loud) — an INFERRED signal (the tag is the evidence, no self-
  // report). Set/overwritten by the session's own posts; PERSISTS across nudges; cleared only when the
  // awaited peer replies, the human prompts directly, or the session broadcasts/untags (handleThreadMessage
  // + sendSessionInput). Not a per-turn flag — it tracks an actual outstanding wait.
  waitingOn: string[] | null;
  // Operating-loop heartbeat (agent-roles.md): a looping ROLE (e.g. the PM) has its idle sessions woken on a
  // server cadence so they sweep the board for stalls even when nobody @-tags them — built-in self-scheduling
  // does NOT fire in a `claude -p` child, so the wake must come from here. `loops` is stamped from the role at
  // spawn. The scheduler (loopTick) keeps the live cadence per session: `loopIntervalMs` is the current gap
  // (BASE while work is active, ×2-backoff up to the ceiling when the channel is quiet), `loopNextAt` is when
  // the next heartbeat is due, and `loopSig` is the last world-signature (channel activity + member statuses)
  // used to detect new activity and reset the cadence to BASE. All inert unless `loops`.
  loops: boolean;
  loopIntervalMs: number;
  loopNextAt: number;
  loopSig: string;
  origin: string;
  // Shadow-git attribution (doc §6): an Edit/Write tool_use claims its target path on the shadow watcher;
  // the matching tool_result commits it attributed. Maps tool_use_id → {shadow-root key, path rel to root}.
  pendingEdits: Map<string, { key: string; rel: string }>;
}

// liveSessions lives on fsState (aliased at the top) so spawned children survive a server reload and
// stay reachable; sessionCleanupHooked is read/written through fsState so the process-exit kill hook
// is installed exactly once across reloads, not stacked.

// Publish the session's buffer (completed lines + the in-flight synthetic turn) on its feed. Bounded
// from the tail; `truncated` mirrors the codec's existing cap signal so the card flags a clipped view.
function publishSession(s: LiveSession): void {
  const lines = [...s.lines];
  if (s.inflight && s.inflight.length > 0) {
    // The live tail: a synthetic assistant message the codec parses exactly like a real one. Only
    // text/thinking accumulate visibly; a tool_use shows its name until its consolidated event lands.
    lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: s.inflight } }));
  }
  let content = lines.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content) > MAX_SESSION_FEED_BYTES) {
    content = content.slice(content.length - MAX_SESSION_FEED_BYTES);
    truncated = true;
  }
  publishFeed("session:" + s.id, {
    content,
    truncated,
    status: s.status,
    skills: s.skills ?? undefined,
    verb: s.verb ?? undefined, // live progress label for the status pill (channel-1 chrome)
    usage: s.usage ?? undefined, // {input, output} token counts for the current/last turn
    endReason: s.endReason ?? undefined, // Phase 2: done/terminated/crashed → the exited band's flavour
    waitingOn: s.waitingOn ?? undefined, // @-tag: idle + this set ⇒ blue "waiting on an agent", not orange
    loops: s.loops || undefined, // looping role: idle + no waitingOn ⇒ calm teal "scheduled", not amber
  });
}

// The full prompt size a usage object represents: fresh input plus both cache tiers. This is the
// "context" number — it grows through a turn as the transcript accretes — not the (small) uncached
// `input_tokens` alone. Tolerant of the partial usage on a `message_start` (cache fields may be absent).
function ctxOf(u: any): number {
  if (!u || typeof u !== "object") return 0;
  return (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0);
}

// A short, human label for what the live turn is doing right now, derived from the in-flight content
// block's tool name. Mirrors the terminal's progress verb — purely cosmetic channel-1 chrome.
function toolVerb(name: string): string {
  switch (name) {
    case "Read": return "Reading";
    case "Write": return "Writing";
    case "Edit":
    case "NotebookEdit": return "Editing";
    case "Bash": return "Running";
    case "Grep":
    case "Glob": return "Searching";
    case "WebFetch": return "Fetching";
    case "WebSearch": return "Searching the web";
    case "Task":
    case "Agent": return "Delegating";
    case "TodoWrite": return "Planning";
    default: return "Using " + name;
  }
}

// Parse one stream-json event off the process stdout and fold it into the session buffer. The shapes
// are the ones the live `claude -p --output-format stream-json --include-partial-messages` emits
// (probed against this project): system/result/rate_limit framing, `stream_event` partial deltas, and
// the CONSOLIDATED `user`/`assistant` events (already in the on-disk .jsonl codec's shape).
function foldSessionEvent(s: LiveSession, e: any): void {
  // The harness advertises its skills in the `system`/`init` event that opens every `-p --output-format
  // stream-json` session. Capture the names so the card can offer `/`-completion. Framing only — nothing
  // folds into the transcript. VERIFIED LIVE 2026-06-20 against a real `claude -p` capture: the on-disk
  // .jsonl advertises skills as a `skill_listing` *attachment* (with a `names` array), but the live
  // stdout stream does NOT emit that attachment — the init event is the only live source. We take
  // `skills` (the curated Skill-tool set) rather than the wider `slash_commands` (which also carries
  // TUI-only built-ins like /clear,/config that are meaningless to pipe into a headless session).
  if (e?.type === "system" && e?.subtype === "init" && Array.isArray(e.skills)) {
    s.skills = (e.skills as unknown[]).filter((n): n is string => typeof n === "string");
    return;
  }

  switch (e?.type) {
    case "assistant":
    case "user":
      // The authoritative completed message — keep the raw line; the codec reads it as-is. It lands
      // mid-stream (before content_block_stop), so clearing inflight here ends the live tail cleanly.
      if (e.message) s.lines.push(JSON.stringify({ type: e.type, message: e.message }));
      foldShadowEdits(s, e); // assistant tool_use → claim path; user tool_result → attributed commit (doc §6)
      s.inflight = null;
      s.status = "running";
      // Bank this message's authoritative usage into the turn total (a `user` event mid-turn is a
      // tool_result — it carries no usage and must not reset the counter; the turn resets only when WE
      // inject the next prompt, in sendSessionInput). `verb` is left alone: between an assistant
      // tool_use and its result the process is executing the tool, so the tool's verb still holds.
      if (e.type === "assistant" && e.message?.usage) {
        s.turnOut += Number(e.message.usage.output_tokens) || 0;
        s.usage = { input: ctxOf(e.message.usage), output: s.turnOut };
      }
      break;
    case "result":
      s.inflight = null;
      s.status = "idle"; // turn finished; the process waits on stdin for the next prompt
      s.verb = null; // no live activity to label; keep `usage` so the pill shows the turn's final counts
      if (s.nudge) flushNudge(s); // a channel message arrived mid-turn → wake to read it at the boundary (§9)
      break;
    case "stream_event": {
      const ev = e.event;
      if (ev?.type === "message_start") {
        s.inflight = [];
        s.usage = { input: ctxOf(ev.message?.usage), output: s.turnOut };
        s.verb = "Thinking"; // a neutral default until the first content_block_start names the activity
      } else if (ev?.type === "content_block_start" && s.inflight) {
        const cb = ev.content_block;
        s.inflight[ev.index] = { ...cb };
        s.verb = cb?.type === "thinking" ? "Thinking" : cb?.type === "tool_use" ? toolVerb(cb.name) : "Responding";
      } else if (ev?.type === "content_block_delta" && s.inflight) {
        const b = s.inflight[ev.index];
        if (b && ev.delta?.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text;
        else if (b && ev.delta?.type === "thinking_delta") b.thinking = (b.thinking ?? "") + ev.delta.thinking;
        // input_json_delta (tool args) isn't accumulated — the consolidated `assistant` event below
        // carries the full input; until then the tool block shows just its name.
      } else if (ev?.type === "message_delta" && s.usage && ev.usage) {
        // The streaming usage frame: output_tokens is cumulative FOR THIS MESSAGE — add it on top of the
        // turn's completed-message total so the live counter ticks up across a multi-message turn.
        s.usage.output = s.turnOut + (Number(ev.usage.output_tokens) || 0);
      }
      if (ev?.type === "message_start" || ev?.type === "content_block_start") s.status = "running";
      break;
    }
    // system / rate_limit_event / anything else: framing only, nothing to render
  }
}

// Resume starts a FRESH process whose stdout carries only the new turns — the prior transcript is not
// replayed (verified against a live `--resume` capture). So seed the live buffer from the session's
// on-disk `.jsonl`, or recommencing would blank the card's history (the live feed supersedes the
// static fields.text). The registry "materialising"/pinning the transcript for the live tail
// (session-timelines.md §5). Same shape foldSessionEvent stores: one {type,message} string per turn.
function seedFromTranscript(s: LiveSession): void {
  const r = readSessionFile(sessionsDir(s.repoPath), s.id);
  if (!r) return;
  for (const line of r.content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if ((e?.type === "user" || e?.type === "assistant") && e.message)
        s.lines.push(JSON.stringify({ type: e.type, message: e.message }));
    } catch {
      // a non-JSON framing line or a ragged tail — skip, same tolerance as the codec
    }
  }
}

// Spawn (or, when `resume`, continue) a Claude Code process under id and wire its stdout to the feed.
// Idempotent per id: a second call returns the existing live session. The process owns its own
// `.jsonl`; we only read its stdout — never write the transcript ourselves (the agent authors it, §5).
// Appended when a session is spawned INTO a channel as a worker. Its task is NOT carried in the spawn
// prompt — that would be an invisible stdin DM, off the legible channel and special-casing the first
// instruction. Instead the assignment arrives as a normal, logged channel message tagged to it. This block
// tells the worker to expect that and — crucially — NOT to wind down before it arrives (the failure mode
// that made a stood-down session re-finish on nothing). Its inbox cursor is seeded to the channel tail at
// spawn (handleSessionSpawn), so the first thing it reads is its assignment, not the backlog.
function workerBrief(threadId: string): string {
  return [
    `YOUR ASSIGNMENT. You were spawned as a worker for thread ${threadId}. Your task is NOT in this prompt —`,
    "it arrives as a THREAD MESSAGE tagged to you. Read it with GET /api/inbox (the most recent message",
    "addressed to you is your assignment); if your inbox is empty it is on its way — stay idle and you'll be",
    "nudged when it lands. Do NOT wind down (/done) until you have received AND completed a task. Read the",
    "thread's brief for context, claim files before editing, and report back in the thread.",
  ].join("\n");
}

function ensureLiveSession(
  id: string,
  repoPath: string,
  resume = false,
  origin = "localhost:5173",
  roleId: string | null = null,
  threadId: string | null = null,
): LiveSession {
  const existing = liveSessions.get(id);
  if (existing && existing.status !== "exited") return existing;

  // The role this session instantiates (agent-roles.md): an explicit roleId on a fresh spawn, else the one
  // recorded on a prior marker so a --resume keeps its role. Its charter is appended to the system prompt
  // and its identity stamped on the marker (below), so the role survives a restart and names the card.
  const prior = readCanvasSession(repoPath, id) ?? {};
  const effectiveRoleId = roleId ?? (typeof prior.roleId === "string" ? prior.roleId : null);
  const role = effectiveRoleId ? readRole(repoPath, effectiveRoleId) : null;

  // Appended system prompt = the ```ask convention + the canvas collaboration brief (env + protocol +
  // norms) + the role charter if this session has one + a worker brief if spawned into a thread, with this
  // session's own identity baked in. One --append-system-prompt flag, all blocks.
  const appendPrompt =
    ASK_CONVENTION + "\n\n" + collabBrief(boardIdentity(repoPath).boardId, id, origin) +
    (role?.charter ? "\n\n## Your role: " + role.name + "\n\n" + role.charter : "") +
    (threadId ? "\n\n" + workerBrief(threadId) : "");
  const args = [
    "-p",
    resume ? "--resume" : "--session-id",
    id,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", SESSION_PERMISSION_MODE,
    "--allowedTools", BASELINE_ALLOWED_TOOLS, // uniform baseline (commit + scripts/canvas), additive over auto
    "--disallowedTools", "AskUserQuestion", // auto-cancels here; steer to the ```ask convention instead
    "--append-system-prompt", appendPrompt,
  ];
  const child = spawn("claude", args, {
    cwd: repoPath,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  // Does this session's role run an operating loop? Then its idle sessions are woken on the server heartbeat
  // (loopTick), and read calm "scheduled" rather than amber "waiting" between ticks. First heartbeat is one
  // BASE interval out — the spawn's own first-turn prompt is the session's opening tick.
  const loops = !!role?.loops;
  const s: LiveSession = {
    // Start IDLE, not running: a freshly-spawned process is waiting on stdin (it emits `system/init`, never
    // a `result`, until it's first prompted), so "running" would be a turn that never ends — and the inbox,
    // which flushes idle-immediately / at a turn boundary, would queue forever with no boundary to drain at.
    // sendSessionInput flips it to running on the first real prompt; the result event flips it back.
    id, repoPath, child, lines: [], inflight: null, status: "idle", skills: null, verb: null, usage: null, turnOut: 0,
    read: {}, nudge: false, waitingOn: null,
    loops, loopIntervalMs: LOOP_BASE_MS, loopNextAt: Date.now() + LOOP_BASE_MS, loopSig: "",
    origin, pendingEdits: new Map(),
  };
  if (resume) seedFromTranscript(s);
  liveSessions.set(id, s);
  // Record ownership in the durable ledger: this is now a canvas-spawned session, so it lists/projects as
  // one and survives a restart as ours. Covers both a fresh spawn and a --resume of an exited one (which
  // re-enters here past the not-exited early return). Best-effort; a failed write never blocks the spawn.
  markCanvasSession(repoPath, id, {
    spawnedAt: Date.now(),
    origin,
    ...(effectiveRoleId
      ? {
          roleId: effectiveRoleId,
          roleName: role?.name ?? effectiveRoleId,
          roleColour: role?.colour ?? null,
          ...(loops ? { loops: true } : {}), // durable note that this session's role loops (legibility)
        }
      : {}),
  });
  stopSessionFeed(id); // the registry now owns this feed — drop any out-of-band file-tail for it

  let buf = "";
  let pub: ReturnType<typeof setTimeout> | null = null;
  const schedulePublish = () => {
    if (pub) return;
    pub = setTimeout(() => { pub = null; publishSession(s); }, 50); // coalesce a delta burst to one frame
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        foldSessionEvent(s, JSON.parse(line));
      } catch {
        // a partial/non-JSON framing line — skip, keep streaming
      }
    }
    schedulePublish();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {}); // drained so the pipe never blocks; not shown on the canvas
  child.on("exit", () => {
    s.status = "exited";
    s.inflight = null;
    s.verb = null;
    // Phase 2: a process that exits while we're NOT shutting the server down and we never asked it to stop
    // (no /done or /terminate set s.endReason) died on its own — record it as a crash. The shuttingDown
    // guard is what keeps a clean server restart (killAll) from being mislabelled a crash on every session.
    if (!s.endReason && !fsState.shuttingDown) { s.endReason = "crashed"; recordSessionEnd(s.repoPath, s.id, "crashed"); }
    publishSession(s);
  });
  child.on("error", () => {
    s.status = "exited";
    if (!s.endReason) { s.endReason = "crashed"; recordSessionEnd(s.repoPath, s.id, "crashed"); }
    publishSession(s);
  });

  if (!fsState.sessionCleanupHooked) {
    fsState.sessionCleanupHooked = true;
    const killAll = () => { fsState.shuttingDown = true; for (const live of liveSessions.values()) live.child.kill(); };
    process.once("exit", killAll);
    process.once("SIGINT", () => { killAll(); process.exit(0); });
    process.once("SIGTERM", () => { killAll(); process.exit(0); });
  }

  publishSession(s); // seed the feed (empty) so the card renders the live shell immediately
  return s;
}

// Write a user prompt into a live session's stdin as a stream-json message. The prompt is echoed into
// the buffer right away (Claude does not echo stdin on stdout) so the card shows it without waiting.
function sendSessionInput(id: string, text: string, opts?: { keepWaitingOn?: boolean }): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  s.status = "running";
  // A real prompt is the turn boundary we own (tool_result `user` events are mid-turn) — reset the
  // turn's token accrual and show a neutral verb until the first stream frame names the activity.
  s.turnOut = 0;
  s.usage = null;
  s.verb = "Working";
  // A DIRECT prompt (the human typing) redirects the session, so its "waiting on a peer" is stale → clear it.
  // But a channel NUDGE (flushNudge passes keepWaitingOn) must NOT clear it: being told to read the channel
  // doesn't end the wait, and clearing on every nudge made the blue evaporate the instant any traffic arrived
  // (the bug that made it un-observable). The wait is ended deliberately — by the awaited peer posting (see
  // handleThreadMessage) or by the session itself posting something new — not by a passing wake.
  if (!opts?.keepWaitingOn) s.waitingOn = null;
  s.child.stdin.write(
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
  );
  publishSession(s);
  return true;
}

// ── channel delivery: off-log log + content-free wake (4e; agent-to-agent-messaging.md §9/§15) ────
// A channel message NEVER enters an agent's stdin as content — that made peer messages masquerade as the
// human's input and scattered the conversation across session cards. Instead it lands in the channel's
// off-log LOG (below), which (a) the channel card renders as the legible conversation and (b) the agent
// READS by tool call (GET /api/inbox → tool output, never a user turn). The only thing pushed to stdin is
// a content-free NUDGE: "you have N new in channel X — go read it." Coalescing (§9) lives in the nudge:
// ≤ one wake per idle/result boundary, and an ignored nudge isn't re-fired until NEW traffic arrives.
const MAX_THREAD_MSGS = 200; // bounded TAIL — the feed republishes the whole buffer, so keep it modest

// Append to a channel's log, trim to the tail, republish its feed (the card's conversation view), and
// PERSIST the message to the board's `.canvas/channels/` ledger so it survives a cold restart (the in-memory
// `threadLogs` only survives a hot re-eval). `boardId` resolves which board's `.canvas/` home to write to —
// every caller already has it. The marker upsert also makes the channel appear in the channels-list rail and
// keeps its title/description fresh from the live snapshot. Both disk writes are best-effort (thread-ledger).
function appendThreadMsg(
  boardId: string,
  threadId: string,
  from: string,
  text: string,
  extra?: { kind: "ask" } | { kind: "intent"; intent: WorkIntent },
): ThreadMsg {
  let log = threadLogs.get(threadId);
  if (!log) threadLogs.set(threadId, (log = []));
  const seq = (log.length ? log[log.length - 1]!.seq : 0) + 1;
  const msg: ThreadMsg = { seq, ts: Date.now(), from, text, ...extra };
  log.push(msg);
  let truncated = false;
  if (log.length > MAX_THREAD_MSGS) { log.splice(0, log.length - MAX_THREAD_MSGS); truncated = true; } // keep recent
  publishFeed("thread:" + threadId, { messages: log, truncated });
  const repoPath = boards.get(boardId)?.repoPath;
  if (repoPath) {
    appendThreadLine(repoPath, threadId, msg);
    // Refresh the marker. Title/brief ride along only when the snapshot can resolve the thread node
    // (so a momentary no-snapshot post bumps activity without clobbering a good title with a blank one).
    const records = boardSnapshotRecords(boardId);
    const thread = records ? threadNode(records, threadId) : null;
    const meta: Record<string, unknown> = { lastSeq: msg.seq, lastTs: msg.ts };
    if (thread) { meta.title = thread.title ?? ""; meta.text = typeof thread.text === "string" ? thread.text : ""; }
    upsertThreadMeta(repoPath, threadId, meta);
  }
  return msg;
}

// Restore a board's thread logs from `.canvas/threads/*.jsonl` into the in-memory map at boot (once per
// board, gated by startBoardFeeds, after migrateChannelLedger has moved any pre-rename dir). This is the
// cold-restart fix: without it, a process restart emptied every thread card's conversation. Republishing
// each restored log to its `thread:<id>` feed seeds feedValues, so a tab that connects to /api/feeds AFTER
// the restart gets the history replayed (handleFeeds) — the thread card renders its backlog with no message
// having to arrive first. Thread ids are globally unique, so the shared (cross-board) threadLogs map is
// safe to seed per board; a log already in memory (a hot re-eval kept it pinned) is left alone — disk and
// memory agree, and we don't want to clobber a live tail with a stale read.
function seedThreadLogs(repoPath: string): void {
  for (const meta of listThreads(repoPath)) {
    const threadId = meta.threadId as string;
    if (threadLogs.has(threadId)) continue; // pinned from before a hot re-eval — keep the live one
    let log = readThreadLog(repoPath, threadId);
    if (log.length > MAX_THREAD_MSGS) log = log.slice(log.length - MAX_THREAD_MSGS); // keep the recent tail
    threadLogs.set(threadId, log);
    if (log.length) publishFeed("thread:" + threadId, { messages: log, truncated: false });
  }
}

// The thread ids a session is an OPEN member of (the reverse of threadMemberSids), for nudge/read.
// Memberships the SERVER has just emitted (a member:open over the bus), so wake / inbox / message logic
// counts a new member IMMEDIATELY — before the browser's snapshot round-trips back (the ~500ms-to-seconds
// window the CLAUDE.md "membership must be in the pushed snapshot" gotcha warns about, and what made a task
// posted right after a spawn miss the new worker). Keyed edgeId → {thread, sid, ts}; threadMemberSids and
// sessionThreads UNION these in (additive, deduped). TTL'd so a membership dropped OUTSIDE the bus (e.g. a
// human deletes the edge in the browser) can't linger past the window the snapshot needs to agree.
const emittedMembers = new Map<string, { thread: string; sid: string; ts: number }>();
const EMITTED_MEMBER_TTL = 60_000;
const sidFromSessionNode = (node: string): string | null =>
  node.startsWith("node:live:") ? node.slice("node:live:".length) : null;
// Non-expired emitted memberships, pruning stale ones in passing.
function liveEmittedMembers(): Array<{ thread: string; sid: string }> {
  const now = Date.now();
  const out: Array<{ thread: string; sid: string }> = [];
  for (const [edgeId, m] of emittedMembers) {
    if (now - m.ts > EMITTED_MEMBER_TTL) emittedMembers.delete(edgeId);
    else out.push({ thread: m.thread, sid: m.sid });
  }
  return out;
}
// Record/forget a server-emitted membership for the immediate-membership window. Called from
// dispatchBusCommand for every member:open / removeEdge it sends (spawn, join, invite).
function trackEmittedMembership(cmd: { type: string; payload?: Record<string, unknown> }): void {
  const p = cmd.payload ?? {};
  if (cmd.type === "removeEdge") {
    if (typeof p.id === "string") emittedMembers.delete(p.id);
    return;
  }
  if (cmd.type !== "addEdge" || String(p.type ?? "") !== "member:open") return;
  const sid = typeof p.from === "string" ? sidFromSessionNode(p.from) : null;
  if (typeof p.id === "string" && typeof p.to === "string" && sid)
    emittedMembers.set(p.id, { thread: p.to, sid, ts: Date.now() });
}

function sessionThreads(records: Array<Record<string, unknown>>, sid: string): string[] {
  const out: string[] = [];
  const node = sessionNodeForSid(records, sid);
  if (node)
    for (const r of records)
      if (r.typeName === "edge" && r.from === node && String(r.type) === "member:open" && threadNode(records, String(r.to)))
        out.push(String(r.to));
  for (const m of liveEmittedMembers()) if (m.sid === sid && !out.includes(m.thread)) out.push(m.thread);
  return out;
}

// A message arrived in a thread: mark every OTHER live member as owing a nudge and wake the idle ones now
// (busy ones fire at their turn boundary). Returns how many live members were notified.
// Wake the members a post NAMED (4-tag era): `wakeSids` is the explicit set of sids to nudge (the @-tag
// resolution). A null set means "the whole room" (an `@all` post, or any non-tagging caller) — the old
// broadcast. An empty set wakes no one: an untagged post is ambient — logged for everyone to read on their
// own cursor, but it interrupts nobody. The sender is always skipped. The unread CURSOR is untouched here,
// so a member that wasn't woken still sees the message next time it reads — wake is gated, content is not.
function wakeThreadMembers(
  boardId: string,
  threadId: string,
  exceptSid: string,
  wakeSids: Set<string> | null,
): number {
  const records = boardSnapshotRecords(boardId);
  if (!records) return 0;
  let woken = 0;
  for (const sid of threadMemberSids(records, threadId)) {
    if (sid === exceptSid) continue;
    if (wakeSids && !wakeSids.has(sid)) continue; // named-only; null ⇒ broadcast (whole room)
    const s = liveSessions.get(sid);
    if (!s || s.status === "exited") continue;
    s.nudge = true;
    woken++;
    if (s.status === "idle") flushNudge(s);
  }
  return woken;
}

// The content-free wake: one coalesced user-text line naming the channels with unread + the read recipe.
// Message CONTENT is deliberately absent — the agent fetches it with the tool call, so it lands in tool
// output. Clears the nudge flag; re-armed only when new traffic calls wakeThreadMembers again.
function flushNudge(s: LiveSession): void {
  s.nudge = false;
  const boardId = boardIdentity(s.repoPath).boardId;
  const records = boardSnapshotRecords(boardId);
  if (!records) return;
  const parts: string[] = [];
  for (const threadId of sessionThreads(records, s.id)) {
    const log = threadLogs.get(threadId) ?? [];
    const cursor = s.read[threadId] ?? 0;
    const unread = log.filter((m) => m.seq > cursor && !cardOnly(m)).length; // card-only entries don't wake
    if (unread > 0) parts.push(`"${threadNode(records, threadId)?.title || threadId}" (${unread} new)`);
  }
  const asks = [...pendingAsks.values()].filter((a) => a.to === s.id).length; // §16 pending consultations
  const lines: string[] = [];
  if (parts.length) lines.push(`new thread messages: ${parts.join(", ")} — GET http://${s.origin}/api/inbox?session=${s.id}`);
  if (asks) lines.push(`${asks} pending question${asks === 1 ? "" : "s"} — GET http://${s.origin}/api/asks?session=${s.id}`);
  if (lines.length === 0) return;
  sendSessionInput(s.id, `[canvas] ${lines.join("; ")}`, { keepWaitingOn: true });
}

// ── operating-loop heartbeat (agent-roles.md) ────────────────────────────────────────────────────
// A looping ROLE (the PM) needs to sweep the board for STALLS — but nothing emits an event when an agent
// goes silent, so a purely reactive session would never wake to notice. And built-in self-scheduling does
// NOT fire in a `claude -p` child (tested), so the wake can't come from inside the agent. So the SERVER
// wakes looping-role sessions on a cadence, reusing the exact content-free nudge path a channel message
// uses (sendSessionInput): the woken session reads its inbox + the board, sweeps, and acts or sleeps.
//
// CADENCE is adaptive and self-tuning per session (all tunable below): tight (~BASE) while work is active,
// exponential ×BACKOFF up to CEIL when the channel is quiet, snapped back to BASE the moment anything
// changes (a new message or a member's status flips). Floor keeps cost/cache sane; the @-tag / ask path is
// the unchanged immediate INTERRUPT for anything urgent, so the heartbeat only has to catch the silent.
const LOOP_BASE_MS = 75_000; // active cadence — a looping session sweeps about this often while work moves
const LOOP_FLOOR_MS = 60_000; // never wake a looping session more often than this (cost / prompt-cache TTL)
const LOOP_CEIL_MS = 600_000; // quiet cadence ceiling (10 min) — the longest gap between sweeps when idle
const LOOP_BACKOFF = 2; // each quiet beat multiplies the interval by this, up to the ceiling
const LOOP_TICK_MS = 15_000; // scheduler granularity — how often loopTick evaluates due/activity (≤ FLOOR)

// A cheap signature of everything a looping session would react to: per member-channel last-seq (new
// messages) and each live member's status (a working→waiting flip etc.). When it changes between ticks the
// world moved, so the cadence resets to BASE. Sorted+joined so it's order-stable across snapshot churn.
function loopWorldSig(s: LiveSession): string {
  const boardId = boardIdentity(s.repoPath).boardId;
  const records = boardSnapshotRecords(boardId);
  if (!records) return s.loopSig; // no snapshot to read → treat as unchanged, don't thrash the cadence
  const parts: string[] = [];
  for (const threadId of sessionThreads(records, s.id)) {
    const log = threadLogs.get(threadId) ?? [];
    parts.push(threadId + ":" + (log.length ? log[log.length - 1]!.seq : 0));
    for (const sid of threadMemberSids(records, threadId)) {
      const m = liveSessions.get(sid);
      parts.push(sid + "=" + (m ? m.status + (m.waitingOn?.length ? "/wa" : "") : "off"));
    }
  }
  return parts.sort().join("|");
}

// One scheduler tick across every board's live sessions: wake the looping ones that are idle and due, and
// keep each session's adaptive cadence. Never wakes a RUNNING session (that would interrupt its turn — it
// re-evaluates next tick once idle), so a heartbeat can't talk over a working PM.
function loopTick(): void {
  const now = Date.now();
  for (const s of liveSessions.values()) {
    if (!s.loops || s.status === "exited") continue;
    const sig = loopWorldSig(s);
    if (sig !== s.loopSig) {
      s.loopSig = sig;
      s.loopIntervalMs = LOOP_BASE_MS; // the world moved → tighten the cadence back to base
      if (s.loopNextAt > now + LOOP_BASE_MS) s.loopNextAt = now + LOOP_BASE_MS; // pull a far-out wake in
    }
    if (s.status !== "idle") continue; // mid-turn: don't interrupt; re-check next tick when idle
    if (now < s.loopNextAt) continue; // not due yet
    sendSessionInput(
      s.id,
      "[canvas] ⏱ loop heartbeat — your scheduled tick (not a human message): read your inbox " +
        `(GET http://${s.origin}/api/inbox?session=${s.id}) and the board (GET /api/canvas, /api/sessions); ` +
        "sweep for stalled or blocked agents, unanswered asks, and drifting work; then act or go back to sleep.",
      { keepWaitingOn: true },
    );
    // Just woke it on a quiet beat → back the cadence off for next time (a new-activity tick will have reset
    // it to BASE above). Clamp to the ceiling, and never below the floor.
    s.loopIntervalMs = Math.min(Math.max(s.loopIntervalMs * LOOP_BACKOFF, LOOP_FLOOR_MS), LOOP_CEIL_MS);
    s.loopNextAt = now + s.loopIntervalMs;
  }
}

// Start the single global heartbeat timer. Pinned on globalThis so a hot re-eval clears and restarts the
// one timer instead of stacking a second (mirrors boardFeedsStarted). One timer drives every board.
function startLoopHeartbeat(): void {
  const g = globalThis as { __canvasLoopHeartbeat?: ReturnType<typeof setInterval> };
  if (g.__canvasLoopHeartbeat) clearInterval(g.__canvasLoopHeartbeat);
  g.__canvasLoopHeartbeat = setInterval(loopTick, LOOP_TICK_MS);
}

// Interrupt a live session's CURRENT TURN without ending the process. Writes a stream-json control
// request to its stdin — the same control channel the Claude Code SDK's `interrupt()` uses. The CLI

// Interrupt a live session's CURRENT TURN without ending the process. Writes a stream-json control
// request to its stdin — the same control channel the Claude Code SDK's `interrupt()` uses. The CLI
// halts the in-flight turn at a safe boundary and emits a `result`, which folds the card back to idle
// (foldSessionEvent), leaving the process alive for the next prompt. No-op (false) once exited.
function sendSessionInterrupt(id: string): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.child.stdin.write(
    JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } }) +
      "\n",
  );
  return true;
}

// POST /api/session/spawn  { prompt? } → { id }. Mint a new session id, spawn the process, and send the
// first prompt if given. The client drops a session card titled <id>, which subscribes to session:<id>.
// The host:port the browser actually reached us on (so the spawned agent's API base matches the live
// server, not a guessed default — sidesteps the 5173/5174 footgun). Falls back to the default dev port.
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === "string" && host ? host : "localhost:5173";
}

// Cap on CONCURRENT live sessions (status !== "exited"), across every board this server hosts. The guard
// against runaway agent fan-out — a session spawning helpers that spawn helpers. Spawn 429s at the cap;
// /terminate frees a slot. A ceiling on concurrency, not on total spawns over time.
const MAX_LIVE_SESSIONS = 12;
const liveSessionCount = (): number => [...liveSessions.values()].filter((s) => s.status !== "exited").length;

// Footprint of a SERVER-created worker card (matches the client's session-card default size).
const WORKER_CARD_W = 800;
const WORKER_CARD_H = 520;
// Where to drop a server-created worker card (see handleSessionSpawn). Anchor it to its channel's card —
// read from the last snapshot — and CASCADE per existing member so successive workers fan out instead of
// stacking, and, above all, land CLOSE to the channel. Agent-chosen coordinates have been reliably bad
// (cards flung far across the canvas); the server knows the channel's real position, so it places the
// worker right beside it: overlapping the channel card's right edge slightly (channel stays mostly
// visible), stepping down-right. Falls back to a near-origin cascade when the channel isn't resolvable.
function placeWorkerCard(
  records: Array<Record<string, unknown>> | null,
  threadId: string | null,
): { x: number; y: number; w: number; h: number } {
  const OVERLAP_X = 120; // worker's left edge sits this far inside the channel card's right edge
  const CASCADE = 56; // per-worker down-right step
  const n = records && threadId ? threadMemberSids(records, threadId).length : 0;
  const layout =
    records && threadId
      ? (records.find((r) => r.typeName === "layout" && (r as { nodeId?: unknown }).nodeId === threadId) as
          | { x?: number; y?: number; w?: number }
          | undefined)
      : undefined;
  if (layout && typeof layout.x === "number" && typeof layout.y === "number") {
    const cw = typeof layout.w === "number" ? layout.w : 300;
    return { x: layout.x + cw - OVERLAP_X + n * CASCADE, y: layout.y + n * CASCADE, w: WORKER_CARD_W, h: WORKER_CARD_H };
  }
  return { x: 80 + n * CASCADE, y: 80 + n * CASCADE, w: WORKER_CARD_W, h: WORKER_CARD_H };
}

async function handleSessionSpawn(
  req: IncomingMessage,
  res: ServerResponse,
  repoPath: string,
  boardId: string,
  origin: string,
): Promise<void> {
  let body: { prompt?: unknown; roleId?: unknown; thread?: unknown; channel?: unknown; card?: unknown } = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (liveSessionCount() >= MAX_LIVE_SESSIONS)
    return sendJson(res, 429, { error: `live-session cap reached (${MAX_LIVE_SESSIONS}); terminate one first` });
  // Optional: spawn this session AS a role — its charter is appended to the system prompt and its identity
  // stamped on the marker (agent-roles.md). An unknown roleId is a client error, not a silent bare spawn.
  let roleId: string | null = null;
  let roleName: string | null = null;
  let roleColour: string | null = null;
  if (body.roleId != null && body.roleId !== "") {
    if (typeof body.roleId !== "string") return sendJson(res, 400, { error: "roleId must be a string" });
    const role = readRole(repoPath, body.roleId);
    if (!role) return sendJson(res, 404, { error: `unknown role "${body.roleId}"` });
    roleId = role.roleId;
    roleName = role.name;
    roleColour = role.colour;
  }
  // `thread` is the canonical spawn-into scope since §8 step 2; `channel` stays a working alias so live
  // agents and old recipes don't break mid-transition.
  const scope = typeof body.thread === "string" && body.thread ? body.thread : body.channel;
  const threadId = typeof scope === "string" && scope ? scope : null;
  const id = crypto.randomUUID();
  try {
    ensureLiveSession(id, repoPath, false, origin, roleId, threadId);
  } catch (err) {
    return sendJson(res, 500, { error: "failed to spawn", detail: String(err) });
  }
  // A worker spawned into a channel starts its inbox at the channel's TAIL (history:"future"), seeded HERE —
  // not via the snapshot-racing member:open onboarding — so its first read is its assignment, not the whole
  // backlog (the replay-burial failure mode that made a returning session dismiss its task as old history).
  if (threadId) {
    pendingHistoryMode.set(historyKey(threadId, id), "future");
    const live = liveSessions.get(id);
    if (live) live.read[threadId] = seedCursor("future", threadLogs.get(threadId) ?? []);
  }
  // Optionally drop the session's canvas card (and, with `channel`, its member:open edge) HERE on the
  // server, so the curl/wrapper caller doesn't addNode + addEdge by hand. The win is POSITIONING (the server
  // reads the channel card's position from the last snapshot and places the worker beside it, vs an agent
  // guessing coordinates badly) AND robustness: dispatchBusCommand records the member:open in the
  // immediate-membership registry, so a task the PM posts right after this reliably wakes the worker even
  // before the snapshot round-trips. `carded` reports whether a live tab applied it. Browser-initiated
  // spawns omit these params and keep placing their own card. `card:true` = a standalone card, no edge.
  let carded = false;
  if (threadId || body.card === true) {
    const records = boardSnapshotRecords(boardId);
    const node = `node:live:${id}`;
    const nodePayload: Record<string, unknown> = {
      id: node, type: "session", title: id, color: roleColour ?? "blue", ...placeWorkerCard(records, threadId),
    };
    if (roleName) nodePayload.name = `${roleName}.${id.slice(0, 8)}`;
    carded = dispatchBusCommand(boardId, { type: "addNode", actor: "system", payload: nodePayload }, origin) > 0;
    if (threadId)
      dispatchBusCommand(
        boardId,
        { type: "addEdge", actor: "system", payload: { id: `edge:member:${id}:${threadId}`, from: node, to: threadId, type: "member:open" } },
        origin,
      );
  }
  if (typeof body.prompt === "string" && body.prompt.trim()) sendSessionInput(id, body.prompt);
  sendJson(res, 200, { id, roleId, roleName, roleColour, carded });
}

// POST /api/session/<id>/input  { text } → write a prompt into the live process. Session-internal: no
// canvas-log entry, no editor.commit (session-timelines §4). 409 if the session isn't live.
async function handleSessionInput(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  let body: { text?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.text !== "string" || !body.text.trim())
    return sendJson(res, 400, { error: "missing text" });
  if (!sendSessionInput(id, body.text)) return sendJson(res, 409, { error: "session not running" });
  sendJson(res, 200, { ok: true });
}

// POST /api/session/<id>/resume → recommence a historical session live, IN PLACE. Seed the live
// buffer from its .jsonl (so the history survives the feed superseding the static transcript) and
// spawn `claude --resume <id>`. The card keys its feed off session:<id>, so the SAME card flips from
// historical to live duplex — no new card, no new id. This is the unify-on-resume handoff (slice 3).
function handleSessionResume(req: IncomingMessage, res: ServerResponse, repoPath: string, id: string): void {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!readSessionFile(sessionsDir(repoPath), id))
    return sendJson(res, 404, { error: "no transcript for that session" });
  try {
    ensureLiveSession(id, repoPath, true, originOf(req));
  } catch (err) {
    return sendJson(res, 500, { error: "failed to resume", detail: String(err) });
  }
  sendJson(res, 200, { ok: true });
}

// POST /api/session/<id>/interrupt → halt the live session's current turn (no body). Session-internal,
// like input/resume: a POST, never editor.commit, never a canvas-log entry. 409 if it isn't live.
function handleSessionInterrupt(res: ServerResponse, id: string): void {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!sendSessionInterrupt(id)) return sendJson(res, 409, { error: "session not running" });
  sendJson(res, 200, { ok: true });
}

// POST /api/session/<id>/terminate → kill the live process and free its cap slot (clean teardown for an
// agent that spawned a helper, replacing OS-level PID-hunting). The `exit` handler flips status to
// "exited" and republishes; we drop the registry entry so the slot frees immediately. The canvas card is
// left as-is (it flips to the historical/exited state) — remove it separately via removeNode if wanted.
// 409 if the session isn't live. Idempotent-ish: a second call 409s once it's already gone.
function handleSessionTerminate(res: ServerResponse, id: string): void {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!endSession(id, "terminated")) return sendJson(res, 409, { error: "session not live" });
  sendJson(res, 200, { ok: true, terminated: id });
}

// POST /api/session/<id>/done → the EXPLICIT "I'm finished" teardown (Phase 2). Same mechanics as
// /terminate — kill the process, free the cap slot — but records `endReason:"done"` so the card paints
// the calm "✓ done" band instead of the neutral terminated one. The human "End session" button and an
// agent that has wrapped up both curl this. No ?board= needed: the live session knows its own repoPath.
// 409 if the session isn't live (you can only end one that's running).
function handleSessionDone(res: ServerResponse, id: string): void {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!endSession(id, "done")) return sendJson(res, 409, { error: "session not live" });
  sendJson(res, 200, { ok: true, done: id });
}

// Shared teardown for /terminate and /done: stamp the end reason (durably, BEFORE the kill — the exit
// handler reads s.endReason to decide it wasn't a crash), kill the child, free the cap slot, republish so
// the card flips to its exited band immediately. Returns false if the session isn't live (→ 409).
function endSession(id: string, endReason: "done" | "terminated"): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.endReason = endReason;
  recordSessionEnd(s.repoPath, id, endReason);
  s.child.kill();
  s.status = "exited";
  s.inflight = null;
  s.verb = null;
  publishSession(s);
  liveSessions.delete(id);
  return true;
}

// Feed: one true-internet source for flavour — the current Hacker News #1 story (keyless API).
// Polled server-side so the browser stays a pure SSE consumer like every other feed.
function startHnFeed(): void {
  const poll = async () => {
    try {
      const ids = (await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json()) as number[];
      const item = (await (
        await fetch(`https://hacker-news.firebaseio.com/v0/item/${ids[0]}.json`)
      ).json()) as { id: number; title: string; by: string; score: number };
      publishFeed("hn", { id: item.id, title: item.title, by: item.by, score: item.score });
    } catch {
      // offline / rate-limited — keep the previous value; the card just stops advancing
    }
  };
  void poll();
  setInterval(poll, 90_000);
}

// ── usage feed (the canvas mirror of Claude Code's /usage) ──────────────────────────────────────
// The account-level plan windows (5-hour session + weekly all-models / Sonnet / Opus) the TUI's
// /usage shows. There is NO local mirror of these, so this polls Anthropic's (undocumented) OAuth
// usage endpoint server-side with the locally-stored OAuth token and republishes the result as the
// off-log `usage` feed — same channel-1 seam as git HEAD / HN, never the canvas log. Two properties
// make this safe to run unattended (the user's stated concern, "is polling ok and free"):
//   • FREE in tokens: it's a METERING call — it reports window utilization and runs no inference, so
//     it consumes none of the budget it measures.
//   • BOUNDED on rate: the endpoint throttles per access-token; the community-safe cadence is 180s
//     WITH a `claude-code/<version>` User-Agent (omitting it trips an aggressive 429 bucket). We back
//     off on 429 and keep the last good value so a throttle never blanks the card.
// The token stays SERVER-SIDE: it sets the Authorization header and is never published on any feed.

// Read the OAuth access token the way the CLI stores it: the macOS keychain item
// "Claude Code-credentials" (a JSON blob), falling back to ~/.claude/.credentials.json. Re-read every
// poll (not cached) so when Claude Code refreshes the token in place we transparently pick up the new
// one — the pragmatic alternative to reimplementing the OAuth refresh flow here. null ⇒ not logged in.
function readClaudeOAuthToken(): Promise<string | null> {
  const fromBlob = (raw: string): string | null => {
    try {
      const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      return typeof t === "string" && t ? t : null;
    } catch {
      return null;
    }
  };
  const fromFile = (): string | null => {
    try {
      return fromBlob(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
    } catch {
      return null;
    }
  };
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      (err, stdout) => resolve((!err && fromBlob(stdout.trim())) || fromFile()),
    );
  });
}

// The required `claude-code/<version>` User-Agent. Resolved once from `claude --version` (so it tracks
// the installed CLI), cached, with a plain fallback if claude isn't on PATH — the prefix is what the
// endpoint gates on, not the exact version.
let claudeUA: string | null = null;
function claudeUserAgent(): Promise<string> {
  if (claudeUA) return Promise.resolve(claudeUA);
  return new Promise((resolve) => {
    execFile("claude", ["--version"], (err, stdout) => {
      const v = (!err && stdout.match(/\d+\.\d+\.\d+/)?.[0]) || "2.0.0";
      resolve((claudeUA = `claude-code/${v}`));
    });
  });
}

const USAGE_POLL_MS = 180_000; // 3 min — safe with the User-Agent; faster trips the 429 bucket
function startUsageFeed(): void {
  let backoff = 0; // extra ms added after a 429, cleared on the next success
  const last = () => (feedValues.get("usage") as Record<string, unknown> | undefined) ?? {};
  const poll = async () => {
    let nextDelay = USAGE_POLL_MS;
    try {
      const token = await readClaudeOAuthToken();
      if (!token) {
        publishFeed("usage", { error: "no-credentials", fetchedAt: Date.now() });
      } else {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": await claudeUserAgent(),
            "Content-Type": "application/json",
          },
        });
        if (res.status === 429) {
          // Throttled — keep the last good windows, just flag it, and wait longer next time.
          backoff = Math.min(backoff ? backoff * 2 : USAGE_POLL_MS, 15 * 60_000);
          nextDelay = USAGE_POLL_MS + backoff;
          publishFeed("usage", { ...last(), error: "rate-limited", fetchedAt: Date.now() });
        } else if (!res.ok) {
          // 401 ⇒ token expired/needs re-auth; anything else ⇒ the endpoint changed or is down.
          publishFeed("usage", { ...last(), error: `http-${res.status}`, fetchedAt: Date.now() });
        } else {
          backoff = 0;
          const data = (await res.json()) as Record<string, unknown>;
          publishFeed("usage", { ...data, error: null, fetchedAt: Date.now() });
        }
      }
    } catch {
      publishFeed("usage", { ...last(), error: "offline", fetchedAt: Date.now() });
    }
    setTimeout(poll, nextDelay); // recursive (not setInterval) so backoff can stretch the gap
  };
  void poll();
}

// ── weather (card-types/weather): Open-Meteo, keyed by a free-text location ──────────────────────
// GET /api/weather?q=<place> → geocode the place (Open-Meteo geocoding, keyless) then fetch its current
// conditions (Open-Meteo forecast, keyless). Done SERVER-SIDE so the card interior never touches the
// public internet (the card-type contract: external data is polled by the host, the interior reads a
// granted signal) and there's no API key or CORS to handle in the browser. Cached per normalized query
// with a short TTL: weather drifts slowly and the public endpoint asks callers to be gentle, so a fleet
// of cards (or a tab reopen) collapses onto one fetch per location per window. Never throws to the
// client — an unresolved place or an offline upstream comes back as a 200 with an `error` tag the card
// renders as a message, mirroring the usage feed's last-good-with-an-error-pill discipline.
interface WeatherCacheEntry {
  ts: number;
  data: unknown;
}
const weatherCache = new Map<string, WeatherCacheEntry>();
const WEATHER_TTL_MS = 10 * 60_000;

async function handleWeather(res: ServerResponse, q: string): Promise<void> {
  const query = q.trim();
  if (!query) return sendJson(res, 200, { q, resolved: false, error: "no-location", fetchedAt: Date.now() });
  const key = query.toLowerCase();
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.ts < WEATHER_TTL_MS) return sendJson(res, 200, hit.data);

  const cache = (data: unknown): void => void weatherCache.set(key, { ts: Date.now(), data });
  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
    );
    const geo = (await geoRes.json()) as { results?: Array<Record<string, unknown>> };
    const loc = geo.results?.[0];
    if (!loc) {
      const data = { q: query, resolved: false, error: "not-found", fetchedAt: Date.now() };
      cache(data); // a misspelling shouldn't re-hit the geocoder every refresh tick
      return sendJson(res, 200, data);
    }
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&timezone=auto`,
    );
    const wx = (await wxRes.json()) as {
      current?: Record<string, number | string>;
      current_units?: Record<string, string>;
    };
    const c = wx.current ?? {};
    const u = wx.current_units ?? {};
    const data = {
      q: query,
      resolved: true,
      name: loc.name as string,
      country: (loc.country as string | undefined) ?? undefined,
      admin1: (loc.admin1 as string | undefined) ?? undefined,
      latitude: lat,
      longitude: lon,
      current: {
        temperature: Number(c.temperature_2m),
        apparentTemperature: Number(c.apparent_temperature),
        humidity: Number(c.relative_humidity_2m),
        windSpeed: Number(c.wind_speed_10m),
        weatherCode: Number(c.weather_code),
        isDay: Number(c.is_day) === 1,
        time: String(c.time ?? ""),
      },
      units: { temperature: u.temperature_2m ?? "°C", windSpeed: u.wind_speed_10m ?? "km/h" },
      error: null,
      fetchedAt: Date.now(),
    };
    cache(data);
    sendJson(res, 200, data);
  } catch {
    // offline / upstream down — serve the last good reading with a staleness tag if we have one, else
    // a bare offline marker. Either way a 200 the card can render, never a 5xx it would have to special-case.
    const stale = weatherCache.get(key);
    if (stale) return sendJson(res, 200, { ...(stale.data as object), error: "offline", fetchedAt: Date.now() });
    sendJson(res, 200, { q: query, resolved: false, error: "offline", fetchedAt: Date.now() });
  }
}

// The repo-scoped feeds for one board (git HEAD + the sessions-list ping), started once per board: at
// startup for the default board, and on mount for the rest (handleBoardMount). Idempotent via
// boardFeedsStarted, which is pinned across reloads so the surviving watchers aren't duplicated.
// BEST-EFFORT prompt push for worktree add/remove: `git worktree add/remove` writes/removes a subdir
// under <canonical>/.git/worktrees/, so a shallow watch there usually catches it and pings `roots:<board>`
// at once. It is NOT relied on for correctness — chokidar loses the path when `.git/worktrees/` itself is
// deleted (the last worktree removed), so boardRoots' TTL revalidation is the actual guarantee; this just
// makes the common case instant. The dir may not exist yet (no worktrees ever); chokidar tolerates that.
function startWorktreesFeed(boardId: string, repoPath: string): void {
  const dir = path.join(repoPath, ".git", "worktrees");
  const ping = (): void => {
    rootsCache.delete(boardId);
    syncShadowRoots(boardId, repoPath); // provision/teardown shadow committers as worktrees appear/vanish
    publishFeed("roots:" + boardId, { ts: Date.now() });
  };
  chokidar
    .watch(dir, { ignoreInitial: true, depth: 0 })
    .on("addDir", ping)
    .on("unlinkDir", ping);
}

// ── shadow-git committer (docs/shadow-git-ledger.md step 1) ───────────────────────────────────────
// The ledger's live half: a SERVER-SIDE watcher per root (independent of browser tabs, unlike handleWatch)
// that commits the work-tree into its shadow repo on settle, preceded by a boot-reconcile that bundles
// whatever changed while we weren't watching into one `external` commit (doc §5). The settle commit is the
// honest `external` floor; per-session attribution rides on the editor tool calls (see foldShadowEdits —
// claim on tool_use, attributed path-scoped commit on tool_result). Watchers aren't pinned — the
// boardFeedsStarted guard stops stacking on hot re-eval, as with the other feeds. Shadow DBs live centrally
// under the canonical repo's .canvas/ (gitRoot = repoPath), so one board spans worktrees and a removed
// worktree's history survives (we close its watcher; the DB persists). syncShadowRoots re-runs on worktree
// add/remove so the committer set tracks boardRoots.
const shadowRoots: Map<string, ReturnType<typeof watchRoot>> = new Map(); // key: boardId\0rootId
const SHADOW_SETTLE_MS = 800;
// The shadow committer's watch ignore (Rule B): see `.canvas/` content so it gets versioned, but never the
// shadow git-dirs under `.canvas/roots/` — a commit writes objects THERE, and watching them would re-commit
// forever (docs/canvas-home.md §5). This is the load-bearing feedback-loop guard.
const shadowIgnored = (p: string): boolean => isInternalPath(p);

// Attribution (doc §6): the server already parses each session's stdout, so an editor tool CALL is our
// honest attribution signal — it names both the session and the exact file. On the assistant `tool_use` we
// CLAIM the target path (the `external` floor then leaves it for us); on the matching `user` tool_result the
// write has landed, so we commit JUST that path attributed to the session. Bash/out-of-band writes name no
// path and keep falling to the `external` floor. (Turn-boundary attribution was abandoned — a turn spans
// many edits over minutes, and a whole-tree snapshot misattributes a concurrent agent's in-flight files.)
const EDIT_TOOL_PATH: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

// Resolve an editor tool's target to a shadow committer: the board root whose work-tree CONTAINS the file
// (longest prefix — so a worktree session attributes to ITS root, not the canonical repo), the path relative
// to that root, and the live watcher handle. null when no active committer owns the path.
function shadowTargetFor(s: LiveSession, filePath: string): { key: string; rel: string; handle: ReturnType<typeof watchRoot> } | null {
  const abs = path.resolve(s.repoPath, filePath); // tools usually emit absolute paths; resolve relatives off cwd
  const boardId = boardIdentity(s.repoPath).boardId;
  let best: { id: string; path: string } | null = null;
  for (const r of boardRoots(boardId)) {
    if ((abs === r.path || abs.startsWith(r.path + path.sep)) && (!best || r.path.length > best.path.length)) best = r;
  }
  if (!best) return null;
  const key = boardId + "\0" + best.id;
  const handle = shadowRoots.get(key);
  return handle ? { key, rel: path.relative(best.path, abs), handle } : null;
}

function foldShadowEdits(s: LiveSession, e: { type?: string; message?: { content?: unknown } }): void {
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  if (e.type === "assistant") {
    // Claim each editor tool_use's target so the floor debounce skips it until the result commits it.
    for (const b of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b?.type !== "tool_use" || !b.id || !b.name) continue;
      const field = EDIT_TOOL_PATH[b.name];
      const fp = field && b.input ? b.input[field] : undefined;
      if (typeof fp !== "string" || !fp) continue;
      const tgt = shadowTargetFor(s, fp);
      if (!tgt) continue;
      tgt.handle.claim([tgt.rel]);
      s.pendingEdits.set(b.id, { key: tgt.key, rel: tgt.rel });
    }
  } else if (e.type === "user") {
    // The write has landed — commit each claimed path attributed (or release it if the edit errored/no-op'd).
    for (const b of content as Array<{ type?: string; tool_use_id?: string }>) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      const pending = s.pendingEdits.get(b.tool_use_id);
      if (!pending) continue;
      s.pendingEdits.delete(b.tool_use_id);
      const handle = shadowRoots.get(pending.key);
      if (!handle) continue; // committer torn down (worktree vanished mid-turn) — claim is gone with it
      const author = `session:${s.id.slice(0, 8)} <${s.id}@foolscap.session>`;
      void handle
        .commitClaimed([pending.rel], { author, message: `${s.id.slice(0, 8)}: edit ${pending.rel}` })
        .catch((err: unknown) => console.error("[shadow] session commit:", err instanceof Error ? err.message : err));
    }
  }
}

function syncShadowRoots(boardId: string, repoPath: string): void {
  const roots = boardRoots(boardId);
  const live = new Set(roots.map((r) => boardId + "\0" + r.id));
  for (const r of roots) {
    const key = boardId + "\0" + r.id;
    if (shadowRoots.has(key)) continue;
    const onErr = (e: unknown): void => console.error(`[shadow] ${r.id}:`, e instanceof Error ? e.message : e);
    // boot-reconcile: one bundled `external` commit catching offline/unobserved changes before live watching.
    void commitRoot(r.path, { rootId: r.id, gitRoot: repoPath, message: "external: reconcile on start" }).catch(onErr);
    const handle = watchRoot(r.path, {
      rootId: r.id,
      gitRoot: repoPath,
      settleMs: SHADOW_SETTLE_MS,
      ignored: shadowIgnored,
      onError: onErr,
    });
    shadowRoots.set(key, handle);
  }
  // tear down watchers for roots that vanished; the shadow DB under .canvas/ stays (history survives removal).
  for (const [key, h] of shadowRoots) {
    if (key.startsWith(boardId + "\0") && !live.has(key)) {
      void h.close();
      shadowRoots.delete(key);
    }
  }
}

function startBoardFeeds(boardId: string, repoPath: string): void {
  if (boardFeedsStarted.has(boardId)) return;
  boardFeedsStarted.add(boardId);
  startGitHeadFeed(boardId, repoPath);
  startSessionsFeed(boardId, sessionsDir(repoPath));
  startWorktreesFeed(boardId, repoPath);
  migrateChannelLedger(repoPath); // one-time §8 step 2 rename: `.canvas/channels/` → `.canvas/threads/`
  seedThreadLogs(repoPath); // restore thread conversations from `.canvas/threads/` (cold-restart fix)
  startThreadsFeed(boardId, repoPath); // live-push the list rail as threads gain activity
  seedDefaultRole(repoPath); // ensure the role-picker on "new session" is never empty on a fresh board
  startRolesFeed(boardId, repoPath); // live-push the roles-list rail as roles are created/edited
  syncShadowRoots(boardId, repoPath); // shadow-git committer per root + boot-reconcile (step 1)
  startLoopHeartbeat(); // global, idempotent — wakes looping-role (PM) sessions to sweep for stalls
}

function startFeeds(): void {
  if (fsState.feedsStarted) return;
  fsState.feedsStarted = true;
  startHnFeed();
  startUsageFeed();
  startCardTypesFeed();
  startBoardFeeds(DEFAULT_BOARD.boardId, DEFAULT_BOARD.repoPath);
}

// ── card types (card-types-as-data.md §3/§7: type definitions are data in the folder) ──────────
// The type registry's server half: list card-types/*/ (type.yaml + the render.js the browser will
// import()), and watch the folder so a template edit on disk reaches the canvas live. The change
// notification rides the EXISTING feed bus ("cardtypes") — a template edit is just one more named
// off-log event the client turns into a signal; the browser-side registry re-imports the module.

const CARD_TYPES_DIR = path.resolve(here, "card-types");

function handleCardTypesList(res: ServerResponse): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(CARD_TYPES_DIR, { withFileTypes: true });
  } catch {
    // no card-types folder yet — an empty registry, not an error
  }
  const types = entries
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const yaml = readText(path.join(CARD_TYPES_DIR, e.name, "type.yaml"));
      return yaml ? [{ type: e.name, yaml: yaml.content }] : [];
    });
  sendJson(res, 200, { types });
}

// Serve card-types/* RAW — straight off disk, Cache-Control: no-store, never through Vite's
// transform pipeline. The pipeline caches per module and only Vite's own watcher invalidates that
// cache, so a feed-triggered re-import racing that watcher could be served the PREVIOUS code (the
// "save twice" dropped-update bug — two independent chokidars, no ordering). A template is runtime
// data under the v1 contract — plain ESM importing only /vendor/lit-html.js — so the bundler has
// nothing to add: read the file, send it, fresh every request. Read in FULL (not via readText, whose
// MAX_BYTES preview cap is for file-card bodies) — a template is code the browser must parse, and a
// truncated module is a syntax error.
function handleCardTypeAsset(res: ServerResponse, pathname: string): void {
  const rel = decodeURIComponent(pathname.slice("/card-types/".length));
  const abs = path.resolve(CARD_TYPES_DIR, rel);
  if (!abs.startsWith(CARD_TYPES_DIR + path.sep)) return sendJson(res, 400, { error: "bad path" });
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "Content-Type": abs.endsWith(".js") ? "text/javascript" : "text/plain",
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function startCardTypesFeed(): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  chokidar.watch(CARD_TYPES_DIR, { ignoreInitial: true }).on("all", (_ev, abs) => {
    pending = path.relative(CARD_TYPES_DIR, abs);
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("cardtypes", { path: pending, ts: Date.now() }), 100);
  });
}

// ── agent bus (demo §10 step 4: the MCP server's dress rehearsal) ───────────────────────────────
// In-band agent interaction over plain HTTP. An agent POSTs a Command to /api/command; the server
// forwards it over SSE (/api/bus) to the browser, which runs it through editor.commit — the SAME
// validated mutation surface a gesture uses, attributed by `actor`. The browser pushes its snapshot
// + recent intent back to POST /api/canvas (debounced), so GET /api/canvas is the agent's read side.
// The server is a dumb relay: it holds no canvas state of its own, just the browser's last push.
//
// PER BOARD (Phase 3): every endpoint takes ?board=<boardId> (default board if omitted). Each board is
// its own bus — a command for board X reaches only the tabs showing X, and X's snapshot is read back
// independently. So `busClients` is a Set PER board and `lastCanvasPush` is a String PER board; 503
// (delivered=0) is judged against THAT board's connected tabs, not all of them. The browser tags its
// /api/bus + /api/canvas calls with its own activeBoardId (agentBus.ts).
//
//   GET  /api/bus?board=     → text/event-stream of Command frames (a board's tabs subscribe)
//   POST /api/command?board= → { type, payload?, actor? } forwarded to that board's connected tabs
//   POST /api/canvas?board=  → that board's { snapshot, recentIntent, ts } (stored verbatim)
//   GET  /api/canvas?board=  → that board's last push, or 404 until one of its tabs has connected

const busClients: Map<string, Set<SseClient>> = new Map();
const lastCanvasPush: Map<string, string> = new Map();

// The bus-client set for a board, created on first subscribe. (The SSE close handler in openSse deletes
// the client from the set but leaves the empty set in the map — harmless; one entry per ever-seen board.)
function busClientsFor(boardId: string): Set<SseClient> {
  let set = busClients.get(boardId);
  if (!set) busClients.set(boardId, (set = new Set<SseClient>()));
  return set;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The binary twin of readBody, for the image-asset write (raw bytes, not utf8). Capped at the same
// MAX_ASSET_BYTES the handler enforces, but bounded here too so an oversized upload can't balloon memory
// before the length check — rejects mid-stream the moment it overruns.
function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      len += c.length;
      if (len > MAX_ASSET_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleCommand(req: IncomingMessage, res: ServerResponse, boardId: string, origin: string): Promise<void> {
  let cmd: { type?: unknown; payload?: unknown; actor?: unknown };
  try {
    cmd = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof cmd.type !== "string") return sendJson(res, 400, { error: "missing command type" });
  // Broadcast to the board's tabs (+ fire the membership announce if it's a member:* edge). delivered=0
  // tells the agent no tab for THIS board is listening — the command went nowhere.
  const delivered = dispatchBusCommand(boardId, cmd as { type: string; payload?: Record<string, unknown>; actor?: string }, origin);
  sendJson(res, delivered > 0 ? 200 : 503, { ok: delivered > 0, delivered, board: boardId });
}

// The member:* edges of a snapshot blob, id → {from,to,type}. The diff source for announceNewMemberships,
// with the same tolerant parse as boardSnapshotRecords (a torn mid-write push yields an empty map — read as
// "no membership edges", the safe direction: a real change re-pushes a whole blob ~500ms later).
function memberEdgesOf(raw: string | undefined): Map<string, { from: string; to: string; type: string }> {
  const out = new Map<string, { from: string; to: string; type: string }>();
  if (raw == null) return out;
  let records: Array<Record<string, unknown>> | undefined;
  try {
    records = (JSON.parse(raw) as { snapshot?: { records?: Array<Record<string, unknown>> } }).snapshot?.records;
  } catch {
    return out;
  }
  for (const r of records ?? [])
    if (r.typeName === "edge" && typeof r.type === "string" && r.type.startsWith("member:") && typeof r.id === "string")
      out.set(r.id, { from: String(r.from), to: String(r.to), type: r.type });
  return out;
}

// Onboarding's SECOND trigger. The first is dispatchBusCommand, which fires for an agent-initiated POST
// join/invite. But a HUMAN-drawn join/accept/leave (connect = join, the edge popover) is a LOCAL
// editor.commit that never crosses the bus — it reaches the server only as this debounced snapshot push.
// So diff the membership edges before↔after and replay each transition through maybeAnnounceMembership
// exactly as the matching bus addEdge/removeEdge would. The per-(edge,phase) dedup makes the overlap with
// the bus path harmless: an agent POST also re-pushes the snapshot moments later, and that second sighting
// no-ops. lastCanvasPush is ALREADY set to `after` here, so roster/cursor-seed resolve against the fresh
// board. The FIRST push after a (re)start (beforeRaw == null) is a BASELINE, not a wave of joins: record
// the existing edges as already-announced without onboarding — the pre-restart sessions are gone and
// replaying their "joined" lines would be noise; a genuine join after the baseline diffs normally.
function announceNewMemberships(boardId: string, beforeRaw: string | undefined, origin: string): void {
  const afterRaw = lastCanvasPush.get(boardId);
  // Fast path: a string scan is far cheaper than parsing the whole board, and membership rarely changes.
  if (!afterRaw?.includes('"member:') && !beforeRaw?.includes('"member:')) return;
  const after = memberEdgesOf(afterRaw);
  if (beforeRaw == null) {
    for (const [id, e] of after) announcedMemberships.add(announceKey(id, e.type));
    return;
  }
  const before = memberEdgesOf(beforeRaw);
  for (const [id, e] of after) {
    if (before.get(id)?.type === e.type) continue; // unchanged phase — already onboarded (or baseline-seeded)
    maybeAnnounceMembership(boardId, { type: "addEdge", payload: { id, from: e.from, to: e.to, type: e.type } }, origin);
  }
  for (const [id] of before)
    if (!after.has(id)) maybeAnnounceMembership(boardId, { type: "removeEdge", payload: { id } }, origin); // clear dedup → a rejoin re-announces
}

async function handleCanvasPush(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  origin: string,
): Promise<void> {
  const body = await readBody(req);
  const beforeRaw = lastCanvasPush.get(boardId); // captured synchronously with the set — no interleave window
  lastCanvasPush.set(boardId, body);
  sendJson(res, 200, { ok: true });
  try {
    announceNewMemberships(boardId, beforeRaw, origin);
  } catch (err) {
    console.warn("[channels] membership announce from snapshot diff failed:", err);
  }
}

function handleCanvasGet(res: ServerResponse, boardId: string): void {
  const push = lastCanvasPush.get(boardId);
  if (push == null) return sendJson(res, 404, { error: "no canvas has pushed state yet" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(push);
}

// ── notebook outputs (docs/notebook-card.md §7, step-3 agent-legibility) ───────────────────────────
// A notebook card's cell OUTPUTS are off-log signia atoms living in the BROWSER (notebook-runtime.ts), so
// they're absent from the file tree AND the /api/canvas snapshot — an agent reads a notebook's source with
// `Read` but otherwise can't see what a cell PRODUCED. The runtime relays them here exactly as agentBus
// relays the canvas snapshot, and the server is the same dumb relay: it holds only the last push, PER
// (board, node id). So GET returns data only WHILE A TAB IS LIVE pushing (404 cold) — the deliberate
// step-3 scope, a window onto a live run rather than a durable artefact (that's the step-4 memo-cache /
// shadow store). The blob is already value-bounded at the browser's serialization point; we cap the whole
// push as a memory safety, matching the file-write 413.
//
//   POST /api/notebook/<id>/outputs ?board=  { ts, root, path, cells:[…], exports:{…} } (stored verbatim)
//   GET  /api/notebook/<id>/outputs ?board=  → that card's last push, or 404 until one has arrived
const lastNotebookOutputs = new Map<string, string>(); // key: boardId \0 nodeId → the pushed blob
const nbOutKey = (boardId: string, id: string): string => boardId + "\0" + id;

async function handleNotebookOutputsPush(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  id: string,
): Promise<void> {
  const body = await readBody(req);
  if (Buffer.byteLength(body, "utf8") > MAX_SESSION_BYTES) return sendJson(res, 413, { error: "too large" });
  lastNotebookOutputs.set(nbOutKey(boardId, id), body);
  sendJson(res, 200, { ok: true });
}

function handleNotebookOutputsGet(res: ServerResponse, boardId: string, id: string): void {
  const blob = lastNotebookOutputs.get(nbOutKey(boardId, id));
  if (blob == null) return sendJson(res, 404, { error: "no outputs pushed for this notebook (is a tab open on it?)" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(blob);
}

// ── threads (threads-as-cards.md — the per-task container; renamed from channels at §8 step 2) ──────
// A THREAD is a task with a conversation attached, reified as a NODE (a card): its `title` is the task,
// its `text` the BRIEF — editable like any card. A session joins by a `member:open` edge (session→thread);
// a post to the thread fans out to every other open member. The whole lifecycle rides the EXISTING
// addEdge/removeEdge bus commands (each a logged, undoable channel-3 act); only the MESSAGE fan-out is
// server-side and OFF-LOG (no IntentEvent — it lands in each recipient's transcript). Everything below is
// served under BOTH /api/thread/… (canonical) and /api/channel/… (transition alias — live agents and old
// recipes keep working; carried-over {type:"channel"} nodes are threads too, see threadNode).
//
//   POST /api/thread/<threadId>/message ?board=  { from, text } — fan out to all other open members
//   POST /api/thread/<threadId>/join    ?board=  { from, history? } — open membership/accept (history: full|future)
//   POST /api/thread/<threadId>/leave   ?board=  { from }       — drop the membership (sever)
//   POST /api/thread/<threadId>/invite  ?board=  { from, target, history? } — propose membership for another session
//   POST /api/thread/<threadId>/history ?board=  { target, mode } — set a member's backlog visibility (full|future)
//   POST /api/thread/<threadId>/intent  ?board=  { from, intent, note? } — declare work-intent (card-only typed act)
//   GET  /api/inbox ?session=<sid>                            — read this session's unread thread messages
// join/leave/invite are server-fulfilled by EMITTING the addEdge/removeEdge over the bus, so the agent
// never has to construct node/edge ids — it works in thread ids + its own sid only.

interface SnapNode {
  typeName: "node";
  id: string;
  type: string;
  title: string;
  text?: string; // a thread node's `text` is its (optional) task brief
}

// The records of a board's last pushed snapshot ({ snapshot:{ records:[…] } }), or null if no tab of that
// board has pushed yet (or the blob is unparseable — a torn mid-write push, treated the same).
function boardSnapshotRecords(boardId: string): Array<Record<string, unknown>> | null {
  const raw = lastCanvasPush.get(boardId);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as { snapshot?: { records?: Array<Record<string, unknown>> } };
    return parsed.snapshot?.records ?? null;
  } catch {
    return null;
  }
}

// A session card carries its session id as the node title (loader.ts: node id node:session:<sid> /
// node:live:<sid>, title = the full sid). Resolve a node id to its session id, or null if the node isn't
// a session card. Reading the title (not parsing the id) keeps this robust to the id scheme.
function nodeSessionId(records: Array<Record<string, unknown>>, nodeId: string): string | null {
  const n = records.find((r) => r.typeName === "node" && r.id === nodeId) as SnapNode | undefined;
  return n && n.type === "session" && typeof n.title === "string" && n.title ? n.title : null;
}

// The reverse: a session id → its card's node id (so an agent that knows only its own sid can join/leave
// without ever handling a node id). Null if no session card on the board carries that title.
function sessionNodeForSid(records: Array<Record<string, unknown>>, sid: string): string | null {
  const n = records.find(
    (r) => r.typeName === "node" && r.type === "session" && r.title === sid,
  ) as SnapNode | undefined;
  return n ? String(n.id) : null;
}

// The channel card by id (or null if that id isn't a channel node).
function threadNode(records: Array<Record<string, unknown>>, threadId: string): SnapNode | null {
  const n = records.find((r) => r.typeName === "node" && r.id === threadId) as SnapNode | undefined;
  // "thread" is the node type since §8 step 2; "channel" is the carried-over legacy type (existing
  // channels live on as long-lived threads — same card, same machinery).
  return n && (n.type === "thread" || n.type === "channel") ? n : null;
}

// A session card's display NAME (the new `name` field a role-spawned card carries, `<RoleName>.<short-sid>`),
// or null if it has none. The renderer falls back to the short sid; tag resolution uses it so `@RoleName`
// reaches a role by its handle. Found by the same title===sid convention as sessionNodeForSid.
function sessionNameForSid(records: Array<Record<string, unknown>>, sid: string): string | null {
  const n = records.find(
    (r) => r.typeName === "node" && r.type === "session" && r.title === sid,
  ) as (SnapNode & { name?: unknown }) | undefined;
  return n && typeof n.name === "string" && n.name ? n.name : null;
}

// The session ids of a channel's OPEN members (from each member:open edge session→channel).
function threadMemberSids(records: Array<Record<string, unknown>>, threadId: string): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.typeName === "edge" && r.to === threadId && String(r.type) === "member:open") {
      const sid = nodeSessionId(records, String(r.from));
      if (sid && !out.includes(sid)) out.push(sid);
    }
  }
  for (const m of liveEmittedMembers()) if (m.thread === threadId && !out.includes(m.sid)) out.push(m.sid);
  return out;
}

// A channel node's `text` is its (optional) DESCRIPTION — Slack-topic style, blank by default. Empty ⇒ "",
// so the onboarding messages can omit the line entirely rather than print a "(none)" placeholder.
const descriptionOf = (chan: SnapNode): string =>
  typeof chan.text === "string" ? chan.text.trim() : "";

// Broadcast a command to a board's tabs (the board lives in the browser, so a mutation is an addEdge/
// removeEdge the tab applies) and fire the membership-announce side-effect. Returns the tab count it
// reached — 0 means no tab of this board is live, so the command went nowhere. Shared by the generic bus
// (handleCommand) and the channel join/leave/invite endpoints, so a UI-drawn join and an agent's POST
// /join both announce identically.
function dispatchBusCommand(
  boardId: string,
  cmd: { type: string; payload?: Record<string, unknown>; actor?: string },
  origin: string,
): number {
  const clients = busClients.get(boardId);
  const delivered = clients?.size ?? 0;
  const frame = `data: ${JSON.stringify(cmd)}\n\n`;
  if (clients) for (const c of clients) c.res.write(frame);
  // Only announce if a tab actually applied it — a command that reached no tab (delivered=0) didn't change
  // the board, so announcing a join/invite that never landed would be a phantom (and double-fire on retry).
  if (delivered > 0) {
    trackEmittedMembership(cmd); // front-run the snapshot so a post right after a spawn/join wakes the new member
    maybeAnnounceMembership(boardId, cmd, origin);
  }
  return delivered;
}

// Membership phases already intro'd, keyed `<edgeId>|<member:type>`, so an idempotent re-put doesn't
// re-announce. Two triggers now race to announce the SAME edge — the bus command (agent POST join) and
// the snapshot-diff (a human-drawn join, which never crosses the bus; see announceNewMemberships) — and
// this Set is what makes the second a no-op. The phase is part of the key so a pending→open UPGRADE still
// fires the open onboarding even though the pending intro already fired. Cleared on removeEdge (both
// phases) so a genuine rejoin announces again.
const announcedMemberships = new Set<string>();
const announceKey = (id: string, type: string): string => `${id}|${type}`;

// How much of the backlog a not-yet-onboarded member should see, keyed `<threadId>|<sid>`. Set by an
// invite/join (or the /history action) that names a mode; consumed + cleared when member:open onboarding
// seeds the read cursor. ABSENT ⇒ the default, FULL history — a new member replays the whole backlog on
// their first inbox read (Slack public-channel style). "future" is the opt-out (start at the tail).
const pendingHistoryMode = new Map<string, "full" | "future">();
const historyKey = (threadId: string, sid: string): string => `${threadId}|${sid}`;
const historyMode = (v: unknown): "full" | "future" | undefined => (v === "full" || v === "future" ? v : undefined);
// The read cursor that gives `sid` the chosen visibility of `log`: full ⇒ 0 (everything is unread), future
// ⇒ the current tail (only messages from here on). The single source of "how much backlog replays".
const seedCursor = (mode: "full" | "future", log: ThreadMsg[]): number =>
  mode === "future" && log.length ? log[log.length - 1]!.seq : 0;

// When a membership edge crosses the bus, ONBOARD the affected session. Onboarding (and only onboarding) is
// a user-text push — the one allowed content injection, since it IS the wake, not a peer message. The
// actual conversation never lands here. member:pending → invite the target; member:open → welcome the
// joiner (brief + roster + post/read recipes), log "X joined" into the thread (a system line the card
// shows) + nudge the existing members, and FILL THE SEAT (§5) when the joiner carries a role. Best-effort:
// if the snapshot can't resolve the nodes, skip.
function maybeAnnounceMembership(
  boardId: string,
  cmd: { type: string; payload?: Record<string, unknown> },
  origin: string,
): void {
  const p = cmd.payload ?? {};
  if (cmd.type === "removeEdge") {
    if (typeof p.id === "string") {
      announcedMemberships.delete(announceKey(p.id, "member:open"));
      announcedMemberships.delete(announceKey(p.id, "member:pending"));
    }
    return;
  }
  if (cmd.type !== "addEdge") return;
  const type = String(p.type ?? "");
  if (!type.startsWith("member:")) return;
  const records = boardSnapshotRecords(boardId);
  if (!records) return;
  const thread = threadNode(records, String(p.to));
  const sid = nodeSessionId(records, String(p.from));
  if (!thread || !sid) return;
  const base = `http://${origin}`;
  const title = thread.title || "(untitled)";
  const description = descriptionOf(thread);
  const descLine = description ? `brief: ${description}\n` : ""; // optional — omit when blank

  if (type === "member:pending") {
    if (announcedMemberships.has(announceKey(String(p.id), type))) return;
    announcedMemberships.add(announceKey(String(p.id), type));
    sendSessionInput(
      sid,
      `[canvas] You're invited to thread ${thread.id} "${title}".\n${descLine}` +
        `to accept: POST ${base}/api/thread/${thread.id}/join {"from":"${sid}"}  ` +
        `(add "history":"future" to skip the backlog and start at the latest)\n` +
        `to decline: POST ${base}/api/thread/${thread.id}/leave {"from":"${sid}"}`,
    );
    return;
  }
  if (type === "member:open") {
    if (announcedMemberships.has(announceKey(String(p.id), type))) return;
    announcedMemberships.add(announceKey(String(p.id), type));
    const others = threadMemberSids(records, thread.id).filter((m) => m !== sid);
    const roster = [sid, ...others].join(", ");
    // full (the default) → the joiner's first inbox read replays the whole backlog; future → only new ones.
    const mode = pendingHistoryMode.get(historyKey(thread.id, sid)) ?? "full";
    pendingHistoryMode.delete(historyKey(thread.id, sid));
    const log = threadLogs.get(thread.id) ?? [];
    const backlog =
      log.length && mode === "full"
        ? ` (${log.length} earlier message${log.length === 1 ? "" : "s"} to read${log.length > 60 ? "; for a long backlog window the tail with ?bytes=20000 or ?limit=40" : ""})`
        : "";
    sendSessionInput(
      sid,
      `[canvas] You joined thread ${thread.id} "${title}".\n${descLine}members: ${roster}\n` +
        `post: POST ${base}/api/thread/${thread.id}/message {"text":"…","from":"${sid}"} — a post is LOGGED for all but only WAKES the members you @-tag (by an id prefix, e.g. @${sid.slice(0, 8)}; @all = everyone; no tag = nobody is woken)\n` +
        `consult one member and block for the answer: POST ${base}/api/thread/${thread.id}/ask {"to":"<sid>","text":"…","from":"${sid}"}\n` +
        `declare your work-intent (card-only, wakes no one): POST ${base}/api/thread/${thread.id}/intent {"from":"${sid}","intent":"working"|"blocked:human"|"blocked:peer"|"done","note":"…"} — declare blocked:human when you ask the human and stop, done when your part is finished\n` +
        `you'll be NUDGED only when a peer @-tags or /asks you; read messages with GET ${base}/api/inbox?session=${sid}, pending asks with GET ${base}/api/asks?session=${sid}${backlog}`,
    );
    if (others.length) {
      appendThreadMsg(boardId, thread.id, "system", `${sid} joined the thread. members now: ${roster}.`);
      wakeThreadMembers(boardId, thread.id, sid, null); // a join is a room event — broadcast it to all members
    }
    const js = liveSessions.get(sid);
    if (js) js.read[thread.id] = seedCursor(mode, log);
    // Seat (§5): a role-spawned joiner FILLS its role's seat on this thread — created on first join,
    // re-occupied (same seat, new sid) when a fresh session of the role arrives. The role rides the
    // session card's `name` ("RoleName.<short-sid>"); a plain unnamed session takes no seat (it stays a
    // sid-identified participant). 1:1 with roles until labelled multiplicity ships.
    const name = sessionNameForSid(records, sid);
    if (name) {
      const role = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
      const repoPath = boards.get(boardId)?.repoPath;
      if (role && repoPath) fillSeat(repoPath, thread.id, role, sid, Date.now());
    }
  }
}

async function handleThreadMessage(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; text?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.text !== "string" || !body.text) return sendJson(res, 400, { error: "missing text" });
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "channel not found" });

  const from = body.from;
  const members = threadMemberSids(records, threadId);
  // Consent: a SESSION must have joined to post (symmetry with receiving). A non-session `from` (the human
  // at the channel card) is the board owner and may post to any channel — §7, legibility not authz.
  if (sessionNodeForSid(records, from) && !members.includes(from))
    return sendJson(res, 403, { error: "sender is not a member of this channel" });

  // Record it in the channel's off-log log (the conversation's home + the card's feed source) — NOT into
  // anyone's stdin. The sender has "seen" its own message, so advance its cursor; the NAMED others are woken.
  const msg = appendThreadMsg(boardId, threadId, from, body.text);
  // @-tags decide the wake set: `@all` (or a non-tagging client) wakes the whole room (null), a tagged post
  // wakes only the named members, an untagged post wakes no one (ambient — still logged for the cursor read).
  // Pair each member sid with its card name so `@RoleName` resolves by handle, not just sid prefix.
  const memberEntries = members.map((sid) => ({ sid, name: sessionNameForSid(records, sid) }));
  const { wakeAll, human, members: tagged } = resolveTags(body.text, memberEntries);
  const wakeSids = wakeAll ? null : new Set(tagged);
  const ss = liveSessions.get(from);
  if (ss) {
    ss.read[threadId] = msg.seq;
    // Blue "waiting on an agent": the sender named a specific peer (not @all, not the human) and will idle
    // after this turn waiting on them. Inferred from the tag — no self-report. Each of the sender's posts
    // OVERWRITES this: tagging a peer sets it; a broadcast / human-directed / untagged post clears it (the
    // sender's intent moved on). It then persists across nudges (sendSessionInput keepWaitingOn) until the
    // awaited peer replies (below) — so the blue holds instead of evaporating on the next bit of traffic.
    const peers = tagged.filter((sid) => sid !== from);
    ss.waitingOn = !wakeAll && !human && peers.length ? peers : null;
  }
  // The awaited peer just spoke: anyone waiting on `from` has had their wait answered — drop `from` from
  // their waitingOn (→ null when empty) and republish so their card/surfaces fall out of blue. This is the
  // deliberate end of the wait (paired with the no-clear-on-nudge above). Republish goes through THIS (the
  // request handler's) publishSession, so it carries the current feed shape.
  for (const w of liveSessions.values()) {
    if (w.waitingOn?.includes(from)) {
      const rest = w.waitingOn.filter((sid) => sid !== from);
      w.waitingOn = rest.length ? rest : null;
      publishSession(w);
    }
  }
  const notified = wakeThreadMembers(boardId, threadId, from, wakeSids);
  sendJson(res, 200, { ok: true, channel: threadId, from, seq: msg.seq, members: members.length, notified });
}

// Resolve a channel id + a session sid to the membership edge between them (any member:* phase), so join
// can UPGRADE a pending invite in place (same edge id) and leave can find what to remove.
function memberEdge(
  records: Array<Record<string, unknown>>,
  sessionNode: string,
  threadId: string,
): string | null {
  const e = records.find(
    (r) => r.typeName === "edge" && r.from === sessionNode && r.to === threadId && String(r.type).startsWith("member:"),
  );
  return e ? String(e.id) : null;
}

async function handleThreadMembership(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
  action: "join" | "leave" | "invite",
  origin: string,
): Promise<void> {
  let body: { from?: unknown; target?: unknown; history?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "channel not found" });

  // For join/leave the actor is the joining session; for invite it's the target being proposed.
  const subjectSid = action === "invite" ? (typeof body.target === "string" ? body.target : "") : body.from;
  if (!subjectSid) return sendJson(res, 400, { error: "missing target" });
  const sessionNode = sessionNodeForSid(records, subjectSid);
  if (!sessionNode) return sendJson(res, 400, { error: `no session card on this board for ${subjectSid}` });

  // An optional history choice rides the invite/join — stash it for the member:open onboarding to consume
  // when it seeds the cursor (a pending invite carries it through to the eventual accept). Absent ⇒ default.
  if (action !== "leave") {
    const mode = historyMode(body.history);
    if (mode) pendingHistoryMode.set(historyKey(threadId, subjectSid), mode);
  }

  let cmd: { type: string; payload: Record<string, unknown>; actor: string };
  if (action === "leave") {
    const id = memberEdge(records, sessionNode, threadId);
    if (!id) return sendJson(res, 404, { error: "not a member of this channel" });
    cmd = { type: "removeEdge", actor: body.from, payload: { id } };
  } else {
    const id = memberEdge(records, sessionNode, threadId) ?? `edge:${crypto.randomUUID().slice(0, 8)}`;
    const type = action === "join" ? "member:open" : "member:pending";
    cmd = { type: "addEdge", actor: body.from, payload: { id, from: sessionNode, to: threadId, type } };
  }
  const delivered = dispatchBusCommand(boardId, cmd, origin);
  if (delivered === 0) return sendJson(res, 503, { error: "no tab of this board is live to apply it", delivered: 0 });
  sendJson(res, 200, { ok: true, channel: threadId, action, subject: subjectSid });
}

// POST /api/thread/<id>/history { target, mode:"full"|"future" } — set how much of the backlog a member
// sees. For a LIVE open member it re-seeds the read cursor now (full ⇒ the backlog is unread again, replayed
// on the next inbox read, and we nudge them; future ⇒ jump past it to the tail). For a not-yet-onboarded
// invitee it stashes the choice for join time. This is the human's per-member control on the channel card;
// agents get the same at join time via the /join,/invite body. Returns where it applied (now | on-join).
async function handleThreadHistory(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { target?: unknown; mode?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  const mode = historyMode(body.mode);
  if (!mode) return sendJson(res, 400, { error: 'mode must be "full" or "future"' });
  if (typeof body.target !== "string" || !body.target) return sendJson(res, 400, { error: "missing target" });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "channel not found" });

  const sid = body.target;
  const live = liveSessions.get(sid);
  if (live && live.status !== "exited" && threadMemberSids(records, threadId).includes(sid)) {
    live.read[threadId] = seedCursor(mode, threadLogs.get(threadId) ?? []);
    let notified = 0;
    if (mode === "full") {
      live.nudge = true; // the backlog is unread for them again — wake them to (re-)read it
      if (live.status === "idle") flushNudge(live);
      notified = 1;
    }
    return sendJson(res, 200, { ok: true, channel: threadId, target: sid, mode, applied: "now", notified });
  }
  pendingHistoryMode.set(historyKey(threadId, sid), mode); // not onboarded yet — apply when they go open
  sendJson(res, 200, { ok: true, channel: threadId, target: sid, mode, applied: "on-join" });
}

// ── §16 ask/reply: synchronous consultation over channel membership ───────────────────────────────────
const ASK_TIMEOUT_DEFAULT = 30_000;
const ASK_TIMEOUT_MAX = 60_000; // capped under the agent's Bash tool timeout so the socket never out-waits it

// Resolve a parked /ask connection exactly once (reply or timeout), clearing its timer and registry entry.
function settleAsk(askId: string, payload: Record<string, unknown>): void {
  const ask = pendingAsks.get(askId);
  if (!ask) return;
  clearTimeout(ask.timer);
  pendingAsks.delete(askId);
  try {
    sendJson(ask.res, 200, payload);
  } catch {
    /* asker disconnected before the answer landed — nothing to do */
  }
}

// POST /api/thread/<id>/ask { from, to, text, timeoutMs? } — a binary consultation: BOTH must be members
// (consent, mirroring handleThreadMessage), the answerer is nudged, and the asker's connection is HELD
// until /reply or timeout. Never touches threadLogs — the broadcast log stays untouched (§16).
async function handleThreadAsk(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; to?: unknown; text?: unknown; timeoutMs?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  if (typeof body.to !== "string" || !body.to) return sendJson(res, 400, { error: "missing to" });
  if (typeof body.text !== "string" || !body.text) return sendJson(res, 400, { error: "missing text" });
  if (body.to === body.from) return sendJson(res, 400, { error: "cannot ask yourself" });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "channel not found" });
  const members = threadMemberSids(records, threadId);
  if (!members.includes(body.from)) return sendJson(res, 403, { error: "asker is not a member of this channel" });
  if (!members.includes(body.to)) return sendJson(res, 403, { error: "answerer is not a member of this channel" });
  const answerer = liveSessions.get(body.to);
  if (!answerer || answerer.status === "exited")
    return sendJson(res, 409, { error: "answerer is not a live session" });

  const askId = crypto.randomUUID();
  const wanted = Number(body.timeoutMs);
  const timeoutMs = Math.min(Number.isFinite(wanted) && wanted > 0 ? wanted : ASK_TIMEOUT_DEFAULT, ASK_TIMEOUT_MAX);
  const timer = setTimeout(() => settleAsk(askId, { askId, timedOut: true }), timeoutMs);
  pendingAsks.set(askId, { askId, threadId, from: body.from, to: body.to, text: body.text, ts: Date.now(), res, timer });
  // Nudge ONLY the answerer (reuse the §15 coalescing): idle → wake now; busy → fire at the result boundary.
  answerer.nudge = true;
  if (answerer.status === "idle") flushNudge(answerer);
  // No sendJson here — the response is parked until settleAsk fires (reply or timeout).
}

// GET /api/asks?session=<sid> — the answerer's pending-consultation queue (parallel to /api/inbox). The
// HELD asks addressed to this session; read-only, resolves nothing.
function handleAsksRead(res: ServerResponse, sid: string | null): void {
  if (!sid) return sendJson(res, 400, { error: "missing ?session=" });
  const asks = [...pendingAsks.values()]
    .filter((a) => a.to === sid)
    .map((a) => ({ askId: a.askId, channel: a.threadId, from: a.from, text: a.text, ts: a.ts }));
  sendJson(res, 200, { asks, count: asks.length });
}

// POST /api/thread/<id>/reply { from, askId, text } — ONLY the addressee answers. Resolves the asker's
// held connection and echoes a card-only Q→A summary (kind:"ask") so the channel card stays legible
// without waking the other members (§16 seam).
async function handleThreadReply(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; askId?: unknown; text?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  if (typeof body.askId !== "string" || !body.askId) return sendJson(res, 400, { error: "missing askId" });
  if (typeof body.text !== "string" || !body.text) return sendJson(res, 400, { error: "missing text" });
  const ask = pendingAsks.get(body.askId);
  if (!ask) return sendJson(res, 404, { error: "no such pending ask (already answered or timed out)" });
  if (ask.threadId !== threadId) return sendJson(res, 400, { error: "askId belongs to a different channel" });
  if (ask.from === body.from) return sendJson(res, 403, { error: "the asker cannot answer its own ask" });
  if (ask.to !== body.from) return sendJson(res, 403, { error: "only the addressee may answer this ask" });

  settleAsk(ask.askId, { askId: ask.askId, reply: { from: body.from, text: body.text, ts: Date.now() } });
  // Legibility echo: a single card-only entry; inbox/nudge skip kind:"ask", so no member is woken.
  appendThreadMsg(boardId, threadId, body.from, `Q (${ask.from}): ${ask.text}\nA: ${body.text}`, { kind: "ask" });
  sendJson(res, 200, { ok: true, askId: ask.askId, channel: threadId, delivered: true });
}

// POST /api/thread/<id>/intent { from, intent, note? } — the work-intent typed act (threads-as-cards §6,
// migration §8 step 1). `idle+working`, `idle+blocked:human`, and `idle+done` are indistinguishable at the
// process layer, so the agent DECLARES which it is: a structured entry in the channel's log, card-only
// (rendered as a small status line; inbox/nudge skip it — an agent's own bookkeeping must not wake the
// room). The latest declaration per member also rides the channel's meta marker (`intents`, keyed by sid —
// the seat record's forerunner; step 2 moves the key to the seat so it survives an occupant respawn), which
// is what /api/threads serves and what the step-3 thread-state projection will range over. `done` doubles
// as the cooperative-yield signal — for now it informs slot management (a PM/human can see who is safe to
// terminate); the reflex scheduler acting on it comes with the projection.
async function handleThreadIntent(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; intent?: unknown; note?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  if (!isWorkIntent(body.intent))
    return sendJson(res, 400, { error: `intent must be one of ${WORK_INTENTS.map((i) => `"${i}"`).join(" | ")}` });
  if (body.note != null && typeof body.note !== "string")
    return sendJson(res, 400, { error: "note must be a string" });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "channel not found" });
  // Consent mirrors handleThreadMessage: a session must have joined to declare; a non-session `from`
  // (the human at the card) is the board owner and may mark any channel.
  if (sessionNodeForSid(records, body.from) && !threadMemberSids(records, threadId).includes(body.from))
    return sendJson(res, 403, { error: "sender is not a member of this channel" });

  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
  const msg = appendThreadMsg(boardId, threadId, body.from, intentLine(body.intent, note), {
    kind: "intent",
    intent: body.intent,
  });
  // The latest-per-participant index: full-object replace onto the meta marker (appendThreadMsg's own meta
  // upsert shallow-merges around it, so activity bumps never clobber it — pinned by the ledger test).
  // Keyed by the declarer's SEAT when it holds one (§5: the declared state must survive an occupant
  // respawn — the fresh session re-fills the seat and inherits/overwrites the same slot), else by sid;
  // `sid` inside the record says which occupant actually spoke.
  const repoPath = boards.get(boardId)?.repoPath;
  let seat: string | null = null;
  if (repoPath) {
    const meta = readThreadMeta(repoPath, threadId);
    seat = seatForSid(meta?.seats, body.from);
    const prior = meta?.intents ?? {};
    upsertThreadMeta(repoPath, threadId, {
      intents: {
        ...prior,
        [seat ?? body.from]: { intent: body.intent, ts: msg.ts, sid: body.from, ...(note ? { note } : {}) },
      },
    });
  }
  sendJson(res, 200, { ok: true, thread: threadId, channel: threadId, from: body.from, seat, intent: body.intent, seq: msg.seq });
}

// The agent-facing shape of an inbox message — DENSER and more LEGIBLE than the stored ThreadMsg. Two
// changes vs the raw record: `from` is a short HANDLE not a 36-char UUID (see inboxHandle), and `ts` (an
// opaque 13-digit epoch-ms) becomes `t`, a compact local `MM-DD HH:MM` (see fmtTs) — which is both readable
// AND fewer bytes than the epoch it replaces, while still carrying date + time so timing conflicts and
// natural-language references ("continuing yesterday's work") survive. `seq` still gives strict ordering, so
// seconds/year are dropped as redundant noise. 92% of a backlog read is message text; this is a readability
// win first, a few-percent size win second.
interface InboxMsg {
  seq: number;
  t: string; // compact local timestamp, `MM-DD HH:MM`
  from: string; // a short, @-taggable handle (see inboxHandle), not the full session UUID
  text: string;
}

// A sender's short handle for the agent-facing inbox: its role name (`RoleName.<short-sid>`, when spawned as
// a role) else an 8-char sid prefix — both of which are valid `@`-tag / prefix handles, so a reader can reply
// to or tag the sender straight from what it sees. `human`/`system` pass through unchanged. (The full sid for
// `/ask`'s `to` / `/invite`'s `target` stays available from the channel's member roster, as it always was.)
function inboxHandle(records: Array<Record<string, unknown>>, from: string): string {
  if (from === "human" || from === "system") return from;
  return sessionNameForSid(records, from) ?? from.slice(0, 8);
}

// A stored epoch-ms `ts` → compact LOCAL `MM-DD HH:MM`. Local (the board is single-user, on this machine) so
// the time reads as the human/agent would discuss it; minute precision (seq carries exact order, so seconds
// add nothing); month-day so a cross-day reference still resolves; year dropped (rarely ambiguous in a live
// channel — re-add if a board ever spans new year).
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Opt-in WINDOWING of a channel's unread tail (CLAUDE.md truncation discipline: bound in ONE place, keep the
// TAIL — recent matters most for a scroll-to-bottom log — and surface a `truncated` flag; never a silent
// drop). Applies a max message COUNT (`limit`) and/or a max TEXT-BYTE budget (`bytes`) to `fresh`, keeping
// the most recent. Always keeps ≥1 message (a budget smaller than the last message still yields it, flagged).
// Returns the kept tail + how many older messages were omitted (0 ⇒ nothing trimmed).
function windowTail(fresh: ThreadMsg[], limit: number | null, bytes: number | null): { kept: ThreadMsg[]; omitted: number } {
  if (limit == null && bytes == null) return { kept: fresh, omitted: 0 };
  let kept = limit != null && fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh.slice();
  if (bytes != null) {
    const out: ThreadMsg[] = [];
    let used = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(kept[i]!.text, "utf8");
      if (out.length > 0 && used + size > bytes) break; // always keep ≥1, then stop once the budget is spent
      out.unshift(kept[i]!);
      used += size;
    }
    kept = out;
  }
  return { kept, omitted: fresh.length - kept.length };
}

// GET /api/inbox?session=<sid> — the read tool. Returns this session's UNREAD channel messages (across all
// channels it's joined to), grouped by channel, and advances its read cursors. The agent fetches this with
// Bash, so the messages land in TOOL OUTPUT, never as a user turn — the whole point of 4e. Content lives
// only in the off-log channel log; this is the read side of it.
function handleInboxRead(res: ServerResponse, sid: string | null, limit: number | null, bytes: number | null): void {
  if (!sid) return sendJson(res, 400, { error: "missing ?session=" });
  const s = liveSessions.get(sid);
  if (!s) return sendJson(res, 404, { error: "no such live session" });
  const records = boardSnapshotRecords(boardIdentity(s.repoPath).boardId);
  type OutChan = { channel: string; title: string; messages: InboxMsg[]; truncated?: { omitted: number; hint: string } };
  const channels: OutChan[] = [];
  if (records) {
    for (const threadId of sessionThreads(records, sid)) {
      const log = threadLogs.get(threadId) ?? [];
      const since = s.read[threadId] ?? 0;
      const fresh = log.filter((mng) => mng.seq > since && !cardOnly(mng)); // ask-echoes / intent acts are card-only
      // Opt-in window: keep the recent TAIL within the requested caps; the omitted are OLDER (the cursor
      // still advances to the end below, so they're marked read — recoverable by re-joining history:"full",
      // which re-seeds the cursor to 0). Surfaced as `truncated`, never silently dropped (CLAUDE.md).
      const { kept, omitted } = windowTail(fresh, limit, bytes);
      if (kept.length) {
        const out: OutChan = {
          channel: threadId,
          title: threadNode(records, threadId)?.title || "",
          messages: kept.map((m) => ({ seq: m.seq, t: fmtTs(m.ts), from: inboxHandle(records, m.from), text: m.text })),
        };
        if (omitted > 0)
          out.truncated = { omitted, hint: `${omitted} older message(s) windowed out; re-join with history:"full" to replay all` };
        channels.push(out);
      }
      if (log.length) s.read[threadId] = log[log.length - 1]!.seq; // mark all read (incl. skipped card-only entries)
    }
  }
  const count = channels.reduce((n, c) => n + c.messages.length, 0);
  sendJson(res, 200, { channels, count });
}

// Parse an opt-in positive-integer window param (?limit= / ?bytes=); null when absent/invalid (⇒ uncapped,
// the default — no silent truncation for a caller that didn't ask for it).
function windowParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function fsApi(): Plugin {
  return {
    name: "canvas-fs-spike-api",
    // A render.js edit must reach the canvas ONLY via the cardtypes feed → cache-busted re-import
    // (templates.ts) — that path updates the one card in place. Since handleCardTypeAsset serves the
    // folder raw, these files never enter Vite's module graph and Vite has nothing to hot-update;
    // this hook is the explicit guard for the one way they still could (a stray static import from
    // app code), where Vite's no-accept-handler fallback would be a full page reload — which drops
    // the in-memory camera.
    handleHotUpdate(ctx) {
      if (ctx.file.startsWith(CARD_TYPES_DIR + path.sep)) return [];
    },
    configureServer(server: ViteDevServer) {
      startFeeds();
      server.middlewares.use((req, res, next) => {
        if (!req.url || !(req.url.startsWith("/api/") || req.url.startsWith("/card-types/")))
          return next();
        const url = new URL(req.url, "http://localhost");
        if (url.pathname.startsWith("/card-types/")) return handleCardTypeAsset(res, url.pathname);

        // The feeds stream is global (one connection per tab; feed names are themselves board-suffixed).
        if (url.pathname === "/api/feeds") return handleFeeds(req, res);
        // Session reads/spawns ARE board-scoped (?board=, default board if omitted) — the transcripts dir
        // and the spawn cwd are this board's repo. input/interrupt/resume address a live process by its
        // globally-unique id; only spawn + resume need the repo (cwd / transcript seed).
        if (url.pathname === "/api/session/spawn" && req.method === "POST") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return void handleSessionSpawn(req, res, b.repoPath, b.boardId, originOf(req));
        }
        const inputMatch = /^\/api\/session\/([\w-]+)\/input$/.exec(url.pathname);
        if (inputMatch && req.method === "POST") return void handleSessionInput(req, res, inputMatch[1]!);
        const resumeMatch = /^\/api\/session\/([\w-]+)\/resume$/.exec(url.pathname);
        if (resumeMatch && req.method === "POST") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return handleSessionResume(req, res, b.repoPath, resumeMatch[1]!);
        }
        const interruptMatch = /^\/api\/session\/([\w-]+)\/interrupt$/.exec(url.pathname);
        if (interruptMatch && req.method === "POST") return handleSessionInterrupt(res, interruptMatch[1]!);
        const terminateMatch = /^\/api\/session\/([\w-]+)\/terminate$/.exec(url.pathname);
        if (terminateMatch && req.method === "POST") return handleSessionTerminate(res, terminateMatch[1]!);
        const doneMatch = /^\/api\/session\/([\w-]+)\/done$/.exec(url.pathname);
        if (doneMatch && req.method === "POST") return handleSessionDone(res, doneMatch[1]!);
        // The channel-message read tool (session id is a global UUID, so no ?board= needed).
        if (url.pathname === "/api/inbox" && req.method === "GET")
          return handleInboxRead(res, url.searchParams.get("session"), windowParam(url, "limit"), windowParam(url, "bytes"));
        // §16: the answerer's pending-consultation queue (session id is a global UUID, so no ?board=).
        if (url.pathname === "/api/asks" && req.method === "GET")
          return handleAsksRead(res, url.searchParams.get("session"));
        // Threads (§8 step 2 — /api/thread/… is canonical; /api/channel/… stays a working alias so live
        // agents and old recipes don't break mid-transition). The thread id is a node id carrying a colon
        // (node:thread:<short> / legacy node:chan:<short>), so the client percent-encodes it — match any
        // non-slash segment and decode before the snapshot lookup.
        const threadMatch = /^\/api\/(?:thread|channel)\/([^/]+)\/(message|join|leave|invite|history|ask|reply|intent)$/.exec(url.pathname);
        if (threadMatch && req.method === "POST") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          const threadId = decodeURIComponent(threadMatch[1]!);
          const action = threadMatch[2]!;
          if (action === "message") return void handleThreadMessage(req, res, b.boardId, threadId);
          if (action === "history") return void handleThreadHistory(req, res, b.boardId, threadId);
          if (action === "ask") return void handleThreadAsk(req, res, b.boardId, threadId);
          if (action === "reply") return void handleThreadReply(req, res, b.boardId, threadId);
          if (action === "intent") return void handleThreadIntent(req, res, b.boardId, threadId);
          return void handleThreadMembership(req, res, b.boardId, threadId, action as "join" | "leave" | "invite", originOf(req));
        }
        if (url.pathname === "/api/session") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return handleSession(res, sessionsDir(b.repoPath), url.searchParams.get("id"), b.repoPath);
        }
        if (url.pathname === "/api/sessions") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return handleSessions(res, sessionsDir(b.repoPath), b.repoPath);
        }
        if (url.pathname === "/api/threads" || url.pathname === "/api/channels") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return handleThreads(res, b.repoPath);
        }
        if (url.pathname === "/api/roles") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          if (req.method === "POST") return void handleRolesCreate(req, res, b.repoPath);
          return handleRoles(res, b.repoPath);
        }
        if (url.pathname === "/api/card-types") return handleCardTypesList(res);
        if (url.pathname === "/api/boards" && req.method === "POST")
          return void handleBoardMount(req, res);
        if (url.pathname === "/api/boards") return handleBoards(res);
        // The agent bus IS board-scoped now (Phase 3): ?board=<id> picks which board's tabs a command
        // reaches and which board's snapshot is read back (default board if omitted).
        if (url.pathname === "/api/bus") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return void openSse(req, res, busClientsFor(b.boardId));
        }
        if (url.pathname === "/api/command" && req.method === "POST") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return void handleCommand(req, res, b.boardId, originOf(req));
        }
        if (url.pathname === "/api/canvas" && req.method === "POST") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return void handleCanvasPush(req, res, b.boardId, originOf(req));
        }
        if (url.pathname === "/api/canvas") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          return handleCanvasGet(res, b.boardId);
        }
        // Notebook outputs (§7 agent-legibility). The id is a node id carrying colons + a slashed path, so
        // the client percent-encodes it — match a non-slash segment and decode, exactly like channels.
        const nbOutMatch = /^\/api\/notebook\/([^/]+)\/outputs$/.exec(url.pathname);
        if (nbOutMatch) {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          const id = decodeURIComponent(nbOutMatch[1]!);
          if (req.method === "POST") return void handleNotebookOutputsPush(req, res, b.boardId, id);
          return handleNotebookOutputsGet(res, b.boardId, id);
        }
        if (url.pathname === "/api/weather") return void handleWeather(res, url.searchParams.get("q") ?? "");

        // The remaining endpoints are board-scoped: ?board=<boardId> picks which mounted repo to serve
        // (defaulting to the dev repo). The board's `root` is then the confined directory every read is
        // re-checked against, exactly as the single static root was before.
        const boardId = url.searchParams.get("board") ?? DEFAULT_BOARD.boardId;
        const board = boards.get(boardId);
        if (!board) return sendJson(res, 400, { error: "unknown board" });

        // The board's ROOTS: its canonical checkout + any git worktrees (worktree-activity slice B). The
        // file/ls/watch endpoints take `?root=<id>` to pick which (defaulting to canonical); `/api/roots`
        // lists them (the file tree drops one tree card per root, coloured by id).
        if (url.pathname === "/api/roots") return sendJson(res, 200, { roots: boardRoots(boardId) });

        // `root` is resolved to a confined dir from the board's KNOWN roots (never a caller path), exactly
        // as the single `board.root` was — an unknown rootId is rejected rather than served.
        const root = rootDir(boardId, url.searchParams.get("root"));
        if (!root) return sendJson(res, 400, { error: "unknown root" });

        if (url.pathname === "/api/ls")
          return handleLs(res, root, url.searchParams.get("path") ?? "");
        if (url.pathname === "/api/file/rename" && req.method === "POST")
          return void handleFileRename(req, res, root);
        if (url.pathname === "/api/file/delete" && req.method === "POST")
          return handleFileDelete(res, root, url.searchParams.get("path") ?? "");
        if (url.pathname === "/api/file") {
          if (req.method === "POST")
            return void handleFileWrite(req, res, root, url.searchParams.get("path") ?? "");
          return handleFile(res, root, url.searchParams.get("path") ?? "");
        }
        if (url.pathname === "/api/asset") {
          if (req.method === "POST")
            return void handleAssetWrite(req, res, root, url.searchParams.get("path") ?? "");
          return handleAssetRead(res, root, url.searchParams.get("path") ?? "");
        }
        if (url.pathname === "/api/watch") return handleWatch(req, res, root);
        return next();
      });
    },
  };
}
