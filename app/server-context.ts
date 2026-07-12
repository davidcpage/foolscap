import type { IncomingMessage } from "node:http";
import type { BoardInfo, BoardRegistryEntry, CanvasFsState, LiveSession, PendingAsk, PendingPermission, RootInfo, SessionBand, SnapNode, ThreadMsg, WsClient } from "./vite-fs-plugin.js";
import type { WorkIntent } from "./work-intent.js";
import type { ThreadMetaMarker } from "./thread-ledger.js";
import type { EnsuredWorktree } from "./worktrees.js";

// ── the ServerContext seam ────────────────────────────────────────────────────────────────────────
// The second seam of the god-file split (server-http.ts is the first). Where server-http.ts holds the
// STATELESS helpers, this module is the single accessor a route handler uses to reach the SHARED,
// cross-request state it was closing over vite-fs-plugin.ts to get: the board registry, the live-session
// registry, the whole fsState singleton, and the state-dependent resolvers (reqBoard / rootDir /
// boardRoots / originOf) built on top of them.
//
// WHY an accessor and not a re-export of the maps: the load-bearing state is pinned on `globalThis` via
// `??=` (see CanvasFsState in vite-fs-plugin.ts) so it survives a Vite hot re-eval. A route module that
// imported the maps directly would still get the right (pinned) objects, but it would also have to import
// them from vite-fs-plugin.ts — the exact coupling this split exists to remove. Instead vite-fs-plugin.ts
// calls `setServerContext(...)` ONCE at module load with references to those same pinned singletons, and a
// later `routes/*.ts` handler calls `getServerContext()`. The context holder is itself globalThis-pinned,
// so a hot re-eval that re-runs vite-fs-plugin.ts (and re-calls setServerContext with the still-pinned
// singletons) never leaves a stale or half-built context behind.
//
// Phase 0 establishes this seam; the route handlers still live inline in vite-fs-plugin.ts and reach their
// state through the module scope directly, so the only consumer today is the wiring below. Phase 1+ lifts
// each handler into its own module, and THAT is where getServerContext() earns its keep.

export interface ServerContext {
  // The pinned singletons (identical objects to the ones vite-fs-plugin.ts holds).
  boards: Map<string, BoardInfo>;
  liveSessions: Map<string, LiveSession>;
  fsState: CanvasFsState;
  // The default board's id — the fallback when a request omits ?board=.
  defaultBoardId: string;
  // State-dependent resolvers (they read `boards` / the roots cache / lastKnownOrigin), so they belong on
  // the context rather than in the stateless server-http.ts module.
  reqBoard: (url: URL) => (BoardInfo & { boardId: string }) | null;
  rootDir: (boardId: string, rootId: string | null) => string | null;
  boardRoots: (boardId: string) => RootInfo[];
  originOf: (req: IncomingMessage) => string;
  // State-dependent EFFECTS the extracted route handlers call (Phase 1: roles/permissions/boards/board-
  // persist). These are operations, categorically identical to the resolvers above — the handler reaches
  // shared cross-request state (the feed bus, the live-session registry, the board registry, the feeds
  // subsystem, the membership dedup) THROUGH them without importing the god-file. Their DEFINITIONS stay
  // in vite-fs-plugin.ts (moving publishFeed/publishSession — 26/19 callers — is a later phase); this seam
  // only exposes the operation, injected once via setServerContext at load. Expose operations, never raw
  // state maps, wherever the operation is the safer surface.
  publishFeed: (feed: string, value: unknown) => void; // push a named off-log event to every feed subscriber
  publishSession: (s: LiveSession) => void; // re-render a live session's card feed (band, permissions, tail)
  boardIdentity: (repoPath: string) => { boardId: string; name: string; repoPath: string }; // realpath→stable id
  readBoardRegistry: () => BoardRegistryEntry[]; // the durable mounted-board registry (lastOpened recency)
  recordBoardOpened: (boardId: string, name: string, repoPath: string, noSessions?: boolean) => void; // upsert a mount into the registry
  ensureCanvasExcluded: (repoPath: string) => void; // keep a mounted repo's git status clean of .canvas/
  startBoardFeeds: (boardId: string, repoPath: string) => void; // git-HEAD + sessions-list feeds for a board
  announceNewMemberships: (
    boardId: string,
    before: Array<Record<string, unknown>> | null,
    after: Array<Record<string, unknown>> | null,
    origin: string,
  ) => void; // onboarding from a snapshot's membership-edge diff
  // Auto-wake on annotation activity (P2/W5, doc-annotations): a qualifying comment/answer on a watched doc
  // nudges an already-servicing worker or server-spawns a fresh doc worker. A cross-cutting EFFECT (it reads
  // liveSessions and drives the spawn/auto-wake-surface subsystem), so — exactly like publishSession — its
  // definition stays in vite-fs-plugin.ts and the annotations route (routes/annotations.ts) reaches it here.
  maybeWakeDocWorker: (
    boardId: string,
    repoPath: string,
    origin: string,
    rel: string,
    eventKind: "note" | "answer" | "suggestion",
  ) => void;
  // Threads / inbox / asks (Phase 3). The extracted thread/inbox/ask route modules call heavily into the
  // channel-delivery / wake / spawn engine — which is Phase-5 territory and stays in the shell. So, exactly
  // like publishSession/maybeWakeDocWorker, these expose the ENGINE OPERATIONS the routes need (definitions
  // stay in vite-fs-plugin.ts, injected once via setServerContext); each is cross-cutting (engine callers
  // outside the routes). Snapshot/log resolvers first (they read boards / the emitted+durable membership
  // bridge / threadLogs), then the delivery/wake/persist/spawn effects. The pure record/history helpers
  // (threadNode/sessionNodeForSid/sessionNameForSid/seedCursor/historyKey) are on the context — not sunk
  // into a route module — because the shell (maybeAnnounceMembership, sessionThreads, boot paths) still
  // calls them too and cannot import from routes/ (cycle); they are resolvers, categorically like reqBoard.
  boardSnapshotRecords: (boardId: string) => Array<Record<string, unknown>> | null;
  threadNode: (records: Array<Record<string, unknown>>, threadId: string) => SnapNode | null;
  sessionNodeForSid: (records: Array<Record<string, unknown>>, sid: string) => string | null;
  sessionNameForSid: (records: Array<Record<string, unknown>>, sid: string) => string | null;
  threadMemberSids: (records: Array<Record<string, unknown>>, threadId: string) => string[];
  sessionThreads: (records: Array<Record<string, unknown>>, sid: string) => string[];
  // P2 relative-offset layout: the session's primary thread + stored offset (for reopen-at-offset placement),
  // and the debounced snapshot-save capture that recomputes each member's offset from its primary thread card.
  sessionAnchor: (
    repoPath: string,
    records: Array<Record<string, unknown>>,
    sid: string,
  ) => { primaryThread: string | null; offset: { dx: number; dy: number } | null };
  captureMemberOffsets: (boardId: string, records: Array<Record<string, unknown>> | null) => void;
  captureReopenSets: (boardId: string, records: Array<Record<string, unknown>> | null) => void;
  threadLog: (boardId: string, threadId: string) => ThreadMsg[];
  seedCursor: (mode: "full" | "future", log: ThreadMsg[]) => number;
  historyKey: (threadId: string, sid: string) => string;
  appendThreadMsg: (
    boardId: string,
    threadId: string,
    from: string,
    text: string,
    extra?: { kind: "ask" } | { kind: "intent"; intent: WorkIntent },
  ) => ThreadMsg;
  wakeThreadMembers: (
    boardId: string,
    threadId: string,
    exceptSid: string,
    opts: { broadcast: boolean; mentioned?: Set<string>; origin?: string },
  ) => number;
  publishThreadFeed: (boardId: string, threadId: string, messages: ThreadMsg[], truncated: boolean) => void;
  flushNudge: (s: LiveSession) => void;
  persistSessionState: (s: LiveSession) => void;
  dispatchBusCommand: (
    boardId: string,
    cmd: { type: string; payload?: Record<string, unknown>; actor?: string },
    origin: string,
  ) => number;
  forgetDurableMember: (repoPath: string | undefined, threadId: string, sid: string) => void;
  // Engine ops the extracted channel-delivery/wake module (server-delivery.ts, P5 sub-step 1) reaches back
  // into. Their DEFINITIONS still live in the shell (session/spawn = sub-step 2; heartbeat + membership
  // registry + snapshot resolvers = sub-step 3), so — exactly like the effects above — the seam injects the
  // operation and the moved delivery functions call it via getServerContext(); the defs move in a later
  // sub-step and just repoint. MAX_THREAD_MSGS rides here as a value the same way MAX_LIVE_SESSIONS does.
  maybeRespawnDormantSeat: (
    boardId: string,
    threadId: string,
    dormantSid: string,
    origin: string,
    meta: ThreadMetaMarker | null,
  ) => void; // reconstitute a dormant SEAT when an @-addressed member has no live process (wakeThreadMembers)
  ensureCoordinatorHeartbeat: (repoPath: string, threadId: string) => void; // first Coordinator staffing auto-enables its sweep
  recordDurableMember: (repoPath: string | undefined, threadId: string, sid: string, ts: number) => void; // membership survives card/edge removal
  trackEmittedMembership: (cmd: { type: string; payload?: Record<string, unknown> }) => void; // front-run the snapshot for the immediate-membership window
  sidFromSessionNode: (node: string) => string | null; // "node:live:<sid>" → sid
  nodeSessionId: (records: Array<Record<string, unknown>>, nodeId: string) => string | null; // a session node's sid (its title)
  MAX_THREAD_MSGS: number; // the bounded thread-log TAIL appendThreadMsg trims to
  republishThreadSeatOccupants: (repoPath: string, threadId: string) => void;
  serverSpawnWorker: (opts: {
    boardId: string;
    repoPath: string;
    origin: string;
    roleId: string | null;
    threadId: string | null;
    anchorNodeId: string | null;
    claimKey: string;
    firstPrompt: string;
  }) => string | null;
  // Sessions routes (Phase 4). The read/list + lifecycle/spawn handlers (routes/sessions.ts) drive the
  // session-host spawn/process ENGINE and the live-session feed/registry machinery — Phase-5 territory that
  // stays in the shell. So, exactly like serverSpawnWorker above, these expose the ENGINE operations the
  // routes need (definitions stay in vite-fs-plugin.ts, injected once via setServerContext); each is shared
  // (a caller outside the route set — serverSpawnWorker, the idle reaper, the feed startup, the shadow-git /
  // adoption paths), so none could sink into the route module. Resolvers/consts first, then the effects.
  sessionsDir: (repoPath: string) => string; // a board's Claude-Code transcripts dir (projectsDirForCwd)
  readSessionFile: (dir: string, id: string) => { content: string; truncated: boolean } | null; // one transcript, tail-capped
  sessionStatus: (repoPath: string, id: string) => SessionBand | null; // the ONE whole-session status band
  liveSessionCount: () => number; // live (status !== "exited") sessions across every board — the spawn cap input
  sessionSpawnRefusal: (boardId: string) => string | null; // why NO real session may spawn on this board (noSessions mount flag / tmpdir scratch board), or null
  MAX_LIVE_SESSIONS: number; // the concurrent-live-session ceiling the spawn guard 429s against
  resolveSpawnCwd: (
    repoPath: string,
    opts: { threadId: string | null; roleId: string | null; worktree: boolean; base: string | null; explicitKey: string | null },
  ) => { cwd: string; worktree: EnsuredWorktree | null; key: string | null }; // worktree-or-board-root spawn cwd
  placeWorkerCard: (
    records: Array<Record<string, unknown>> | null,
    threadId: string | null,
  ) => { x: number; y: number; w: number; h: number }; // server-side worker-card placement beside its channel
  ensureLiveSession: (
    id: string,
    repoPath: string,
    resume?: boolean,
    origin?: string,
    roleId?: string | null,
    threadId?: string | null,
    cwd?: string,
    model?: string | null, // explicit per-spawn model; null → role `model:` frontmatter → DEFAULT_SESSION_MODEL
  ) => LiveSession; // spawn/adopt a live process into the registry (session-host engine)
  sendSessionInput: (id: string, text: string, opts?: { keepWaitingOn?: boolean }) => boolean; // write a prompt to stdin
  sendSessionInterrupt: (id: string) => boolean; // halt the current turn via the stdin control channel
  endSession: (id: string, endReason: "done" | "terminated") => boolean; // teardown: kill + free the cap slot
  ensureSessionFeed: (dir: string, id: string, repoPath: string) => void; // start live-tailing a transcript
  // Shadow-git fold (P5 sub-step 2): the extracted session engine (server-sessions.ts foldSessionEvent) reaches
  // the shadow-git committer here. Its DEFINITION is the shadow-git cluster still in the shell (sub-step 3), so
  // — exactly like the delivery ops — the seam injects the operation and the def repoints when it moves.
  foldShadowEdits: (s: LiveSession, e: { type?: string; message?: { content?: unknown } }) => void;
}

// Pin the holder on globalThis (like fsState) so a hot re-eval doesn't strand a stale context: the getter
// keeps working across the re-eval, and vite-fs-plugin.ts re-sets it during its own re-run regardless.
const holder = ((globalThis as { __canvasServerContext?: { ctx: ServerContext | null } }).__canvasServerContext ??= {
  ctx: null,
});

export function setServerContext(ctx: ServerContext): void {
  holder.ctx = ctx;
}

// Returns the live context. Throws if called before vite-fs-plugin.ts wired it — a programming error (a
// route module evaluated its handler before configureServer ran), never an expected runtime state.
export function getServerContext(): ServerContext {
  if (!holder.ctx) throw new Error("ServerContext not initialized — setServerContext must run at plugin load");
  return holder.ctx;
}

// ── lazy fsState-map accessors ────────────────────────────────────────────────────────────────────
// These four maps are declared OPTIONAL on CanvasFsState. They were historically initialized by a `??=`
// block in vite-fs-plugin.ts's module body, so every consumer that reached them via a `!` non-null
// assertion (`fsState.pendingAsks!`) silently depended on that shell init having run first — a load-order
// coupling that a hermetic fake ServerContext, built without the shell, would crash against (undefined map).
// Each accessor below initializes its map IN PLACE on first read, so any caller — the shell, an extracted
// engine/route module, or a test fake — gets a live map with no ordering dependency. ONE accessor per map;
// nothing else `??=`-inits these. (Pure functions of their fsState arg, so a test can call them on a bare
// fake state without wiring the global context.)
export function getPendingAsks(fsState: CanvasFsState): Map<string, PendingAsk> {
  return (fsState.pendingAsks ??= new Map<string, PendingAsk>());
}
export function getPendingPermissions(fsState: CanvasFsState): Map<string, PendingPermission> {
  return (fsState.pendingPermissions ??= new Map<string, PendingPermission>());
}
export function getWsClients(fsState: CanvasFsState): Set<WsClient> {
  return (fsState.wsClients ??= new Set<WsClient>());
}
export function getPendingHistoryMode(fsState: CanvasFsState): Map<string, "full" | "future"> {
  return (fsState.pendingHistoryMode ??= new Map<string, "full" | "future">());
}
