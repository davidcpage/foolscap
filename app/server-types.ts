import type { ServerResponse } from "node:http";
import type chokidar from "chokidar";
import type { SseClient } from "./server-http.js";
import type { SessionHostClient } from "./session-host-client.js";
import type { SessionProc } from "./session-proc.js";
import type { WorkIntent } from "./work-intent.js";
import type { BoardEngineEntry } from "./board-engine.js";
import type { watchRoot } from "./shadow-git.js";

// ── the shared server-side type vocabulary ──────────────────────────────────────────────────────────
// The type home for the agent-orchestration server (F-S4 of the god-file split). These declarations used
// to live in vite-fs-plugin.ts, so eight engine/route modules type-imported the shell just to name a
// LiveSession or a ThreadMsg — a declaration-level coupling to the god-file the split exists to remove.
// They are TYPES only (erased at runtime), so this module imports the few type deps it needs (SseClient,
// SessionProc, …) with `import type` and introduces no runtime edge or load-order hazard for any importer.

// A board node the server resolves out of a durable snapshot: the minimal shape the orchestration code
// duck-reads (typeName/type/title/text), NOT core's full record.
export interface SnapNode {
  typeName: "node";
  id: string;
  type: string;
  title: string;
  text?: string; // a thread node's `text` is its (optional) task brief
}

// A mounted board's served root + metadata (the in-memory `boards` map's value).
export interface BoardInfo {
  root: string;
  name: string;
  repoPath: string;
  // Mounted with { noSessions: true } (or repo under the OS tmpdir): a scratch/test board on which NO real
  // `claude` session may ever spawn — explicit or server-fired. The http-contract suite's annotation writes
  // used to auto-wake a REAL doc worker per test run (real token spend); this is the board-level refusal.
  noSessions?: boolean;
}

// One row of the durable mounted-board registry (`.canvas/boards.json`) — survives a server restart.
export interface BoardRegistryEntry {
  boardId: string;
  name: string;
  repoPath: string;
  lastOpened: number; // ms epoch of the latest mount POST
  noSessions?: boolean; // sticky no-real-sessions flag (BoardInfo.noSessions) — survives a restart
}

// A board root: its canonical checkout ("repo") or a discovered git worktree of it.
export interface RootInfo {
  id: string; // "repo" for the canonical checkout; slug(basename) for a worktree
  name: string;
  path: string; // absolute, realpath'd — the confined dir every read of this root is re-checked against
  branch: string;
  head: string;
}

// The ONE whole-session status band — one server-side source so every view (sessions list, minimap dot,
// heads-up, card) agrees instead of re-deriving it.
export type SessionBand =
  | "working" | "waiting" | "waiting-agent" | "scheduled" | "done" | "crashed" | "ended";

// One channel's off-log message log entry (4e): the durable-for-the-process record of a channel's
// conversation, the source for both the channel:<id> feed (the card's conversation view) and GET /api/inbox.
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
// allow-list and routed it here via the per-session MCP relay. The relay's POST is PARKED (the §16
// held-response pattern) until a human clicks allow/deny on the session card or the hold times out. Same
// lifetime rules as PendingAsk: pinned in fsState across a hot re-eval; the held `res`/`timer` are
// process-bound (a restart fails the relay's fetch, which denies fail-closed).
export interface PendingPermission {
  permId: string;
  sid: string; // the session whose tool call is blocked (its card renders the prompt)
  toolName: string; // e.g. "Bash" — the tool the CLI is asking about
  input: unknown; // the tool's input object, echoed back on allow (updatedInput)
  ts: number;
  res?: ServerResponse; // Claude: the MCP relay's parked connection
  providerRequestId?: string; // Codex: request retained by the long-lived host
  timer: ReturnType<typeof setTimeout>;
}

// One tab's WebSocket connection (/api/ws) — the single transport that replaced the tab's standing SSE
// streams (feeds + bus + one watch per root), which each held one of the browser's SIX per-host HTTP/1.1
// connection slots. A WebSocket lives in a separate, much larger browser budget.
export interface WsClient {
  boardId: string; // fixed at connect (?board=) — bus commands fan out per board
  tab?: string; // stable per-tab id (?tab=, sessionStorage-scoped) so tabCountFor dedupes a board-switch
  // overlap (old page's socket not yet reaped) into ONE tab; absent = legacy/untagged, counts individually
  watches: Map<string, () => void>; // rootId → watcher close ({sub:"watch"} subscriptions)
  send(msg: unknown): void;
}

// The assistant message being built from partial stream deltas (a live turn's in-flight content blocks).
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

// A live `claude -p` session in the registry: the process (behind the SessionProc seam), its transcript
// tail, live turn state, model/usage, channel read-cursors + wake state, and the auto-wake/shadow-git
// bookkeeping. The single in-memory record every view of a running agent reads.
export interface LiveSession {
  id: string;
  provider: "claude" | "codex";
  providerSessionId: string | null; // Codex thread id; null for Claude and while a new Codex thread binds
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
  plan?: Array<{ step: string; status?: string }>; // provider-neutral live plan projection
  error?: string | null; // latest provider error, cleared at the next turn
  // The model actually SERVING this session — folded from the stream (init's requested model, then each
  // assistant message's authoritative `message.model`, which tracks a server-side refusal fallback, e.g.
  // fable-5 → opus-4-8; see canvas-workers-fable-fallback-opus memory). Rendered as a chip on the session
  // card and the sessions list so a silent model demotion is VISIBLE. null until the first frame names it.
  model: string | null;
  // The reasoning effort this session was spawned at (spawn param > role `effort:` > provider default),
  // one of EFFORT_LEVELS or null when the provider default applies. Unlike `model` it does NOT change
  // mid-session (there's no server-side effort fallback), so it's set once at spawn and rides the feed +
  // the durable marker so the pill's effort suffix survives Done.
  effort: string | null;
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

// A live shadow-git watcher handle (shadow-git.js) — keyed boardId\0rootId in fsState.shadowRoots.
export type ShadowRootHandle = ReturnType<typeof watchRoot>;

// The server's whole cross-request mutable state, pinned on globalThis so it survives a Vite hot re-eval.
// Every collection that affects behaviour lives here (see THE RULE below); the optional maps lazy-init via
// their accessors in server-context.ts.
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
  emittedMembers?: Map<string, { thread: string; sid: string; ts: number }>; // server-emitted memberships awaiting the snapshot (lazy-init via getEmittedMembers)
  durableMembers?: Map<string, Set<string>>; // threadId → member sids that survive card/edge removal, marker-backed (lazy-init via getDurableMembers)
  shadowRoots?: Map<string, ShadowRootHandle>; // boardId\0rootId → live shadow-git watcher (lazy-init via getShadowRoots)
  busClients?: Map<string, Set<SseClient>>; // SSE compat bus subscribers, per board (lazy-init via getBusClients)
  lastNotebookOutputs?: Map<string, string>; // boardId\0nodeId → last pushed outputs blob
  liveKernels?: Map<string, unknown>; // boardId\0nodeId → live Jupyter kernel (server-kernel.ts; typed there to avoid a cycle; lazy-init via `??=`)
  kernelsReconciled?: boolean; // one-shot flag: the gateway-orphan sweep ran once this server lifetime (server-kernel.ts; survives re-eval on fsState, resets on restart)
  announcedMemberships?: Set<string>; // edgeId|phase dedup for onboarding announcements (lazy-init via getAnnouncedMemberships)
  pendingHistoryMode?: Map<string, "full" | "future">; // threadId|sid → backlog visibility for a not-yet-onboarded member (lazy-init via getPendingHistoryMode)
  boardEngines?: Map<string, BoardEngineEntry>; // boardId → the live server-materialized core Store (board-engine.ts, design §9 stage 1); the single event-seq sequencer + append point (stage 2)
}
