import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { watchRoot } from "./shadow-git.js";
import { canvasSessionsDir, recordSessionEnd } from "./session-ledger.js";
import { type SessionProc } from "./session-proc.js";
import { type SessionHostClient } from "./session-host-client.js";
import { listThreads, migrateChannelLedger, readSeenMentions, seatForSid, type ThreadMetaMarker } from "./thread-ledger.js";
import { humanWaiting, cardOnly } from "./thread-waiting.js";
import { connectedEdgeIds } from "./node-cascade.js";
import { intentLine, type WorkIntent } from "./work-intent.js";
import { deriveThreadState } from "./thread-state.js";
import { parseWorktreePorcelain } from "./worktrees.js";
import { boardPersistMtime, describeBoardEvents, readBoardPersist } from "./board-persist.js";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { sendJson, readBody, openSse, type SseClient } from "./server-http.js";
import { getWsClients, setServerContext } from "./server-context.js";
import { announceNewMemberships, appendThreadMsg, dispatchBusCommand, drainPendingBusReplay, ensureCommandId, flushNudge, publishThreadFeed, wakeThreadMembers } from "./server-delivery.js";
import { attachSessionHost, autoWakeReapTick, endSession, ensureLiveSession, ensureSessionFeed, liveSessionCount, MAX_LIVE_SESSIONS, MAX_SESSION_BYTES, persistSessionState, placeWorkerCard, publishSession, readSessionFile, reconcileSessionBands, republishThreadSeatOccupants, resolveSpawnCwd, sendSessionInput, sendSessionInterrupt, serverSpawnWorker, sessionsDir, sessionStatus } from "./server-sessions.js";
import { boardSnapshotRecords, forgetDurableMember, historyKey, MAX_THREAD_MSGS, nodeSessionId, recordDurableMember, seedCursor, seedThreadLogs, sessionNameForSid, sessionNodeForSid, sessionThreads, sidFromSessionNode, threadLog, threadMemberSids, threadNode, trackEmittedMembership } from "./server-snapshot.js";
import { ensureCoordinatorHeartbeat, foldShadowEdits, maybeRespawnDormantSeat, maybeWakeDocWorker, originOf, publishFeed, startCardTypesFeed, startGitHeadFeed, startHnFeed, startLoopHeartbeat, startRolesFeed, startSessionsFeed, startThreadsFeed, startUsageFeed, syncShadowRoots } from "./server-orchestration.js";
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
import { kernelRoutes } from "./routes/kernel.js";
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

// sessionsDir (a board's Claude-Code transcripts dir) moved to server-sessions.ts (P5 sub-step 3).

// sessionTranscriptDir (the per-session transcripts-dir resolver) moved to routes/sessions.ts (god-file
// split, Phase 4) — only the session read/resume routes called it. It reaches sessionsDir through the
// ServerContext (sessionsDir stays here: the sessions-feed startup + the live-tail seed still call it).

// boardRootForCwd (worktree-cwd → canonical board root) moved to server-sessions.ts (P5 sub-step 2).

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

// MAX_SESSION_BYTES moved to server-sessions.ts (P5 sub-step 3); handleNotebookOutputsPush imports it.

// The filesystem-serving / confinement helpers (EXCLUDE_DIRS, isInternalPath, TEXT_EXT, IMAGE_EXT/MIME,
// MAX_ASSET_BYTES, safeResolve, fileVersion, openRootWatcher) now live in the stateless server-fs.ts seam
// (alongside MAX_BYTES/readText in server-http.ts) so the extracted file/asset/watch/annotation route modules
// share one definition. Only isInternalPath (the shadow-git ignore predicate) and openRootWatcher (the WS
// file-watch) still have callers HERE, so those two are imported back at the top of this file.

// readSessionFile (one transcript's tail-capped read) moved to server-sessions.ts (P5 sub-step 3).

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
// endReasonBand / hasScheduledWake / sessionStatus (the ONE whole-session status band) moved to
// server-sessions.ts (P5 sub-step 3). The SessionBand type stays in the shell (above).

// handleSessions (GET /api/sessions) moved to routes/sessions.ts (god-file split, Phase 4). It reaches
// sessionStatus through the ServerContext (sessionStatus stays here — the band-republish loop calls it too).

// startSessionsFeed moved to server-orchestration.ts (P5 sub-step 3).

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

// startThreadsFeed moved to server-orchestration.ts (P5 sub-step 3).

// startRolesFeed moved to server-orchestration.ts (P5 sub-step 3).

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
export interface WsClient {
  boardId: string; // fixed at connect (?board=) — bus commands fan out per board
  watches: Map<string, () => void>; // rootId → watcher close ({sub:"watch"} subscriptions)
  send(msg: unknown): void;
}
// A bus command held for later replay: the same shape dispatchBusCommand broadcasts. Buffered per board
// when a creation command (addNode/addEdge) reached no live tab (Bug A/C persist-gap), replayed on the
// next ws-attach so a tab applies + PERSISTS it into the durable store (what GET /api/canvas serves).
export interface PendingBusCommand {
  type: string;
  payload?: Record<string, unknown>;
  actor?: string;
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
  pendingAsks?: Map<string, PendingAsk>; // §16 askId → held consultation (lazy-init via getPendingAsks in server-context.ts)
  pendingPermissions?: Map<string, PendingPermission>; // permId → held permission prompt (lazy-init via getPendingPermissions)
  wsClients?: Set<WsClient>; // connected /api/ws tabs (lazy-init via getWsClients)
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
  liveKernels?: Map<string, unknown>; // boardId\0nodeId → live Jupyter kernel (server-kernel.ts; typed there to avoid a cycle; lazy-init via `??=`)
  announcedMemberships?: Set<string>; // edgeId|phase dedup for onboarding announcements
  pendingHistoryMode?: Map<string, "full" | "future">; // threadId|sid → backlog visibility for a not-yet-onboarded member (lazy-init via getPendingHistoryMode)
  lastEventSeq?: Map<string, number>; // boardId → highest event seq appended (the second-writer tripwire)
  pendingBusReplay?: Map<string, PendingBusCommand[]>; // boardId → creation commands that reached no live tab, replayed on the next ws-attach (Bug A/C persist-gap)
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
// pendingAsks / pendingPermissions / wsClients / pendingHistoryMode are NOT aliased or `??=`-inited here:
// each reaches its map through its lazy accessor in server-context.ts (getPendingAsks / getPendingPermissions
// / getWsClients / getPendingHistoryMode), so no consumer — shell, engine module, route, or test fake —
// depends on a shell load-order side effect. The shell's own wsClients readers below use getWsClients(fsState).

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

// publishFeed (the off-log feed-bus write) moved to server-orchestration.ts (P5 sub-step 3). handleFeeds (below)
// + attachWs stay in the shell (SSE/WS transport) and read fsState.feedClients/feedValues directly.

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
      getWsClients(fsState).add(client);
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
      // Persist-gap replay (Bug A/C): creation commands (a summon's session card + member:open edge, a
      // headless /api/command addNode) that reached NO live tab were buffered — the bus is a broadcast
      // relay and the durable store GET /api/canvas serves is written only by a tab's Persistence save.
      // Hand them to THIS freshly-attached tab so it applies + persists them; first attacher drains the
      // buffer (a second tab hydrates the now-persisted records rather than re-applying a duplicate).
      for (const cmd of drainPendingBusReplay(b.boardId)) client.send({ ch: "bus", cmd });
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
        getWsClients(fsState).delete(client);
      });
    });
  });
}

// startGitHeadFeed (the repo-HEAD commit feed) moved to server-orchestration.ts (P5 sub-step 3).

// The live-session feed + spawn/permission consts, collabBrief, ensureSessionFeed/stopSessionFeed (P5
// sub-step 2) and the persist/publish/status cluster + MAX_SESSION_FEED_BYTES (P5 sub-step 3) all live in
// server-sessions.ts now. The LiveSession + ContentBlock TYPES stay in the shell below (shared vocabulary).

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

// persistSessionState / permissionsOf / publishSession / republishThreadSeatOccupants moved to
// server-sessions.ts (P5 sub-step 3 — folded into the session engine, alongside sessionStatus/readSessionFile).

// The session-engine stdout-fold helpers (ctxOf/toolVerb/foldSessionEvent/seedFromTranscript/workerBrief),
// ensureLiveSession, the session-host client (REMOTE_SESSIONS/attachSessionHost/adoptSession/wireSessionHooks),
// and sendSessionInput moved to server-sessions.ts (P5 sub-step 2).

// The channel thread-log (threadLog/seedThreadLogs/MAX_THREAD_MSGS) + the emitted/durable membership
// registry (sidFromSessionNode/liveEmittedMembers/trackEmittedMembership/recordDurableMember/
// forgetDurableMember) + sessionThreads moved to server-snapshot.ts (P5 sub-step 3).

// The operating-loop heartbeat (LOOP_TICK_MS/loopTick/startLoopHeartbeat) moved to server-orchestration.ts
// (P5 sub-step 3). loopTick drives autoWakeReapTick + standingJobsTick + reconcileSessionBands; startBoardFeeds imports startLoopHeartbeat.

// sendSessionInterrupt moved to server-sessions.ts (P5 sub-step 2).

// originOf (+ lastKnownOrigin, the server-fired-spawn origin seed) moved to server-orchestration.ts (P5 sub-step 3).

// The spawn-cap consts (MAX_LIVE_SESSIONS) + liveSessionCount/placeWorkerCard/resolveSpawnCwd moved to server-sessions.ts (P5 sub-step 2).

// handleSessionSpawn (POST /api/session/spawn) moved to routes/sessions.ts (god-file split, Phase 4). It
// reaches the spawn primitives it shares with serverSpawnWorker below — liveSessionCount / MAX_LIVE_SESSIONS
// / resolveSpawnCwd / placeWorkerCard / ensureLiveSession / sendSessionInput — plus the snapshot/thread
// resolvers, through the ServerContext; those definitions stay here (Phase-5 engine territory).

// serverSpawnWorker (the server-spawn-from-a-durable-record primitive) moved to server-sessions.ts (P5 sub-step 2).

// docWorkerBrief/dormantWakeBrief + maybeWakeDocWorker (doc-wake) + maybeRespawnDormantSeat (dormant-seat
// respawn) moved to server-orchestration.ts (P5 sub-step 3); both wake ops stay ctx ops for the routes/delivery.

// autoWakeReapTick (the idle-worker keep-alive reaper) moved to server-sessions.ts (P5 sub-step 2); loopTick calls it via the import.

// standingJobNudge + ensureCoordinatorHeartbeat + standingJobsTick (the standing-jobs firing loop) moved to
// server-orchestration.ts (P5 sub-step 3). ensureCoordinatorHeartbeat stays a ctx op (server-delivery calls it).

// handleSessionInput / handleSessionResume / handleSessionInterrupt / handleSessionTerminate /
// handleSessionDone (POST /api/session/<id>/{input,resume,interrupt,terminate,done}) moved to
// routes/sessions.ts (god-file split, Phase 4). They reach the process/teardown engine — sendSessionInput,
// sendSessionInterrupt, ensureLiveSession, endSession (below), readSessionFile, originOf — through the
// ServerContext; those definitions stay here (Phase-5 session-host territory).

// endSession (the shared /terminate + /done teardown) moved to server-sessions.ts (P5 sub-step 2).

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

// denySessionPermissions (teardown deny-all) moved to server-sessions.ts (P5 sub-step 2).

// The HN feed (startHnFeed) + the usage feed (startUsageFeed + readClaudeOAuthToken/claudeUserAgent/
// USAGE_POLL_MS) moved to server-orchestration.ts (P5 sub-step 3); startFeeds imports startHnFeed/startUsageFeed.

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

// ── shadow-git committer moved to server-orchestration.ts (P5 sub-step 3): shadowRoots/SHADOW_SETTLE_MS/
// shadowIgnored/EDIT_TOOL_PATH/shadowTargetFor/foldShadowEdits/syncShadowRoots. The ShadowRootHandle type
// stays in the shell (it types CanvasFsState.shadowRoots); startWorktreesFeed/startBoardFeeds import syncShadowRoots.

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

// startCardTypesFeed (the template-edit watch feed) moved to server-orchestration.ts (P5 sub-step 3).

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
  return (busClients.get(boardId)?.size ?? 0) + [...getWsClients(fsState)].filter((c) => c.boardId === boardId).length;
}

// T3c helper: tear down every edge touching `nodeId` before its removeNode lands. Emits a removeEdge over
// the bus for each connected edge (connectedEdgeIds off the durable snapshot) so the cascade is server-
// authoritative, and — for a session card — also drops its member edges from the emitted-membership bridge,
// including any join still inside the ~400ms save window (the snapshot wouldn't list those yet). Idempotent:
// re-removing an edge the store already dropped is a no-op.
function cascadeNodeEdges(boardId: string, nodeId: string, actor: string, origin: string): void {
  const emittedMembers = (fsState.emittedMembers ??= new Map<string, { thread: string; sid: string; ts: number }>());
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
  // Bug B/C: mint the created node/edge id SERVER-side when the caller omits it, so a headless caller can
  // ADDRESS what it just created. ensureCommandId writes the id into `cmd.payload` (so the tab we broadcast
  // to uses it rather than minting its own) and returns it to echo in the response. null for non-create
  // commands, which carry no created id.
  const createdId = ensureCommandId(cmd as { type?: string; payload?: unknown });
  // Broadcast to the board's tabs (+ fire the membership announce if it's a member:* edge). delivered=0
  // tells the agent no tab for THIS board is listening — the command went nowhere.
  const delivered = dispatchBusCommand(boardId, cmd as { type: string; payload?: Record<string, unknown>; actor?: string }, origin);
  sendJson(res, delivered > 0 ? 200 : 503, { ok: delivered > 0, delivered, board: boardId, ...(createdId ? { id: createdId } : {}) });
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

// The snapshot/log resolvers (boardSnapshotRecords, nodeSessionId, sessionNodeForSid, threadNode,
// sessionNameForSid, threadMemberSids) + the backlog-visibility seed (seedCursor/historyKey) moved to
// server-snapshot.ts (P5 sub-step 3). pendingHistoryMode is reached via fsState (routes/threads.ts).

// clearBlockedIntents + resumeRunning (the idle→running self-freshen) moved to server-sessions.ts (P5 sub-step 2).

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
  // Engine op the extracted server-sessions.ts calls back into: foldSessionEvent folds an assistant tool_use /
  // user tool_result into the shadow-git committer. Its def is the shadow-git cluster (P5 sub-step 3), so it
  // stays in the shell for now and the seam injects it, exactly like the delivery ops above.
  foldShadowEdits,
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
  // Jupyter kernel broker (routes/kernel.ts, Path B): POST /api/kernel/<nodeId>/{run,run-all,interrupt,
  // restart,shutdown}. Node id is a percent-encoded PATH segment (carries node:<root>:<path>), board is
  // ?board= — self-resolved like the session /<id>/* routes. Distinct path prefix, so array position is free.
  ...kernelRoutes,
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
