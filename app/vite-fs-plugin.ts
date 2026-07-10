import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { commitRoot, watchRoot } from "./shadow-git.js";
import { canvasSessionsDir, markCanvasSession, projectsDirForCwd, readCanvasSession, recordSessionEnd, updateCanvasSession } from "./session-ledger.js";
import { localProc, remoteProc, type SessionProc, type ProcHooks } from "./session-proc.js";
import { connectSessionHost, type SessionHostClient, type HostSessionInfo } from "./session-host-client.js";
import { sessionHostSocketPath } from "./session-host-protocol.js";
import { addThreadMember, appendThreadLine, canvasThreadsDir, fillSeat, listThreads, migrateChannelLedger, ownBlockedIntentKeys, readPins, readSeenMentions, readThreadLog, readThreadMeta, removeThreadMember, seatForSid, sessionDeclaredDone, sessionIdleIntent, threadLevelForSid, threadMembersFromMeta, untaggedSeatNudgeTarget, upsertThreadMeta, type PinnedMsg, type ThreadMetaMarker } from "./thread-ledger.js";
import { humanWaiting, cardOnly } from "./thread-waiting.js";
import { connectedEdgeIds } from "./node-cascade.js";
import { intentLine, type WorkIntent } from "./work-intent.js";
import { wakesSeat } from "./notification-levels.js";
import { deriveThreadState } from "./thread-state.js";
import { readWatchers } from "./doc-watch.js";
import { claimSurface, docSurfaceKey, isSurfaceClaimed, qualifyingWatchers, reapKeepAliveMs, releaseSurface, seatSurfaceKey, shouldReapIdle, surfaceClaimant } from "./auto-wake.js";
import { dueJobs, jobClaimKey, jobDueWithInterval, planRoleJobFire, readJobs, sessionHasScheduledWake, stampFired, upsertJob } from "./standing-jobs.js";
import { COORDINATOR_ROLE, coordinatorHeartbeatJobSpec, heartbeatEffectiveInterval } from "./coordinator-heartbeat.js";
import { idleBand, shouldRepublishBand } from "./session-band-republish.js";
import { docJobClaimKey, listDocsWithJobs, readDocJobs, stampDocFired } from "./doc-jobs.js";
import { canvasRolesDir, listRoles, readRole } from "./role-ledger.js";
import { ensureWorktree, listWorktrees as listThreadWorktrees, workItemKey, parseWorktreePorcelain, worktreeOnboarding } from "./worktrees.js";
import { boardPersistMtime, describeBoardEvents, readBoardPersist, readBoardSnapshot } from "./board-persist.js";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { sendJson, readBody, openSse, type SseClient } from "./server-http.js";
import { setServerContext } from "./server-context.js";
import { announceNewMemberships, appendThreadMsg, dispatchBusCommand, flushNudge, publishThreadFeed, wakeThreadMembers } from "./server-delivery.js";
import type { GlobalRoute, BoardRoute, RootRoute } from "./routes/router.js";
import { exact, oneOf, prefix, re } from "./routes/router.js";
import { weatherRoutes } from "./routes/weather.js";
import { cardTypeRoutes, handleCardTypeAsset, CARD_TYPES_DIR } from "./routes/card-types.js";
import { roleRoutes } from "./routes/roles.js";
import { permissionRoutes, settlePermission, PERMISSION_HOLD_MS } from "./routes/permissions.js";
import { boardRoutes } from "./routes/boards.js";
import { boardPersistRoutes } from "./routes/board-persist.js";
import { fileRootRoutes } from "./routes/files.js";
import { annotationBoardRoutes } from "./routes/annotations.js";
import { rootsBoardRoutes } from "./routes/roots.js";
import { inboxRoutes } from "./routes/inbox.js";
import { askRoutes } from "./routes/asks.js";
import { threadRoutes } from "./routes/threads.js";
import { sessionLifecycleRoutes, sessionReadRoutes } from "./routes/sessions.js";
import { isInternalPath, openRootWatcher } from "./server-fs.js";

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
export interface BoardInfo {
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
export interface BoardRegistryEntry {
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

// A board's Claude Code transcripts dir: ~/.claude/projects/<abs path with every non-alnum → ->. Per board
// (was a single module constant) so a canvas over another repo lists THAT repo's sessions, not the dev
// repo's. The slug rule lives once in projectsDirForCwd (session-ledger) — a board root has no dots so it's
// unchanged, but a worktree cwd contains `.canvas` and MUST slug the dot too (`.canvas` → `-canvas`), or its
// transcript dir won't be found. Passing a worktree cwd here resolves that session's own dir.
function sessionsDir(repoPath: string): string {
  return projectsDirForCwd(repoPath);
}

// sessionTranscriptDir (the per-session transcripts-dir resolver) moved to routes/sessions.ts (god-file
// split, Phase 4) — only the session read/resume routes called it. It reaches sessionsDir through the
// ServerContext (sessionsDir stays here: the sessions-feed startup + the live-tail seed still call it).

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

// /api/boards (list + mount) now lives in routes/boards.ts (god-file split, Phase 1); boardJson moved
// there with it. The mount orchestration reaches boardIdentity/readBoardRegistry/recordBoardOpened/
// ensureCanvasExcluded/startBoardFeeds through the ServerContext (wired at setServerContext below).

// ── worktrees as ROOTS (worktree-activity slice B) ────────────────────────────────────────────────
// A board is a workspace that can serve MORE THAN ONE root: its canonical checkout (rootId "repo") plus
// every linked git worktree of that repo. Worktrees are DISCOVERED, never mounted: `git worktree list`
// sees whatever an agent or a human created via the CLI, so a new tree appears on its own (and the
// watcher below re-discovers on `.git/worktrees/` churn). Node ids are already `node:<root>:<path>`, so
// the extra roots' file cards never collide; the rootId is the slug of the worktree's dir basename.
export interface RootInfo {
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
  const raw = parseWorktreePorcelain(out); // shared with worktreeExists (worktrees.js) — one format parser
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
    .map((r) => ({ real: realpath(r.path), branch: r.branch, head: r.head }))
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

// The board MOUNT handler (POST /api/boards) moved to routes/boards.ts with the list handler above.

// ── the durable board store (external-repo boards step 4: records live with the repo) ─────────────
// handleBoardPersistWrite + the /api/board/persist route (GET/DELETE/POST event|snapshot|import) now live
// in routes/board-persist.ts (god-file split, Phase 1). The second-writer tripwire (fsState.lastEventSeq)
// and the membership-diff onboarding (announceNewMemberships) are reached through the ServerContext; the
// board-persist.js file store is imported directly there.

// Claude Code's transcripts live in ~/.claude/projects/<slug> — resolved PER BOARD by sessionsDir(repoPath)
// above (the session handlers thread the board's dir), so the cards serve the right repo's history.
const MAX_SESSION_BYTES = 4 * 1024 * 1024; // whole sessions, bounded against a pathological one. The
// card scrolls, so we serve the full transcript; the cap only guards an extreme outlier (and the
// card flags it honestly when it bites — the codec marks a partial tail). In-memory spike, so a few
// MB in node.text is fine.

// The filesystem-serving / confinement helpers (EXCLUDE_DIRS, isInternalPath, TEXT_EXT, IMAGE_EXT/MIME,
// MAX_ASSET_BYTES, safeResolve, fileVersion, openRootWatcher) now live in the stateless server-fs.ts seam
// (alongside MAX_BYTES/readText in server-http.ts) so the extracted file/asset/watch/annotation route modules
// share one definition. Only isInternalPath (the shadow-git ignore predicate) and openRootWatcher (the WS
// file-watch) still have callers HERE, so those two are imported back at the top of this file.

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

// handleSession + sessionSummary/summaryCache moved to routes/sessions.ts (god-file split, Phase 4) — only
// the session read/list routes call them. handleSession reaches readSessionFile + ensureSessionFeed, and
// handleSessions reaches sessionStatus, through the ServerContext; those three stay here (readSessionFile
// and sessionStatus are shared with the feed/shadow-git/band paths, ensureSessionFeed is the feed engine).

// The lifecycle BAND a session reads, in the SAME categories the session card paints
// (card-types/session/render.js `frameState`): a live process is `working` (running) or `waiting` (idle,
// the loud "your turn") — except an idle session that named a peer in a channel @-tag reads `waiting-agent`
// (blue, "waiting on an agent, not you"); an ended one reads its recorded reason — `done` / `crashed` / a
// neutral `ended` (terminate or unknown). One server-side source so every view (the sessions list bar, the
// minimap dot, the heads-up) agrees with the card instead of re-deriving it.
export type SessionBand =
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
// The ONE whole-session status band both surfaces render from (thread mrcmofwf-10): the session card's
// frame band (card-types/session/render.js) AND that session's participant pill in every thread
// (thread-state.js memberPillState) read THIS value, so they can never disagree. Process-observed bands
// (working/scheduled/crashed/ended) are authoritative and GLOBAL; only the *idle* band takes a declared-
// intent refinement, folded WHOLE-SESSION (across every thread the session is in — sessionIdleIntent), per
// the v2 precedence. `null` = bandless (a never-run session that has handed you nothing yet, or an unknown
// session): both surfaces render neutral, never a fabricated "your turn".
function sessionStatus(repoPath: string, id: string): SessionBand | null {
  const live = liveSessions.get(id);
  if (live) {
    // A held permission prompt outranks everything live: the process is technically mid-turn
    // ("running"), but it's blocked on a HUMAN click — the one state the loud band exists for.
    if (live.status !== "exited" && [...pendingPermissions.values()].some((p) => p.sid === id)) return "waiting";
    if (live.status === "running") return "working";
    if (live.status === "idle") {
      // Never-run: idle with no output yet has handed you nothing back, so the loud amber "your turn" is
      // wrong — stay bandless until the first turn produces output and idles again (which IS your turn).
      if (live.lines.length === 0) return null;
      // Idle band precedence (v3, whole-session — see idleBand): a DECLARED intent outranks a wake timer —
      // declared blocked:human (loud orange) > declared blocked:peer (blue) > scheduled (a looping role asleep
      // on its heartbeat — teal, no human demand; gated on an ACTUAL live wake, not the static `loops` flag) >
      // a server-inferred @-tag peer-wait (blue `waitingOn`, free) > the default orange "your turn". Declared
      // intent is aggregated across ALL the session's threads; `done`/`working` don't paint the idle band
      // (done never colours a live session — it shows only once the process exits, via endReason grey). One
      // listThreads read shared by both consults.
      const metas = listThreads(repoPath);
      const scheduled = !!live.loops && sessionHasScheduledWake(metas, id);
      return idleBand(sessionIdleIntent(metas, id), scheduled, !!live.waitingOn?.length);
    }
    if (live.endReason) return endReasonBand(live.endReason); // exited process with a recorded reason
  }
  // not live (or exited with no in-memory reason) → the durable marker is the only surviving source
  return endReasonBand(readCanvasSession(repoPath, id)?.endReason as string | undefined);
}

// handleSessions (GET /api/sessions) moved to routes/sessions.ts (god-file split, Phase 4). It reaches
// sessionStatus through the ServerContext (sessionStatus stays here — the band-republish loop calls it too).

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
// Also watches the board's MARKER dir (`.canvas/sessions/`): the list is now marker-driven, and a WORKTREE
// session's transcript lands in a projects dir this watcher can't see, so its arrival would otherwise miss
// the feed and only show on a manual refresh. A spawn writes the marker under the board root, so watching
// that dir pings the list the moment any owned session (worktree or not) appears or changes end-state.
// (Like the git/HN/cardtypes feeds, the watcher isn't pinned on fsState — the boardFeedsStarted guard
// stops a server reload from stacking a second one per board, and a surviving watcher keeps publishing.)
function startSessionsFeed(boardId: string, dir: string, markersDir: string): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  const ping = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("sessions:" + boardId, { ts: Date.now() }), 200);
  };
  chokidar.watch(dir, { ignoreInitial: true, depth: 0 }).on("all", ping);
  // ignorePermissionErrors + a lazy create: the marker dir may not exist until the first spawn/adoption.
  chokidar.watch(markersDir, { ignoreInitial: true, depth: 0, ignorePermissionErrors: true }).on("all", ping);
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
    // The board owner's UNSEEN-MENTION signal per thread (user waiting-state + you-pill): an @you/@human
    // mention the human has not yet VIEWED (humanWaiting × the durable per-thread `seenMentions`) → the
    // threads-list row shows signal (a): a quiet count badge + an interactive hover popover of the pending
    // mentions, each click a cross-card jump to that message. Same derivation the thread card feeds off, so
    // list and card agree with no client re-derivation. threadLog is the in-memory tail (seeded at boot, kept
    // fresh by appendThreadMsg); the threads:<board> ping re-pulls on any message/reply/seen, so the signal
    // sets and clears live. Unlike the card feed, the rail carries the PREVIEW (sender + snippet) — the rail
    // is where the human picks a specific message to jump to (the "you" pill is presence-only now). Sender
    // labels resolve server-side (the rail card can't reach the client name registry): a seated poster shows
    // its role handle, else a short sid — @human mentions come from seated agents, so the role reads well.
    const seats = m.seats ?? {};
    const fromLabel = (sid: string) =>
      sid === "human" ? "you" : sid === "system" ? "system" : (seatForSid(seats, sid) ?? sid.slice(0, 8));
    const { waiting: youWaiting, count: youWaitingCount, preview, more: youWaitingMore } =
      humanWaiting(threadLog(boardId, m.threadId), readSeenMentions(repoPath, m.threadId));
    const youWaitingPreview = preview.map((p) => ({ ...p, fromLabel: fromLabel(p.from) }));
    return {
      threadId: m.threadId,
      chanId: m.threadId,
      title: typeof m.title === "string" ? m.title : "",
      text: typeof m.text === "string" ? m.text : "",
      messages: typeof m.lastSeq === "number" ? m.lastSeq : 0,
      mtime: (m.lastTs ?? m.createdAt ?? 0) as number,
      youWaiting,
      youWaitingCount,
      youWaitingPreview,
      youWaitingMore,
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

// /api/roles (list + create) now lives in routes/roles.ts (god-file split, Phase 1); the create path
// reaches publishFeed through the ServerContext to nudge an open picker.

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

// ── feeds (demo §10: "the clock with a fetch in it") ────────────────────────────────────────────
// A tiny server-side feed registry, multiplexed onto ONE SSE stream (/api/feeds). Each feed is a
// named source that publishes its latest value; the client turns each name into an off-log signal
// (the clock's pattern, fed from here instead of setInterval). Values are channel-1-only on the
// canvas — nothing a feed emits ever touches the log/persistence/git. New connections get every
// feed's last value immediately, so cards render without waiting for the next tick.

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
export interface ThreadMsg {
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
// unread filter (an agent's own bookkeeping must not wake the room). `cardOnly` is shared with
// thread-waiting.js's human-waiting derivation so the two can't drift on what counts as bookkeeping.
// §16 ask/reply: a synchronous consultation held in memory, keyed by askId (NOT a persisted recipient —
// the durable log stays broadcast-only). The HTTP response is parked until reply or timeout. Pinned in
// fsState so the queue survives a hot re-eval; the held `res`/`timer` are process-bound (a restart times
// them out, which is the correct degradation).
export interface PendingAsk {
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
export interface PendingPermission {
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
export interface CanvasFsState {
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
// PERMISSION_HOLD_MS now lives in routes/permissions.ts (with the permission handlers) and is imported at
// the top of this file — the spawn path below reads it to size MCP_TOOL_TIMEOUT a minute above the hold.
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

export interface LiveSession {
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
  // Band-staleness reconciliation (thread mrcmofwf-10): the last whole-session status band publishSession
  // pushed onto this session's feed. The loopTick safety net compares a freshly recomputed sessionStatus to
  // this and republishes on drift, catching out-of-band transitions (a standing job / intent / waitingOn that
  // moves the live band without firing one of the session's own process events). `undefined` = never
  // published (nothing to reconcile yet); `null` is a real published value (a bandless never-run session).
  lastBand?: SessionBand | null;
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
  // Compute the band ONCE and remember it: this pushed value is what the card renders, and the loopTick
  // safety net compares against `lastBand` to catch it going stale on an out-of-band transition.
  const band = sessionStatus(s.repoPath, s.id);
  s.lastBand = band;
  publishFeed("session:" + s.id, {
    content,
    truncated,
    status: s.status,
    // The ONE whole-session status band (sessionStatus) the card renders its frame from — the SAME value
    // the thread participant pill reads off /api/sessions, so the two surfaces can't drift. Sent on every
    // publish (including `null` = bandless/never-run) so the card stops recomputing the band client-side;
    // it falls back to its own derivation only when this key is absent (a slice-1 file-tail feed).
    band,
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

// Republish every LIVE seat occupant of a thread (mrcmofwf-10 instant path). A standing job created/removed
// on a seat flips that occupant's `scheduled` band (sessionHasScheduledWake goes true/false) with no process
// event of its own, so push the affected occupants' feeds now rather than waiting for the loopTick safety
// net. Cheap: a thread holds a handful of seats, publishSession recomputes the band fresh, and dead/absent
// occupants are skipped. Best-effort — a read failure leaves the safety net to reconcile.
function republishThreadSeatOccupants(repoPath: string, threadId: string): void {
  try {
    const seats = readThreadMeta(repoPath, threadId)?.seats ?? {};
    for (const seat of Object.values(seats) as Array<{ sid?: string }>) {
      const s = seat?.sid ? liveSessions.get(seat.sid) : undefined;
      if (s && s.status !== "exited") publishSession(s);
    }
  } catch { /* best-effort; loopTick reconciles */ }
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
      resumeRunning(s); // idle→running: fold the transition (auto-freshen any blocked:* intent, part 2)
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
      if (ev?.type === "message_start" || ev?.type === "content_block_start") resumeRunning(s);
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
  // A --worktree worker's cwd is its isolated checkout while repoPath stays the canonical board root; when
  // the two differ, append the isolation onboarding (worktrees.js) so the worker confines edits to its
  // worktree and keeps main clean. Every path pointer in the rest of the prompt names the main checkout, so
  // without this a worker anchors on those and edits main — the bug this closes. Branch is best-effort; the
  // cwd path is the load-bearing fact, so a git miss just drops the branch label.
  let worktreeBlock = "";
  if (cwd !== repoPath) {
    let branch = "";
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch {
      // best-effort; the onboarding stands without the branch name
    }
    worktreeBlock = "\n\n" + worktreeOnboarding({ cwd, repoPath, branch });
  }
  const appendPrompt =
    ASK_CONVENTION + "\n\n" + collabBrief(boardIdentity(repoPath).boardId, id, origin) +
    worktreeBlock +
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
  resumeRunning(s); // a prompt/nudge resumes the process → auto-freshen any blocked:* intent (part 2)
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

// ── operating-loop heartbeat (agent-roles.md) ────────────────────────────────────────────────────
// A looping ROLE (the Coordinator) needs to sweep the board for STALLS — but nothing emits an event when an agent
// goes silent, so a purely reactive session would never wake to notice. And built-in self-scheduling does
// NOT fire in a `claude -p` child (tested), so the wake can't come from inside the agent — the SERVER has to
// fire the timer. This USED to be a bespoke per-session loop here (a cadence timer that nudged every already-
// live looping session). It has been RETIRED and CONVERGED onto the general STANDING-JOB machinery (R6/W6):
// the Coordinator heartbeat is now a standing job on the Coordinator's thread (`coordinator-heartbeat.js`),
// fired by `standingJobsTick`, which under TIMERS-NUDGE-NEVER-SPAWN only NUDGES a live+idle Coordinator
// (cheap — context intact) and does nothing for a dormant seat (a timer can't create a session; a real
// event — @-mention/ask/human — is what revives one). Reap-only-on-done keeps that live seat PARKED between
// nudges, so the heartbeat keeps finding it. One driver, no fork. Enabling that job is the AUTONOMY SWITCH
// and is human-gated (`scripts/canvas job
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
  reconcileSessionBands(); // mrcmofwf-10: republish any session whose live band has drifted from its last
  //                          push — the catch-all for out-of-band transitions the instant paths don't cover.
}

// Band-staleness safety net (thread mrcmofwf-10). Runs AFTER the ticks above so it sees the state they left
// (a job that fired, a seat reaped). For every live session, recompute the live band and republish only when
// it has drifted from what was last pushed — so the card's pushed band can never stay stale for longer than
// one tick regardless of WHAT changed it (standing job, seat flip, intent, waitingOn). Republish-on-change
// only, so this is not per-tick spam; sessionStatus short-circuits to "working" for running sessions (no
// disk read), so the listThreads read is hit only for the handful of idle sessions.
function reconcileSessionBands(): void {
  for (const s of liveSessions.values()) {
    if (shouldRepublishBand(s.lastBand, sessionStatus(s.repoPath, s.id))) publishSession(s);
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

// handleSessionSpawn (POST /api/session/spawn) moved to routes/sessions.ts (god-file split, Phase 4). It
// reaches the spawn primitives it shares with serverSpawnWorker below — liveSessionCount / MAX_LIVE_SESSIONS
// / resolveSpawnCwd / placeWorkerCard / ensureLiveSession / sendSessionInput — plus the snapshot/thread
// resolvers, through the ServerContext; those definitions stay here (Phase-5 engine territory).

// ── P2/W5: server-spawn-from-a-durable-record (auto-wake.js) ─────────────────────────────────────────
// The SERVER reconstitutes a session from a durable record on a qualifying wake — a comment/answer on a
// watched doc (Trigger 1, maybeWakeDocWorker) or an @-addressed message to a dormant thread seat (Trigger 2,
// maybeRespawnDormantSeat). Both share this one primitive: mint a fresh session, seed it from the record
// (thread history / the doc's annotation queue + the memory brief ensureLiveSession already bakes in), claim
// the surface single-flight, drop a card, and send the first-turn worker brief. `--resume` is deliberately
// NOT used (R1): reconstitution is a FRESH spawn seeded from the durable substrate, never a transcript
// replay. Only Triggers 1 & 2 spawn — standing jobs (W6) do NOT ride this: under TIMERS-NUDGE-NEVER-SPAWN a
// timer may only nudge a live seat, never mint a session. Returns the new sid, or null if it couldn't spawn
// (cap reached / spawn error — logged, never thrown: a wake is best-effort, it degrades to pull).
const IDLE_KEEPALIVE_MS = 15 * 60_000; // R1: a DONE auto-wake worker idles this long, then the reaper winds it
// down. Extended from 5 min — 5 was aggressive and churned Coordinators mid-task. Under REAP-ONLY-ON-DONE
// (reapKeepAliveMs) this window applies ONLY to a session that has declared `done`; every other stance —
// working, blocked:*, undeclared — is PARKED and never idle-reaped. The Coordinator heartbeat (4 min) stays
// well inside this so a live Coordinator is nudged, not reaped.

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

// The keep-alive reaper: an auto-wake worker is wound down ONLY once it has declared `done` and been idle past
// the grace window. REAP-ONLY-ON-DONE (thread mrcauz0v-f): every other stance — working, blocked:*, undeclared
// — PARKS (never idle-reaped). This is the counterpart to "timers nudge, never spawn": a reaped worker can no
// longer be revived by any timer (the heartbeat is nudge-only), so we don't reap a still-relevant session; a
// parked idle session is harmless (no tokens). Only auto-wake workers are eligible — never a human card.
// Thread markers are read once per repo per tick (only for repos with an eligible session). Runs on loopTick.
function autoWakeReapTick(): void {
  const now = Date.now();
  const threadsByRepo = new Map<string, ThreadMetaMarker[]>();
  for (const s of liveSessions.values()) {
    // Cheap pre-filter before the marker read: only an idle auto-wake worker with an idle stamp can reap.
    if (!s.autoWake || s.status !== "idle" || !s.idleSince) continue;
    let metas = threadsByRepo.get(s.repoPath);
    if (!metas) {
      try {
        metas = listThreads(s.repoPath);
      } catch {
        metas = [];
      }
      threadsByRepo.set(s.repoPath, metas);
    }
    // Reap only a session that has FINISHED (declared done, active nowhere); everything else parks (→ null).
    const done = sessionDeclaredDone(metas, s.id);
    const keepAlive = reapKeepAliveMs(done, IDLE_KEEPALIVE_MS);
    if (!shouldReapIdle(s, now, keepAlive)) continue;
    console.warn(
      `[auto-wake] reaping idle worker ${s.id} (declared done, idle ${Math.round((now - s.idleSince!) / 1000)}s ≥ ` +
        `${keepAlive! / 1000}s grace) — winding down`,
    );
    endSession(s.id, "done");
  }
}

// The standing-job NUDGE: the cheap — and now ONLY — wake a standing job can deliver. Under "timers nudge,
// never spawn" a standing job only ever nudges an ALREADY-LIVE target (a role-seat occupant kept parked by
// reap-only-on-done, or a live doc worker); there is no fresh-spawn brief anymore. Reuses the live session's
// assembled context — the sendSessionInput nudge path the loop heartbeat uses. The instruction rides the
// nudge inline (unlike a content-free wake).
function standingJobNudge(job: { instruction: string }, origin: string): string {
  return (
    `[canvas] ⏱ STANDING JOB — your scheduled tick (not a human message). YOUR INSTRUCTION:\n${job.instruction}\n\n` +
    `- Do exactly what it says. **If there's nothing to do, post NOTHING** ("skip days with nothing") — no "all clear" noise.\n` +
    `- Then go back to sleep (stay live for the next tick). Read your inbox first if you need context: ` +
    `GET http://${origin}/api/inbox?session=<your session id>.`
  );
}

// Part 1 — heartbeat DEFAULT-ON. Auto-enable the Coordinator heartbeat standing job the first time a
// Coordinator seat is staffed (coordinator-heartbeat.js): a Coordinator that doesn't proactively sweep can't
// do its core job (peers signal completion via a `done` intent that wakes no one, so only a sweep notices),
// and the standalone CLI enable step was routinely forgotten — so staffing a Coordinator IS the (human)
// autonomy decision that turns it on. Idempotent: skipped when a Coordinator-role job already exists, so a
// human who deliberately `job rm`'d it isn't overridden. Best-effort; the CLI verb remains the override path.
function ensureCoordinatorHeartbeat(repoPath: string, threadId: string): void {
  try {
    if (readJobs(repoPath, threadId).some((j) => j.role === COORDINATOR_ROLE)) return;
    upsertJob(repoPath, threadId, coordinatorHeartbeatJobSpec());
  } catch {
    /* best-effort — the CLI verb (`scripts/canvas job coordinator`) remains the manual fallback */
  }
}

// Trigger 3 — STANDING JOBS (R6, W6). The server-fired timer half of the wakeable substrate: every loop
// heartbeat, fire the standing jobs that have come due across every board's threads. TIMERS NUDGE, NEVER
// SPAWN (human-locked invariant, thread mrcauz0v-f): a role-seat job whose seat is still occupied by a LIVE
// session NUDGES that session (cheap — context intact); a DORMANT (or reaped) target is left alone — the timer
// does NOT respawn it (see planRoleJobFire below). Reviving a dormant seat waits for a real event (@-mention/
// ask/human); reap-only-on-done keeps a wound-down Coordinator PARKED so the nudge keeps finding it rather
// than the old runaway of a timer respawning it in a loop. SINGLE-FLIGHT: a job whose prior fire is still running (its surface claimed, or the live occupant
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
      // Read the marker once for both the due-check's intent (part 4 backoff) and the seat resolution below.
      const tMeta = readThreadMeta(board.repoPath, t.threadId);
      for (const job of readJobs(board.repoPath, t.threadId)) {
        // Part 4 — intent-keyed backoff: a role-seat job's EFFECTIVE interval slows while its seat's occupant
        // is parked on the human (blocked:human), keeps the base cadence otherwise. Derived live from the
        // seat's declared intent — no stored backoff state (heartbeatEffectiveInterval is a no-op unless
        // blocked:human, so a bare/undeclared job fires exactly as before).
        const seatIntent = job.role ? tMeta?.intents?.[job.role]?.intent ?? null : null;
        if (!jobDueWithInterval(job, now, heartbeatEffectiveInterval(job.intervalMs, seatIntent))) continue;
        const key = jobClaimKey(t.threadId, job);
        if (isSurfaceClaimed(key)) continue; // a prior fire's worker still servicing this surface — no double-fire

        // TIMERS NUDGE, NEVER SPAWN (human-locked invariant, thread mrcauz0v-f). A standing job may only NUDGE
        // an already-live seat occupant; it must never create a session. So:
        //   - a BARE (roleless) job has no seat to nudge → nothing to do (its old "spawn a fresh worker every
        //     interval" behaviour is removed; re-add an explicit periodic-spawn primitive here if ever needed).
        //   - a ROLE-seat job (incl. the Coordinator heartbeat): planRoleJobFire → "nudge" a live+idle occupant
        //     (the only fire a timer may make), "skip" a mid-turn one, or "none" (dormant/absent, or a
        //     stood-down `done` seat) — both non-nudge outcomes do nothing and do NOT stamp, so the job simply
        //     re-evaluates next tick. A wound-down Coordinator is kept PARKED by the reaper (reap-only-on-done),
        //     so the nudge keeps finding it; a truly-exited seat waits for a real event (@-mention/ask/human).
        if (!job.role) continue; // bare job: no live seat to nudge, and timers don't spawn → no-op
        const sid = tMeta?.seats?.[job.role]?.sid; // reuse the marker read once at the top of this thread
        const live = typeof sid === "string" ? liveSessions.get(sid) : undefined;
        if (planRoleJobFire(live?.status ?? null, seatIntent) !== "nudge") continue; // skip / none → no fire, no stamp
        sendSessionInput(live!.id, standingJobNudge(job, lastKnownOrigin), { keepWaitingOn: true });
        stampFired(board.repoPath, t.threadId, job.id, now);
      }
    }

    // Doc standing jobs (doc-jobs.js) — the SAME server-fired timer on a DOC's marker, and the SAME invariant:
    // TIMERS NUDGE, NEVER SPAWN. A due doc job may only nudge a LIVE, idle worker already servicing the doc
    // (single-flight per doc, docJobClaimKey = docSurfaceKey); a mid-turn worker is skipped (no stamp); a
    // dead/absent claimant is a no-op (the old fresh-respawn is removed). A doc that needs a worker gets one
    // reactively via maybeWakeDocWorker (an annotation event), not from this timer.
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
        if (!claimant) continue; // no live worker on the doc — timers don't spawn → nothing to do
        const s = liveSessions.get(claimant);
        if (!s || s.status === "exited") {
          releaseSurface(key, claimant); // stale claim (worker gone) — clear it; no respawn
          continue;
        }
        if (s.status !== "idle") continue; // mid-turn — don't interrupt; retry next tick (no stamp)
        sendSessionInput(claimant, standingJobNudge(job, lastKnownOrigin), { keepWaitingOn: true });
        stampDocFired(board.repoPath, rel, job.id, now);
      }
    }
  }
}

// handleSessionInput / handleSessionResume / handleSessionInterrupt / handleSessionTerminate /
// handleSessionDone (POST /api/session/<id>/{input,resume,interrupt,terminate,done}) moved to
// routes/sessions.ts (god-file split, Phase 4). They reach the process/teardown engine — sendSessionInput,
// sendSessionInterrupt, ensureLiveSession, endSession (below), readSessionFile, originOf — through the
// ServerContext; those definitions stay here (Phase-5 session-host territory).

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

// settlePermission + the three /api/permission* handlers moved to routes/permissions.ts (god-file split,
// Phase 1); settlePermission is imported at the top of this file so the teardown path below can call it.
// They reach the shared pending-prompt registry (fsState.pendingPermissions), liveSessions, and
// publishSession through the ServerContext.

// Deny every prompt a session still holds — the teardown path (terminate/done/exit). The human can no
// longer meaningfully answer, and a relay still waiting should hear an honest reason, not a hangup.
function denySessionPermissions(sid: string, message: string): void {
  for (const p of [...pendingPermissions.values()])
    if (p.sid === sid) settlePermission(p.permId, { behavior: "deny", message });
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

// /api/weather (Open-Meteo, keyed by a free-text location) now lives in routes/weather.ts — a fully
// self-contained extraction (god-file split, Phase 1); its route is spread into GLOBAL_ROUTES below.

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
  const markersDir = canvasSessionsDir(repoPath);
  try {
    fs.mkdirSync(markersDir, { recursive: true }); // so chokidar has a dir to watch before the first spawn
  } catch {
    /* best-effort — the watcher tolerates a missing dir, this just makes the watch immediate */
  }
  startSessionsFeed(boardId, sessionsDir(repoPath), markersDir);
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
// The type-registry ROUTE handlers (/api/card-types list + the raw /card-types/* asset serve) now live in
// routes/card-types.ts (god-file split, Phase 1), which OWNS the CARD_TYPES_DIR path and exports it. The
// WATCH feed below stays here for now (it's stateful — rides the "cardtypes" feed bus) and imports the dir:
// a template edit on disk pings the client, whose registry re-imports the module. CARD_TYPES_DIR is also
// imported by the HMR guard in configureServer (keep template files out of Vite's transform pipeline).

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

export interface SnapNode {
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

// How much of the backlog a not-yet-onboarded member should see, keyed `<threadId>|<sid>`. Set by an
// invite/join (or the /history action) that names a mode; consumed + cleared when member:open onboarding
// seeds the read cursor. ABSENT ⇒ the default, FULL history — a new member replays the whole backlog on
// their first inbox read (Slack public-channel style). "future" is the opt-out (start at the tail).
const pendingHistoryMode = (fsState.pendingHistoryMode ??= new Map<string, "full" | "future">());
const historyKey = (threadId: string, sid: string): string => `${threadId}|${sid}`;
// The read cursor that gives `sid` the chosen visibility of `log`: full ⇒ 0 (everything is unread), future
// ⇒ the current tail (only messages from here on). The single source of "how much backlog replays".
const seedCursor = (mode: "full" | "future", log: ThreadMsg[]): number =>
  mode === "future" && log.length ? log[log.length - 1]!.seq : 0;

// Part 2 — the work-intent self-freshen. A session going idle→running means a wake landed and it is
// computing again: the block (if any) has been ANSWERED, so no agent action is needed to retire it. Sweep
// every thread this session participates in and auto-transition any `blocked:*` it declared → `working`.
// Recording it as a real intent act (a kind:"intent" log entry + the marker slot) freshens BOTH surfaces
// uniformly — the roster pill (reads the log) and the rail state / deriveThreadState (reads the marker) —
// with a provenance note, and it converges (the next resume finds nothing). Part 1's pill fusion shows 'working'
// WHILE running; this makes the durable record honest so it doesn't snap back to a stale 'blocked' the
// moment the process idles again. Best-effort: a failure just leaves the (live-covered) view to part 1.
function clearBlockedIntents(repoPath: string, sid: string): void {
  const boardId = boardIdentity(repoPath).boardId;
  for (const meta of listThreads(repoPath)) {
    // ownBlockedIntentKeys is the pure (unit-tested) detection half — which of this thread's intent slots
    // hold a block THIS session itself declared (never another occupant's sacred, seat-inherited block).
    const keys = ownBlockedIntentKeys(meta.intents, sid);
    if (!keys.length) continue;
    const threadId = meta.threadId;
    // Append the freshening as a real intent act (kind:"intent" → renders on the thread + roster pill,
    // wakes no one) so the pill (which reads the log) un-stales; then overwrite the SAME marker slot(s) the
    // block sat in — the exact keys, not a re-derived seat key, so a sid-keyed block can't be stranded —
    // so the rail state / deriveThreadState (which reads the marker) agrees. Both surfaces freshen
    // uniformly, with a provenance note. Converges: the next resume finds nothing left to clear.
    const msg = appendThreadMsg(boardId, threadId, sid, intentLine("working", "auto: resumed — block answered"), {
      kind: "intent",
      intent: "working",
    });
    const next = { ...(readThreadMeta(repoPath, threadId)?.intents ?? {}) };
    for (const key of keys) next[key] = { intent: "working", ts: msg.ts, sid };
    upsertThreadMeta(repoPath, threadId, { intents: next });
  }
}

// Flip a live session to `running`, firing the idle→running side effects exactly ONCE on the transition
// (the guard makes a mid-turn running-set — every assistant/stream event — a no-op, so the thread sweep
// runs at most once per turn-start, not per event). The single chokepoint for "the process resumed".
function resumeRunning(s: LiveSession): void {
  if (s.status === "running") return;
  s.status = "running";
  try {
    clearBlockedIntents(s.repoPath, s.id);
  } catch {
    /* best-effort — part 1's live pill fusion already covers the running view */
  }
}

// Wire the ServerContext seam ONCE at module load (before configureServer runs). The references handed in
// are the same globalThis-pinned singletons the rest of this file holds, so a route handler lifted into a
// `routes/*.ts` module in a later phase reaches identical state via getServerContext() — no fork across a
// Vite hot re-eval (this call re-runs on a re-eval and re-points the pinned holder at the still-pinned
// singletons). No consumer in Phase 0; the seam is proved by typecheck matching this shape to the real state.
setServerContext({
  boards,
  liveSessions,
  fsState,
  defaultBoardId: DEFAULT_BOARD.boardId,
  reqBoard,
  rootDir,
  boardRoots,
  originOf,
  // State-dependent EFFECTS the Phase-1 route modules call (roles/permissions/boards/board-persist). The
  // definitions stay here; the seam only injects the operation so a route handler reaches shared state
  // without importing this file (no runtime cycle — server-context.ts type-imports only).
  publishFeed,
  publishSession,
  boardIdentity,
  readBoardRegistry,
  recordBoardOpened,
  ensureCanvasExcluded,
  startBoardFeeds,
  announceNewMemberships,
  maybeWakeDocWorker,
  // Threads / inbox / asks (Phase 3) — snapshot/log resolvers + delivery/wake/spawn effects the extracted
  // routes/{threads,inbox,asks}.ts call. Definitions stay here (the delivery/wake engine is Phase-5
  // territory); the seam injects the operations, same as the effects above.
  boardSnapshotRecords,
  threadNode,
  sessionNodeForSid,
  sessionNameForSid,
  threadMemberSids,
  sessionThreads,
  threadLog,
  seedCursor,
  historyKey,
  appendThreadMsg,
  wakeThreadMembers,
  publishThreadFeed,
  flushNudge,
  persistSessionState,
  dispatchBusCommand,
  forgetDurableMember,
  // Engine ops the extracted server-delivery.ts calls back into (defs still here; move in a later sub-step).
  maybeRespawnDormantSeat,
  ensureCoordinatorHeartbeat,
  recordDurableMember,
  trackEmittedMembership,
  sidFromSessionNode,
  nodeSessionId,
  MAX_THREAD_MSGS,
  republishThreadSeatOccupants,
  serverSpawnWorker,
  // Sessions (Phase 4) — the read/list + lifecycle/spawn route modules (routes/sessions.ts) reach the
  // session-host spawn/process engine + the transcript/feed machinery through these. Definitions stay here
  // (Phase-5 territory); the seam injects the operations, same as the effects above.
  sessionsDir,
  readSessionFile,
  sessionStatus,
  liveSessionCount,
  MAX_LIVE_SESSIONS,
  resolveSpawnCwd,
  placeWorkerCard,
  ensureLiveSession,
  sendSessionInput,
  sendSessionInterrupt,
  endSession,
  ensureSessionFeed,
});

// ── the route table (replaces the linear if/else ladder) ──────────────────────────────────────────
// The middleware below is a THREE-STAGE dispatcher, reproducing the exact staged-resolution gate the
// if/else ladder encoded: GLOBAL routes are tried first (each self-resolves its board via reqBoard where
// it needs one); if none match, the shared board gate resolves ?board= once (400 on unknown) and BOARD
// routes are tried; if none match, the shared root gate resolves ?root= once (400 on unknown) and ROOT
// routes are tried; a miss falls through to Vite via next(). Within each stage, entries are evaluated in
// array order — so exact-before-prefix/param ordering is just declaration order, preserved arm-for-arm.
// A route with a `method` only matches that verb and otherwise FALLS THROUGH to later entries, exactly as
// the ladder's `&& req.method === "POST"` arms did; a route without one matches any verb and branches on
// the method inside its handler (the ladder's `if (req.method === "POST") … else …` arms).
// The matcher combinators (exact/oneOf/prefix/re) + the three staged route shapes (GlobalRoute/BoardRoute/
// RootRoute) now live in routes/router.ts so an extracted route module declares its registrations in the
// same vocabulary; imported at the top of this file. Extracted concerns (Phase 1: weather, card-types)
// export a route array that is SPREAD into the stage table at the arm-order position their inline entry held.

// STAGE 1 — GLOBAL routes (tried before the shared board gate; board-scoped ones call reqBoard themselves).
const GLOBAL_ROUTES: GlobalRoute[] = [
  // The feeds stream is global (one connection per tab; feed names are themselves board-suffixed).
  { match: exact("/api/feeds"), run: (req, res) => handleFeeds(req, res) },
  // Session lifecycle + spawn (routes/sessions.ts): POST /api/session/spawn then POST /api/session/<id>/
  // {input,resume,interrupt,terminate,done} — same six arms, same order/method/gate-stage the inline entries
  // held. The load-bearing ordering (spawn exact → /<id>/* regex → the bare /api/session read below in
  // sessionReadRoutes) is preserved by the two spread points.
  ...sessionLifecycleRoutes,
  // Permission prompts (permission-prompt-tool): the relay's held POST, the card's decision buttons, and
  // the headless list. Ids are global UUIDs — no ?board= anywhere here. (routes/permissions.ts)
  ...permissionRoutes,
  // The channel-message read tool (routes/inbox.ts) — same GET arm, same position.
  ...inboxRoutes,
  // §16 the answerer's pending-consultation queue (routes/asks.ts) — same GET arm, same position.
  ...askRoutes,
  // Threads (routes/threads.ts): the POST /api/(thread|channel)/<id>/<action> verb-dispatch arm, then the
  // GET .../jobs and GET .../worktrees reads — same three arms, same order/method/gate-stage. The action
  // regex ordering relative to the bare /api/threads list below stays load-bearing (unchanged).
  ...threadRoutes,
  // Session read + list (routes/sessions.ts): GET /api/session (transcript tail) then GET /api/sessions
  // (list) — same two arms, same order/method/gate-stage, spread here after the thread routes and before
  // the bare /api/threads list, exactly where the inline entries sat.
  ...sessionReadRoutes,
  {
    match: oneOf("/api/threads", "/api/channels"),
    run: (_req, res, url) => {
      const b = reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return handleThreads(res, b.boardId, b.repoPath);
    },
  },
  ...roleRoutes, // /api/roles list + create (routes/roles.ts) — same arm, same position
  ...cardTypeRoutes, // /api/card-types (routes/card-types.ts) — same GET arm, same position
  ...boardRoutes, // /api/boards POST(mount)+GET(list) (routes/boards.ts) — same two arms, same order
  // The durable board store (step 4): the browser's persistence backends live here now. (routes/board-persist.ts)
  ...boardPersistRoutes,
  // The agent bus IS board-scoped now (Phase 3): ?board=<id> picks which board's tabs a command reaches and
  // which board's snapshot is read back (default board if omitted).
  {
    match: exact("/api/bus"),
    run: (req, res, url) => {
      const b = reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return void openSse(req, res, busClientsFor(b.boardId));
    },
  },
  {
    method: "POST",
    match: exact("/api/command"),
    run: (req, res, url) => {
      const b = reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return void handleCommand(req, res, b.boardId, originOf(req));
    },
  },
  {
    match: exact("/api/canvas"),
    run: (_req, res, url) => {
      const b = reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return handleCanvasGet(res, b.boardId);
    },
  },
  // Notebook outputs (§7 agent-legibility). The id is a node id carrying colons + a slashed path, so the
  // client percent-encodes it — match a non-slash segment and decode, exactly like channels.
  {
    match: re(/^\/api\/notebook\/([^/]+)\/outputs$/),
    run: (req, res, url, g) => {
      const b = reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      const id = decodeURIComponent(g[0]!);
      if (req.method === "POST") return void handleNotebookOutputsPush(req, res, b.boardId, id);
      return handleNotebookOutputsGet(res, b.boardId, id);
    },
  },
  ...weatherRoutes, // /api/weather (routes/weather.ts) — self-contained, same position
];

// STAGE 2 — BOARD routes (reached only after the shared board gate resolved `board`/`boardId`).
const BOARD_ROUTES: BoardRoute[] = [
  ...rootsBoardRoutes, // /api/roots (routes/roots.ts) — same arm, same position
  ...annotationBoardRoutes, // /api/annotations GET+POST (routes/annotations.ts) — same arm, same position
];

// STAGE 3 — ROOT routes (reached only after the shared root gate resolved the confined `root` dir).
const ROOT_ROUTES: RootRoute[] = [
  // The filesystem-serving surface (routes/files.ts): ls / file GET+POST / rename / delete / asset GET+POST /
  // watch — same arm order, method, and gate-stage the inline entries held.
  ...fileRootRoutes,
];

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

        // STAGE 1 — global routes (each self-resolves its board where it needs one).
        for (const r of GLOBAL_ROUTES) {
          if (r.method && req.method !== r.method) continue;
          const g = r.match(url.pathname);
          if (g) return r.run(req, res, url, g);
        }

        // The shared BOARD gate: the remaining endpoints are board-scoped: ?board=<boardId> picks which
        // mounted repo to serve (defaulting to the dev repo). Resolved ONCE here, then shared by the board-
        // and root-stage routes below — exactly as the ladder resolved it after the last global arm.
        const boardId = url.searchParams.get("board") ?? DEFAULT_BOARD.boardId;
        const board = boards.get(boardId);
        if (!board) return sendJson(res, 400, { error: "unknown board" });

        // STAGE 2 — board-scoped routes (before the root gate; `/api/annotations` resolves its own canonical root).
        for (const r of BOARD_ROUTES) {
          if (r.method && req.method !== r.method) continue;
          const g = r.match(url.pathname);
          if (g) return r.run(req, res, url, g, boardId, board);
        }

        // The shared ROOT gate: `root` is resolved to a confined dir from the board's KNOWN roots (never a
        // caller path), exactly as the single `board.root` was — an unknown rootId is rejected rather than
        // served. Resolved once, shared by every root-stage route below.
        const root = rootDir(boardId, url.searchParams.get("root"));
        if (!root) return sendJson(res, 400, { error: "unknown root" });

        // STAGE 3 — root-scoped file/asset/watch routes.
        for (const r of ROOT_ROUTES) {
          if (r.method && req.method !== r.method) continue;
          const g = r.match(url.pathname);
          if (g) return r.run(req, res, url, g, boardId, board, root);
        }
        return next();
      });
    },
  };
}
