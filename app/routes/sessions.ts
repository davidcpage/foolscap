import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getPendingHistoryMode, getServerContext } from "../server-context.js";
import { exact, re, type GlobalRoute } from "./router.js";
import { isCanvasSession, listSessions, markCanvasSession, projectsDirsForCwd, readCanvasSession } from "../session-ledger.js";
import { durableSessionThreads } from "../server-snapshot.js";
import { sessionSummaryFromText } from "../session-summary.js";
import { readRole } from "../role-ledger.js";
import { ensureWorktree } from "../worktrees.js";
import { MAX_SESSION_BYTES, projectCodexHistory, isValidEffort, EFFORT_LEVELS } from "../server-sessions.js";

// ── the sessions routes (read/list + lifecycle/spawn) — god-file split, Phase 4 ─────────────────────
// The two GLOBAL-stage clusters that make sessions legible and drivable: the read/list pair (GET
// /api/session transcript tail, GET /api/sessions list) and the lifecycle/spawn set (POST /api/session/
// spawn + POST /api/session/<id>/{input,resume,interrupt,terminate,done}). These are a SELF-CRITICAL path
// — spawn/terminate are how every worker (including the next phase's) gets staffed — so behaviour is
// preserved byte-exact: each handler body is identical to its god-file original, the only delta a
// `getServerContext()` preamble binding the shared state + the spawn/process ENGINE operations (defined in
// the shell, Phase-5 territory) to the local names the body already used. Concern-owned helpers used ONLY
// by these handlers move here (sessionTranscriptDir, sessionSummary + summaryCache); everything shared with
// serverSpawnWorker / the reaper / the feed machinery stays in the shell and is reached via the context.
//
// The two arm arrays are exported separately because the arms are NON-CONTIGUOUS in GLOBAL_ROUTES: the
// lifecycle/spawn arms sit at the top (before permissions) and the read arms sit after the thread routes.
// Two spread points preserve the exact positions/order/method/gate-stage the inline entries held, and the
// load-bearing ordering (spawn exact → /<id>/* regex → bare /api/session) is intact.

// The transcripts dir for ONE session: its marker records the process `cwd` (worktree sessions spawn under
// <board>/.canvas/worktrees/<key>), so a worktree session's .jsonl lives in a different projects dir than
// the board root's. Falls back to the board-root dir for board-root/adopted sessions (marker without cwd, or
// no marker yet). The single resolver the list (listSessions), the open (handleSession) and the resume all
// go through, so a worktree session's transcript is found everywhere — not just the live-tail seed.
function sessionTranscriptDir(repoPath: string, id: string): string {
  const cwd = readCanvasSession(repoPath, id)?.cwd as string | undefined;
  const candidates = projectsDirsForCwd(cwd ?? repoPath);
  return candidates.find((dir) => fs.existsSync(path.join(dir, id + ".jsonl"))) ?? candidates[0]!;
}

async function handleSession(res: ServerResponse, dir: string, id: string | null, repoPath: string, boardId: string): Promise<void> {
  const { readSessionFile, ensureSessionFeed, boardSnapshotRecords, sessionAnchor, publishFeed, fsState, liveSessions } = getServerContext();
  let chosen = id;
  if (!chosen) chosen = listSessions(dir, repoPath)[0]?.id ?? null;
  if (!chosen) return sendJson(res, 404, { error: "no sessions found" });
  if (!/^[\w-]+$/.test(chosen)) return sendJson(res, 400, { error: "bad session id" });
  // Resolve the transcript dir PER SESSION: a worktree session's .jsonl isn't under the board-root `dir`
  // this handler was passed, but under its own cwd's projects dir (recorded on the marker). Without this a
  // listed worktree session 404s the moment its card is opened.
  const tdir = sessionTranscriptDir(repoPath, chosen);
  const marker = readCanvasSession(repoPath, chosen);
  const isCodex = marker?.provider === "codex";
  const providerSessionId = isCodex && typeof marker?.providerSessionId === "string"
    ? marker.providerSessionId
    : null;
  // A live process owns session:<id> and publishes it from the (finer) live stream. Opening the card of a
  // STILL-LIVE Codex session must NOT stamp an `ended:true` thread/read projection over that feed — two
  // publishers fighting flips the card to the ended band and forks the transcript (finding 3). This is the
  // same guard the Claude file-tail path has (ensureSessionFeed / server-sessions.ts). The history is still
  // read and returned in the response body for the initial paint; we just skip the clobbering publish.
  const owned = liveSessions.get(chosen);
  const liveOwned = !!owned && owned.status !== "exited";
  let r = readSessionFile(tdir, chosen);
  if (isCodex && providerSessionId) {
    if (!fsState.hostClient?.connected)
      return sendJson(res, 503, { error: "session host unavailable for Codex history" });
    if (typeof fsState.hostClient.codexHistory !== "function")
      return sendJson(res, 503, {
        error: "dev server restart required after the session-host protocol upgrade",
      });
    try {
      const projected = projectCodexHistory(await fsState.hostClient.codexHistory(providerSessionId));
      let content = projected.lines.join("\n");
      let truncated = false;
      if (Buffer.byteLength(content) > MAX_SESSION_BYTES) {
        const buf = Buffer.from(content);
        content = buf.subarray(buf.length - MAX_SESSION_BYTES).toString("utf8");
        truncated = true;
      }
      r = { content, truncated };
      if (!liveOwned)
        publishFeed("session:" + chosen, {
          ...r,
          ended: true,
          provider: "codex",
          providerSessionId,
          endReason: marker?.endReason,
          // Durable model/effort off the marker so the ended card keeps its tinted pill + effort suffix.
          model: (marker?.model as string | undefined) ?? undefined,
          effort: (marker?.effort as string | undefined) ?? undefined,
          error: projected.error ?? undefined,
        });
    } catch (err) {
      return sendJson(res, 502, { error: "failed to read Codex history", detail: String(err) });
    }
  }
  if (!r) {
    if (!marker) return sendJson(res, 404, { error: "not found" });
    r = { content: "", truncated: false };
    publishFeed("session:" + chosen, {
      ...r,
      ended: true,
      provider: isCodex ? "codex" : "claude",
      providerSessionId: providerSessionId ?? undefined,
      endReason: marker.endReason,
      // Durable model/effort off the marker so even a no-history ended card keeps its tinted pill + suffix.
      model: (marker.model as string | undefined) ?? undefined,
      effort: (marker.effort as string | undefined) ?? undefined,
      noHistory: true,
    });
  }
  // Backfill the ledger: a card asked for this transcript, so it's ON the board — that makes it canvas-
  // owned by adoption (whether we spawned it or it predates the ledger). Marking on first serve is what
  // migrates existing cards in (so they list again) without a client change, and keeps the list filtered
  // to externals nobody has placed. Write-once: a real spawn already wrote a richer marker; don't clobber it.
  if (!isCanvasSession(repoPath, chosen)) markCanvasSession(repoPath, chosen, { adoptedAt: Date.now() });
  if (!isCodex) ensureSessionFeed(tdir, chosen, repoPath); // Codex history was published from app-server above
  // The threads this session is a DURABLE member of, so the client can redraw the `member:open` edge(s) on
  // reopen: the card + its edge vanished on close, but the membership outlived them (delete-card-keep-session).
  // LEDGER-ONLY on purpose (durableSessionThreads, not sessionThreads): the client repaints edges from this
  // list, and a snapshot-edge-derived entry the ledger doesn't back would be re-onboarded as a fresh join
  // when the redrawn edge lands — the pill-click-on-a-Done-session spurious join. Reporting only what the
  // ledger holds keeps card-close/reopen (and every pill-click) provably display-only.
  const records = boardSnapshotRecords(boardId) ?? [];
  const threads = durableSessionThreads(repoPath, chosen);
  // P2 relative-offset layout: the session's PRIMARY thread (earliest joined) + its stored offset, so the
  // client places the reopened card at primaryThreadCardPos + offset instead of a fresh cascade spot. Null
  // primaryThread / offset → the client falls back to spawnAt. A pure read (changes no server state).
  const { primaryThread, offset } = sessionAnchor(repoPath, records, chosen);
  // The role this session instantiates (from its marker, as handleSessions ~117-118 already reads for the
  // list): so reopen can restamp the card's friendly `name` ("<Role>.<short-sid>", the spawn convention) and
  // the card title + member pill read the role label instead of the bare sid. null for a plain session.
  sendJson(res, 200, {
    id: chosen,
    content: r.content,
    truncated: r.truncated,
    threads,
    primaryThread,
    offset,
    roleName: (marker?.roleName as string | undefined) ?? null,
    roleId: (marker?.roleId as string | undefined) ?? null,
  });
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

function sessionSummary(
  abs: string,
  mtime: number,
): { title: string | null; turns: number; messages: number } {
  const hit = summaryCache.get(abs);
  if (hit && hit.mtime === mtime)
    return { title: hit.title, turns: hit.turns, messages: hit.messages };
  let summary: { title: string | null; turns: number; messages: number };
  try {
    // Scan the WHOLE transcript (session-summary.js explains why a head/tail slice corrupts the counts and
    // title). Memory is bounded here by parsing at most once per mtime; the byte cap lives at the file reads
    // that serve content to the browser (readSessionFile / the live feed), not on this metadata pass.
    summary = sessionSummaryFromText(fs.readFileSync(abs, "utf8"));
  } catch {
    // unreadable transcript → no summary; the client falls back to the bare id
    summary = { title: null, turns: 0, messages: 0 };
  }
  summaryCache.set(abs, { mtime, ...summary });
  return summary;
}

function sessionSummaryForPath(abs: string, fallbackMtime: number): { title: string | null; turns: number; messages: number } {
  let sourceMtime = fallbackMtime;
  try {
    sourceMtime = fs.statSync(abs).mtimeMs;
  } catch {
    // The transcript can disappear between the marker-driven list and this metadata pass. The summary
    // reader below already degrades an unreadable path to an empty summary; keep that race non-fatal.
  }
  return sessionSummary(abs, sourceMtime);
}

// GET /api/sessions → every historical provider session (newest-first), for the Open-session dropdown.
// Claude rows resolve their provider-authored `.jsonl`; Codex rows resolve their durable app-server thread
// id. A card deleted from the canvas still appears here because the marker is the ownership index.
function handleSessions(res: ServerResponse, dir: string, repoPath: string): void {
  const { sessionStatus, liveSessions } = getServerContext();
  const onDisk = listSessions(dir, repoPath);
  const sessions = onDisk.map((s) => {
    const marker = readCanvasSession(repoPath, s.id);
    return {
      ...s,
      ...(marker?.provider === "codex" || s.noHistory
        ? { title: null, turns: 0, messages: 0 }
        : sessionSummaryForPath(path.join(sessionTranscriptDir(repoPath, s.id), s.id + ".jsonl"), s.mtime)),
      status: sessionStatus(repoPath, s.id),
      // The role this session instantiates, if any — lets the list/minimap render `<RoleName>.<short-sid>`,
      // with roleColour so a historical row's role chip tints the same as the live picker swatch.
      roleId: (marker?.roleId as string | undefined) ?? null,
      roleName: (marker?.roleName as string | undefined) ?? null,
      roleColour: (marker?.roleColour as string | undefined) ?? null,
      provider: marker?.provider === "codex" ? "codex" : "claude",
      // The serving model + effort. Prefer the LIVE registry (folded serving model, tracks a fallback), then
      // fall back to the durable marker so an ENDED row still shows its tinted pill + effort suffix instead
      // of a blank chip — the disappearing-pill fix. The marker records the requested model, re-persisted to
      // the actual serving model at each turn boundary, so a dead row is honest, not a stale guess.
      model: liveSessions.get(s.id)?.model ?? (marker?.model as string | undefined) ?? null,
      effort: liveSessions.get(s.id)?.effort ?? (marker?.effort as string | undefined) ?? null,
    };
  });
  // Union in LIVE sessions the disk walk missed: a session that hasn't completed a single turn has a
  // marker but NO transcript (`claude -p` writes the .jsonl per completed turn), so listSessions skips
  // it — right for DEAD markers (their row would 404 on open) but a live one holds a real process and a
  // cap slot while invisible here (a prompt-less spawn hid for 23h — the 20fd21de zombie). `noTurns`
  // marks the row honest: live, nothing recorded yet. It disappears again once it exits turn-less, and
  // graduates to a normal row on its first completed turn.
  const listed = new Set(onDisk.map((s) => s.id));
  for (const l of liveSessions.values()) {
    if (l.repoPath !== repoPath || l.status === "exited" || listed.has(l.id)) continue;
    const marker = readCanvasSession(repoPath, l.id);
    sessions.push({
      id: l.id,
      mtime: (marker?.spawnedAt as number | undefined) ?? Date.now(),
      bytes: 0,
      title: null,
      turns: 0,
      messages: 0,
      noTurns: true,
      status: sessionStatus(repoPath, l.id),
      roleId: (marker?.roleId as string | undefined) ?? null,
      roleName: (marker?.roleName as string | undefined) ?? null,
      roleColour: (marker?.roleColour as string | undefined) ?? null,
      provider: l.provider,
      model: l.model ?? null,
      effort: l.effort ?? null,
    } as (typeof sessions)[number]);
  }
  sessions.sort((a, b) => b.mtime - a.mtime); // keep the newest-first contract across both sources
  sendJson(res, 200, { sessions });
}

// POST /api/session/spawn  { prompt? } → { id }. Mint a new session id, spawn the process, and send the
// first prompt if given. The client drops a session card titled <id>, which subscribes to session:<id>.
async function handleSessionSpawn(
  req: IncomingMessage,
  res: ServerResponse,
  repoPath: string,
  boardId: string,
  origin: string,
): Promise<void> {
  const {
    liveSessionCount, sessionSpawnRefusal, MAX_LIVE_SESSIONS, resolveSpawnCwd, ensureLiveSession, liveSessions,
    boardSnapshotRecords, placeWorkerCard, dispatchBusCommand, sendSessionInput,
    persistSessionState, historyKey, seedCursor, threadLog, fsState,
  } = getServerContext();
  const pendingHistoryMode = getPendingHistoryMode(fsState);
  let body: {
    id?: unknown; prompt?: unknown; roleId?: unknown; thread?: unknown; channel?: unknown; card?: unknown;
    worktree?: unknown; base?: unknown; worktreeKey?: unknown; model?: unknown; provider?: unknown;
    effort?: unknown;
  } = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  // A noSessions/tmpdir scratch board never runs a real session — a test hitting this route must get a
  // loud 403, not a live `claude` process (the auto-wake path refuses with the same predicate).
  const refusal = sessionSpawnRefusal(boardId);
  if (refusal) return sendJson(res, 403, { error: refusal });
  if (liveSessionCount() >= MAX_LIVE_SESSIONS)
    return sendJson(res, 429, { error: `live-session cap reached (${MAX_LIVE_SESSIONS}); terminate one first` });
  const provider = body.provider == null || body.provider === "" ? "claude" : body.provider;
  if (provider !== "claude" && provider !== "codex")
    return sendJson(res, 400, { error: 'provider must be "claude" or "codex"' });
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
  // Optional: the model this session runs. Explicit here beats the role's `model:` frontmatter beats
  // DEFAULT_SESSION_MODEL (resolveSessionModel in server-sessions.ts) — the spawner chooses, per spawn.
  let model: string | null = null;
  if (body.model != null && body.model !== "") {
    if (typeof body.model !== "string") return sendJson(res, 400, { error: "model must be a string" });
    model = body.model;
  }
  // Optional: the reasoning effort this session runs. One of low|medium|high|xhigh|max (valid on both
  // providers); absent = the provider default (no `--effort` / `reasoningEffort` sent). Explicit here beats
  // the role's `effort:` frontmatter (resolveSessionEffort in server-sessions.ts). A bad value is a 400,
  // not a silent drop — the picker only ever sends a valid level, so a bad one is a client bug worth surfacing.
  let effort: string | null = null;
  if (body.effort != null && body.effort !== "") {
    if (!isValidEffort(body.effort))
      return sendJson(res, 400, { error: `effort must be one of ${EFFORT_LEVELS.join("|")}` });
    effort = body.effort;
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
  // The session id is normally SERVER-minted. A deferred-start card (deferred-start-session-cards) mints
  // its OWN UUID client-side (so the stub card's node id + feed key are stable from creation) and passes it
  // here as `id`; the process then adopts that id and the same card flips from stub to live with no id
  // reconciliation. Validate it strictly — a proper UUID, not one already live (a routing collision) — and
  // fall back to server minting when absent, so every other spawn path is unchanged.
  let id: string;
  if (body.id != null && body.id !== "") {
    if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id))
      return sendJson(res, 400, { error: "id must be a UUID" });
    if (liveSessions.has(body.id)) return sendJson(res, 409, { error: "session id already in use" });
    id = body.id;
  } else {
    id = crypto.randomUUID();
  }
  try {
    ensureLiveSession(id, repoPath, false, origin, roleId, threadId, cwd, model, provider, effort);
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
  // guessing coordinates badly) AND robustness: §9 stage 2 commits the card + member:open edge durably
  // server-side (dispatchBusCommand → commitBoardCommand), so a task the Coordinator posts right after this
  // reliably resolves the worker's membership even with no live tab and before any snapshot round-trip.
  // `carded` now means simply "created" (always true when card params are given) — never "deferred/lost".
  // Browser-initiated spawns omit these params and keep placing their own card. `card:true` = a standalone card.
  let carded = false;
  if (threadId || body.card === true) {
    const records = boardSnapshotRecords(boardId);
    const node = `node:live:${id}`;
    const nodePayload: Record<string, unknown> = {
      id: node, type: "session", title: id, color: roleColour ?? "blue", ...placeWorkerCard(records, threadId),
    };
    if (roleName) nodePayload.name = `${roleName}.${id.slice(0, 8)}`;
    // §9 stage 2: the card (+ member:open edge) is committed + made durable server-side here — no live tab
    // required, so it's always created (`carded` now means "created", never "deferred until a tab attaches").
    carded = !!dispatchBusCommand(boardId, { type: "addNode", actor: "system", payload: nodePayload }, origin);
    if (threadId)
      dispatchBusCommand(
        boardId,
        { type: "addEdge", actor: "system", payload: { id: `edge:member:${id}:${threadId}`, from: node, to: threadId, type: "member:open" } },
        origin,
      );
  }
  if (typeof body.prompt === "string" && body.prompt.trim()) sendSessionInput(id, body.prompt);
  sendJson(res, 200, {
    id, provider, roleId, roleName, roleColour, carded,
    ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch, reused: worktree.reused, linked: worktree.linked } } : {}),
  });
}

// POST /api/session/<id>/input  { text } → write a prompt into the live process. Session-internal: no
// canvas-log entry, no editor.commit (session-timelines §4). 409 if the session isn't live.
async function handleSessionInput(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const { sendSessionInput } = getServerContext();
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
  const { readSessionFile, ensureLiveSession, originOf } = getServerContext();
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  const marker = readCanvasSession(repoPath, id);
  const isCodex = marker?.provider === "codex" && typeof marker?.providerSessionId === "string";
  if (!isCodex && !readSessionFile(sessionTranscriptDir(repoPath, id), id))
    return sendJson(res, 404, { error: "no transcript for that session" });
  try {
    const cwd = typeof marker?.cwd === "string" ? marker.cwd : repoPath;
    ensureLiveSession(id, repoPath, true, originOf(req), null, null, cwd, null, isCodex ? "codex" : "claude");
  } catch (err) {
    return sendJson(res, 500, { error: "failed to resume", detail: String(err) });
  }
  sendJson(res, 200, { ok: true });
}

// POST /api/session/<id>/interrupt → halt the live session's current turn (no body). Session-internal,
// like input/resume: a POST, never editor.commit, never a canvas-log entry. 409 if it isn't live.
function handleSessionInterrupt(res: ServerResponse, id: string): void {
  const { sendSessionInterrupt } = getServerContext();
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
  const { endSession } = getServerContext();
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
  const { endSession } = getServerContext();
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!endSession(id, "done")) return sendJson(res, 409, { error: "session not live" });
  sendJson(res, 200, { ok: true, done: id });
}

// The lifecycle/spawn arms — the TOP group of GLOBAL_ROUTES (right after /api/feeds, before the
// permission routes). Session reads/spawns ARE board-scoped (?board=, default board if omitted) — the
// transcripts dir and the spawn cwd are this board's repo. input/interrupt/resume address a live process
// by its globally-unique id; only spawn + resume need the repo (cwd / transcript seed). The load-bearing
// order — /api/session/spawn (exact) before /api/session/<id>/* (regex) before the bare /api/session read
// (in sessionReadRoutes, further down GLOBAL_ROUTES) — is preserved.
export const sessionLifecycleRoutes: GlobalRoute[] = [
  {
    method: "POST",
    match: exact("/api/session/spawn"),
    run: (req, res, url) => {
      const ctx = getServerContext();
      const b = ctx.reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return void handleSessionSpawn(req, res, b.repoPath, b.boardId, ctx.originOf(req));
    },
  },
  { method: "POST", match: re(/^\/api\/session\/([\w-]+)\/input$/), run: (req, res, _url, g) => void handleSessionInput(req, res, g[0]!) },
  {
    method: "POST",
    match: re(/^\/api\/session\/([\w-]+)\/resume$/),
    run: (req, res, url, g) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return handleSessionResume(req, res, b.repoPath, g[0]!);
    },
  },
  { method: "POST", match: re(/^\/api\/session\/([\w-]+)\/interrupt$/), run: (_req, res, _url, g) => handleSessionInterrupt(res, g[0]!) },
  { method: "POST", match: re(/^\/api\/session\/([\w-]+)\/terminate$/), run: (_req, res, _url, g) => handleSessionTerminate(res, g[0]!) },
  { method: "POST", match: re(/^\/api\/session\/([\w-]+)\/done$/), run: (_req, res, _url, g) => handleSessionDone(res, g[0]!) },
];

// The read/list arms — spread into GLOBAL_ROUTES after the thread routes (before the /api/threads list).
export const sessionReadRoutes: GlobalRoute[] = [
  {
    match: exact("/api/session"),
    run: (_req, res, url) => {
      const ctx = getServerContext();
      const b = ctx.reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return void handleSession(res, ctx.sessionsDir(b.repoPath), url.searchParams.get("id"), b.repoPath, b.boardId);
    },
  },
  {
    match: exact("/api/sessions"),
    run: (_req, res, url) => {
      const ctx = getServerContext();
      const b = ctx.reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return handleSessions(res, ctx.sessionsDir(b.repoPath), b.repoPath);
    },
  },
];
