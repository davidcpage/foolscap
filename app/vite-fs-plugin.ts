import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { commitRoot, watchRoot } from "./shadow-git.js";
import { isCanvasSession, listSessions, markCanvasSession, readCanvasSession, recordSessionEnd, updateCanvasSession } from "./session-ledger.js";
import { localProc, remoteProc, type SessionProc, type ProcHooks } from "./session-proc.js";
import { connectSessionHost, type SessionHostClient, type HostSessionInfo } from "./session-host-client.js";
import { sessionHostSocketPath } from "./session-host-protocol.js";
import { addThreadMember, appendThreadLine, canvasThreadsDir, fillSeat, listThreads, migrateChannelLedger, pinMessage, readPins, readThreadLog, readThreadMeta, releaseSeat, removeThreadMember, seatForSid, setThreadLevel, threadLevelForSid, threadMembersFromMeta, unpinMessage, upsertThreadMeta, type PinnedMsg, type ThreadMetaMarker } from "./thread-ledger.js";
import { classifyMentionSpawn, resolveTags } from "./thread-tags.js";
import { humanWaiting } from "./thread-waiting.js";
import { unreadMentions, contentVersion, isStaleWrite } from "./cas-guard.js";
import { connectedEdgeIds } from "./node-cascade.js";
import { isWorkIntent, intentLine, WORK_INTENTS, type WorkIntent } from "./work-intent.js";
import { isNotificationLevel, NOTIFICATION_LEVELS, wakesSeat } from "./notification-levels.js";
import { deriveThreadState } from "./thread-state.js";
import { resolveAnchor, type QuoteAnchor } from "./anchors.js";
import { appendAnnotationEvent, foldAnnotations, listAnnotatedPaths, questionState, suggestionState, readAnnotationLog, type AnnotationEvent, type AnnotationOption } from "./annotations.js";
import { listWatchedPaths, readWatchers, removeWatcher, setWatcher, setWatcherState, type WatchRecord } from "./doc-watch.js";
import { claimSurface, docSurfaceKey, isSurfaceClaimed, qualifyingWatchers, releaseSurface, seatSurfaceKey, shouldReapIdle, surfaceClaimant } from "./auto-wake.js";
import { dueJobs, jobClaimKey, planRoleJobFire, readJobs, removeJob, sessionHasScheduledWake, stampFired, upsertJob } from "./standing-jobs.js";
import { docJobClaimKey, listDocsWithJobs, readDocJobs, removeDocJob, stampDocFired, upsertDocJob } from "./doc-jobs.js";
import { reanchorFile } from "./annotation-reanchor.js";
import { canvasRolesDir, createRole, listRoles, readRole, bundledRoleFileFor } from "./role-ledger.js";
import { ensureWorktree, listWorktrees as listThreadWorktrees, removeWorktree, mergeWorktree, workItemKey } from "./worktrees.js";
import { appendBoardEvent, boardPersistMtime, clearBoardPersist, compactBoardEvents, describeBoardEvents, importBoardPersist, readBoardPersist, readBoardSnapshot, writeBoardSnapshot } from "./board-persist.js";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";

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

// ── durable board registry (multi-canvas: mounted boards survive a server restart) ────────────────
// The in-memory `boards` map dies with the process, which used to mean every non-default board was
// forgotten on restart: a tab had to re-mount via ?repo=, and until it did that board's ?board= requests
// 400'd (sidecar-surviving sessions included). The registry is the durable twin: one JSON file in the DEV
// repo's `.canvas/` (the server's own home — git-ignored, shadow-versioned like the rest of canvas-home)
// recording every repo ever mounted, with a lastOpened stamp for the picker's recency sort. On boot each
// remembered path that still exists is re-registered — map entry only; the per-board feeds/watchers stay
// LAZY (started when a tab actually mounts), so a long registry doesn't fan out watchers for boards
// nobody opens. The default board is implicit and never recorded.
const BOARDS_FILE = path.join(ROOTS.repo!, ".canvas", "boards.json");
interface BoardRegistryEntry {
  boardId: string;
  name: string;
  repoPath: string;
  lastOpened: number; // ms epoch of the latest mount POST
}
function readBoardRegistry(): BoardRegistryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(BOARDS_FILE, "utf8")) as { boards?: BoardRegistryEntry[] };
    return Array.isArray(parsed.boards) ? parsed.boards : [];
  } catch {
    return []; // absent/corrupt → empty registry (the next mount rewrites it)
  }
}
// Upsert on every mount POST — read-modify-write against the FILE, not a cached copy (the module hot
// re-evals; cheap correctness beats a stale mirror at this call rate).
function recordBoardOpened(boardId: string, name: string, repoPath: string): void {
  const entries = readBoardRegistry().filter((e) => e.boardId !== boardId);
  entries.push({ boardId, name, repoPath, lastOpened: Date.now() });
  try {
    fs.mkdirSync(path.dirname(BOARDS_FILE), { recursive: true });
    fs.writeFileSync(BOARDS_FILE, JSON.stringify({ version: 1, boards: entries }, null, 2) + "\n");
  } catch (e) {
    console.error("[boards] registry write failed:", e instanceof Error ? e.message : e);
  }
}
// Boot remount: re-register every remembered board whose repo still exists. Entries for vanished paths
// are KEPT in the file (a repo on an unmounted volume isn't gone forever) but not served this run.
for (const e of readBoardRegistry()) {
  if (boards.has(e.boardId)) continue;
  try {
    if (!fs.statSync(e.repoPath).isDirectory()) continue;
  } catch {
    continue;
  }
  boards.set(e.boardId, { root: e.repoPath, name: e.name, repoPath: e.repoPath });
}
// …and the reverse: PRUNE pinned entries the registry no longer records (the file is the durable
// truth — deleting an entry there is how a scratch/test board is retired without bouncing the whole
// process; the pinned map otherwise outlives every re-eval by design). A pruned board's requests 400
// until a tab re-mounts it via ?repo= (board.ts navigation self-heals exactly that way). Its feeds, if
// started, keep idling until a real restart — harmless, and not worth a teardown path here.
{
  const registered = new Set(readBoardRegistry().map((e) => e.boardId));
  for (const id of [...boards.keys()])
    if (id !== DEFAULT_BOARD.boardId && !registered.has(id)) {
      boards.delete(id);
      console.log(`[boards] pruned ${id} (no longer in the registry)`);
    }
}

// A board's Claude Code transcripts dir: ~/.claude/projects/<repoPath with / → ->. Per board now (was a
// single module constant) so a canvas over another repo lists THAT repo's sessions, not the dev repo's.
function sessionsDir(repoPath: string): string {
  return path.join(os.homedir(), ".claude", "projects", repoPath.replace(/\//g, "-"));
}

// Map a session's process cwd back to its CANONICAL board root. A worktree session runs in
// `<canonical>/.canvas/worktrees/<key>` (a deterministic location we own), so its board home — where the
// `.canvas/` markers/threads/memory live — is the path before `/.canvas/worktrees/`. Any other cwd IS the
// board root. Used on adoption after a restart, where the sidecar hands back the process cwd (the worktree)
// but the marker/threads must still resolve against the canonical checkout.
function boardRootForCwd(cwd: string): string {
  const marker = `${path.sep}.canvas${path.sep}worktrees${path.sep}`;
  const i = cwd.indexOf(marker);
  return i === -1 ? cwd : cwd.slice(0, i);
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
  // lastOpened rides along from the registry (0 for the default board / anything unrecorded) so the
  // picker can sort by recency without a second endpoint.
  const opened = new Map(readBoardRegistry().map((e) => [e.boardId, e.lastOpened]));
  sendJson(res, 200, {
    boards: [...boards.entries()].map(([id, b]) => ({ ...boardJson(id, b), lastOpened: opened.get(id) ?? 0 })),
  });
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
  // Agent worktrees (`spawn --worktree`) live under the board's own `.canvas/worktrees/` home. They are
  // ISOLATED workspaces, not sibling checkouts to browse, so they must NOT become board roots (that would
  // flood the file tree with one full tree per live agent). Drop anything under this board's `.canvas/`.
  const canvasHome = realpath(path.join(canonicalPath, ".canvas")) + path.sep;
  return raw
    .map((r) => ({ real: realpath(r.path!), branch: r.branch ?? "", head: r.head ?? "" }))
    .filter((r) => r.real !== canon && !r.real.startsWith(canvasHome))
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

// Mounting seeds `.canvas/` into the target repo (roles, threads, session markers — canvas-home), which
// an EXTERNAL repo's .gitignore won't cover: its `git status` gets noisy and the canvas-home force-add
// gates assume the dir is ignored. Fix it at the mount, in `.git/info/exclude` — the repo-local ignore
// file git keeps OUTSIDE the working tree, so the repo's tracked files are never touched. check-ignore
// first: exit 0 = already ignored (the dev repo's own case) → no-op; exit 1 = not ignored → append;
// anything else (128 = not a git repo at all) → nothing to do. Best-effort throughout — a repo we can't
// write to just keeps its noisy status.
function ensureCanvasExcluded(repoPath: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", ".canvas/"], { cwd: repoPath, stdio: "ignore" });
    return; // already ignored
  } catch (e) {
    if ((e as { status?: unknown }).status !== 1) return; // not "unignored" — not a git repo, or git absent
  }
  try {
    // --git-path resolves the right location even for a worktree checkout (info/ lives in the common dir).
    const rel = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoPath, encoding: "utf8" }).trim();
    const excludeFile = path.resolve(repoPath, rel);
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, "\n# foolscap: the canvas home (auto-added on board mount)\n.canvas/\n");
    console.log(`[boards] excluded .canvas/ via ${excludeFile}`);
  } catch (e) {
    console.error("[boards] could not exclude .canvas/:", e instanceof Error ? e.message : e);
  }
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
  // Every mount POST (a tab opening ?repo=, including a re-open) bumps the registry's lastOpened; the
  // default board is implicit and stays out of the file.
  if (id.boardId !== DEFAULT_BOARD.boardId) recordBoardOpened(id.boardId, id.name, id.repoPath);
  ensureCanvasExcluded(id.repoPath); // keep the target repo's git status clean of `.canvas/`
  startBoardFeeds(id.boardId, id.repoPath); // git HEAD + sessions-list feeds for this repo
  sendJson(res, 200, boardJson(id.boardId, boards.get(id.boardId)!));
}

// ── the durable board store (external-repo boards step 4: records live with the repo) ─────────────
// The browser's EventStore/SnapshotStore (core's persistence seam) are now HTTP clients over these
// endpoints (app/src/remote-store.ts); board-persist.js owns the files under `<repo>/.canvas/board/`.
// IndexedDB is retired as the durable tier — a board opened in any browser/profile/machine hydrates
// from the repo's own `.canvas/`, and `import` adopts a board's pre-existing IndexedDB state once.
// Writes THROW on failure and 500 here — the client store retries; a swallowed event is data loss.
async function handleBoardPersistWrite(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  repoPath: string,
  kind: "event" | "snapshot" | "import",
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  try {
    if (kind === "event") {
      if (typeof body.event !== "object" || body.event === null)
        return sendJson(res, 400, { error: "missing event" });
      const ev = body.event as Record<string, unknown>;
      // Second-writer tripwire: tabs mint their own seq (core/src/log.ts), so the log is single-
      // sequencer only while ONE tab writes. A non-monotonic append means a second writer (another
      // tab, a leaked headless probe) is interleaving — the append still lands (refusing would lose
      // a real gesture), but the collision must be LOUD, not discovered at hydrate. Seeded from the
      // snapshot watermark on the first append after boot, so a stale writer trips even then.
      const lastEventSeq = (fsState.lastEventSeq ??= new Map<string, number>());
      if (typeof ev.seq === "number") {
        const stored = readBoardSnapshot(repoPath) as { seq?: unknown } | null;
        const last = lastEventSeq.get(boardId) ?? (stored && typeof stored.seq === "number" ? stored.seq : undefined);
        if (last !== undefined && ev.seq <= last)
          console.warn(
            `[boards] event seq collision on ${boardId}: got ${ev.seq} after ${last} — ` +
              `a second writer is appending (another tab or a leaked probe); the log now holds conflicting seqs`,
          );
        if (last === undefined || ev.seq > last) lastEventSeq.set(boardId, ev.seq);
      }
      appendBoardEvent(repoPath, ev);
      return sendJson(res, 200, { ok: true });
    }
    if (kind === "snapshot") {
      if (typeof body.snapshot !== "object" || body.snapshot === null)
        return sendJson(res, 400, { error: "missing snapshot" });
      const snap = body.snapshot as { seq?: unknown; records?: Array<Record<string, unknown>> };
      // Capture the snapshot being replaced FIRST: the before↔after membership diff below is how a
      // human-drawn thread join/leave (a local commit that never crosses the bus) reaches onboarding.
      const before = readBoardSnapshot(repoPath) as { seq?: unknown; records?: Array<Record<string, unknown>> } | null;
      // Watermark guard: never roll the snapshot BACKWARDS. A stale tab (behind because another tab
      // kept committing) would otherwise clobber the newer save — events replay heals the content,
      // but the membership diff below would then see phantom joins on the next good save. 409 is
      // deliberate (4xx): remote-store must NOT retry a save that will never become fresh; the error
      // surfaces via Persistence.onError in the stale tab, which is exactly where the news belongs.
      if (
        before && typeof before.seq === "number" && typeof snap.seq === "number" && snap.seq < before.seq
      ) {
        console.warn(
          `[boards] STALE snapshot save refused for ${boardId}: seq ${snap.seq} < stored ${before.seq} — ` +
            `a second writer is behind the board (another tab or a leaked probe)`,
        );
        return sendJson(res, 409, { error: "stale snapshot", storedSeq: before.seq, gotSeq: snap.seq });
      }
      writeBoardSnapshot(repoPath, snap as Record<string, unknown>);
      sendJson(res, 200, { ok: true });
      try {
        announceNewMemberships(boardId, before ? (before.records ?? []) : null, snap.records ?? [], originOf(req));
      } catch (err) {
        console.warn("[threads] membership announce from snapshot diff failed:", err);
      }
      return;
    }
    // import: the one-time IndexedDB adoption. Refused (imported:false) once any server state exists.
    const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : [];
    const snapshot =
      typeof body.snapshot === "object" && body.snapshot !== null
        ? (body.snapshot as Record<string, unknown>)
        : null;
    const imported = importBoardPersist(repoPath, events, snapshot);
    // ALWAYS log adoptions: whichever tab wins this race seeds the board's durable state forever, and
    // the wrong winner is invisible after the fact. The user-agent is what tells a leaked HEADLESS
    // probe tab (this exact incident: a stale HeadlessChrome's near-empty IndexedDB beat the real
    // browser to the import and "reset" the board) apart from the browser the human is actually in.
    console.log(
      `[boards] persist import ${imported ? "ACCEPTED" : "refused (state exists)"} for ${boardId}: ` +
        `${events.length} events, snapshot=${snapshot ? "yes" : "no"} — ua: ${req.headers["user-agent"] ?? "?"}`,
    );
    return sendJson(res, 200, { imported });
  } catch (e) {
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// Claude Code's transcripts live in ~/.claude/projects/<slug> — resolved PER BOARD by sessionsDir(repoPath)
// above (the session handlers thread the board's dir), so the cards serve the right repo's history.
const MAX_SESSION_BYTES = 4 * 1024 * 1024; // whole sessions, bounded against a pathological one. The
// card scrolls, so we serve the full transcript; the cap only guards an extreme outlier (and the
// card flags it honestly when it bites — the codec marks a partial tail). In-memory spike, so a few
// MB in node.text is fine.

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".vite", ".cache", "coverage",
  // `.canvas` is DELIBERATELY NOT here: the canvas's own filesystem (docs/canvas-home.md — memory, roles,
  // threads, annotations, images) is BROWSABLE so a human can navigate to a file (e.g. `.canvas/memory/`)
  // and drag it onto the board as an editable/annotatable card. The browse listing (handleLs / Rule A) is
  // kept in lock-step with servability by ALSO filtering on isInternalPath (Rule B) — so it shows exactly
  // what the content endpoint will serve, hiding only the two off-limits `.canvas` subtrees (`board`, the
  // churny record store; `roots`, the shadow git-dirs / feedback-loop hazard). No dead rows that 404 on open.
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
      // The board record store (board-persist.js): an event append per GESTURE + a snapshot rewrite
      // per edit burst. No card reads these via the file endpoints (they have their own
      // /api/board/persist API), so watching them would only spam every tab with watch events and
      // TRIGGER a shadow commit per gesture. They still ride ALONG in shadow commits fired by real
      // content edits (commitRoot force-adds `.canvas` minus only `roots`) — versioned, not churning.
      if (segs[i + 1] === "board") return true;
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

// W12 — the doc's optimistic-concurrency version: a content hash of its FULL on-disk bytes (not the
// MAX_BYTES preview), so the CAS detects a change anywhere in the file, and `null` for a file that doesn't
// exist yet. A read stamps this alongside the content; a write echoes it as `baseVersion` (handleFileWrite).
function fileVersion(abs: string): string | null {
  try {
    return contentVersion(fs.readFileSync(abs));
  } catch {
    return null; // no such file — the version of "absent" (a create passes baseVersion:null)
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
      if (!EXCLUDE_DIRS.has(e.name) && !isInternalPath(rel)) dirs.push(rel);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase()) && !isInternalPath(rel)) {
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
  if (!r) {
    // Role cards read `.canvas/roles/<id>/role.md` through this endpoint. On a board with no override the
    // file exists only as a bundled default (app/default-roles/) — serve that read-only so the card mirrors
    // the shipped role instead of hanging on "loading…", until an edit writes the board copy (copy-on-write).
    // Same text gates already applied via `allowed`; the fallback is only reached on a genuine miss.
    const bundled = allowed ? bundledRoleFileFor(rel) : null;
    const br = bundled ? readText(bundled) : null;
    if (bundled && br)
      return sendJson(res, 200, { path: rel, content: br.content, truncated: br.truncated, version: fileVersion(bundled) });
    return sendJson(res, 404, { error: "not found" });
  }
  // W12: stamp the content version so a card can echo it back as `baseVersion` on write (optimistic lock).
  sendJson(res, 200, { path: rel, content: r.content, truncated: r.truncated, version: fileVersion(abs!) });
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
  repoPath: string,
): Promise<void> {
  const abs = safeResolve(root, rel);
  const allowed =
    !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  if (!allowed) return sendJson(res, 404, { error: "not found" }); // 404, like the read — never confirm a blocked path
  let body: { content?: unknown; baseVersion?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  if (typeof body.content !== "string") return sendJson(res, 400, { error: "content required" });
  // Bound the write at the one place a byte cap belongs (CLAUDE.md): the same MAX_BYTES the read previews
  // at — a card's editable view is preview-sized, so a write larger than that is out of this path's scope.
  if (Buffer.byteLength(body.content, "utf8") > MAX_BYTES) return sendJson(res, 413, { error: "too large" });
  // W12 — optimistic-concurrency CAS: a write MAY carry `baseVersion` (the version it read). If it does and
  // the file has since moved, reject 409 with the current version + content so the writer can rebase — the
  // conflict IS the coordination (docs/simple-markdown-editor-lessons.md Idea 2). Opt-in: a write that omits
  // `baseVersion` (every caller today — notebook write-back, sticky/thread bodies) is unguarded, unchanged.
  if (body.baseVersion !== undefined) {
    const current = fileVersion(abs!);
    if (isStaleWrite(body.baseVersion, current)) {
      const r = current == null ? null : readText(abs!);
      return sendJson(res, 409, {
        error: "stale write: file changed since baseVersion — re-read and rebase",
        path: rel,
        currentVersion: current,
        content: r?.content ?? null,
        truncated: r?.truncated ?? false,
      });
    }
  }
  try {
    fs.mkdirSync(path.dirname(abs!), { recursive: true });
    fs.writeFileSync(abs!, body.content, "utf8");
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  // Self-heal any annotations this write moved (§4), so a viewing card's highlights track the new bytes
  // immediately rather than waiting for the next annotation read. Best-effort — a no-op for an unannotated
  // file, and never allowed to fail the write it rides on. (The agent's Edit tool bypasses this path and
  // hits the disk directly; the read-time reanchor covers that — this is the /api/file card-save fast path.)
  try {
    reanchorFile(repoPath, body.content, rel);
  } catch {
    /* reanchor is best-effort; the write already succeeded */
  }
  // Return the NEW version so a card can chain edits without a re-read (W12): the write's own next baseVersion.
  sendJson(res, 200, { path: rel, ok: true, version: fileVersion(abs!) });
}

// ── doc annotations (docs/doc-annotations.md; build-order step 1) ───────────────────────────────
// Standoff highlight-and-comment on file-backed cards: the annotated file's bytes never change;
// comments are quote-anchored records in the board repo's `.canvas/annotations/` ledger
// (annotations.js), anchored by TextQuoteSelector and resolved by anchors.js. READS derive
// `orphaned` per annotation against the file's CURRENT bytes (derived at read time, never stored —
// the thread-state principle); WRITES are server-side appends, so commenting/replying needs no live
// tab (an agent can answer annotations on a board nobody has open). Appends land under
// `.canvas/annotations/`, which the root watcher already forwards (isInternalPath lets `.canvas/`
// content through), so a viewing card gets its invalidation ride-along for free — no new feed.

// The annotated file's content, behind the SAME gates as the file read (handleFile): inside the
// root, not internal, a known text extension — so an annotation op can never probe a path the
// listing wouldn't show. The MAX_BYTES head-truncation is shared with the card's read on purpose:
// anchors resolve against exactly what a card can display, and an anchor beyond the preview cap
// reads as orphaned rather than pointing at text nobody can see.
function readAnnotatedSource(root: string, rel: string): string | null {
  const abs = safeResolve(root, rel);
  const allowed = !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  return allowed ? (readText(abs!)?.content ?? null) : null;
}

// GET /api/annotations?board=<id>&path=<path> → one file's folded annotations, each with `orphaned`
// and its resolved source `range` (null when orphaned). No ledger → { annotations: [] }, 200 — "no
// comments" isn't an error. Omitting `path` lists every annotated file with open/orphan counts —
// the sweep surface ("what's awaiting an answer", doc §7).
function handleAnnotationsRead(res: ServerResponse, root: string, repoPath: string, rel: string | null): void {
  if (!rel) {
    // The sweep spans every doc that has annotations OR a watcher (P1/W4) — so "what's watched" shows up
    // even on a doc no one has commented on yet.
    const paths = [...new Set([...listAnnotatedPaths(repoPath), ...listWatchedPaths(repoPath)])].sort();
    const files = paths
      .map((p) => {
        const annos = foldAnnotations(readAnnotationLog(repoPath, p));
        const src = readAnnotatedSource(root, p);
        const open = annos.filter((a) => !a.resolved);
        const watchers = readWatchers(repoPath, p);
        // Question roll-up (docs/anchored-async-ask.md §6): `awaiting` needs a HUMAN to decide,
        // `answered` needs an AGENT to apply — surfaced separately from plain open comments so the
        // sweep answers "what's waiting on me" (awaiting) and "what's ready to apply" (answered).
        return {
          path: p,
          total: annos.length,
          open: open.length,
          orphaned: open.filter((a) => src == null || !resolveAnchor(src, a.anchor)).length,
          awaiting: annos.filter((a) => questionState(a) === "awaiting").length,
          answered: annos.filter((a) => questionState(a) === "answered").length,
          // "what's watched" (P1/W4): the count of active (non-paused) watchers arming this doc.
          watched: watchers.filter((w) => w.state !== "paused").length,
          watchers,
        };
      })
      .filter((f) => f.total > 0 || f.watchers.length > 0);
    return sendJson(res, 200, { files });
  }
  const src = readAnnotatedSource(root, rel); // a deleted/blocked file ⇒ every anchor orphans (quotes intact — the payload)
  // Self-heal (§4): re-mint anchors an intervening edit moved BEFORE we fold, so the read reflects the
  // fresh selectors and future reads hit the offset fast path. Best-effort, converges in one pass, and
  // covers every edit path (the Edit tool, /api/file, an external editor, git) — this read is the one
  // place that sees the current bytes and the ledger together, so no watcher is needed.
  reanchorFile(repoPath, src ?? null, rel);
  const annos = foldAnnotations(readAnnotationLog(repoPath, rel));
  const annotations = annos.map((a) => {
    const range = src == null ? null : resolveAnchor(src, a.anchor);
    // `state` is the read-time derived status: awaiting/answered/resolved for a question,
    // pending/accepted/rejected for a suggestion, absent for a plain note (the `orphaned` principle).
    const state = questionState(a) ?? suggestionState(a);
    return { ...a, orphaned: !range, range, ...(state ? { state } : {}) };
  });
  // A doc's SEAT roster (P1/W4) — who's armed to be woken by a comment, at what level — plus its standing
  // JOBS (doc-jobs.js), the server-fired timers on this doc's marker. Both ride the per-file read so the card
  // can paint a watcher chip / job list alongside the annotations, and the CLI `job list --doc` reads it.
  sendJson(res, 200, { path: rel, annotations, watchers: readWatchers(repoPath, rel), jobs: readDocJobs(repoPath, rel) });
}

// POST /api/annotations?board=<id> { path, op, … } → append one §5 event. Ops and their fields:
//   create   { path, anchor:{exact, prefix?, suffix?, offset?}, text, author,
//              kind?:"note"|"question"|"suggestion", options?:[{label,description?}], blocking?, replacement? } → { ok, id, ts, orphaned, state? }
//   reply    { path, id, from, text }
//   answer   { path, id, by, choice?, text? }   (the target must be a kind:"question")
//   accept   { path, id, by }   reject { path, id, by }   (the target must be a kind:"suggestion")
//   resolve  { path, id, by }        reopen { path, id, by }
//   reanchor { path, id, anchor, by }
//   thread   { path, id, thread }
//   watch    { path, role, level?, state?, by }   (arm/re-level a doc watcher — P1/W4)
//   pause    { path, role }   resume { path, role }   unwatch { path, role }   (a watcher's state)
//   job      { path, instruction, intervalMs?, role?, jobId?, by }   (create/update a doc standing job — doc-jobs.js)
//   unjob    { path, jobId, by }   (remove a doc standing job)
// `kind:"question"` (with optional `options`/`blocking`) turns a create into an anchored async-ask
// (docs/anchored-async-ask.md §4); `answer` records a human's/peer's decision on it. options/blocking
// are ignored on a note. The awaiting/answered/resolved state is derived at read (never stored).
// 400 on a bad op / missing field; 404 on a blocked/absent target file (create — never confirms a
// blocked path, like the file read) or an unknown annotation id (every other op); 500 when the
// append fails (the ledger is a comment's ONLY home — unlike a thread message there is no live
// in-memory source, so a lost write must be loud). `author`/`from`/`by` is "human" or a session
// sid — the thread-message attribution convention. A create whose anchor doesn't resolve is still
// accepted but reported `orphaned:true`, so a curl'd selector with a typo'd quote isn't born a
// silent orphan.
// The reserved watcher handle an ask-armed doc seat holds (P2/W5, anchored-async-ask §4): a `--blocking`
// question auto-arms it at `mentions` level so the later `answer` wakes a continuation with no human having
// pre-watched the doc. Cleared once no unresolved blocking question remains. Not a real role, so an
// answer-driven wake spawns a plain (bare) doc worker.
const ASK_WATCH_ROLE = "ask";

async function handleAnnotationsWrite(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  repoPath: string,
  boardId: string,
  origin: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  const str = (k: string): string | null =>
    typeof body[k] === "string" && (body[k] as string).length > 0 ? (body[k] as string) : null;
  const anchorOf = (v: unknown): QuoteAnchor | null => {
    if (!v || typeof v !== "object") return null;
    const a = v as Record<string, unknown>;
    if (typeof a.exact !== "string" || a.exact.length === 0) return null;
    return {
      exact: a.exact,
      ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}),
      ...(typeof a.suffix === "string" ? { suffix: a.suffix } : {}),
      ...(typeof a.offset === "number" ? { offset: a.offset } : {}),
    };
  };
  // Parse `options` (a multiple-choice question's choices) into [{label, description?}] — tolerant of
  // both a bare string array (["A","B"]) and the object form ([{label,description}]); a malformed/empty
  // list yields null (no options). docs/anchored-async-ask.md §4.
  const optionsOf = (v: unknown): AnnotationOption[] | null => {
    if (!Array.isArray(v)) return null;
    const out: AnnotationOption[] = [];
    for (const o of v) {
      if (typeof o === "string" && o.length > 0) out.push({ label: o });
      else if (o && typeof o === "object") {
        const r = o as Record<string, unknown>;
        if (typeof r.label === "string" && r.label.length > 0)
          out.push({
            label: r.label,
            ...(typeof r.description === "string" ? { description: r.description } : {}),
          });
      }
    }
    return out.length > 0 ? out : null;
  };
  const rel = str("path");
  const op = str("op");
  if (!rel) return sendJson(res, 400, { error: "path required" });
  const ts = Date.now();

  if (op === "create") {
    const anchor = anchorOf(body.anchor);
    const text = str("text");
    const author = str("author");
    if (!anchor || !text || !author)
      return sendJson(res, 400, { error: "create needs anchor.exact, text, author" });
    const src = readAnnotatedSource(root, rel);
    if (src == null) return sendJson(res, 404, { error: "not found" });
    // kind defaults to "note" (stored implicitly — a create with no kind folds to note, so existing
    // callers are unchanged); question fields ride only on a question, `replacement` only on a suggestion.
    const isQuestion = body.kind === "question";
    const isSuggestion = body.kind === "suggestion";
    const options = isQuestion ? optionsOf(body.options) : null;
    const blocking = isQuestion && body.blocking === true;
    // A suggestion is a span REPLACEMENT — the proposed new text is required (an empty string is a valid
    // deletion, so the guard is "is it a string", not "is it truthy").
    const replacement = isSuggestion ? (typeof body.replacement === "string" ? body.replacement : null) : null;
    if (isSuggestion && replacement == null)
      return sendJson(res, 400, { error: "a suggestion needs a replacement string" });
    const id = "anno:" + crypto.randomUUID();
    const ev: AnnotationEvent = {
      ev: "create",
      id,
      path: rel,
      anchor,
      text,
      author,
      ts,
      ...(isQuestion ? { kind: "question" } : isSuggestion ? { kind: "suggestion" } : {}),
      ...(options ? { options } : {}),
      ...(blocking ? { blocking: true } : {}),
      ...(replacement != null ? { replacement } : {}),
    };
    if (!appendAnnotationEvent(repoPath, rel, ev)) return sendJson(res, 500, { error: "append failed" });
    if (isQuestion) {
      // A blocking question arms an ask-armed doc seat (mentions) so the ANSWER wakes a continuation (§4).
      // The question itself awaits a HUMAN — it wakes no agent (no-op-spawn avoidance), so no doc-wake here.
      if (blocking) setWatcher(repoPath, rel, { role: ASK_WATCH_ROLE, level: "mentions", by: author, ts });
    } else {
      // A note OR a suggestion is room-wide activity a reviewer should service → wake an `all` watcher.
      maybeWakeDocWorker(boardId, repoPath, origin, rel, isSuggestion ? "suggestion" : "note");
    }
    return sendJson(res, 200, {
      ok: true,
      id,
      ts,
      orphaned: !resolveAnchor(src, anchor),
      ...(isQuestion ? { kind: "question", state: "awaiting" } : {}),
      ...(isSuggestion ? { kind: "suggestion", state: "pending" } : {}),
    });
  }

  // Doc-WATCH ops (P1/W4, doc-watch.js) — a doc's SEAT roster, not an annotation. They key on `role`, not
  // an annotation id, so they're handled before the id-gated block below. `watch` binds/re-levels a role as
  // a watcher (arm the "watch for comments" affordance); `pause`/`resume` toggle its state; `unwatch` drops
  // it. The doc must exist (like `create`). W4 is pull-mode plumbing: this records who to wake — the actual
  // server-spawn on a qualifying comment is W5.
  if (op === "watch" || op === "unwatch" || op === "pause" || op === "resume") {
    const role = str("role");
    const by = str("by") ?? "human";
    if (!role) return sendJson(res, 400, { error: `${op} needs role` });
    if (readAnnotatedSource(root, rel) == null) return sendJson(res, 404, { error: "not found" });
    if (op === "unwatch") {
      const removed = removeWatcher(repoPath, rel, role);
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true, removed: true } : { error: "no such watcher" });
    }
    if (op === "pause" || op === "resume") {
      const w = setWatcherState(repoPath, rel, role, op === "pause" ? "paused" : "active");
      return w ? sendJson(res, 200, { ok: true, watcher: w }) : sendJson(res, 404, { error: "no such watcher" });
    }
    // op === "watch": bind or re-level (level defaults to `all` on a fresh bind; state via optional field).
    const level = isNotificationLevel(body.level) ? body.level : undefined;
    const state = body.state === "paused" ? "paused" : body.state === "active" ? "active" : undefined;
    const w = setWatcher(repoPath, rel, { role, level, state, by, ts });
    return sendJson(res, 200, { ok: true, watcher: w });
  }

  // Doc-JOB ops (doc-jobs.js) — a STANDING JOB on the doc's marker, the W6 thread-job drop-in generalized
  // onto a doc (the `/api/thread/<id>/job` shape, doc-scoped). `job` creates/updates (jobId edits in place;
  // a named `role` fires into that role's seat, else a bare doc worker; intervalMs clamps up to the 60s
  // floor); `unjob` removes by jobId. Keyed on job fields, not an annotation id, so handled before the
  // id-gated block. The doc must exist (like `create`/`watch`). The server-fired half is standingJobsTick.
  if (op === "job" || op === "unjob") {
    const by = str("by") ?? "human";
    if (readAnnotatedSource(root, rel) == null) return sendJson(res, 404, { error: "not found" });
    if (op === "unjob") {
      const jobId = str("jobId");
      if (!jobId) return sendJson(res, 400, { error: "unjob needs jobId" });
      const { removed, jobs } = removeDocJob(repoPath, rel, jobId);
      return sendJson(res, removed ? 200 : 404, { ok: removed, path: rel, removed, jobs });
    }
    const instruction = str("instruction");
    const jobId = str("jobId");
    if (!instruction && !jobId) return sendJson(res, 400, { error: "job needs instruction" });
    if (body.intervalMs != null && !Number.isFinite(Number(body.intervalMs)))
      return sendJson(res, 400, { error: "intervalMs must be a number of milliseconds" });
    if (body.role != null && typeof body.role !== "string")
      return sendJson(res, 400, { error: "role must be a string (a role id) or omitted" });
    const { job, jobs } = upsertDocJob(repoPath, rel, {
      id: jobId ?? undefined,
      role: typeof body.role === "string" ? body.role : null,
      intervalMs: body.intervalMs as number | undefined,
      instruction: instruction ?? undefined,
      by,
      ts,
    });
    return sendJson(res, 200, { ok: true, path: rel, job, jobs });
  }

  // Every other op targets an existing annotation on an existing ledger.
  const id = str("id");
  if (!id) return sendJson(res, 400, { error: "id required" });
  const target = foldAnnotations(readAnnotationLog(repoPath, rel)).find((a) => a.id === id);
  if (!target) return sendJson(res, 404, { error: "unknown annotation" });

  // Suggestion ACCEPT/REJECT (track-changes) — a terminal decision on a `kind:"suggestion"`. Accept APPLIES
  // the replacement to the file's bytes (splice the anchored span → replacement) and resolves; reject just
  // resolves, bytes untouched. Both are one-shot: a suggestion already decided is refused (409). Handled
  // here — ahead of the shared `ev` assembly below — because accept mutates the file, not just the ledger.
  if (op === "accept" || op === "reject") {
    if (target.kind !== "suggestion") return sendJson(res, 400, { error: "not a suggestion" });
    const by = str("by");
    if (!by) return sendJson(res, 400, { error: `${op} needs by` });
    if (target.decision) return sendJson(res, 409, { error: `suggestion already ${target.decision}` });
    if (op === "accept") {
      // Resolve the span against the SAME preview the card sees (readAnnotatedSource) to get [start,end);
      // an orphan can't be applied (its span is gone) → 409, the writer must re-anchor or reject.
      const src = readAnnotatedSource(root, rel);
      if (src == null) return sendJson(res, 404, { error: "not found" });
      const range = resolveAnchor(src, target.anchor);
      if (!range) return sendJson(res, 409, { error: "orphaned suggestion — its span is gone; re-anchor or reject" });
      // Splice into the FULL on-disk bytes, not the MAX_BYTES preview: a truncated splice would silently drop
      // the file's tail. The head is byte-identical up to the cut, so the preview-derived [start,end) — which
      // can only resolve within the preview — are valid offsets into the full text too (CLAUDE.md size-cap rule).
      const abs = safeResolve(root, rel);
      let full: string;
      try {
        full = fs.readFileSync(abs!, "utf8");
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
      const next = full.slice(0, range.start) + (target.replacement ?? "") + full.slice(range.end);
      try {
        fs.writeFileSync(abs!, next, "utf8");
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
      // Record the accept only AFTER the bytes landed: on the rare append failure the file is edited but the
      // suggestion stays pending (visible, not silently diverged) and the 500 tells the caller.
      if (!appendAnnotationEvent(repoPath, rel, { ev: "accept", id, by, ts }))
        return sendJson(res, 500, { error: "append failed" });
      // Self-heal the sibling anchors the splice moved (the /api/file write path's move), best-effort.
      try {
        reanchorFile(repoPath, next, rel);
      } catch {
        /* reanchor is best-effort; the edit already landed */
      }
      return sendJson(res, 200, { ok: true, id, ts, state: "accepted", applied: true, version: fileVersion(abs!) });
    }
    // reject — resolve without touching the bytes.
    if (!appendAnnotationEvent(repoPath, rel, { ev: "reject", id, by, ts }))
      return sendJson(res, 500, { error: "append failed" });
    return sendJson(res, 200, { ok: true, id, ts, state: "rejected", applied: false });
  }

  let ev: AnnotationEvent;
  if (op === "reply") {
    const from = str("from");
    const text = str("text");
    if (!from || !text) return sendJson(res, 400, { error: "reply needs from, text" });
    ev = { ev: "reply", id, from, text, ts };
  } else if (op === "answer") {
    // Record a decision on a question (§4): a choice (an option label) and/or free prose; at least one
    // is required. Answering a plain note is a category error (400) — there's nothing to answer.
    if (target.kind !== "question") return sendJson(res, 400, { error: "not a question" });
    const by = str("by");
    const choice = str("choice");
    const text = str("text");
    if (!by) return sendJson(res, 400, { error: "answer needs by" });
    if (!choice && !text) return sendJson(res, 400, { error: "answer needs choice and/or text" });
    ev = { ev: "answer", id, by, ts, ...(choice ? { choice } : {}), ...(text ? { text } : {}) };
  } else if (op === "resolve" || op === "reopen") {
    const by = str("by");
    if (!by) return sendJson(res, 400, { error: `${op} needs by` });
    ev = { ev: op, id, by, ts };
  } else if (op === "reanchor") {
    const anchor = anchorOf(body.anchor);
    const by = str("by");
    if (!anchor || !by) return sendJson(res, 400, { error: "reanchor needs anchor.exact, by" });
    ev = { ev: "reanchor", id, anchor, by, ts };
  } else if (op === "thread") {
    const thread = str("thread");
    if (!thread) return sendJson(res, 400, { error: "thread needs thread" });
    ev = { ev: "thread", id, thread, ts };
  } else {
    return sendJson(res, 400, { error: "unknown op" });
  }
  if (!appendAnnotationEvent(repoPath, rel, ev)) return sendJson(res, 500, { error: "append failed" });
  // Post-write wake (P2/W5): an ANSWER is activity addressed to the ask-armed seat → wake a continuation.
  if (op === "answer") maybeWakeDocWorker(boardId, repoPath, origin, rel, "answer");
  // Clearing the ask-armed seat: once NO unresolved blocking question remains on the doc, drop it (§4 — the
  // `resolve` clears the watcher the `--blocking` create armed). Re-derived from state, so it survives
  // multiple concurrent blocking asks (only the last resolve removes it).
  if (op === "resolve") {
    const stillBlocking = foldAnnotations(readAnnotationLog(repoPath, rel)).some(
      (a) => a.kind === "question" && a.blocking && questionState(a) !== "resolved",
    );
    if (!stillBlocking) removeWatcher(repoPath, rel, ASK_WATCH_ROLE);
  }
  sendJson(res, 200, { ok: true, id, ts });
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
// Is a wake ACTUALLY scheduled for this session? The `loops` role flag is static legibility ("this is a
// looping-TYPE role") and asserts nothing about a timer — real wakes come from live standing JOBS on a thread
// (standing-jobs.js), which are human-gated and often absent. So an idle looping session reads the calm teal
// "scheduled" band only when some thread carries a live job whose ROLE-SEAT this session currently occupies
// (sessionHasScheduledWake); otherwise it's genuinely "waiting", not asleep on a heartbeat. Only consulted for
// idle looping sessions (callers gate on `loops` first), so the listThreads marker read stays off the hot path.
function hasScheduledWake(repoPath: string, id: string): boolean {
  try {
    return sessionHasScheduledWake(listThreads(repoPath), id);
  } catch {
    return false;
  }
}
function sessionStatus(repoPath: string, id: string): SessionBand {
  const live = liveSessions.get(id);
  if (live) {
    // A held permission prompt outranks everything live: the process is technically mid-turn
    // ("running"), but it's blocked on a HUMAN click — the one state the loud band exists for.
    if (live.status !== "exited" && [...pendingPermissions.values()].some((p) => p.sid === id)) return "waiting";
    if (live.status === "running") return "working";
    // Idle: blocked on a peer (blue) > asleep on the loop heartbeat (calm teal `scheduled`, a looping role
    // between ticks — no human demand) > the default loud amber "your turn". `scheduled` is gated on an ACTUAL
    // live scheduled wake (hasScheduledWake), not the static `loops` flag — a looping role with no standing job
    // will never wake on a timer, so it's "waiting" (a real demand on you), not asleep.
    if (live.status === "idle") {
      if (live.waitingOn?.length) return "waiting-agent";
      if (live.loops && hasScheduledWake(repoPath, id)) return "scheduled";
      return "waiting";
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

// The PARTICIPANTS a thread's state derives from (§8 step 3): the union of the current member:open
// roster (snapshot edges + the emitted-membership registry) and the seats' current occupants — seats
// are the DURABLE participants, so a thread whose card (and edges) were removed, or a board whose tab
// hasn't pushed a snapshot yet (a cold server), still projects from its seat records. Each participant
// pairs what the canvas OBSERVES (its process-state, from the live-session registry; absent = exited)
// with what only the agent could SAY (its latest work-intent off the marker, seat-keyed where it holds
// one so the declaration survives a respawn). Intent keys that name no agent (the human's own mark at
// the card) annotate the log but are not participants — humans emit no work-intent (lifecycle §6);
// the close verb (§8 step 6) is the human's tool.
interface ThreadParticipantOut {
  sid: string;
  seat: string | null; // the seat handle it occupies (§5), null for a plain unnamed session
  role: string | null; // the seat's role name (= handle until labelled multiplicity ships)
  processState: "running" | "idle" | "exited";
  intent: string | null; // latest declared work-intent, null if never declared
}
function threadParticipants(boardId: string, threadId: string, marker: ThreadMetaMarker): ThreadParticipantOut[] {
  const records = boardSnapshotRecords(boardId) ?? [];
  const seats = marker.seats ?? {};
  const intents = marker.intents ?? {};
  const sids = new Set<string>(threadMemberSids(records, threadId));
  for (const s of Object.values(seats)) if (s.sid) sids.add(s.sid);
  return [...sids].map((sid) => {
    const live = liveSessions.get(sid);
    const seat = seatForSid(seats, sid);
    return {
      sid,
      seat,
      role: seat ? (seats[seat]?.role ?? seat) : null,
      processState: live?.status ?? "exited",
      intent: intents[seat ?? sid]?.intent ?? null,
    };
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
// `state` + `participants` are the §8 step-3 DERIVED projection (thread-state.js — active/waiting/dormant
// the way `status` rides /api/sessions): computed at read time from marker × roster × live registry,
// never stored — the marker keeps only what was declared, the projection is always current.
function handleThreads(res: ServerResponse, boardId: string, repoPath: string): void {
  const threads = listThreads(repoPath).map((m) => {
    const participants = threadParticipants(boardId, m.threadId, m);
    // The board owner's WAITING signal per thread (user waiting-state + you-pill, Phase 2): an unaddressed
    // @you/@human mention → the threads-list card highlights this row so the human can find it. Same
    // server-side derivation as the thread:<id> feed's pill (humanWaiting over the log), so the list and the
    // open card agree with no client re-derivation. threadLog is the in-memory tail (seeded at boot, kept
    // fresh by appendThreadMsg), so this stays a cheap read; the threads:<board> ping re-pulls on any
    // message or reply, setting/clearing the highlight live.
    // Only the waiting flag + count here: the threads-list card shows an amber highlight and a count badge,
    // no per-message preview (you can't select a message from the list — the thread card's "you" pill is
    // where the preview + jump-to-message lives, off the thread:<id> feed). So we drop preview/more.
    const { waiting: youWaiting, count: youWaitingCount } =
      humanWaiting(threadLog(boardId, m.threadId));
    return {
      threadId: m.threadId,
      chanId: m.threadId,
      title: typeof m.title === "string" ? m.title : "",
      text: typeof m.text === "string" ? m.text : "",
      messages: typeof m.lastSeq === "number" ? m.lastSeq : 0,
      mtime: (m.lastTs ?? m.createdAt ?? 0) as number,
      youWaiting,
      youWaitingCount,
      // Latest declared work-intent per participant (threads-as-cards §6; keyed by seat handle where the
      // declarer holds one, else sid) — the raw material the state projection derives from.
      intents: m.intents ?? {},
      // The §5 seat records: the durable per-thread participants (role posts), 1:1 with roles until labels.
      seats: m.seats ?? {},
      state: deriveThreadState(participants),
      participants,
    };
  });
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

// ── threads-list feed (the threads browser card's live push) ─────────────────────────────────────
// The threads-list mirror of startSessionsFeed: watch `.canvas/threads/` and PING the `threads:<boardId>`
// feed on any marker add/change (a thread gaining its first message, or a title/activity update); the client
// re-pulls /api/threads once per ping (content.ts). A bare ping, not the list — handleThreads stays the one
// place the list is built. mkdir first so chokidar has a directory to watch even before any thread has been
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

// The chokidar watcher one watch subscription rides — shared by the SSE endpoint (handleWatch, the
// compat path) and a WebSocket `{sub:"watch"}` subscription. Forwards add/change/unlink as {type, path}
// events until the returned close fn runs.
function openRootWatcher(root: string, send: (ev: { type: string; path: string }) => void): () => void {
  const emit = (type: string) => (abs: string) => send({ type, path: path.relative(root, abs) });
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
  return () => void watcher.close();
}

// Server-Sent Events: hold the connection open and forward chokidar add/change/unlink as JSON frames.
// This is the reactive ingest path — an out-of-band edit (your editor, an agent, git pull) becomes a
// live event the canvas turns into a card update, with no polling. COMPAT path since the WS transport
// landed: the app subscribes over /api/ws (a standing SSE stream eats one of the browser's six
// per-host HTTP/1.1 connection slots — the pool-starvation bug), but the endpoint stays for external
// consumers and old tabs.
function handleWatch(req: IncomingMessage, res: ServerResponse, root: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);
  const close = openRootWatcher(root, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000); // keep proxies from closing the stream
  req.on("close", () => {
    clearInterval(ping);
    close();
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
// Permission prompts (permission-prompt-tool): a session's Claude Code CLI hit a tool call outside its
// allow-list and — instead of headless auto-deny — routed it here via the per-session MCP relay
// (permission-prompt-mcp.js). The relay's POST is PARKED (the §16 held-response pattern) until a human
// clicks allow/deny on the session card or the hold times out. Same lifetime rules as PendingAsk: pinned
// in fsState across a hot re-eval; the held `res`/`timer` are process-bound (a restart fails the relay's
// fetch, which denies fail-closed with an honest "the human never saw this" message).
interface PendingPermission {
  permId: string;
  sid: string; // the session whose tool call is blocked (its card renders the prompt)
  toolName: string; // e.g. "Bash" — the tool the CLI is asking about
  input: unknown; // the tool's input object, echoed back on allow (updatedInput)
  ts: number;
  res: ServerResponse; // the MCP relay's parked connection, resolved on decision/timeout
  timer: ReturnType<typeof setTimeout>;
}
// One tab's WebSocket connection (/api/ws) — the single transport that replaced the tab's standing SSE
// streams (feeds + bus + one watch per root), because each of those held one of the browser's SIX
// per-host HTTP/1.1 connection slots: ~3 tabs starved the pool and every further request (the document
// itself, the template registry's fetches) queued forever with no error. A WebSocket lives in a separate,
// much larger browser budget, so tabs no longer compete with real request/response traffic.
interface WsClient {
  boardId: string; // fixed at connect (?board=) — bus commands fan out per board
  watches: Map<string, () => void>; // rootId → watcher close ({sub:"watch"} subscriptions)
  send(msg: unknown): void;
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
  pendingPermissions?: Map<string, PendingPermission>; // permId → held permission prompt (??= likewise)
  wsClients?: Set<WsClient>; // connected /api/ws tabs (added via ??= for old pinned state)
  // CANVAS_SESSION_HOST mode: the one client to the session-host sidecar. Pinned so an in-process re-eval
  // reuses the attached socket instead of a second `hello` bouncing off its own busy guard. `null` after a
  // busy rejection (another dev server holds the slot) → spawns fall back to in-process ownership.
  hostClient?: SessionHostClient | null;
  hostAttachStarted?: boolean; // attachSessionHost runs once per process, like the cleanup hook
  // THE RULE: every cross-request mutable collection that affects behaviour lives on fsState (??= at its
  // declaration site, like pendingAsks above). An unpinned module-scope map silently empties on a hot
  // re-eval while the pinned boolean guards stop the code that would refill it — shadowRoots was the
  // lesson: post-re-eval spawns found no watcher handle and their edits fell to the anonymous `external`
  // shadow floor with no error anywhere. Pure recompute-on-miss caches (summaryCache, weatherCache,
  // rootsCache) are the deliberate exception — a re-eval only costs them a recompute.
  persistTimers?: Map<string, ReturnType<typeof setTimeout>>; // session-marker debounce (timers are process-bound, so handles stay valid across re-evals)
  emittedMembers?: Map<string, { thread: string; sid: string; ts: number }>; // server-emitted memberships awaiting the snapshot
  durableMembers?: Map<string, Set<string>>; // threadId → member sids that survive card/edge removal (marker-backed)
  shadowRoots?: Map<string, ShadowRootHandle>; // boardId\0rootId → live shadow-git watcher
  busClients?: Map<string, Set<SseClient>>; // SSE compat bus subscribers, per board
  lastNotebookOutputs?: Map<string, string>; // boardId\0nodeId → last pushed outputs blob
  announcedMemberships?: Set<string>; // edgeId|phase dedup for onboarding announcements
  pendingHistoryMode?: Map<string, "full" | "future">; // threadId|sid → backlog visibility for a not-yet-onboarded member
  lastEventSeq?: Map<string, number>; // boardId → highest event seq appended (the second-writer tripwire)
}
type ShadowRootHandle = ReturnType<typeof watchRoot>;
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
const pendingPermissions = (fsState.pendingPermissions ??= new Map<string, PendingPermission>());
const wsClients = (fsState.wsClients ??= new Set<WsClient>());

// One-time shape migration for a HOT RE-EVAL over a pre-SessionProc registry: entries pinned by the old
// module carry a raw `child` (its stdout/exit handlers — old closures — still publish fine); wrap it so
// THIS module's proc.write/kill reach the surviving process. Same spirit as the `??=` guards above.
for (const s of liveSessions.values()) {
  const legacy = (s as unknown as { child?: { stdin: { write(d: string): void }; kill(): void } }).child;
  const shape = s as unknown as { proc?: SessionProc; status: string };
  if (legacy && !shape.proc) {
    shape.proc = {
      kind: "local",
      get alive() {
        return shape.status !== "exited";
      },
      write: (l: string) => {
        if (shape.status === "exited") return false;
        legacy.stdin.write(l + "\n");
        return true;
      },
      kill: () => legacy.kill(),
    };
  }
}

function publishFeed(feed: string, value: unknown): void {
  feedValues.set(feed, value);
  const frame = `data: ${JSON.stringify({ feed, value })}\n\n`;
  for (const c of feedClients) c.res.write(frame);
  for (const c of wsClients) c.send({ ch: "feed", feed, value });
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

// ── the tab transport (/api/ws) ──────────────────────────────────────────────────────────────────
// ONE WebSocket per tab carries everything the server pushes: feed frames (replayed on connect, like
// the SSE stream), the board's bus commands, and per-root file-watch events (client-subscribed with
// {sub:"watch", root}). Rationale on WsClient above: standing SSE streams ate the browser's six-per-host
// HTTP/1.1 pool — three tabs starved every later fetch into a silent forever-queue. The SSE endpoints
// (/api/feeds, /api/bus, /api/watch) stay as compat aliases; agents keep using plain HTTP.
//
// Attached per http server (WeakSet-guarded): a plugin edit re-evals this module in the same process,
// and a full server restart brings a NEW httpServer — attach once to each. Vite's own HMR socket has
// its own upgrade listener; ours ignores every pathname but /api/ws, so the two coexist.
const wsAttachedServers: WeakSet<object> = ((globalThis as { __canvasWsAttached?: WeakSet<object> })
  .__canvasWsAttached ??= new WeakSet());

function attachWs(server: ViteDevServer): void {
  const http = server.httpServer;
  if (!http || wsAttachedServers.has(http)) return;
  wsAttachedServers.add(http);
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://localhost");
    } catch {
      return;
    }
    if (url.pathname !== "/api/ws") return; // not ours — Vite's HMR listener handles its own upgrades
    wss.handleUpgrade(req, socket, head, (ws) => {
      const b = reqBoard(url);
      if (!b) return void ws.close(4400, "unknown board");
      const client: WsClient = {
        boardId: b.boardId,
        watches: new Map(),
        send(msg) {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
      };
      wsClients.add(client);
      {
        // The durable store assumes ONE writer tab per board (tabs mint their own event seq and race
        // the debounced snapshot save). A second connection is an ordinary event now (picker, probes),
        // so say it loudly the moment it happens — the ua is what tells a leaked headless probe from
        // a second real browser.
        const tabs = tabCountFor(b.boardId);
        if (tabs > 1)
          console.warn(
            `[boards] ${tabs} tabs now live on ${b.boardId} — concurrent writers can mint colliding event seqs ` +
              `and race snapshot saves. ua: ${req.headers["user-agent"] ?? "?"}`,
          );
      }
      for (const [feed, value] of feedValues) client.send({ ch: "feed", feed, value }); // replay, like handleFeeds
      const ping = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, 25000);
      ws.on("message", (data) => {
        let msg: { sub?: unknown; unsub?: unknown; root?: unknown };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        const root = typeof msg.root === "string" ? msg.root : null;
        if (msg.sub === "watch" && root && !client.watches.has(root)) {
          // Same confinement as GET /api/watch: the root must be one of this BOARD's known roots.
          const dir = rootDir(client.boardId, root);
          if (!dir) return;
          client.watches.set(root, openRootWatcher(dir, (ev) => client.send({ ch: "watch", root, ev })));
        } else if (msg.unsub === "watch" && root) {
          client.watches.get(root)?.();
          client.watches.delete(root);
        }
      });
      ws.on("error", () => {
        /* close follows; the close handler is the one teardown */
      });
      ws.on("close", () => {
        clearInterval(ping);
        for (const close of client.watches.values()) close();
        wsClients.delete(client);
      });
    });
  });
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

// Permission prompts on the card (docs/threads-as-cards follow-on; the fix for the "a nod in the
// channel can't lift the builder's gate" problem): `--permission-prompt-tool` (documented CLI flag,
// v2.1.199+) routes every would-prompt permission check to an MCP tool instead of headless auto-deny.
// Ours is permission-prompt-mcp.js — a per-session stdio relay that POSTs /api/permission/request and
// waits; the server PARKS that request until a human clicks allow/deny ON THE SESSION CARD (the §16
// held-response pattern). Approval lands in the acting session's own permission flow — full trust, no
// channel relay. The RED LINE stays gated exactly as before; what changes is that a gate now surfaces
// as a clickable prompt instead of a silent denial. Hold is deliberately generous (a human may be away;
// the blocked turn is blocked on them regardless); the CLI-side MCP tool timeout must outlast it, so
// it's set a minute above via MCP_TOOL_TIMEOUT on the spawn env (sidecar pass-through — an OLD sidecar
// ignores env and the CLI's default tool timeout applies: prompts then die early but still fail closed).
const PERMISSION_HOLD_MS = 10 * 60_000;
const PERMISSION_TOOL = "mcp__canvas__permission_prompt"; // mcp__<server>__<tool> under --mcp-config's "canvas"

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
// The collaboration/harness brief lives in editable `app/harness.md` (git-tracked, alongside this file) so
// it can be iterated on in-repo. It carries {{base}}/{{boardId}}/{{sessionId}} placeholder tokens that are
// interpolated at spawn time here. Read fresh each call (no cache) — iteration ease is the point.
function collabBrief(boardId: string, sessionId: string, origin: string): string {
  const base = `http://${origin}`;
  return fs
    .readFileSync(path.join(here, "harness.md"), "utf8")
    .replaceAll("{{base}}", base)
    .replaceAll("{{boardId}}", boardId)
    .replaceAll("{{sessionId}}", sessionId)
    // Absolute path of the dir holding harness.md (= the app/ dir). Lets the core brief point at the
    // on-demand leaf recipes (`{{harnessDir}}/harness/thread-comms.md`) with a path a worker can Read
    // from any board's cwd. Leaves are Read RAW — collabBrief does NOT interpolate them, so they carry
    // no {{...}} tokens of their own.
    .replaceAll("{{harnessDir}}", here);
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
  repoPath: string; // the board's CANONICAL repo — where its `.canvas/` home (markers, threads, memory) lives
  // The process's working directory. Equals repoPath for an ordinary session; for a WORKTREE session
  // (`spawn --worktree`) it's the isolated worktree checkout under `.canvas/worktrees/`, while repoPath
  // stays the canonical board home so markers/threads/memory/boardIdentity all resolve there. seedFromTranscript
  // keys the transcript dir off cwd (Claude Code stores transcripts per working dir), so a --resume finds them.
  cwd: string;
  // The process, behind the SessionProc seam (session-proc.js): local = we spawned and own it (dies with
  // the dev server), remote = the session-host sidecar owns it (survives a dev-server restart).
  proc: SessionProc;
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
  // Operating-loop legibility (agent-roles.md): `loops` is stamped from the role at spawn for a looping ROLE
  // (e.g. the Coordinator). It no longer drives a bespoke wake cadence — the heartbeat was migrated onto the
  // standing-job machinery (see loopTick / coordinator-heartbeat.js) — it survives only so an idle looping
  // session reads the calm `scheduled` band (sessionStatus) instead of the loud amber "waiting".
  loops: boolean;
  origin: string;
  // Shadow-git attribution (doc §6): an Edit/Write tool_use claims its target path on the shadow watcher;
  // the matching tool_result commits it attributed. Maps tool_use_id → {shadow-root key, path rel to root}.
  pendingEdits: Map<string, { key: string; rel: string }>;
  // Auto-wake worker lifecycle (P2/W5, auto-wake.js): set on a session the SERVER spawned from a durable
  // record (a doc's comment queue, a dormant thread seat). `autoWakeKey` is its single-flight surface claim
  // (released on exit); `idleSince` stamps when it last went idle, so the R1 keep-alive reaper winds it down
  // after the grace window. All undefined on a human- or role-spawned session (they're never auto-reaped).
  autoWake?: boolean;
  autoWakeKey?: string;
  idleSince?: number;
}

// liveSessions lives on fsState (aliased at the top) so spawned children survive a server reload and
// stay reachable; sessionCleanupHooked is read/written through fsState so the process-exit kill hook
// is installed exactly once across reloads, not stacked.

// Persist the live-registry state that must survive a restart — the thread read cursors and waitingOn —
// onto the session's durable marker. Without this, a restart that keeps the SESSION alive (a --resume, or
// the session-host sidecar) still resets its cursors to 0 and the next inbox read re-delivers every joined
// thread's whole backlog as "unread". Debounced per session (reads/posts come in bursts); the timer reads
// s.read at fire time, so it always writes the latest cursors. Best-effort like every marker write.
const persistTimers = (fsState.persistTimers ??= new Map<string, ReturnType<typeof setTimeout>>());
function persistSessionState(s: LiveSession): void {
  if (persistTimers.has(s.id)) return;
  persistTimers.set(
    s.id,
    setTimeout(() => {
      persistTimers.delete(s.id);
      updateCanvasSession(s.repoPath, s.id, { read: s.read, waitingOn: s.waitingOn });
    }, 500),
  );
}

// The pending permission prompts addressed to one session, in card-render shape (no held internals).
// Oldest-first so the card shows them in arrival order.
function permissionsOf(sid: string): Array<{ id: string; toolName: string; input: unknown; ts: number }> {
  return [...pendingPermissions.values()]
    .filter((p) => p.sid === sid)
    .sort((a, b) => a.ts - b.ts)
    .map((p) => ({ id: p.permId, toolName: p.toolName, input: p.input, ts: p.ts }));
}

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
    // The card can't consult the jobs ledger, so the server tells it whether a wake is ACTUALLY scheduled:
    // an idle looping session with no held waitingOn AND a live standing job on its seat (hasScheduledWake).
    // Computed only for that narrow case (short-circuits on status/loops/waitingOn first) so the marker read
    // stays off the hot path — publishSession fires on every delta burst. Replaces the old raw `loops` flag,
    // which asserted "scheduled" for any looping role even when nothing would ever wake it.
    scheduled: (s.status === "idle" && !s.waitingOn?.length && s.loops && hasScheduledWake(s.repoPath, s.id)) || undefined,
    // Held permission prompts: the card renders allow/deny buttons and paints the loud waiting band —
    // the process is mid-turn ("running") but blocked on a HUMAN, and only the server knows that.
    permissions: (() => { const p = permissionsOf(s.id); return p.length ? p : undefined; })(),
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
      if (s.autoWake) s.idleSince = Date.now(); // start the R1 keep-alive clock for an auto-wake worker
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
  // Claude Code stores transcripts per PROCESS working dir, so key off cwd (the worktree for a --worktree
  // session), not the canonical board root — else a worktree session's transcript wouldn't be found.
  const r = readSessionFile(sessionsDir(s.cwd), s.id);
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
  cwd: string = repoPath, // the process working dir — a worktree checkout for `spawn --worktree`, else the board root
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
  // session's own identity baked in. One --append-system-prompt flag, all blocks. Board MEMORY is no longer
  // injected here — it IS Claude Code's built-in file memory, pointed at `.canvas/memory` via
  // `autoMemoryDirectory` (below), so the built-in system handles both recall (MEMORY.md index) and the
  // save-a-durable-fact instructions; a second custom injection only duplicated and fought that prompt.
  const appendPrompt =
    ASK_CONVENTION + "\n\n" + collabBrief(boardIdentity(repoPath).boardId, id, origin) +
    (role?.charter ? "\n\n## Your role: " + role.name + "\n\n" + role.charter : "") +
    (threadId ? "\n\n" + workerBrief(threadId) : "");
  // The permission relay (see PERMISSION_HOLD_MS): a per-session stdio MCP server whose one tool the
  // CLI calls for every would-prompt permission check. Target endpoint + identity ride its env — the
  // same absolute-URL convention the collab brief bakes in. node = our own execPath (the sidecar's PATH
  // isn't guaranteed to carry one).
  const mcpConfig = {
    mcpServers: {
      canvas: {
        command: process.execPath,
        args: [path.join(process.cwd(), "permission-prompt-mcp.js")],
        env: { CANVAS_PERMISSION_URL: `http://${origin}/api/permission/request`, CANVAS_SESSION_ID: id },
      },
    },
  };
  // Board MEMORY = Claude Code's built-in file memory pointed at this board's `.canvas/memory` home, so a
  // worker's recalled facts AND its saved durable facts live in the shared, shadow-versioned board store
  // rather than the per-user `~/.claude/projects/<cwd>/memory` default. MUST be ABSOLUTE — a relative value
  // is silently ignored and falls back to the default (verified on CC 2.1.202); `autoMemoryDirectory` names
  // the memory dir DIRECTLY (no `<encoded-cwd>/memory` suffix, unlike older CLI builds). Per-board via
  // repoPath, so every mounted board gets its own store. (This repo's INTERACTIVE sessions are pointed at
  // the same dir via `.claude/settings.local.json`; --settings here covers spawned workers on any board.)
  const settingsOverride = { autoMemoryDirectory: path.join(repoPath, ".canvas", "memory") };
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
    "--mcp-config", JSON.stringify(mcpConfig),
    "--settings", JSON.stringify(settingsOverride), // built-in memory → .canvas/memory (additive over project settings)
    "--permission-prompt-tool", PERMISSION_TOOL, // gate hits → the card's allow/deny, not silent denial
    "--append-system-prompt", appendPrompt,
  ];
  // Does this session's role run an operating loop? Then its idle sessions are woken on the server heartbeat
  // (loopTick), and read calm "scheduled" rather than amber "waiting" between ticks. First heartbeat is one
  // BASE interval out — the spawn's own first-turn prompt is the session's opening tick.
  const loops = !!role?.loops;
  // Who owns the process? In CANVAS_SESSION_HOST mode the sidecar does (the child survives a dev-server
  // restart); otherwise we spawn in-process, exactly as before. Remote mode with the host UNREACHABLE
  // (crashed mid-flight, still reconnecting) throws — a loud 500 beats silently spawning a child under
  // in-process ownership that the next restart would kill. (hostClient === null means the slot was busy —
  // another dev server owns the host — and THAT falls back to local on purpose.)
  // The hooks close over `s` (declared just below) — they only fire async, well after it's assigned.
  if (REMOTE_SESSIONS && fsState.hostClient && !fsState.hostClient.connected)
    throw new Error("session host unreachable (reconnecting) — retry in a moment");
  // MCP_TOOL_TIMEOUT must OUTLAST the server's permission hold, or the CLI gives up on the relay first
  // and the prompt dies with an opaque client-side error instead of our honest hold-timeout deny.
  const spawnSpec = {
    cmd: "claude", args, cwd, // worktree checkout for a --worktree session; the board root otherwise
    env: { MCP_TOOL_TIMEOUT: String(PERMISSION_HOLD_MS + 60_000) },
  };
  const proc =
    REMOTE_SESSIONS && fsState.hostClient
      ? remoteProc(fsState.hostClient, id, wireSessionHooks(() => s), { spawn: spawnSpec })
      : localProc(spawnSpec, wireSessionHooks(() => s));
  const s: LiveSession = {
    // Start IDLE, not running: a freshly-spawned process is waiting on stdin (it emits `system/init`, never
    // a `result`, until it's first prompted), so "running" would be a turn that never ends — and the inbox,
    // which flushes idle-immediately / at a turn boundary, would queue forever with no boundary to drain at.
    // sendSessionInput flips it to running on the first real prompt; the result event flips it back.
    id, repoPath, cwd, proc, lines: [], inflight: null, status: "idle", skills: null, verb: null, usage: null, turnOut: 0,
    // Cursors revive from the marker (persistSessionState) so a --resume / sidecar adoption doesn't reset
    // them to 0 and re-deliver every joined thread's backlog as unread.
    read: prior.read && typeof prior.read === "object" ? { ...(prior.read as Record<string, number>) } : {},
    nudge: false, waitingOn: null,
    loops,
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
    ...(cwd !== repoPath ? { cwd } : {}), // durable note of a worktree cwd (legibility; boardRootForCwd re-derives repoPath)
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

  if (!fsState.sessionCleanupHooked) {
    fsState.sessionCleanupHooked = true;
    // Local children die with the dev server (they'd be orphaned pipes otherwise). Remote children are
    // the entire point of the sidecar: leave them running — the socket just closes, the host sees a
    // detach, and the next dev server adopts them.
    const killAll = () => { fsState.shuttingDown = true; for (const live of liveSessions.values()) if (live.proc.kind === "local") live.proc.kill(); };
    process.once("exit", killAll);
    process.once("SIGINT", () => { killAll(); process.exit(0); });
    process.once("SIGTERM", () => { killAll(); process.exit(0); });
  }

  publishSession(s); // seed the feed (empty) so the card renders the live shell immediately
  return s;
}

// ── Session-host mode (the DEFAULT): session processes live in a sidecar, survive dev-server restarts ──
// The sidecar (session-host.js) is auto-started on first attach and OWNS the `claude -p` children; this
// server is a client. Restarting the dev server no longer kills the very sessions implementing/testing
// the change being tested — on boot we re-attach and ADOPT whatever is still running. Stopping the
// SIDECAR is the explicit stop-everything (`npm run session-host:stop`). Opt OUT with
// `CANVAS_SESSION_HOST=0` (`npm run dev:local`) for the old in-process, die-with-the-server model —
// and an unreachable/busy sidecar degrades to that model by itself (see attachSessionHost).
const REMOTE_SESSIONS = process.env.CANVAS_SESSION_HOST !== "0";

// Connect to (auto-starting if needed) the session host, adopt its live sessions, stamp its dead ones.
// Once per process; a hot re-eval keeps the pinned client. A "busy" rejection (another dev server holds
// the client slot — the 5173/5174 footgun) leaves hostClient null: this server warns and runs its own
// spawns in-process, and does NOT touch the other server's sessions.
async function attachSessionHost(): Promise<void> {
  if (!REMOTE_SESSIONS || fsState.hostAttachStarted) return;
  fsState.hostAttachStarted = true;
  const appDir = process.cwd(); // `npm run dev` runs in app/ — same dir the session-host CLI resolves
  let client: SessionHostClient;
  try {
    client = await connectSessionHost({
      socketPath: sessionHostSocketPath(appDir),
      hostScript: path.join(appDir, "session-host.js"),
      clientPid: process.pid,
    });
  } catch (err) {
    fsState.hostClient = null;
    console.warn(`[session-host] ${String(err)} — sessions will run in-process (they die with this server)`);
    return;
  }
  fsState.hostClient = client;
  const { sessions, exits } = await client.list();
  for (const info of sessions) adoptSession(client, info);
  // Deaths while no dev server was attached: stamp them so the cards read crashed/ended, not status-less.
  for (const ex of exits) {
    const boardRoot = boardRootForCwd(ex.cwd); // a worktree cwd → its canonical board home (where the marker lives)
    if (!readCanvasSession(boardRoot, ex.id)?.endReason)
      recordSessionEnd(boardRoot, ex.id, ex.reason === "self" ? "crashed" : "terminated");
  }
  await client.ackExits(exits.map((e) => e.id));
  if (sessions.length || exits.length)
    console.log(`[session-host] adopted ${sessions.length} live session(s), stamped ${exits.length} exit(s)`);
}

// Rebuild a LiveSession around a child that survived our restart. History = seedFromTranscript (the same
// tail a --resume shows — completed turns; in-flight partials are gone until the next consolidated event).
// Status comes from the host's busy bit, never guessed: a wrong "idle" would let the nudge machinery
// inject stdin MID-TURN and interrupt it. Cursors/waitingOn/loops/origin revive from the marker
// (persistSessionState). Hooks attach FIRST, buffering, so a turn completing during the seed isn't lost
// (a rare duplicate of the newest turn is cosmetic and self-heals on the next resume).
function adoptSession(client: SessionHostClient, info: HostSessionInfo): void {
  if (liveSessions.has(info.id)) return; // pinned across a re-eval — already ours
  // The sidecar hands back the process cwd; for a worktree session that's the worktree, so derive the
  // canonical board root (where the marker/threads/memory live) before reading the marker.
  const boardRoot = boardRootForCwd(info.cwd);
  const marker = readCanvasSession(boardRoot, info.id) ?? {};
  const hooks = wireSessionHooks(() => s);
  const pending: string[] = [];
  let buffering = true;
  const proc = remoteProc(client, info.id, {
    onLine: (line) => (buffering ? void pending.push(line) : hooks.onLine(line)),
    onExit: (x) => hooks.onExit(x),
  });
  const s: LiveSession = {
    id: info.id, repoPath: boardRoot, cwd: info.cwd, proc, lines: [], inflight: null,
    status: info.busy ? "running" : "idle", skills: null, verb: info.busy ? "Working" : null,
    usage: null, turnOut: 0,
    read: marker.read && typeof marker.read === "object" ? { ...(marker.read as Record<string, number>) } : {},
    nudge: false,
    waitingOn: Array.isArray(marker.waitingOn) ? (marker.waitingOn as string[]) : null,
    loops: !!marker.loops,
    origin: typeof marker.origin === "string" ? marker.origin : "localhost:5173",
    pendingEdits: new Map(), // an Edit claimed pre-restart commits unattributed — accepted loss
  };
  seedFromTranscript(s);
  liveSessions.set(info.id, s);
  buffering = false;
  for (const line of pending) hooks.onLine(line);
  stopSessionFeed(info.id); // the registry owns this feed again — drop any out-of-band file-tail
  publishSession(s);
}

// The ProcHooks for a live session: fold each stdout line into the buffer/status, coalesce publishes,
// and stamp how the process ended. Takes a getter because the hooks are wired before the LiveSession
// literal exists (they only fire async, after it does). Shared by spawn (local or remote) and adoption.
function wireSessionHooks(get: () => LiveSession): ProcHooks {
  let pub: ReturnType<typeof setTimeout> | null = null;
  return {
    onLine(line) {
      const s = get();
      try {
        foldSessionEvent(s, JSON.parse(line));
      } catch {
        // a partial/non-JSON framing line — skip, keep streaming
      }
      if (pub) return;
      pub = setTimeout(() => { pub = null; publishSession(get()); }, 50); // coalesce a delta burst to one frame
    },
    onExit({ reason }) {
      const s = get();
      // Release this worker's single-flight claim even on the endSession path: endSession sets status
      // "exited" before its kill lands here (so the guard below early-returns), so the release must run
      // first. Idempotent — releaseSurface only frees a claim this exact sid still holds.
      if (s.autoWakeKey) releaseSurface(s.autoWakeKey, s.id);
      if (s.status === "exited") return; // endSession already tore it down (kill → this hook still fires)
      s.status = "exited";
      s.inflight = null;
      s.verb = null;
      // Phase 2: only a child that died ON ITS OWN is a crash — not one we killed (endSession sets the
      // reason before its kill lands here as "killed"), not a host shutdown ("shutdown" — the remote twin
      // of the old shuttingDown guard, which still covers local killAll on the way out).
      if (reason === "self" && !s.endReason && !fsState.shuttingDown) {
        s.endReason = "crashed";
        recordSessionEnd(s.repoPath, s.id, "crashed");
      }
      denySessionPermissions(s.id, "the session exited before a human decided");
      publishSession(s);
    },
  };
}

// Write a user prompt into a live session's stdin as a stream-json message. The prompt is echoed into
// the buffer right away (Claude does not echo stdin on stdout) so the card shows it without waiting.
function sendSessionInput(id: string, text: string, opts?: { keepWaitingOn?: boolean }): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  s.status = "running";
  s.idleSince = undefined; // back to work — reset the auto-wake keep-alive clock (no-op for a normal session)
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
  s.proc.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }));
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

// The in-memory log for a thread, lazily seeded from the ledger on first touch. seedThreadLogs
// (startBoardFeeds) covers a MOUNTED board at boot, but a board can also be merely re-REGISTERED from
// boards.json with no tab ever mounting it — its endpoints resolve, its logs were never seeded. An
// append that started from an empty map would mint seq 1 onto a ledger whose real tail may be hundreds
// of messages on, corrupting order and every member's read cursor. Same tail trim as the boot seed.
function threadLog(boardId: string, threadId: string): ThreadMsg[] {
  let log = threadLogs.get(threadId);
  if (!log) {
    const repoPath = boards.get(boardId)?.repoPath;
    log = repoPath ? readThreadLog(repoPath, threadId) : [];
    if (log.length > MAX_THREAD_MSGS) log = log.slice(log.length - MAX_THREAD_MSGS);
    threadLogs.set(threadId, log);
  }
  return log;
}

// Append to a channel's log, trim to the tail, republish its feed (the card's conversation view), and
// PERSIST the message to the board's `.canvas/channels/` ledger so it survives a cold restart (the in-memory
// `threadLogs` only survives a hot re-eval). `boardId` resolves which board's `.canvas/` home to write to —
// every caller already has it. The marker upsert also makes the channel appear in the channels-list rail and
// keeps its title/description fresh from the live snapshot. Both disk writes are best-effort (thread-ledger).
// Publish a thread's conversation feed (the card's view). Carries the message tail PLUS the thread's PINS
// (R-PIN head context) so the card's pinned tray stays live on every message and every pin/unpin — the pin
// state rides the same feed the log does, no second subscription. Pins live on the durable marker (read
// best-effort; [] when there's no repo/marker). Used by appendThreadMsg, seedThreadLogs, and the pin handler.
function publishThreadFeed(boardId: string, threadId: string, messages: ThreadMsg[], truncated: boolean): void {
  const repoPath = boards.get(boardId)?.repoPath;
  const pins: PinnedMsg[] = repoPath ? readPins(repoPath, threadId) : [];
  // The board owner's waiting signal (user waiting-state + you-pill): an @you/@human mention newer than the
  // human's own last post is unaddressed → colour the "you" roster pill amber. Clear-on-reply, derived
  // read-time from the log (no cursor, no durable state — thread-waiting.js). `count` feeds the pill tooltip.
  // `count` feeds the pill badge; `preview`/`more` feed the pill's hover preview + jump-to-message (Phase 3).
  const { waiting: youWaiting, count: youWaitingCount, preview: youWaitingPreview, more: youWaitingMore } =
    humanWaiting(messages);
  publishFeed("thread:" + threadId, {
    messages,
    truncated,
    pins,
    youWaiting,
    youWaitingCount,
    youWaitingPreview,
    youWaitingMore,
  });
}

function appendThreadMsg(
  boardId: string,
  threadId: string,
  from: string,
  text: string,
  extra?: { kind: "ask" } | { kind: "intent"; intent: WorkIntent },
): ThreadMsg {
  const log = threadLog(boardId, threadId); // lazy-seeds from the ledger — never mint seq 1 onto a real tail
  const seq = (log.length ? log[log.length - 1]!.seq : 0) + 1;
  const msg: ThreadMsg = { seq, ts: Date.now(), from, text, ...extra };
  log.push(msg);
  let truncated = false;
  if (log.length > MAX_THREAD_MSGS) { log.splice(0, log.length - MAX_THREAD_MSGS); truncated = true; } // keep recent
  publishThreadFeed(boardId, threadId, log, truncated);
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
    // Rehydrate durable membership from the marker (survives a cold restart — the in-memory index doesn't).
    // Done before the threadLogs short-circuit: a hot re-eval keeps threadLogs but may have dropped the index.
    const durable = threadMembersFromMeta(meta);
    if (durable.length) {
      const set = durableMembers.get(threadId) ?? new Set<string>();
      for (const sid of durable) set.add(sid);
      durableMembers.set(threadId, set);
    }
    if (threadLogs.has(threadId)) continue; // pinned from before a hot re-eval — keep the live one
    let log = readThreadLog(repoPath, threadId);
    if (log.length > MAX_THREAD_MSGS) log = log.slice(log.length - MAX_THREAD_MSGS); // keep the recent tail
    threadLogs.set(threadId, log);
    if (log.length) publishThreadFeed(repoPath ? boardIdentity(repoPath).boardId : "", threadId, log, false);
  }
  // Backfill durable membership from the persisted snapshot's live member:open EDGES — so a member that
  // joined BEFORE this became marker-backed (its marker has no `members` yet) is still adopted as durable
  // on boot. Without this, such a member counts only while its edge lives, and a card delete would drop it
  // — the migration gap for memberships that predate the fix. Idempotent; writes the marker as it adopts.
  const snap = readBoardSnapshot(repoPath) as { records?: Array<Record<string, unknown>> } | null;
  for (const r of snap?.records ?? [])
    if (r.typeName === "edge" && String(r.type) === "member:open") {
      const sid = sidFromSessionNode(String(r.from));
      if (sid) recordDurableMember(repoPath, String(r.to), sid, Date.now());
    }
}

// The thread ids a session is an OPEN member of (the reverse of threadMemberSids), for nudge/read.
// Memberships the SERVER has just emitted (a member:open over the bus), so wake / inbox / message logic
// counts a new member IMMEDIATELY — before the browser's snapshot round-trips back (the ~500ms-to-seconds
// window the CLAUDE.md "membership must be in the pushed snapshot" gotcha warns about, and what made a task
// posted right after a spawn miss the new worker). Keyed edgeId → {thread, sid, ts}; threadMemberSids and
// sessionThreads UNION these in (additive, deduped). TTL'd so a membership dropped OUTSIDE the bus (e.g. a
// human deletes the edge in the browser) can't linger past the window the snapshot needs to agree.
const emittedMembers = (fsState.emittedMembers ??= new Map<string, { thread: string; sid: string; ts: number }>());
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

// DURABLE membership (delete-card-keep-session): the sids that JOINED a thread and haven't LEFT, keyed by
// threadId. The `member:open` edge is the canvas VIEW of a membership and dies with the session's card
// (removeNode cascades its wires; core is deliberately blind to member semantics). This index is the
// membership ITSELF — unioned into threadMemberSids / sessionThreads so a cardless session still counts as
// a member (still logged, still wakeable by @-tag, still in the roster). Marker-backed (thread-ledger's
// `members`): this in-memory map is the fast read side, the marker the durable tier a cold restart rehydrates
// from (seedThreadLogs). Recorded on every member:open sighting; dropped only on a REAL leave (not card delete).
const durableMembers = (fsState.durableMembers ??= new Map<string, Set<string>>());
// Record sid as a durable member of a thread (in-memory + marker). Idempotent; needs the board's repoPath.
function recordDurableMember(repoPath: string | undefined, threadId: string, sid: string, ts: number): void {
  let set = durableMembers.get(threadId);
  if (!set) durableMembers.set(threadId, (set = new Set<string>()));
  set.add(sid);
  if (repoPath) addThreadMember(repoPath, threadId, sid, ts);
}
// Forget a durable membership (in-memory + marker) — the REAL-leave companion, never called on a card delete.
function forgetDurableMember(repoPath: string | undefined, threadId: string, sid: string): void {
  const set = durableMembers.get(threadId);
  if (set) { set.delete(sid); if (set.size === 0) durableMembers.delete(threadId); }
  if (repoPath) removeThreadMember(repoPath, threadId, sid);
}

function sessionThreads(records: Array<Record<string, unknown>>, sid: string): string[] {
  const out: string[] = [];
  const node = sessionNodeForSid(records, sid);
  if (node)
    for (const r of records)
      if (r.typeName === "edge" && r.from === node && String(r.type) === "member:open" && threadNode(records, String(r.to)))
        out.push(String(r.to));
  for (const m of liveEmittedMembers()) if (m.sid === sid && !out.includes(m.thread)) out.push(m.thread);
  // Durable members whose card/edge is gone: still a member of these threads (the card was only a view).
  for (const [threadId, set] of durableMembers) if (set.has(sid) && !out.includes(threadId)) out.push(threadId);
  return out;
}

// A message arrived in a thread: mark every OTHER live member as owing a nudge and wake the idle ones now
// (busy ones fire at their turn boundary). Returns how many live members were notified.
//
// The wake is gated by each member's SEAT LEVEL (P1/W4, notification-levels.js) — the R2 recast: a member's
// static, self-declared preference decides whether a room broadcast reaches it, and an explicit @-mention
// always overrides (reaching a `mentions`/`paused` seat too). `opts`:
//   • broadcast — a room-wide post (`@all`, or a room event like a join): wakes only members at level `all`.
//   • mentioned — the sids a post @-addressed: woken regardless of their level (the @-mention override).
// An untagged post is neither (broadcast:false, mentioned empty): ambient, wakes no one — logged for
// everyone to read on their own cursor. The sender is always skipped. The unread CURSOR is untouched here,
// so a member that wasn't woken still sees the message next time it reads — wake is gated, content is not.
function wakeThreadMembers(
  boardId: string,
  threadId: string,
  exceptSid: string,
  opts: { broadcast: boolean; mentioned?: Set<string>; origin?: string },
): number {
  const records = boardSnapshotRecords(boardId);
  if (!records) return 0;
  const meta = boards.get(boardId)?.repoPath ? readThreadMeta(boards.get(boardId)!.repoPath, threadId) : null;
  let woken = 0;
  for (const sid of threadMemberSids(records, threadId)) {
    if (sid === exceptSid) continue;
    const mentioned = opts.mentioned?.has(sid) ?? false;
    if (!wakesSeat(threadLevelForSid(meta, sid), { mentioned, broadcast: opts.broadcast })) continue;
    const s = liveSessions.get(sid);
    if (!s || s.status === "exited") {
      // Dormant seat (P2/W5, R1): the member is addressable but no live process backs it. An @-ADDRESSED
      // message reconstitutes it from the durable record; a bare broadcast to a dormant room wakes no one
      // (the R1 "addresses a dormant seat" condition — a broadcast never respawns). `origin` gates it: only
      // the thread-message path (which passes it) reconstitutes; a join broadcast has none, so it's inert.
      if (mentioned && opts.origin) maybeRespawnDormantSeat(boardId, threadId, sid, opts.origin, meta);
      continue;
    }
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
// A looping ROLE (the Coordinator) needs to sweep the board for STALLS — but nothing emits an event when an agent
// goes silent, so a purely reactive session would never wake to notice. And built-in self-scheduling does
// NOT fire in a `claude -p` child (tested), so the wake can't come from inside the agent — the SERVER has to
// fire the timer. This USED to be a bespoke per-session loop here (a cadence timer that nudged every already-
// live looping session). It has been RETIRED and CONVERGED onto the general STANDING-JOB machinery (R6/W6):
// the Coordinator heartbeat is now a standing job on the Coordinator's thread (`coordinator-heartbeat.js`),
// fired by `standingJobsTick` through the one `serverSpawnWorker` primitive with WAKE-LIVE-ELSE-RESPAWN — so
// it nudges a live+idle Coordinator (cheap) AND, unlike the old bespoke path, reconstitutes a DORMANT one.
// One driver, no fork. Enabling that job is the AUTONOMY SWITCH and is human-gated (`scripts/canvas job
// coordinator <thread>`); absent the job there is no auto-heartbeat, which is the correct gated-off state.
// The `loops` role flag survives only as LEGIBILITY: an idle looping session reads the calm `scheduled` band
// (sessionStatus) rather than the loud amber "waiting", since its wake comes from a scheduled job not a human.
const LOOP_TICK_MS = 15_000; // scheduler granularity — how often loopTick evaluates due jobs / reaps idle workers

// One scheduler tick: reap idle auto-wake workers and fire due standing jobs. Both iterate their own records;
// neither interrupts a RUNNING session (a mid-turn target is skipped and retried next tick).
function loopTick(): void {
  autoWakeReapTick(); // P2/W5: wind down auto-wake workers idle past the keep-alive window (own iteration)
  standingJobsTick(); // R6/W6: fire the standing jobs that have come due (own iteration over the markers) —
  //                     this is now the SOLE heartbeat driver, incl. the migrated Coordinator heartbeat
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
// halts the in-flight turn at a safe boundary and emits a `result`, which folds the card back to idle
// (foldSessionEvent), leaving the process alive for the next prompt. No-op (false) once exited.
function sendSessionInterrupt(id: string): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.proc.write(
    JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } }),
  );
  return true;
}

// POST /api/session/spawn  { prompt? } → { id }. Mint a new session id, spawn the process, and send the
// first prompt if given. The client drops a session card titled <id>, which subscribes to session:<id>.
// The host:port the browser actually reached us on (so the spawned agent's API base matches the live
// server, not a guessed default — sidesteps the 5173/5174 footgun). Falls back to the default dev port.
// The last request host we saw — the origin a SERVER-FIRED spawn (standingJobsTick) seeds its worker brief /
// bus commands with, since it has no triggering request of its own. The server is strictPort-pinned to
// 127.0.0.1:5173, so the constant fallback is correct until the first request refines it.
let lastKnownOrigin = "127.0.0.1:5173";
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  const origin = typeof host === "string" && host ? host : "localhost:5173";
  lastKnownOrigin = origin;
  return origin;
}

// Cap on CONCURRENT live sessions (status !== "exited"), across every board this server hosts. The guard
// against runaway agent fan-out — a session spawning helpers that spawn helpers. Spawn 429s at the cap;
// /terminate frees a slot. A ceiling on concurrency, not on total spawns over time.
const MAX_LIVE_SESSIONS = 12;
const liveSessionCount = (): number => [...liveSessions.values()].filter((s) => s.status !== "exited").length;
// Is `sid` a LIVE session right now (running or idle, not exited / not gone)? The synchronous liveness
// predicate the seat machinery reaches for — an exited session (or one never seen) fails it, which is what
// lets a departed-occupant seat re-fill on respawn while a live occupant is never displaced.
const isSidLive = (sid: string): boolean => {
  const s = liveSessions.get(sid);
  return !!s && s.status !== "exited";
};

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

// Resolve the working directory a spawn runs in: an isolated git worktree when `--worktree` was requested
// OR the work item already HAS one (so a respawn re-attaches to the same tree/branch rather than cutting a
// fresh one — the whole reason worktrees are keyed by work item, not sid), else the canonical board root.
// Throws when a worktree is needed but the work item can't be durably keyed (no thread) — surfaced as a 400.
function resolveSpawnCwd(
  repoPath: string,
  opts: { threadId: string | null; roleId: string | null; worktree: boolean; base: string | null; explicitKey: string | null },
): { cwd: string; worktree: ReturnType<typeof ensureWorktree> | null; key: string | null } {
  const key = workItemKey({ threadId: opts.threadId, roleId: opts.roleId, explicitKey: opts.explicitKey });
  const existing = key && opts.threadId ? listThreadWorktrees(repoPath, opts.threadId)[key] : null;
  if (!opts.worktree && !existing) return { cwd: repoPath, worktree: null, key: null };
  if (!key || !opts.threadId)
    throw new Error("a worktree spawn needs a thread — the thread (or role seat) is the durable work-item key");
  const wt = ensureWorktree(repoPath, opts.threadId, key, opts.base);
  return { cwd: wt.path, worktree: wt, key };
}

async function handleSessionSpawn(
  req: IncomingMessage,
  res: ServerResponse,
  repoPath: string,
  boardId: string,
  origin: string,
): Promise<void> {
  let body: {
    prompt?: unknown; roleId?: unknown; thread?: unknown; channel?: unknown; card?: unknown;
    worktree?: unknown; base?: unknown; worktreeKey?: unknown;
  } = {};
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
  // Worktree isolation (Stage 1): run this session in its own git worktree instead of the shared board root.
  // Resolve the cwd BEFORE spawning — a bad request (worktree with no thread) or a git failure must 4xx/5xx,
  // not leave a live process pointed at the wrong tree.
  const wantWorktree = body.worktree === true;
  const base = typeof body.base === "string" && body.base ? body.base : null;
  const explicitKey = typeof body.worktreeKey === "string" && body.worktreeKey ? body.worktreeKey : null;
  let cwd = repoPath;
  let worktree: ReturnType<typeof ensureWorktree> | null = null;
  try {
    const resolved = resolveSpawnCwd(repoPath, { threadId, roleId, worktree: wantWorktree, base, explicitKey });
    cwd = resolved.cwd;
    worktree = resolved.worktree;
  } catch (err) {
    return sendJson(res, 400, { error: "worktree spawn rejected", detail: String(err) });
  }
  const id = crypto.randomUUID();
  try {
    ensureLiveSession(id, repoPath, false, origin, roleId, threadId, cwd);
  } catch (err) {
    return sendJson(res, 500, { error: "failed to spawn", detail: String(err) });
  }
  // A worker spawned into a channel starts its inbox at the channel's TAIL (history:"future"), seeded HERE —
  // not via the snapshot-racing member:open onboarding — so its first read is its assignment, not the whole
  // backlog (the replay-burial failure mode that made a returning session dismiss its task as old history).
  if (threadId) {
    pendingHistoryMode.set(historyKey(threadId, id), "future");
    const live = liveSessions.get(id);
    if (live) {
      live.read[threadId] = seedCursor("future", threadLog(boardId, threadId));
      persistSessionState(live);
    }
  }
  // Optionally drop the session's canvas card (and, with `channel`, its member:open edge) HERE on the
  // server, so the curl/wrapper caller doesn't addNode + addEdge by hand. The win is POSITIONING (the server
  // reads the channel card's position from the last snapshot and places the worker beside it, vs an agent
  // guessing coordinates badly) AND robustness: dispatchBusCommand records the member:open in the
  // immediate-membership registry, so a task the Coordinator posts right after this reliably wakes the worker even
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
  sendJson(res, 200, {
    id, roleId, roleName, roleColour, carded,
    ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch, reused: worktree.reused, linked: worktree.linked } } : {}),
  });
}

// ── P2/W5: server-spawn-from-a-durable-record (auto-wake.js) ─────────────────────────────────────────
// The SERVER reconstitutes a session from a durable record on a qualifying wake — a comment/answer on a
// watched doc (Trigger 1, maybeWakeDocWorker) or an @-addressed message to a dormant thread seat (Trigger 2,
// maybeRespawnDormantSeat). Both share this one primitive: mint a fresh session, seed it from the record
// (thread history / the doc's annotation queue + the memory brief ensureLiveSession already bakes in), claim
// the surface single-flight, drop a card, and send the first-turn worker brief. `--resume` is deliberately
// NOT used (R1): reconstitution is a FRESH spawn seeded from the durable substrate, never a transcript
// replay. W6 (standing jobs) rides this same function. Returns the new sid, or null if it couldn't spawn
// (cap reached / spawn error — logged, never thrown: a wake is best-effort, it degrades to pull).
const IDLE_KEEPALIVE_MS = 5 * 60_000; // R1: an auto-wake worker idles this long, then the reaper winds it down

function serverSpawnWorker(opts: {
  boardId: string;
  repoPath: string;
  origin: string;
  roleId: string | null;
  threadId: string | null; // set → member:open edge + thread-cursor seed; null → a standalone doc worker
  anchorNodeId: string | null; // the node to position the worker card beside (thread card / doc card)
  claimKey: string;
  firstPrompt: string;
}): string | null {
  // Replicate handleSessionSpawn's cap guard — a server-fired spawn must not blow past MAX_LIVE_SESSIONS.
  // No silent drop (repo principle): LOG the skip so a doc/seat that should've been serviced isn't left
  // invisibly waiting. It re-fires on the next qualifying activity (a deferred-wake queue is a follow-up).
  if (liveSessionCount() >= MAX_LIVE_SESSIONS) {
    console.warn(
      `[auto-wake] live-session cap (${MAX_LIVE_SESSIONS}) reached — SKIPPING spawn for ${opts.claimKey}; ` +
        `it will re-fire on the next qualifying activity (no deferred-wake queue yet)`,
    );
    return null;
  }
  const id = crypto.randomUUID();
  // RE-ATTACH on respawn: if the work item this wake targets already has a worktree, land the fresh session
  // back in it (never cut a new one). worktree:false so we only reuse an existing record, never create here —
  // a server-fired wake shouldn't newly isolate a work item that wasn't set up for it.
  let cwd = opts.repoPath;
  try {
    cwd = resolveSpawnCwd(opts.repoPath, {
      threadId: opts.threadId, roleId: opts.roleId, worktree: false, base: null, explicitKey: null,
    }).cwd;
  } catch (err) {
    console.warn(`[auto-wake] worktree re-attach failed for ${opts.claimKey}: ${String(err)}`);
  }
  let live: LiveSession;
  try {
    live = ensureLiveSession(id, opts.repoPath, false, opts.origin, opts.roleId, opts.threadId, cwd);
  } catch (err) {
    console.warn(`[auto-wake] spawn failed for ${opts.claimKey}: ${String(err)}`);
    return null;
  }
  live.autoWake = true;
  live.autoWakeKey = opts.claimKey;
  claimSurface(opts.claimKey, id); // single-flight: the surface is now being serviced by this sid
  // A thread worker starts at the thread's FULL backlog (history:"full") so it's seeded from the thread's
  // durable history — the addressed message that woke it replays on its first inbox read (R1).
  if (opts.threadId) {
    pendingHistoryMode.set(historyKey(opts.threadId, id), "full");
    live.read[opts.threadId] = seedCursor("full", threadLog(opts.boardId, opts.threadId));
    persistSessionState(live);
  }
  // Drop the worker card (+ member:open edge for a thread worker), positioned by the SERVER beside the
  // anchor node — the human should SEE the summoned worker, and agents place cards badly. maybeAnnounceMembership
  // (fired by the addEdge) onboards a thread worker and re-fills its seat from the card name.
  const records = boardSnapshotRecords(opts.boardId);
  const role = opts.roleId ? readRole(opts.repoPath, opts.roleId) : null;
  const node = `node:live:${id}`;
  const nodePayload: Record<string, unknown> = {
    id: node, type: "session", title: id, color: role?.colour ?? "blue",
    ...placeWorkerCard(records, opts.anchorNodeId),
  };
  if (role?.name) nodePayload.name = `${role.name}.${id.slice(0, 8)}`;
  dispatchBusCommand(opts.boardId, { type: "addNode", actor: "system", payload: nodePayload }, opts.origin);
  if (opts.threadId)
    dispatchBusCommand(
      opts.boardId,
      { type: "addEdge", actor: "system", payload: { id: `edge:member:${id}:${opts.threadId}`, from: node, to: opts.threadId, type: "member:open" } },
      opts.origin,
    );
  sendSessionInput(id, opts.firstPrompt);
  return id;
}

// The doc worker's first-turn brief: service the doc's open-annotation queue, loop-until-dry, wind down.
// Its own session id is baked into the collab brief (ensureLiveSession), so `<your session id>` resolves.
function docWorkerBrief(rel: string, origin: string): string {
  return (
    `[canvas] You are an auto-spawned DOC WORKER for \`${rel}\`. Activity landed on this doc's annotations and needs servicing.\n` +
    `- Read the open queue: \`scripts/canvas anno list ${rel}\` (or GET http://${origin}/api/annotations?path=${encodeURIComponent(rel)}).\n` +
    `- For each ANSWERED question (a human decided): apply the decision by editing the doc, then RESOLVE the question (resolution belongs to the asker — you).\n` +
    `- For each open COMMENT (note) meant for you: reply and make the change it asks for.\n` +
    `- LEAVE questions still AWAITING a human — you can't answer those; don't touch or resolve them.\n` +
    `- Re-read the queue after each pass so a comment that arrived mid-work is caught; LOOP until nothing actionable remains.\n` +
    `- Then WIND DOWN: POST http://${origin}/api/session/<your session id>/done. Don't linger idle — batch this wake and exit; fresh activity will spawn a new worker.`
  );
}

// The dormant-seat reconstitution brief: a FRESH session standing back up an addressed-but-vacant seat.
function dormantWakeBrief(handle: string, origin: string): string {
  return (
    `[canvas] You've been RECONSTITUTED as the \`${handle}\` seat on this thread — a message was addressed to you while the prior session had wound down. This is a FRESH session seeded from the thread's durable history (NOT a resume): read the thread to catch up.\n` +
    `- Read your inbox: GET http://${origin}/api/inbox?session=<your session id> — the message addressed to you is there (the full backlog replays on this first read).\n` +
    `- Read the thread, then respond to what was asked and continue the seat's work.\n` +
    `- Leave anything you need in the thread before you wind down — a fresh session can't recover your process state.\n` +
    `- When your part is done: POST http://${origin}/api/session/<your session id>/done.`
  );
}

// Trigger 1 — DOC-WAKE. Called after a qualifying annotation write (a `note` comment, or an `answer` on a
// question). If any active watcher's level clears the event (auto-wake.js reuses W4's wakesSeat), service the
// doc: NUDGE a live worker already on it (R1 keep-alive continuity — a comment within its idle window
// continues it, no duplicate) or spawn a fresh one. Single-flight per doc; the worker loops-until-dry.
function maybeWakeDocWorker(boardId: string, repoPath: string, origin: string, rel: string, eventKind: "note" | "answer" | "suggestion"): void {
  const qualifying = qualifyingWatchers(readWatchers(repoPath, rel), eventKind);
  if (qualifying.length === 0) return; // no watcher this activity would wake — nothing to do
  const key = docSurfaceKey(rel);
  const claimant = surfaceClaimant(key);
  if (claimant) {
    const s = liveSessions.get(claimant);
    if (s && s.status !== "exited") {
      // A worker is already servicing this doc — nudge it to re-check rather than spawn a duplicate.
      sendSessionInput(
        claimant,
        `[canvas] new annotation activity on ${rel} — re-check the open queue (\`scripts/canvas anno list ${rel}\`) and keep servicing it; POST /api/session/<your session id>/done when the queue is dry.`,
      );
      return;
    }
    releaseSurface(key, claimant); // stale claim (worker gone) — clear it and spawn fresh below
  }
  // The worker runs as the first qualifying watcher whose role is a real charter'd role; else bare (the
  // ask-armed watcher's reserved handle isn't a role, so an answer-driven wake spawns a plain doc worker).
  let roleId: string | null = null;
  for (const w of qualifying) if (readRole(repoPath, w.role)) { roleId = w.role; break; }
  serverSpawnWorker({
    boardId, repoPath, origin, roleId, threadId: null, anchorNodeId: `node:repo:${rel}`,
    claimKey: key, firstPrompt: docWorkerBrief(rel, origin),
  });
}

// Trigger 2 — DORMANT-SEAT RESPAWN (R1). Called from wakeThreadMembers when an @-addressed member has no
// live session. Reconstitute the seat: read the dormant occupant's role from its marker, spawn fresh into
// the thread, and re-occupy the SAME seat with the new sid. Single-flight per seat; a bare (unseated)
// dormant member has no reconstitution identity, so it's left as a dropped nudge (unchanged behaviour).
function maybeRespawnDormantSeat(boardId: string, threadId: string, dormantSid: string, origin: string, meta: ThreadMetaMarker | null): void {
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return;
  const handle = seatForSid(meta?.seats, dormantSid);
  if (!handle) return; // a plain sid participant, not a seated role — nothing durable to stand back up
  const key = seatSurfaceKey(threadId, handle);
  if (isSurfaceClaimed(key)) return; // already being reconstituted — don't race a second worker onto the seat
  const roleId = (readCanvasSession(repoPath, dormantSid)?.roleId as string | undefined) ?? null;
  const newSid = serverSpawnWorker({
    boardId, repoPath, origin, roleId, threadId, anchorNodeId: threadId,
    claimKey: key, firstPrompt: dormantWakeBrief(handle, origin),
  });
  // Re-occupy the seat immediately with the fresh sid so the next addressed message finds it live/claimed
  // (onboarding also fills it from the card name; fillSeat is idempotent on the same sid).
  if (newSid) fillSeat(repoPath, threadId, handle, newSid, Date.now());
}

// The R1 keep-alive reaper: an auto-wake worker that's been idle past the grace window is wound down (its
// seat/doc goes dormant; the next qualifying activity respawns fresh). Only auto-wake workers are eligible —
// never a human card, never the looping Coordinator. Runs on the loop heartbeat's cadence (loopTick).
function autoWakeReapTick(): void {
  const now = Date.now();
  for (const s of liveSessions.values()) {
    if (!shouldReapIdle(s, now, IDLE_KEEPALIVE_MS)) continue;
    console.warn(
      `[auto-wake] reaping idle worker ${s.id} (idle ${Math.round((now - s.idleSince!) / 1000)}s ≥ ` +
        `${IDLE_KEEPALIVE_MS / 1000}s keep-alive) — winding down; next activity respawns fresh`,
    );
    endSession(s.id, "done");
  }
}

// The standing-job worker's first-turn brief (R6, W6). The job's `instruction` is the payload; the framing
// enforces the two R6 norms explicitly — "skip days with nothing" is INSTRUCTED here (a periodic job that
// finds nothing must post NOTHING and wind down, or it becomes per-interval "all clear" noise — silence has
// to be told, not assumed), and the worker is told it's a FRESH session (never a resume) so it reads the
// thread for context rather than expecting recovered process state.
function standingJobBrief(job: { instruction: string; role: string | null }, origin: string): string {
  return (
    `[canvas] You are an auto-spawned STANDING-JOB WORKER — a scheduled job on this thread fired on its interval. ` +
    `This is a FRESH session (NOT a resume); read the thread first if you need context: ` +
    `GET http://${origin}/api/inbox?session=<your session id>.\n` +
    `YOUR SCHEDULED INSTRUCTION:\n${job.instruction}\n\n` +
    `- Do exactly what the instruction says. Leave any real finding as a thread message BEFORE you wind down ` +
    `(a fresh session can't recover your process state).\n` +
    `- **If there is NOTHING to do, post NOTHING and wind down immediately.** A periodic job that finds nothing ` +
    `must be SILENT — do NOT post "nothing to report" / "all clear" noise. Silence is the correct output of an ` +
    `empty run ("skip days with nothing").\n` +
    `- When done (whether you acted or found nothing): POST http://${origin}/api/session/<your session id>/done.`
  );
}

// The standing-job NUDGE: the cheap wake for a job whose target session is STILL LIVE (a role-seat job
// firing at an interval shorter than the 5-min keep-alive window). Reuses the live session's assembled
// context — the sendSessionInput nudge path the loop heartbeat uses — rather than paying a fresh respawn's
// context-reassembly cost. The instruction rides the nudge inline (unlike a content-free wake).
function standingJobNudge(job: { instruction: string }, origin: string): string {
  return (
    `[canvas] ⏱ STANDING JOB — your scheduled tick (not a human message). YOUR INSTRUCTION:\n${job.instruction}\n\n` +
    `- Do exactly what it says. **If there's nothing to do, post NOTHING** ("skip days with nothing") — no "all clear" noise.\n` +
    `- Then go back to sleep (stay live for the next tick). Read your inbox first if you need context: ` +
    `GET http://${origin}/api/inbox?session=<your session id>.`
  );
}

// Trigger 3 — STANDING JOBS (R6, W6). The server-fired timer half of the wakeable substrate: every loop
// heartbeat, fire the standing jobs that have come due across every board's threads. WAKE-LIVE-ELSE-RESPAWN
// (the efficiency norm — human's W6 concern, seq 104): a role-seat job whose seat is still occupied by a LIVE
// session NUDGES that session (cheap — context intact), and only a DORMANT target pays a fresh respawn via the
// serverSpawnWorker primitive (the same path doc-wake and dormant-seat respawn ride). This makes the
// "<5min ⇒ wake existing / >5min ⇒ full respawn" split FALL OUT of the 5-min keep-alive window automatically:
// a short interval finds the occupant still alive (nudge); an interval past keep-alive finds it reaped
// (respawn). SINGLE-FLIGHT: a job whose prior fire is still running (its surface claimed, or the live occupant
// mid-turn) is SKIPPED this tick and retried next — no double-fire, never talk over a working session.
// FIRE-NEXT-DUE: stampFired re-bases the schedule to now only on a REAL fire, so a boot-time overdue job fires
// once (never replaying missed fires) and a cap-skipped / busy-skipped fire retries next tick. Jobs live on
// the thread marker, so they survive their creator and a restart.
function standingJobsTick(): void {
  const now = Date.now();
  for (const [boardId, board] of boards) {
    let threads;
    try {
      threads = listThreads(board.repoPath);
    } catch {
      continue;
    }
    for (const t of threads) {
      for (const job of dueJobs(readJobs(board.repoPath, t.threadId), now)) {
        const key = jobClaimKey(t.threadId, job);
        if (isSurfaceClaimed(key)) continue; // a prior fire's worker still servicing this surface — no double-fire

        // Role-seat job (incl. the migrated Coordinator heartbeat): prefer waking a LIVE occupant over a fresh
        // respawn (the efficiency norm). Resolve the seat's current sid and let planRoleJobFire decide from its
        // liveness — "nudge" a live+idle occupant (cheap), "skip" a mid-turn one WITHOUT stamping (so the fire
        // lands the moment it's idle), "respawn" a dormant/absent one. A bare (roleless) job always respawns.
        if (job.role) {
          const sid = readThreadMeta(board.repoPath, t.threadId)?.seats?.[job.role]?.sid;
          const live = typeof sid === "string" ? liveSessions.get(sid) : undefined;
          const plan = planRoleJobFire(live?.status ?? null);
          if (plan === "skip") continue; // mid-turn occupant — don't interrupt; retry next tick (no stamp)
          if (plan === "nudge") {
            sendSessionInput(live!.id, standingJobNudge(job, lastKnownOrigin), { keepWaitingOn: true });
            stampFired(board.repoPath, t.threadId, job.id, now);
            continue;
          }
          // plan === "respawn" → fall through to the fresh spawn below
        }
        // Dormant target (or a bare job) → a full fresh respawn seeded from the durable record.
        const newSid = serverSpawnWorker({
          boardId,
          repoPath: board.repoPath,
          origin: lastKnownOrigin,
          roleId: job.role ?? null,
          threadId: t.threadId,
          anchorNodeId: t.threadId,
          claimKey: key,
          firstPrompt: standingJobBrief(job, lastKnownOrigin),
        });
        // Only re-base the schedule on a REAL spawn: a cap-skipped fire (newSid null — serverSpawnWorker
        // already logged it) leaves lastFiredAt untouched so it re-fires next tick, no silent drop.
        if (newSid) stampFired(board.repoPath, t.threadId, job.id, now);
      }
    }

    // Doc standing jobs (doc-jobs.js) — the SAME server-fired timer on a DOC's marker. One surface per doc
    // (docJobClaimKey = docSurfaceKey), so a timer-fired doc worker and an annotation-driven doc-wake worker
    // mutually exclude (the "one worker per doc's open queue" model). Structure mirrors maybeWakeDocWorker's
    // claimant handling AND the thread job's mid-turn skip: a LIVE claimant on the doc surface is nudged
    // (cheap — it's already on the doc) unless mid-turn (retry next tick, no stamp); a dead/absent claimant
    // is respawned fresh. Same fire-next-due / single-flight guarantees as the thread half.
    let docPaths: string[];
    try {
      docPaths = listDocsWithJobs(board.repoPath);
    } catch {
      docPaths = [];
    }
    for (const rel of docPaths) {
      for (const job of dueJobs(readDocJobs(board.repoPath, rel), now)) {
        const key = docJobClaimKey(rel);
        const claimant = surfaceClaimant(key);
        if (claimant) {
          const s = liveSessions.get(claimant);
          if (s && s.status !== "exited") {
            if (s.status !== "idle") continue; // mid-turn — don't interrupt; retry next tick (no stamp)
            sendSessionInput(claimant, standingJobNudge(job, lastKnownOrigin), { keepWaitingOn: true });
            stampDocFired(board.repoPath, rel, job.id, now);
            continue;
          }
          releaseSurface(key, claimant); // stale claim (worker gone) — clear it and respawn fresh below
        }
        const newSid = serverSpawnWorker({
          boardId,
          repoPath: board.repoPath,
          origin: lastKnownOrigin,
          roleId: job.role ?? null,
          threadId: null, // a doc worker: no member:open edge, positioned beside the doc card
          anchorNodeId: `node:repo:${rel}`,
          claimKey: key,
          firstPrompt: standingJobBrief(job, lastKnownOrigin),
        });
        if (newSid) stampDocFired(board.repoPath, rel, job.id, now);
      }
    }
  }
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
  denySessionPermissions(id, `the session was ${endReason} before a human decided`);
  if (s.autoWakeKey) releaseSurface(s.autoWakeKey, s.id); // free its single-flight surface immediately
  s.endReason = endReason;
  recordSessionEnd(s.repoPath, id, endReason);
  s.proc.kill();
  s.status = "exited";
  s.inflight = null;
  s.verb = null;
  publishSession(s);
  liveSessions.delete(id);
  return true;
}

// ── Permission prompts: the relay's held POST + the card's decision buttons ──────────────────────────
// The server half of --permission-prompt-tool (see PERMISSION_HOLD_MS at the top): the per-session MCP
// relay POSTs each would-prompt permission check here and the connection PARKS until a human clicks
// allow/deny on the session card (or the hold times out → an honest fail-closed deny). The pending set
// rides the session's feed (`permissions`) so the card paints buttons + the loud waiting band, and
// /api/sessions' status derives "waiting" from it (sessionStatus) so the minimap/list/stack agree.

// Resolve one parked relay POST exactly once (decision, timeout, or teardown), clearing its timer and
// registry entry and repainting the card (the pending block + waiting band live on the session feed).
function settlePermission(permId: string, payload: Record<string, unknown>): void {
  const p = pendingPermissions.get(permId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingPermissions.delete(permId);
  try {
    sendJson(p.res, 200, payload);
  } catch {
    /* relay disconnected — the CLI already gave up on this prompt; nothing left to answer */
  }
  const s = liveSessions.get(p.sid);
  if (s) publishSession(s);
}

// Deny every prompt a session still holds — the teardown path (terminate/done/exit). The human can no
// longer meaningfully answer, and a relay still waiting should hear an honest reason, not a hangup.
function denySessionPermissions(sid: string, message: string): void {
  for (const p of [...pendingPermissions.values()])
    if (p.sid === sid) settlePermission(p.permId, { behavior: "deny", message });
}

// POST /api/permission/request { session, toolName, input, toolUseId? } — the MCP relay's held call.
// Only a LIVE registry session may hold a prompt (404 otherwise — the relay turns that into its own
// fail-closed deny). No sendJson on the success path: the response parks until /decision or timeout.
async function handlePermissionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { session?: unknown; toolName?: unknown; input?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.session !== "string" || !body.session) return sendJson(res, 400, { error: "missing session" });
  if (typeof body.toolName !== "string" || !body.toolName) return sendJson(res, 400, { error: "missing toolName" });
  const s = liveSessions.get(body.session);
  if (!s || s.status === "exited") return sendJson(res, 404, { error: "not a live canvas session" });
  const permId = crypto.randomUUID();
  const timer = setTimeout(
    () =>
      settlePermission(permId, {
        behavior: "deny",
        message:
          `no human decision within ${Math.round(PERMISSION_HOLD_MS / 60_000)} minutes — denied by default. ` +
          "The human never saw or refused this; retry when they're around, or post in your thread.",
      }),
    PERMISSION_HOLD_MS,
  );
  pendingPermissions.set(permId, { permId, sid: s.id, toolName: body.toolName, input: body.input ?? {}, ts: Date.now(), res, timer });
  // The relay side can drop first (claude killed mid-hold, or its MCP tool timeout fired despite our
  // margin): un-park without answering, so the card doesn't keep offering a decision nobody is owed.
  // Fires on the success path too (every response's socket eventually closes) — the map guard makes
  // that a no-op because settlePermission already removed the entry.
  res.on("close", () => {
    const gone = pendingPermissions.get(permId);
    if (!gone || gone.res !== res) return;
    clearTimeout(gone.timer);
    pendingPermissions.delete(permId);
    const live = liveSessions.get(gone.sid);
    if (live) publishSession(live);
  });
  publishSession(s); // paint the prompt (and flip the band to waiting) immediately
}

// POST /api/permission/<permId>/decision { behavior: "allow"|"deny", message? } — the card's buttons
// (or a shell twin via /api/permissions). Allow echoes the tool input back unchanged (updatedInput is
// the CLI's contract); deny carries the human's message when given.
async function handlePermissionDecision(req: IncomingMessage, res: ServerResponse, permId: string): Promise<void> {
  let body: { behavior?: unknown; message?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (body.behavior !== "allow" && body.behavior !== "deny")
    return sendJson(res, 400, { error: 'behavior must be "allow" or "deny"' });
  const p = pendingPermissions.get(permId);
  if (!p) return sendJson(res, 404, { error: "no such pending permission (already decided or timed out)" });
  settlePermission(
    permId,
    body.behavior === "allow"
      ? { behavior: "allow", updatedInput: p.input }
      : {
          behavior: "deny",
          message:
            typeof body.message === "string" && body.message
              ? body.message
              : "denied by the human on the canvas card",
        },
  );
  sendJson(res, 200, { ok: true, id: permId, behavior: body.behavior });
}

// GET /api/permissions[?session=<sid>] — the pending prompts, board-wide or per session: the headless
// twin of the card's block, so a shell can see (and answer, via /decision) prompts without a tab.
function handlePermissionsRead(res: ServerResponse, sid: string | null): void {
  const permissions = [...pendingPermissions.values()]
    .filter((p) => !sid || p.sid === sid)
    .sort((a, b) => a.ts - b.ts)
    .map((p) => ({ id: p.permId, session: p.sid, toolName: p.toolName, input: p.input, ts: p.ts }));
  sendJson(res, 200, { permissions, count: permissions.length });
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
const shadowRoots = (fsState.shadowRoots ??= new Map<string, ShadowRootHandle>()); // key: boardId\0rootId — pinned:
// an unpinned map emptied on hot re-eval while boardFeedsStarted kept syncShadowRoots from refilling it,
// so every session spawned after a re-eval lost attribution to the `external` floor (see fsState rule).
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
  const rel = path.relative(best.path, abs);
  // Agent worktrees (`spawn --worktree`) live under the board's `.canvas/worktrees/` and are their OWN real
  // git checkouts — they reach main via merge-on-green, never the shadow ledger. listWorktrees excludes them
  // from boardRoots, so an edit inside one has no committer of its own and falls through to the canonical
  // repo root, yielding rel = `.canvas/worktrees/<key>/…`. Staging that with `git add` in the canonical
  // work-tree hits the nested checkout's gitlink boundary ("is in submodule"). Never shadow-attribute it.
  const wtHome = path.join(".canvas", "worktrees");
  if (rel === wtHome || rel.startsWith(wtHome + path.sep)) return null;
  const key = boardId + "\0" + best.id;
  const handle = shadowRoots.get(key);
  return handle ? { key, rel, handle } : null;
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
  startRolesFeed(boardId, repoPath); // live-push the roles-list rail as roles are created/edited
  syncShadowRoots(boardId, repoPath); // shadow-git committer per root + boot-reconcile (step 1)
  startLoopHeartbeat(); // global, idempotent — wakes looping-role (Coordinator) sessions to sweep for stalls
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
// validated mutation surface a gesture uses, attributed by `actor`. The READ side is served from the
// durable board store (`.canvas/board/` — board-persist.js): the browser's debounced persistence save
// is the one snapshot write path, and GET /api/canvas reads it back with the recent intent derived
// from the event log. (The old second pipe — agentBus pushing a near-identical snapshot to POST
// /api/canvas just for this read — is retired; reads now work with NO tab live, so the response
// carries `tabs` as the liveness signal instead of the old 404.)
//
// PER BOARD (Phase 3): every endpoint takes ?board=<boardId> (default board if omitted). Each board is
// its own bus — a command for board X reaches only the tabs showing X, and X's snapshot is read back
// independently. So `busClients` is a Set PER board; 503 (delivered=0) is judged against THAT board's
// connected tabs, not all of them.
//
//   GET  /api/bus?board=     → text/event-stream of Command frames (a board's tabs subscribe)
//   POST /api/command?board= → { type, payload?, actor? } forwarded to that board's connected tabs
//   GET  /api/canvas?board=  → { ts, tabs, snapshot, recentIntent } from the durable store; 404 only
//                              when the board has never persisted anything

const busClients = (fsState.busClients ??= new Map<string, Set<SseClient>>());

// The bus-client set for a board, created on first subscribe. (The SSE close handler in openSse deletes
// the client from the set but leaves the empty set in the map — harmless; one entry per ever-seen board.)
function busClientsFor(boardId: string): Set<SseClient> {
  let set = busClients.get(boardId);
  if (!set) busClients.set(boardId, (set = new Set<SseClient>()));
  return set;
}

// How many tabs can ACT on this board right now — the same census dispatchBusCommand's `delivered` is
// judged against (the app's tabs ride /api/ws; the SSE set is the compat path). The `tabs` liveness
// signal on GET /api/canvas.
function tabCountFor(boardId: string): number {
  return (busClients.get(boardId)?.size ?? 0) + [...wsClients].filter((c) => c.boardId === boardId).length;
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

// T3c helper: tear down every edge touching `nodeId` before its removeNode lands. Emits a removeEdge over
// the bus for each connected edge (connectedEdgeIds off the durable snapshot) so the cascade is server-
// authoritative, and — for a session card — also drops its member edges from the emitted-membership bridge,
// including any join still inside the ~400ms save window (the snapshot wouldn't list those yet). Idempotent:
// re-removing an edge the store already dropped is a no-op.
function cascadeNodeEdges(boardId: string, nodeId: string, actor: string, origin: string): void {
  const records = boardSnapshotRecords(boardId) ?? [];
  const ids = new Set(connectedEdgeIds(records, nodeId));
  const sid = nodeSessionId(records, nodeId);
  if (sid)
    for (const [edgeId, m] of emittedMembers)
      if (m.sid === sid) {
        ids.add(edgeId);
        emittedMembers.delete(edgeId); // clear the bridge even with no live tab to apply the removeEdge
      }
  for (const id of ids) dispatchBusCommand(boardId, { type: "removeEdge", actor, payload: { id } }, origin);
}

async function handleCommand(req: IncomingMessage, res: ServerResponse, boardId: string, origin: string): Promise<void> {
  let cmd: { type?: unknown; payload?: unknown; actor?: unknown };
  try {
    cmd = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof cmd.type !== "string") return sendJson(res, 400, { error: "missing command type" });
  // T3c: a removeNode CASCADES its edges server-side, so "delete edges before nodes" is no longer a rule the
  // operator carries. The browser store already tears a node's wires down (core removeNode), but re-deriving
  // the edge set here and emitting a removeEdge for each FIRST makes the cascade client-independent and — the
  // part only the server owns — lets us clear the in-memory emitted-membership bridge, so a deleted session
  // card stops counting as a thread member at once rather than after the 60s TTL.
  if (cmd.type === "removeNode") {
    const nodeId = typeof (cmd.payload as { id?: unknown } | undefined)?.id === "string" ? String((cmd.payload as { id: string }).id) : null;
    if (nodeId) cascadeNodeEdges(boardId, nodeId, typeof cmd.actor === "string" ? cmd.actor : "system", origin);
  }
  // Broadcast to the board's tabs (+ fire the membership announce if it's a member:* edge). delivered=0
  // tells the agent no tab for THIS board is listening — the command went nowhere.
  const delivered = dispatchBusCommand(boardId, cmd as { type: string; payload?: Record<string, unknown>; actor?: string }, origin);
  sendJson(res, delivered > 0 ? 200 : 503, { ok: delivered > 0, delivered, board: boardId });
}

// The member:* edges of a snapshot's records, id → {from,to,type}. The diff source for
// announceNewMemberships (null/absent records → empty map — read as "no membership edges", the safe
// direction: a real change re-saves a whole snapshot ~400ms later).
function memberEdgesOf(records: Array<Record<string, unknown>> | null | undefined): Map<string, { from: string; to: string; type: string }> {
  const out = new Map<string, { from: string; to: string; type: string }>();
  for (const r of records ?? [])
    if (r.typeName === "edge" && typeof r.type === "string" && r.type.startsWith("member:") && typeof r.id === "string")
      out.set(r.id, { from: String(r.from), to: String(r.to), type: r.type });
  return out;
}

// Onboarding's SECOND trigger. The first is dispatchBusCommand, which fires for an agent-initiated POST
// join/invite. But a HUMAN-drawn join/accept/leave (connect = join, the edge popover) is a LOCAL
// editor.commit that never crosses the bus — it reaches the server only as the debounced durable
// snapshot save (remote-store.ts → /api/board/persist/snapshot, which calls this with the snapshot it
// just replaced and the one it wrote). So diff the membership edges before↔after and replay each
// transition through maybeAnnounceMembership exactly as the matching bus addEdge/removeEdge would. The
// per-(edge,phase) dedup makes the overlap with the bus path harmless: an agent POST also re-saves the
// snapshot moments later, and that second sighting no-ops. `before == null` means the board's FIRST
// ever snapshot (brand-new or just-imported board) — a BASELINE, not a wave of joins: record its edges
// as already-announced without onboarding. A server restart needs no such special case any more: the
// durable before-snapshot survives it, so the first post-restart save diffs against real state.
function announceNewMemberships(
  boardId: string,
  before: Array<Record<string, unknown>> | null,
  after: Array<Record<string, unknown>> | null,
  origin: string,
): void {
  const afterEdges = memberEdgesOf(after);
  if (before == null) {
    for (const [id, e] of afterEdges) announcedMemberships.add(announceKey(id, e.type));
    return;
  }
  const beforeEdges = memberEdgesOf(before);
  for (const [id, e] of afterEdges) {
    if (beforeEdges.get(id)?.type === e.type) continue; // unchanged phase — already onboarded (or baseline-seeded)
    maybeAnnounceMembership(boardId, { type: "addEdge", payload: { id, from: e.from, to: e.to, type: e.type } }, origin);
  }
  for (const [id, e] of beforeEdges) {
    if (afterEdges.has(id)) continue;
    maybeAnnounceMembership(boardId, { type: "removeEdge", payload: { id } }, origin); // clear dedup → a rejoin re-announces
    // Decouple the CARD (a view) from MEMBERSHIP (durable). A member:open edge can vanish two ways:
    //   • the session's CARD was deleted — its node is ALSO gone from `after` → KEEP the membership (the
    //     session stays logged + wakeable, just cardless: the delete-card-keep-session fix).
    //   • a real LEAVE — the card still stands, only the edge was disconnected → DROP the membership.
    // The node's presence in `after` is the honest discriminator (the /leave endpoint drops it directly).
    if (e.type === "member:open") {
      const nodeGone = !(after ?? []).some((r) => r.typeName === "node" && r.id === e.from);
      const sid = sidFromSessionNode(e.from);
      if (!nodeGone && sid) forgetDurableMember(boards.get(boardId)?.repoPath, e.to, sid);
    }
  }
}

// The agents' board read, served from the DURABLE store (unification: the browser used to push a
// second, near-identical snapshot here just for this read — retired; remote-store.ts's persistence
// save is the one write path now). `tabs` is the liveness signal: a successful read no longer implies
// a live tab (that was the old 404's meaning), and a WRITE still needs one — check `tabs`/`delivered`
// before treating the board as actionable. 404 only for a board with nothing persisted yet.
function handleCanvasGet(res: ServerResponse, boardId: string): void {
  const b = boards.get(boardId);
  if (!b) return sendJson(res, 400, { error: "unknown board" });
  const { events, snapshot } = readBoardPersist(b.repoPath);
  if (!snapshot && events.length === 0)
    return sendJson(res, 404, { error: "no board state persisted yet" });
  sendJson(res, 200, {
    ts: boardPersistMtime(b.repoPath),
    tabs: tabCountFor(boardId),
    snapshot: snapshot ?? { records: [], version: 0 },
    recentIntent: describeBoardEvents(events),
  });
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
const lastNotebookOutputs = (fsState.lastNotebookOutputs ??= new Map<string, string>()); // key: boardId \0 nodeId → the pushed blob
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
//   POST /api/thread/<threadId>/pin     ?board=  { from, seq, pinned? } — flag/unflag a message as head context (R-PIN)
//   GET  /api/inbox ?session=<sid>                            — read this session's unread thread messages (+ pins)
// join/leave/invite are server-fulfilled by EMITTING the addEdge/removeEdge over the bus, so the agent
// never has to construct node/edge ids — it works in thread ids + its own sid only.

interface SnapNode {
  typeName: "node";
  id: string;
  type: string;
  title: string;
  text?: string; // a thread node's `text` is its (optional) task brief
}

// The records of a board's DURABLE snapshot (`.canvas/board/snapshot.json` — the same one hydrate
// serves), or null if the board has never saved one. Used for all server-side node/edge resolution
// (thread membership, session-card lookup, spawn positioning); it no longer needs a live tab, only a
// board that has persisted at least once. Lags a just-committed change by the ~400ms save debounce —
// the same window the old tab-push had.
function boardSnapshotRecords(boardId: string): Array<Record<string, unknown>> | null {
  const b = boards.get(boardId);
  if (!b) return null;
  const snap = readBoardSnapshot(b.repoPath) as { records?: Array<Record<string, unknown>> } | null;
  return snap?.records ?? null;
}

// T3b: block a join until its member:open edge lands in the DURABLE snapshot — poll the saved records for
// the edge id until it appears or the deadline passes. The tab applies the addEdge then persists on a
// ~400ms debounce, so a caller that messages/asks the instant /join returns would otherwise race that save
// and 403 ("not a member") off a snapshot that doesn't list the edge yet. Bounded and returns false (rather
// than hanging the request) on timeout — the in-memory emitted-membership bridge still covers the window,
// so a timeout degrades to the old best-effort behaviour, never a broken join. Kept well under the agent's
// Bash/curl timeout.
const JOIN_PERSIST_TIMEOUT_MS = 5000;
const JOIN_PERSIST_POLL_MS = 75;
async function waitForEdgePersisted(boardId: string, edgeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = boardSnapshotRecords(boardId);
    if (recs && recs.some((r) => r.typeName === "edge" && r.id === edgeId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, JOIN_PERSIST_POLL_MS));
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
  // Durable members whose session card was deleted keep their membership (the card was only a view) — a
  // surviving member here with no edge is exactly the delete-card-keep-session case.
  for (const sid of durableMembers.get(threadId) ?? []) if (!out.includes(sid)) out.push(sid);
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
  const clients = busClients.get(boardId); // SSE compat path — the app's tabs ride /api/ws now
  const sockets = [...wsClients].filter((c) => c.boardId === boardId);
  const delivered = (clients?.size ?? 0) + sockets.length;
  const frame = `data: ${JSON.stringify(cmd)}\n\n`;
  if (clients) for (const c of clients) c.res.write(frame);
  for (const c of sockets) c.send({ ch: "bus", cmd });
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
const announcedMemberships = (fsState.announcedMemberships ??= new Set<string>());
const announceKey = (id: string, type: string): string => `${id}|${type}`;

// How much of the backlog a not-yet-onboarded member should see, keyed `<threadId>|<sid>`. Set by an
// invite/join (or the /history action) that names a mode; consumed + cleared when member:open onboarding
// seeds the read cursor. ABSENT ⇒ the default, FULL history — a new member replays the whole backlog on
// their first inbox read (Slack public-channel style). "future" is the opt-out (start at the tail).
const pendingHistoryMode = (fsState.pendingHistoryMode ??= new Map<string, "full" | "future">());
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
    // Record the DURABLE membership on EVERY sighting (idempotent), ahead of the onboarding dedup: this is
    // the single funnel every join path reaches — a bus addEdge (spawn/join/invite-accept) AND a human-drawn
    // join replayed here from the snapshot diff. The membership now outlives the card/edge (deleting the card
    // removes the view, not this record); it's dropped only by a real leave (announceNewMemberships / /leave).
    recordDurableMember(boards.get(boardId)?.repoPath, thread.id, sid, Date.now());
    if (announcedMemberships.has(announceKey(String(p.id), type))) return;
    announcedMemberships.add(announceKey(String(p.id), type));
    const others = threadMemberSids(records, thread.id).filter((m) => m !== sid);
    const roster = [sid, ...others].join(", ");
    // full (the default) → the joiner's first inbox read replays the whole backlog; future → only new ones.
    const mode = pendingHistoryMode.get(historyKey(thread.id, sid)) ?? "full";
    pendingHistoryMode.delete(historyKey(thread.id, sid));
    const log = threadLog(boardId, thread.id);
    const backlog =
      log.length && mode === "full"
        ? ` (${log.length} earlier message${log.length === 1 ? "" : "s"} to read${log.length > 60 ? "; for a long backlog window the tail with ?bytes=20000 or ?limit=40" : ""})`
        : "";
    sendSessionInput(
      sid,
      `[canvas] You joined thread ${thread.id} "${title}".\n${descLine}members: ${roster}\n` +
        `post: POST ${base}/api/thread/${thread.id}/message {"text":"…","from":"${sid}"} — a post is LOGGED for all but only WAKES the members you @-tag (by an id prefix, e.g. @${sid.slice(0, 8)}; @all = everyone; no tag = nobody is woken)\n` +
        `consult one member and block for the answer: POST ${base}/api/thread/${thread.id}/ask {"to":"<sid>","text":"…","from":"${sid}"}\n` +
        `declare your work-intent (card-only, wakes no one): POST ${base}/api/thread/${thread.id}/intent {"from":"${sid}","intent":"working"|"blocked:human"|"blocked:peer"|"done","note":"…"} — declare blocked:human when you ask the human and stop, done when your part is finished; a "done" should carry a thread message with PROOF against the pinned Done-when condition (R5)\n` +
        `pin a message as head context (re-read every wake): POST ${base}/api/thread/${thread.id}/pin {"from":"${sid}","seq":<n>,"pinned":true} — pin the task statement + the Done-when condition; unpin with pinned:false. /inbox returns a thread's pins under \`pinned\`\n` +
        `you'll be NUDGED only when a peer @-tags or /asks you; read messages with GET ${base}/api/inbox?session=${sid}, pending asks with GET ${base}/api/asks?session=${sid}${backlog}`,
    );
    if (others.length) {
      appendThreadMsg(boardId, thread.id, "system", `${sid} joined the thread. members now: ${roster}.`);
      wakeThreadMembers(boardId, thread.id, sid, { broadcast: true }); // a join is a room event — reaches level-`all` seats
    }
    const js = liveSessions.get(sid);
    if (js) {
      js.read[thread.id] = seedCursor(mode, log);
      persistSessionState(js);
    }
    // Seat (§5): a role-spawned joiner FILLS its role's seat on this thread — created on first join,
    // re-occupied (same seat, new sid) when a fresh session of the role arrives AFTER the prior occupant
    // exited (the respawn re-fill). The role rides the session card's `name` ("RoleName.<short-sid>"); a
    // plain unnamed session takes no seat (it stays a sid-identified participant). 1:1 with roles until
    // labelled multiplicity ships. LIVE-OCCUPANCY GUARD: if the seat is still held by a LIVE session of the
    // same role, the joiner must NOT displace it — fillSeat returns `blocked` and we onboard it SEATLESS,
    // telling it who holds the seat (fixes the two-Coordinator seat-theft; the departed-occupant re-fill
    // still works because an exited holder fails the liveness predicate).
    const name = sessionNameForSid(records, sid);
    if (name) {
      const role = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
      const repoPath = boards.get(boardId)?.repoPath;
      if (role && repoPath) {
        const r = fillSeat(repoPath, thread.id, role, sid, Date.now(), isSidLive);
        if (r.blocked)
          sendSessionInput(
            sid,
            `[canvas] The ${role} seat on thread ${thread.id} is held by a live session (${r.heldBy}); ` +
              `you joined SEATLESS (a sid-identified member). @${role} mentions still route to the seated ${role}.`,
          );
      }
    }
  }
}

async function handleThreadMessage(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; text?: unknown; force?: unknown };
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

  // W11 — mention-gated CAS guard (compare-and-swap on the poster's read cursor). A live SESSION poster may
  // not post over a message that @-mentioned it and still sits unread past its cursor: it must read the
  // thread first (structurally, not just by norm). Exempt a non-session `from` (the human at the card sees
  // the whole thread), and honor an explicit `force:true` override. The 409 hands back the blocking unread
  // so one read-then-repost clears it (no archaeology — the poster GETs /api/inbox to advance its cursor,
  // then reposts). Card-only intents/pins go through their own handlers, so this path is real messages only.
  const posting = liveSessions.get(from);
  if (posting && body.force !== true) {
    const memberEntries = members.map((sid) => ({ sid, name: sessionNameForSid(records, sid) }));
    const blocking = unreadMentions({
      log: threadLogs.get(threadId) ?? [],
      cursor: posting.read[threadId] ?? 0,
      from,
      members: memberEntries,
    });
    if (blocking.length)
      return sendJson(res, 409, {
        error: "unread @-mention: read the thread (GET /api/inbox) before posting, or pass force:true",
        channel: threadId,
        cursor: posting.read[threadId] ?? 0,
        unread: blocking.map((m) => ({ seq: m.seq, from: m.from, text: m.text, ts: m.ts })),
      });
  }

  // Record it in the channel's off-log log (the conversation's home + the card's feed source) — NOT into
  // anyone's stdin. The sender has "seen" its own message, so advance its cursor; the NAMED others are woken.
  const msg = appendThreadMsg(boardId, threadId, from, body.text);
  // @-tags decide the wake set: `@all` (or a non-tagging client) wakes the whole room (null), a tagged post
  // wakes only the named members, an untagged post wakes no one (ambient — still logged for the cursor read).
  // Pair each member sid with its card name so `@RoleName` resolves by handle, not just sid prefix.
  const memberEntries = members.map((sid) => ({ sid, name: sessionNameForSid(records, sid) }));
  const { wakeAll, human, members: tagged, unknown } = resolveTags(body.text, memberEntries);
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
    persistSessionState(ss);
  }
  // The awaited peer just spoke: anyone waiting on `from` has had their wait answered — drop `from` from
  // their waitingOn (→ null when empty) and republish so their card/surfaces fall out of blue. This is the
  // deliberate end of the wait (paired with the no-clear-on-nudge above). Republish goes through THIS (the
  // request handler's) publishSession, so it carries the current feed shape.
  for (const w of liveSessions.values()) {
    if (w.waitingOn?.includes(from)) {
      const rest = w.waitingOn.filter((sid) => sid !== from);
      w.waitingOn = rest.length ? rest : null;
      persistSessionState(w);
      publishSession(w);
    }
  }
  // @-tags decide the wake set, now gated by each member's seat level (P1/W4): `@all` is a room broadcast
  // (wakes level-`all` seats), a member tag is a mention (wakes that seat regardless of level), an untagged
  // post is ambient (neither — wakes no one).
  const notified = wakeThreadMembers(boardId, threadId, from, { broadcast: wakeAll, mentioned: new Set(tagged), origin: originOf(req) });
  // §step5 (threads-as-cards roadmap): an @-tag that resolved to NO member but NAMES a known role
  // COLD-SPAWNS a fresh session into the thread — the mention itself is the summons (role/seat-based only).
  const spawned = spawnMentionedWorkers(boardId, threadId, unknown, originOf(req));
  sendJson(res, 200, { ok: true, channel: threadId, from, seq: msg.seq, members: members.length, notified, spawned });
}

// §step5 (threads-as-cards roadmap: @Role mention → cold-spawn). Each UNKNOWN @-tag (one resolveTags left
// unmatched — no member, no keyword) that NAMES A KNOWN ROLE summons a fresh session INTO this thread,
// reusing the seat-creating serverSpawnWorker cascade (card + member:open edge + server-side placement). The
// role gets its FIRST seat here (the member:open onboarding fills it from the card name), self-limiting at one
// seat per role. A token that is not a known role stays inert prose (no spawn — the pre-existing silent
// discard, no regression). (A seatless reserved-keyword path once cold-spawned a plain worker per mention; it
// was REMOVED as a footgun — naming the token in prose triggered a runaway spawn cascade.) The worker is
// seeded from the thread's FULL backlog, so the triggering message replays on its first inbox read: it wakes
// onto the task. NOT the dormant-seat path — an existing seat (live or dormant) resolves to a MEMBER and rides
// maybeRespawnDormantSeat; this is first-contact only. Returns the spawns for the response (legibility/tests).
function spawnMentionedWorkers(
  boardId: string,
  threadId: string,
  unknownTags: string[],
  origin: string,
): Array<{ token: string; sid: string; role: string | null }> {
  const spawned: Array<{ token: string; sid: string; role: string | null }> = [];
  if (!unknownTags?.length) return spawned;
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return spawned;
  const roles = listRoles(repoPath);
  const records = boardSnapshotRecords(boardId);
  const title = (records ? threadNode(records, threadId) : null)?.title || threadId;
  for (const tok of unknownTags) {
    const hit = classifyMentionSpawn(tok, roles);
    if (!hit) continue; // not a known role — leave as inert prose (no regression)
    // A role summons into its named seat, single-flight per seat so a duplicate tag in the same burst doesn't
    // race a second worker onto it.
    const claimKey = seatSurfaceKey(threadId, hit.name);
    if (isSurfaceClaimed(claimKey)) continue;
    const sid = serverSpawnWorker({
      boardId, repoPath, origin,
      roleId: hit.roleId,
      threadId, anchorNodeId: threadId, claimKey,
      firstPrompt: mentionSpawnBrief(origin, hit.name, title),
    });
    if (sid) spawned.push({ token: tok, sid, role: hit.name });
  }
  return spawned;
}

// The first-turn brief for a session COLD-SPAWNED by an @-mention (spawnMentionedWorkers). A fresh session
// (not a resume): its thread cursor is seeded to the full backlog, so the summoning message replays on the
// first inbox read below. `role` names the seat it occupies.
function mentionSpawnBrief(origin: string, role: string, threadTitle: string): string {
  const who = `the ${role} for thread "${threadTitle}" — your role's seat on this thread is now yours`;
  return (
    `[canvas] You've been SUMMONED into a thread by an @-mention — you are ${who}. This is a FRESH session (not a resume); read the thread to catch up on the task.\n` +
    `- Read your inbox: GET http://${origin}/api/inbox?session=<your session id> — the message that summoned you is there (the full backlog replays on this first read).\n` +
    `- Read the thread, respond to what was asked, and do the work; post status/blockers back to the thread.\n` +
    `- Leave anything durable in the thread before you wind down (a fresh session can't recover your process state).\n` +
    `- When your part is done: POST http://${origin}/api/session/<your session id>/done.`
  );
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
    // Release the seat this leaver holds (§5): a seat survives a process EXIT (respawn re-fills it), but an
    // explicit LEAVE is a deliberate departure — give the seat back so the next same-role join fills fresh,
    // and self-heal a seat stuck to a departed sid. Best-effort; keyed on the leaver's sid, not the role.
    // Drop the durable membership too: THIS is a real leave (unlike a card delete, which keeps membership).
    const repoPath = boards.get(boardId)?.repoPath;
    if (repoPath) releaseSeat(repoPath, threadId, body.from);
    forgetDurableMember(repoPath, threadId, body.from);
  } else {
    const id = memberEdge(records, sessionNode, threadId) ?? `edge:${crypto.randomUUID().slice(0, 8)}`;
    const type = action === "join" ? "member:open" : "member:pending";
    cmd = { type: "addEdge", actor: body.from, payload: { id, from: sessionNode, to: threadId, type } };
  }
  const delivered = dispatchBusCommand(boardId, cmd, origin);
  if (delivered === 0) return sendJson(res, 503, { error: "no tab of this board is live to apply it", delivered: 0 });
  // T3b: a join doesn't return until its member:open edge is in the saved snapshot (waitForEdgePersisted),
  // so the caller can message/ask straight away without racing the ~400ms persist. `persisted:false` means
  // the block timed out (the emitted-membership bridge still covers membership); leave/invite don't wait.
  const persisted = action === "join" ? await waitForEdgePersisted(boardId, String(cmd.payload.id), JOIN_PERSIST_TIMEOUT_MS) : undefined;
  sendJson(res, 200, { ok: true, channel: threadId, action, subject: subjectSid, ...(persisted === undefined ? {} : { persisted }) });
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
    live.read[threadId] = seedCursor(mode, threadLog(boardId, threadId));
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
// is what /api/threads serves and what the thread-state projection (thread-state.js) ranges over. `done` doubles
// as the cooperative-yield signal — for now it informs slot management (a Coordinator/human can see who is safe to
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

// POST /api/thread/<id>/level { from, level } — set the caller's notification LEVEL on this thread (P1/W4,
// notification-levels.js): `all` (the default — any room broadcast wakes it), `mentions` (only an @-address
// wakes it), or `paused` (nothing auto-wakes; an @-mention still overrides). The level rides the caller's
// SEAT when it holds one (durable across respawn), else a sid-keyed fallback. It is NOT a card entry — it
// changes only the wake fan-out condition (wakeThreadMembers), never the message record. Consent mirrors
// intent: a member (or the human at the card) may set a level. 400 on a bad level; 403 for a non-member.
async function handleThreadLevel(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; level?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  if (!isNotificationLevel(body.level))
    return sendJson(res, 400, { error: `level must be one of ${NOTIFICATION_LEVELS.map((l) => `"${l}"`).join(" | ")}` });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "thread not found" });
  if (sessionNodeForSid(records, body.from) && !threadMemberSids(records, threadId).includes(body.from))
    return sendJson(res, 403, { error: "sender is not a member of this thread" });
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });
  const { seat, level } = setThreadLevel(repoPath, threadId, body.from, body.level);
  // Nudge the rail so a listing re-pull reflects the change (like an intent/pin does).
  publishFeed("threads:" + boardId, { ts: Date.now() });
  sendJson(res, 200, { ok: true, thread: threadId, channel: threadId, from: body.from, seat, level });
}

// POST /api/thread/<id>/pin { from, seq, pinned } — flag (or unflag) a message as HEAD CONTEXT (R-PIN,
// wakeable-substrate-plan W7). Pins are the thread's durable head: re-read on every wake ahead of the recent
// tail, so the task statement, the `Done when:` condition (R5), and any load-bearing framing stay present
// however long the log grows. The pinned message keeps its chronological place in the log; the card renders a
// collapsible tray and the inbox surfaces the pins on every read. `pinned` defaults to true (a bare pin call
// pins). Pinning snapshots the message onto the marker (thread-ledger), so a pin survives the log's bounded
// tail. Consent mirrors handleThreadMessage/Intent: a member (or the human at the card) may pin.
async function handleThreadPin(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; seq?: unknown; pinned?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 1)
    return sendJson(res, 400, { error: "seq must be a positive integer" });
  if (body.pinned != null && typeof body.pinned !== "boolean")
    return sendJson(res, 400, { error: "pinned must be a boolean" });
  const pinned = body.pinned !== false; // default true — a bare pin call pins
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "thread not found" });
  if (sessionNodeForSid(records, body.from) && !threadMemberSids(records, threadId).includes(body.from))
    return sendJson(res, 403, { error: "sender is not a member of this thread" });
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });

  let pins: PinnedMsg[];
  if (pinned) {
    // Find the message to snapshot: the in-memory tail first (the common case), else the full ledger (a pin
    // of an older message that has scrolled out of the bounded tail — the very case snapshotting exists for).
    const log = threadLog(boardId, threadId);
    let msg = log.find((mng) => mng.seq === body.seq) as ThreadMsg | undefined;
    if (!msg) msg = readThreadLog(repoPath, threadId).find((mng) => mng.seq === body.seq) as ThreadMsg | undefined;
    if (!msg) return sendJson(res, 404, { error: "no message at that seq in this thread" });
    pins = pinMessage(repoPath, threadId, msg, body.from, Date.now());
  } else {
    pins = unpinMessage(repoPath, threadId, body.seq);
  }
  // Republish the conversation feed so the card's pinned tray updates live (pins ride the same feed).
  const log = threadLog(boardId, threadId);
  publishThreadFeed(boardId, threadId, log, false);
  // Nudge the rail (threads:<board>) so a listing re-pull reflects the change, like an intent does.
  publishFeed("threads:" + boardId, { ts: Date.now() });
  sendJson(res, 200, { ok: true, thread: threadId, channel: threadId, seq: body.seq, pinned, pins });
}

// POST /api/thread/<id>/worktree — manage the thread's work-item worktrees. `op:"remove"` (Stage 1) is the
// EXPLICIT teardown fired on WORK-ITEM completion, guarded: it skips+warns on a dirty tree or unmerged branch
// unless `force`. `op:"merge"` (Stage 3) is merge-on-green: green-gate the branch in its worktree (skip with
// `noVerify`), then `git merge --no-ff` into `base` (default main) from the canonical checkout and tear the
// worktree down — refusing on a dirty worktree / dirty|wrong-branch canonical / a failing gate, and aborting
// cleanly on a merge conflict. `op:"list"` returns the recorded worktrees. The work-item key is derived like
// a spawn's: explicit `key`, else `roleId`'s seat, else the thread itself. Consent mirrors pin/intent: a
// member (or the human at the card) may act.
async function handleThreadWorktree(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; op?: unknown; key?: unknown; roleId?: unknown; force?: unknown; base?: unknown; noVerify?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const op = typeof body.op === "string" ? body.op : "list";
  if (op !== "list" && op !== "remove" && op !== "merge") return sendJson(res, 400, { error: `unknown op "${op}" (list|remove|merge)` });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "thread not found" });
  if (sessionNodeForSid(records, body.from) && !threadMemberSids(records, threadId).includes(body.from))
    return sendJson(res, 403, { error: "sender is not a member of this thread" });
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });

  if (op === "list") return sendJson(res, 200, { thread: threadId, worktrees: listThreadWorktrees(repoPath, threadId) });
  const explicitKey = typeof body.key === "string" && body.key ? body.key : null;
  const roleId = typeof body.roleId === "string" && body.roleId ? body.roleId : null;
  const key = workItemKey({ threadId, roleId, explicitKey });

  if (op === "merge") {
    const base = typeof body.base === "string" && body.base ? body.base : "main";
    const result = mergeWorktree(repoPath, threadId, key!, { base, noVerify: body.noVerify === true, force: body.force === true });
    publishFeed("threads:" + boardId, { ts: Date.now() }); // rail re-pull (a merged worktree drops off the marker)
    return sendJson(res, result.merged ? 200 : 409, { thread: threadId, key, ...result });
  }

  const result = removeWorktree(repoPath, threadId, key!, { force: body.force === true });
  publishFeed("threads:" + boardId, { ts: Date.now() }); // rail re-pull (a removed worktree drops off the marker)
  return sendJson(res, result.removed ? 200 : 409, { thread: threadId, key, ...result });
}

// POST /api/thread/<id>/job — create/update or remove a STANDING JOB (R6, W6, standing-jobs.js). A standing
// job is a periodic server-fired worker on this thread's durable marker: every `intervalMs` the server spawns
// a fresh worker (the one serverSpawnWorker primitive, single-flight) seeded with `instruction`, then it acts
// or (finding nothing) winds down silently. Jobs survive their creator AND a server restart — they live on the
// marker, not the session. Create/update: { from, instruction, intervalMs?, role?, jobId? } — `jobId` updates
// an existing job in place; a named `role` fires INTO that role's seat, else a bare worker; `intervalMs` is
// clamped up to the 60s floor. Remove: { from, jobId, remove:true }. Consent mirrors intent/pin/level: a
// member (or the human at the card) may manage a thread's jobs. Read the current jobs with GET .../jobs.
async function handleThreadJob(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  let body: { from?: unknown; instruction?: unknown; intervalMs?: unknown; role?: unknown; jobId?: unknown; remove?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const records = boardSnapshotRecords(boardId);
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "thread not found" });
  if (sessionNodeForSid(records, body.from) && !threadMemberSids(records, threadId).includes(body.from))
    return sendJson(res, 403, { error: "sender is not a member of this thread" });
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });

  // Remove a job by id.
  if (body.remove === true) {
    if (typeof body.jobId !== "string" || !body.jobId) return sendJson(res, 400, { error: "remove needs a jobId" });
    const { removed, jobs } = removeJob(repoPath, threadId, body.jobId);
    publishFeed("threads:" + boardId, { ts: Date.now() }); // nudge the rail to re-pull like an intent does
    return sendJson(res, removed ? 200 : 404, { ok: removed, thread: threadId, removed, jobs });
  }
  // Create or update.
  if (typeof body.instruction !== "string" || !body.instruction.trim())
    return sendJson(res, 400, { error: "missing instruction" });
  if (body.intervalMs != null && !Number.isFinite(Number(body.intervalMs)))
    return sendJson(res, 400, { error: "intervalMs must be a number of milliseconds" });
  if (body.role != null && typeof body.role !== "string")
    return sendJson(res, 400, { error: "role must be a string (a role id) or omitted" });
  const { job, jobs } = upsertJob(repoPath, threadId, {
    id: typeof body.jobId === "string" ? body.jobId : undefined,
    role: typeof body.role === "string" ? body.role : null,
    intervalMs: body.intervalMs,
    instruction: body.instruction,
    by: body.from,
  });
  publishFeed("threads:" + boardId, { ts: Date.now() });
  sendJson(res, 200, { ok: true, thread: threadId, job, jobs });
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
  const boardId = boardIdentity(s.repoPath).boardId;
  const records = boardSnapshotRecords(boardId);
  // `pinned` is the thread's HEAD CONTEXT (R-PIN): re-read on EVERY wake ahead of the recent tail, so the
  // task statement / `Done when:` condition / load-bearing framing stay present however far the log has
  // scrolled. Surfaced on any thread that has fresh messages this read (a wake implies fresh content there),
  // in the same compact shape as messages. It does NOT advance the cursor and is not counted as unread.
  type OutChan = {
    channel: string;
    title: string;
    messages: InboxMsg[];
    pinned?: InboxMsg[];
    truncated?: { omitted: number; hint: string };
  };
  const channels: OutChan[] = [];
  if (records) {
    for (const threadId of sessionThreads(records, sid)) {
      let log = threadLog(boardId, threadId);
      const since = s.read[threadId] ?? 0;
      if (log.length && log[0]!.seq > since + 1) {
        // The in-memory tail (MAX_THREAD_MSGS — a feed-republish bound, not a read cap) starts past this
        // member's cursor: the older unread live only on disk. Serve THIS read from the full ledger
        // instead of re-dropping content a memory bound already paid for (CLAUDE.md truncation rule —
        // only the caller's own opt-in ?limit/?bytes window may cut, and it surfaces `truncated`).
        const full = readThreadLog(s.repoPath, threadId);
        if (full.length) log = full;
      }
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
        // Head context: attach the pins so a woken agent re-reads the task/done-condition/framing (R-PIN).
        const pins = readPins(s.repoPath, threadId);
        if (pins.length)
          out.pinned = pins.map((p) => ({ seq: p.seq, t: fmtTs(p.ts), from: inboxHandle(records, p.from), text: p.text }));
        channels.push(out);
      }
      if (log.length) s.read[threadId] = log[log.length - 1]!.seq; // mark all read (incl. skipped card-only entries)
    }
    persistSessionState(s);
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
      attachWs(server); // the tabs' one-socket transport (feeds + bus + watch)
      void attachSessionHost(); // CANVAS_SESSION_HOST mode: adopt the sidecar's surviving sessions
      server.middlewares.use((req, res, next) => {
        // ONE canonical browser origin (127.0.0.1). `localhost` and `127.0.0.1` are different origins to
        // the browser, so each holds its OWN IndexedDB — a tab opened on the other spelling sees a
        // different (usually empty) copy of every board, which reads as "where did my board go". Redirect
        // page NAVIGATIONS (GET asking for text/html) to the canonical host and let everything else —
        // curl recipes, API calls, module fetches — pass untouched on either spelling. 127.0.0.1 is
        // canonical (not localhost) because the boards people already have live there.
        const host = req.headers.host ?? "";
        if (
          req.method === "GET" &&
          host.startsWith("localhost") &&
          (req.headers.accept ?? "").includes("text/html") &&
          !(req.url ?? "").startsWith("/api/") &&
          !(req.url ?? "").startsWith("/card-types/")
        ) {
          res.writeHead(302, { Location: `http://${host.replace(/^localhost/, "127.0.0.1")}${req.url ?? "/"}` });
          return void res.end();
        }
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
        // Permission prompts (permission-prompt-tool): the relay's held POST, the card's decision
        // buttons, and the headless list. Ids are global UUIDs — no ?board= anywhere here.
        if (url.pathname === "/api/permission/request" && req.method === "POST")
          return void handlePermissionRequest(req, res);
        const permMatch = /^\/api\/permission\/([\w-]+)\/decision$/.exec(url.pathname);
        if (permMatch && req.method === "POST") return void handlePermissionDecision(req, res, permMatch[1]!);
        if (url.pathname === "/api/permissions" && req.method === "GET")
          return handlePermissionsRead(res, url.searchParams.get("session"));
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
        const threadMatch = /^\/api\/(?:thread|channel)\/([^/]+)\/(message|join|leave|invite|history|ask|reply|intent|level|pin|job|worktree)$/.exec(url.pathname);
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
          if (action === "level") return void handleThreadLevel(req, res, b.boardId, threadId);
          if (action === "pin") return void handleThreadPin(req, res, b.boardId, threadId);
          if (action === "job") return void handleThreadJob(req, res, b.boardId, threadId);
          if (action === "worktree") return void handleThreadWorktree(req, res, b.boardId, threadId);
          return void handleThreadMembership(req, res, b.boardId, threadId, action as "join" | "leave" | "invite", originOf(req));
        }
        // GET /api/thread/<id>/jobs — read this thread's standing jobs (R6/W6, for the CLI + smoke test).
        const threadJobsMatch = /^\/api\/(?:thread|channel)\/([^/]+)\/jobs$/.exec(url.pathname);
        if (threadJobsMatch && req.method === "GET") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          const threadId = decodeURIComponent(threadJobsMatch[1]!);
          return sendJson(res, 200, { thread: threadId, jobs: readJobs(b.repoPath, threadId) });
        }
        // GET /api/thread/<id>/worktrees — read this thread's recorded work-item worktrees (Stage 1, for the CLI).
        const threadWorktreesMatch = /^\/api\/(?:thread|channel)\/([^/]+)\/worktrees$/.exec(url.pathname);
        if (threadWorktreesMatch && req.method === "GET") {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          const threadId = decodeURIComponent(threadWorktreesMatch[1]!);
          return sendJson(res, 200, { thread: threadId, worktrees: listThreadWorktrees(b.repoPath, threadId) });
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
          return handleThreads(res, b.boardId, b.repoPath);
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
        // The durable board store (step 4): the browser's persistence backends live here now.
        if (url.pathname.startsWith("/api/board/persist")) {
          const b = reqBoard(url);
          if (!b) return sendJson(res, 400, { error: "unknown board" });
          if (url.pathname === "/api/board/persist" && req.method === "GET") {
            // Compact on the boot read (once per page load): drop events the snapshot absorbed,
            // beyond a generous tail — see board-persist.js. Never silent when it bites.
            const { dropped } = compactBoardEvents(b.repoPath);
            if (dropped > 0) console.log(`[boards] compacted ${b.boardId}: dropped ${dropped} events below the snapshot watermark tail`);
            return sendJson(res, 200, readBoardPersist(b.repoPath));
          }
          if (url.pathname === "/api/board/persist" && req.method === "DELETE") {
            clearBoardPersist(b.repoPath);
            return sendJson(res, 200, { ok: true });
          }
          if (req.method === "POST") {
            const kind = url.pathname.slice("/api/board/persist/".length);
            if (kind === "event" || kind === "snapshot" || kind === "import")
              return void handleBoardPersistWrite(req, res, b.boardId, b.repoPath, kind);
          }
          return sendJson(res, 404, { error: "unknown board-persist endpoint" });
        }
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

        // Doc annotations (docs/doc-annotations.md): quote-anchored standoff comments on this board's
        // files. Deliberately CANONICAL-root only (no ?root=): the ledger is keyed by repo-relative
        // path, and a worktree's copy of a doc is the same doc — annotations shouldn't fork per tree.
        if (url.pathname === "/api/annotations") {
          const canonical = rootDir(boardId, null);
          if (!canonical) return sendJson(res, 400, { error: "unknown root" });
          if (req.method === "POST") return void handleAnnotationsWrite(req, res, canonical, board.repoPath, boardId, originOf(req));
          return handleAnnotationsRead(res, canonical, board.repoPath, url.searchParams.get("path"));
        }

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
            return void handleFileWrite(req, res, root, url.searchParams.get("path") ?? "", board.repoPath);
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
