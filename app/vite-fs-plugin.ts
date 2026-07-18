import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { canvasSessionsDir, recordSessionEnd } from "./session-ledger.js";
import { type SessionProc } from "./session-proc.js";
import { migrateChannelLedger } from "./thread-ledger.js";
import { cardOnly } from "./thread-waiting.js";
import { intentLine, type WorkIntent } from "./work-intent.js";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { sendJson, openSse, originHostAllowed, type SseClient } from "./server-http.js";
import type { CanvasFsState, LiveSession, ThreadMsg, WsClient } from "./server-types.js";
import { boardIdentity, boardRoots, boards, DEFAULT_BOARD, ensureCanvasExcluded, invalidateBoardRoots, readBoardRegistry, recordBoardOpened, reqBoard, rootDir } from "./server-boards.js";
import { getBusClients, getWsClients, setServerContext } from "./server-context.js";
import { announceNewMemberships, appendThreadMsg, dispatchBusCommand, flushNudge, publishThreadFeed, wakeThreadMembers } from "./server-delivery.js";
import { attachSessionHost, autoWakeReapTick, endSession, ensureLiveSession, ensureSessionFeed, isScratchBoard, liveSessionCount, MAX_LIVE_SESSIONS, PERMISSION_HOLD_MS, persistSessionState, placeWorkerCard, publishSession, readSessionFile, reconcileSessionBands, republishThreadSeatOccupants, resolveSpawnCwd, sendSessionInput, sendSessionInterrupt, serverSpawnWorker, sessionsDir, sessionSpawnRefusal, sessionStatus, settlePermission } from "./server-sessions.js";
import { boardSnapshotRecords, captureMemberOffsets, captureReopenSets, forgetDurableMember, historyKey, MAX_THREAD_MSGS, nodeSessionId, recordDurableMember, seedCursor, seedThreadLogs, sessionAnchor, sessionNameForSid, sessionNodeForSid, sessionThreads, sidFromSessionNode, threadLog, threadMemberSids, threadNode, trackEmittedMembership } from "./server-snapshot.js";
import { ensureCoordinatorHeartbeat, foldShadowEdits, maybeRespawnDormantSeat, maybeWakeDocWorker, originOf, publishFeed, startCardTypesFeed, startGitHeadFeed, startGitLogFeed, startHnFeed, startLoopHeartbeat, startRolesFeed, startSessionsFeed, startThreadsFeed, startUsageFeed, syncShadowRoots } from "./server-orchestration.js";
import { foldCodexEvent } from "./codex-projection.js";
import type { GlobalRoute, BoardRoute, RootRoute } from "./routes/router.js";
import { exact, oneOf, prefix, re } from "./routes/router.js";
import { weatherRoutes } from "./routes/weather.js";
import { feedRoutes } from "./routes/feed.js";
import { cardTypeRoutes, handleCardTypeAsset } from "./routes/card-types.js";
import { roleRoutes } from "./routes/roles.js";
import { permissionRoutes } from "./routes/permissions.js";
import { boardRoutes } from "./routes/boards.js";
import { boardPersistRoutes } from "./routes/board-persist.js";
import { fileRootRoutes } from "./routes/files.js";
import { annotationBoardRoutes } from "./routes/annotations.js";
import { rootsBoardRoutes } from "./routes/roots.js";
import { inboxRoutes } from "./routes/inbox.js";
import { askRoutes } from "./routes/asks.js";
import { threadRoutes, threadListRoutes } from "./routes/threads.js";
import { sessionLifecycleRoutes, sessionReadRoutes } from "./routes/sessions.js";
import { kernelRoutes } from "./routes/kernel.js";
import { notebookRoutes } from "./routes/notebook.js";
import { canvasRoutes } from "./routes/canvas.js";
import { shutdownKernel } from "./server-kernel.js";
import { CARD_TYPES_DIR, isInternalPath, openDirWatcher, safeResolve } from "./server-fs.js";

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

// The board registry / identity / ROOTS engine (boardIdentity, the boards map + its durable registry,
// reqBoard, boardRoots/rootDir, ensureCanvasExcluded, and the boot-remount/prune side effects) moved to
// server-boards.ts (F-S3). Every external consumer reaches it through the ServerContext; the shell imports
// the pieces it still uses directly (boards, DEFAULT_BOARD, reqBoard, boardRoots, rootDir, boardIdentity) at
// the top of this file.

// boardIds whose repo-scoped feeds (githead + sessions-list) are already running — also pinned, since the
// surviving watchers from before a re-eval keep publishing (they close over the pinned feedClients/Values).
const boardFeedsStarted: Set<string> = ((globalThis as { __canvasBoardFeeds?: Set<string> })
  .__canvasBoardFeeds ??= new Set());

// The /api/threads + /api/channels list (handleThreads) and its §8 step-3 participant projection
// (threadParticipants) moved to routes/threads.ts — they read the roster/seats/live-registry through the
// ServerContext seam, alongside the rest of the thread routes.


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
// A card-only entry never wakes a member and never counts as inbox content — the shared gate for every
// unread filter (an agent's own bookkeeping must not wake the room). `cardOnly` is shared with
// thread-waiting.js's human-waiting derivation so the two can't drift on what counts as bookkeeping.
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
      answerRequest: () => false,
      kill: () => legacy.kill(),
    };
  }
}

// handleFeeds (below) + attachWs are the shell's SSE/WS transport — they read fsState.feedClients/
// feedValues directly (the publishFeed write side lives in server-orchestration.ts).

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

// The minimal ws surface the heartbeat reaper touches (the real `ws` WebSocket satisfies it; a test can
// pass a fake). `on("pong", …)` re-arms the liveness flag; `terminate()` force-closes a half-open socket
// (which fires the existing ws.on("close"), the ONE WsClient removal path); `ping()` probes.
interface HeartbeatWs {
  readyState: number;
  OPEN: number;
  on(event: "pong", cb: () => void): void;
  ping(): void;
  terminate(): void;
}

// Standard ws heartbeat reaper (exported for direct test). Each tick: if the socket missed the previous
// ping (no pong arrived since it was armed), terminate it — that fires ws.on("close") which removes the
// WsClient, so an orphaned board-switch socket is reaped within ~2 intervals (~50s). Otherwise re-arm
// isAlive=false and ping. Returns the interval handle so the close handler can clearInterval it.
export function installWsHeartbeat(ws: HeartbeatWs, intervalMs = 25000): ReturnType<typeof setInterval> {
  let isAlive = true;
  ws.on("pong", () => {
    isAlive = true;
  });
  return setInterval(() => {
    if (!isAlive) return void ws.terminate();
    isAlive = false;
    if (ws.readyState === ws.OPEN) ws.ping();
  }, intervalMs);
}

// The (root, dir) watch key — one string, so client.watches keys on the PAIR (a directory watch belongs to
// its root). NUL can't occur in a path or a root slug, so it's an unambiguous separator.
export function watchKey(root: string, dir: string): string {
  return root + "\0" + dir;
}

// Open ONE depth-0 directory watcher for this socket, keyed (root, dir) and idempotent per pair (the client
// refcounts multiple card subscribers of a (root, dir) down to a single sub message, so a repeat sub is a
// no-op guard, never a leaked watcher). Confinement mirrors GET /api/watch: `root` must be one of this
// BOARD's known roots (resolveRoot), and `dir` must resolve WITHIN that root (safeResolve) — a caller can't
// watch an arbitrary path. `resolveRoot`/`open` are injected so the keying + confinement is unit-testable
// without a live server (attachWs passes the real rootDir + openDirWatcher). Events are streamed back tagged
// with (root, dir) so the client routes each to the right subscription.
export function openClientWatch(
  client: WsClient,
  root: string,
  dir: string,
  resolveRoot: (boardId: string, root: string) => string | null,
  open: (absDir: string, relBase: string, send: (ev: { type: string; path: string }) => void) => () => void,
): void {
  const key = watchKey(root, dir);
  if (client.watches.has(key)) return; // already watching this (root, dir) on this socket
  const rootAbs = resolveRoot(client.boardId, root);
  if (!rootAbs) return; // unknown root for this board — refuse (same confinement as /api/watch)
  const absDir = safeResolve(rootAbs, dir);
  if (!absDir) return; // `dir` escapes the root — refuse
  client.watches.set(
    key,
    open(absDir, rootAbs, (ev) => {
      client.send({ ch: "watch", root, dir, ev });
      // BUG-3: a deleted `.ipynb` can't be re-run, so reap its kernel rather than leaving a stray Python
      // process bound to a file that no longer exists. Node id is `node:<root>:<relPath>` (routes/kernel.ts
      // parseNodeId); shutdownKernel is a no-op when no kernel is live for it. ev.path is ROOT-relative
      // (relBase = rootAbs), so the id is right regardless of which directory watcher delivered the unlink.
      if (ev.type === "unlink" && ev.path.toLowerCase().endsWith(".ipynb")) {
        void shutdownKernel(client.boardId, `node:${root}:${ev.path}`);
      }
    }),
  );
}

// Close this socket's watcher for one (root, dir), if present — the {unsub:"watch"} twin.
export function closeClientWatch(client: WsClient, root: string, dir: string): void {
  const key = watchKey(root, dir);
  client.watches.get(key)?.();
  client.watches.delete(key);
}

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
    // Origin/Host allowlist (pre-push audit, MEDIUM): a cross-origin page or a DNS-rebind Host must not
    // open a board/feed read socket. Same rule as the HTTP dispatcher; reject with a raw 403 + destroy.
    if (!originHostAllowed(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const b = reqBoard(url);
      if (!b) return void ws.close(4400, "unknown board");
      const client: WsClient = {
        boardId: b.boardId,
        tab: url.searchParams.get("tab") ?? undefined, // stable per-tab id — dedupes board-switch overlap
        watches: new Map(),
        send(msg) {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
      };
      getWsClients(fsState).add(client);
      {
        // §9 stage 2: the server is now the single event-seq sequencer (bus commits + the /event echo both
        // mint from its one counter), so extra tabs no longer collide on seqs. They DO still each write the
        // debounced snapshot.json (a cache — the 409 stale-guard keeps it monotonic), so a second connection
        // stays worth logging; the ua tells a leaked headless probe from a second real browser.
        const tabs = tabCountFor(b.boardId);
        if (tabs > 1)
          console.warn(
            `[boards] ${tabs} tabs now live on ${b.boardId} — multiple tabs still race the debounced snapshot ` +
              `save (cache only; event seqs are server-sequenced). ua: ${req.headers["user-agent"] ?? "?"}`,
          );
      }
      for (const [feed, value] of feedValues) client.send({ ch: "feed", feed, value }); // replay, like handleFeeds
      // §9 stage 2: the persist-gap replay buffer is retired. A bus command is now committed + made durable
      // server-side at /api/command (with or without a live tab), so a freshly-attached tab hydrates every
      // created node/edge from the durable store via its boot GET /api/board/persist — there is nothing left
      // to hand-replay on attach.
      // Heartbeat reaper (see installWsHeartbeat): a board switch is a full-page nav, so the old page's
      // socket should close — but an abrupt document teardown can lose the close frame, leaving a half-open
      // socket filed forever under the same board id. That was the phantom "N tabs now live" over-count;
      // the reaper terminates a socket that missed its ping, which fires ws.on("close") to remove the client.
      const ping = installWsHeartbeat(ws);
      ws.on("message", (data) => {
        let msg: { sub?: unknown; unsub?: unknown; root?: unknown; dir?: unknown };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        // The watch protocol keys on (root, dir): the client subscribes the specific DIRECTORIES that hold a
        // live dependency, not the whole root (docs/root-watcher-fd-scaling.md). Both fields are required;
        // `dir` may be "" (the root's own top level, for a file card at the root). rootDir + safeResolve
        // confinement, the (root, dir) keying, and the .ipynb kernel-reap all live in openClientWatch.
        const root = typeof msg.root === "string" ? msg.root : null;
        const dir = typeof msg.dir === "string" ? msg.dir : null;
        if (root == null || dir == null) return;
        if (msg.sub === "watch") openClientWatch(client, root, dir, rootDir, openDirWatcher);
        else if (msg.unsub === "watch") closeClientWatch(client, root, dir);
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

// liveSessions lives on fsState (aliased at the top) so spawned children survive a server reload and
// stay reachable; sessionCleanupHooked is read/written through fsState so the process-exit kill hook
// is installed exactly once across reloads, not stacked.

// ── Permission prompts: the relay's held POST + the card's decision buttons ──────────────────────────
// The server half of --permission-prompt-tool (see PERMISSION_HOLD_MS at the top): the per-session MCP
// relay POSTs each would-prompt permission check here and the connection PARKS until a human clicks
// allow/deny on the session card (or the hold times out → an honest fail-closed deny). The pending set
// rides the session's feed (`permissions`) so the card paints buttons + the loud waiting band, and
// /api/sessions' status derives "waiting" from it (sessionStatus) so the minimap/list/stack agree.

// The three /api/permission* handlers live in routes/permissions.ts (god-file split, Phase 1); settlePermission
// + PERMISSION_HOLD_MS live in the session engine (server-sessions.ts) and are imported at the top of this file
// so the teardown path below can call settlePermission. They reach the shared pending-prompt registry
// (fsState.pendingPermissions), liveSessions, and publishSession through the ServerContext.

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
    invalidateBoardRoots(boardId);
    syncShadowRoots(boardId, repoPath); // provision/teardown shadow committers as worktrees appear/vanish
    publishFeed("roots:" + boardId, { ts: Date.now() });
  };
  chokidar
    .watch(dir, { ignoreInitial: true, depth: 0 })
    .on("addDir", ping)
    .on("unlinkDir", ping);
}


function startBoardFeeds(boardId: string, repoPath: string): void {
  if (boardFeedsStarted.has(boardId)) return;
  boardFeedsStarted.add(boardId);
  startGitHeadFeed(boardId, repoPath);
  startGitLogFeed(boardId, repoPath); // the board repo's recent commit log, under the generic `data:*` namespace
  const markersDir = canvasSessionsDir(repoPath);
  try {
    fs.mkdirSync(markersDir, { recursive: true }); // so chokidar has a dir to watch before the first spawn
  } catch {
    /* best-effort — the watcher tolerates a missing dir, this just makes the watch immediate */
  }
  startSessionsFeed(boardId, sessionsDir(repoPath), markersDir);
  migrateChannelLedger(repoPath); // one-time §8 step 2 rename: `.canvas/channels/` → `.canvas/threads/`
  seedThreadLogs(repoPath); // restore thread conversations from `.canvas/threads/` (cold-restart fix)
  startThreadsFeed(boardId, repoPath); // live-push the list rail as threads gain activity
  startRolesFeed(boardId, repoPath); // live-push the roles-list rail as roles are created/edited
  // No shadow machinery on a scratch/test board (tmpdir or noSessions): a tmpdir repo is not a git repo, so
  // the shadow committer and its worktrees watcher just spew `[shadow] … add failed: fatal: not a git
  // repository` / bare `fatal: not a git repository` from git probes against a throwaway tree. Skip both at
  // the source (real boards are unaffected). The rest of the feeds are cheap and harmless on a scratch board.
  if (!isScratchBoard(boardId)) {
    startWorktreesFeed(boardId, repoPath); // .git/worktrees watcher → re-sync shadow roots as trees appear/vanish
    syncShadowRoots(boardId, repoPath); // shadow-git committer per root + boot-reconcile (step 1)
  }
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

const busClients = getBusClients(fsState);

// How many tabs can ACT on this board right now — the same census dispatchBusCommand's `delivered` is
// judged against (the app's tabs ride /api/ws; the SSE set is the compat path). The `tabs` liveness
// signal on GET /api/canvas. WS clients are deduped by their stable per-tab id (?tab=), so a board-switch
// overlap — the old page's socket lingering until the reaper takes it — counts as ONE tab, not two;
// untagged/legacy WS connections have no id and each count individually. The SSE busClients keep counting
// as before (one compat path per connection).
export function tabCountFor(boardId: string): number {
  const tabs = new Set<string>();
  let untagged = 0;
  for (const c of getWsClients(fsState)) {
    if (c.boardId !== boardId) continue;
    if (c.tab) tabs.add(c.tab);
    else untagged++;
  }
  return (busClients.get(boardId)?.size ?? 0) + tabs.size + untagged;
}

// The agent-bus core handlers — /api/bus (SSE), POST /api/command (+ its removeNode edge-cascade), and
// GET /api/canvas (the durable board read) — moved to routes/canvas.ts. tabCountFor (above) stays: the
// transport owns the client sets it counts, and the seam exposes it to the extracted /api/canvas handler.

// The notebook-outputs relay (POST/GET /api/notebook/<id>/outputs) moved to routes/notebook.ts; its
// last-push map lives on the pinned fsState (fsState.lastNotebookOutputs), reached via getServerContext.

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
  sessionAnchor,
  captureMemberOffsets,
  captureReopenSets,
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
  sessionSpawnRefusal,
  MAX_LIVE_SESSIONS,
  resolveSpawnCwd,
  placeWorkerCard,
  ensureLiveSession,
  sendSessionInput,
  sendSessionInterrupt,
  endSession,
  ensureSessionFeed,
  // Engine op the extracted server-sessions.ts calls back into: foldSessionEvent folds an assistant tool_use /
  // user tool_result into the shadow-git committer. Its def lives in server-orchestration.ts (with the
  // shadow-git cluster); the seam injects it here, exactly like the delivery ops above.
  foldShadowEdits,
  // Codex event fold — def in codex-projection.ts (dev-server half of the codex-* family); foldSessionEvent
  // dispatches a codex_event frame to it via the seam, same as foldShadowEdits.
  foldCodexEvent,
  // The live-tab census: def stays here (the transport owns the client sets); the seam exposes it to the
  // extracted /api/canvas handler (routes/canvas.ts).
  tabCountFor,
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
// RootRoute) live in routes/router.ts (imported at the top) so an extracted route module declares its
// registrations in the same vocabulary; each exports a route array SPREAD into the stage table at the
// arm-order position its inline entry held.

// The dispatch seam's error boundary (BUG-4b). A route's `run` is typed `void` but most handlers are async;
// a synchronous throw OR a rejected promise used to escape the dispatcher as an UNHANDLED rejection — never a
// response — hanging the request and risking a process-level crash on unhandled rejections. Funnel both here:
// call the handler inside a try, and if it returned a thenable attach a `.catch`. On either failure, log with
// the method+path for triage and send a 500 — but ONLY when nothing has been written yet (`!headersSent`), so
// a handler that already started a response (an SSE stream, a partial body) that later errors is logged
// without corrupting or double-writing its stream. One boundary retires the whole unhandled-rejection class.
export function runRoute(req: IncomingMessage, res: ServerResponse, url: URL, run: () => unknown): void {
  const onError = (err: unknown) => {
    console.error(`[api] unhandled handler error for ${req.method ?? "?"} ${url.pathname}:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  };
  try {
    const r = run();
    if (r != null && typeof (r as { then?: unknown }).then === "function") (r as Promise<unknown>).catch(onError);
  } catch (err) {
    onError(err);
  }
}

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
  ...threadListRoutes, // GET /api/threads + /api/channels list (routes/threads.ts) — same arm, same position
  ...roleRoutes, // /api/roles list + create (routes/roles.ts) — same arm, same position
  ...cardTypeRoutes, // /api/card-types (routes/card-types.ts) — same GET arm, same position
  ...boardRoutes, // /api/boards POST(mount)+GET(list) (routes/boards.ts) — same two arms, same order
  // The durable board store (step 4): the browser's persistence backends live here now. (routes/board-persist.ts)
  ...boardPersistRoutes,
  // The agent-bus core: /api/bus (SSE), POST /api/command, GET /api/canvas (routes/canvas.ts) — same three
  // arms, same order/method/gate-stage the inline entries held.
  ...canvasRoutes,
  ...notebookRoutes, // /api/notebook/<id>/outputs GET+POST (routes/notebook.ts) — same arm, same position
  ...weatherRoutes, // /api/weather (routes/weather.ts) — self-contained, same position
];

// STAGE 2 — BOARD routes (reached only after the shared board gate resolved `board`/`boardId`).
const BOARD_ROUTES: BoardRoute[] = [
  ...feedRoutes, // POST /api/feed/<name> (routes/feed.ts) — data:* publish, board-scoped via the shared gate
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
        // Origin/Host allowlist (pre-push audit, MEDIUM): reject any /api/ request whose Host is not a
        // loopback host (DNS-rebind guard) or that carries a foreign Origin (cross-origin browser fetch).
        // No-Origin CLI/agent-bus/sidecar traffic and same-origin browser traffic pass untouched. Scoped to
        // /api/ — the static /card-types/ assets are read-only module fetches the app itself loads same-origin.
        if (req.url.startsWith("/api/") && !originHostAllowed(req.headers.origin, req.headers.host))
          return sendJson(res, 403, { error: "forbidden: origin/host not allowed" });
        const url = new URL(req.url, "http://localhost");
        if (url.pathname.startsWith("/card-types/")) return handleCardTypeAsset(res, url.pathname);

        // STAGE 1 — global routes (each self-resolves its board where it needs one).
        for (const r of GLOBAL_ROUTES) {
          if (r.method && req.method !== r.method) continue;
          const g = r.match(url.pathname);
          if (g) return runRoute(req, res, url, () => r.run(req, res, url, g));
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
          if (g) return runRoute(req, res, url, () => r.run(req, res, url, g, boardId, board));
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
          if (g) return runRoute(req, res, url, () => r.run(req, res, url, g, boardId, board, root));
        }
        return next();
      });
    },
  };
}
