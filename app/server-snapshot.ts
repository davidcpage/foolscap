import { getServerContext } from "./server-context.js";
import { RECORD_TYPE, NODE_TYPE, EDGE_TYPE } from "../core/src/records.js";
import {
  addThreadMember,
  listThreads,
  memberOffsetFromMeta,
  readThreadLog,
  readThreadMeta,
  removeThreadMember,
  setMemberOffset,
  setReopenSet,
  threadMembersFromMeta,
} from "./thread-ledger.js";
import { boardStoreRecords } from "./board-engine.js";
import { publishThreadFeed } from "./server-delivery.js";
import type { SnapNode, ThreadMsg } from "./vite-fs-plugin.js";

// ── the snapshot / thread-log / membership resolvers (P5 sub-step 3) ───────────────────────────────
// The pure READ side of the orchestration engine (the P3-deferred server-snapshot.ts split): resolving a
// board's durable snapshot to nodes/edges (session cards, thread nodes, member rosters), the in-memory
// thread-log tail the feed + inbox read from, the backlog-visibility seed, and the DURABLE membership
// registry (the emitted-membership bridge + the delete-card-keep-session set) that thread membership unions
// in. No timers, no process control, no spawning — just record/log resolution and the membership bookkeeping
// those resolvers share (which is why sub-step 1 deliberately left the registry to migrate here with them).
//
// Like server-delivery.ts / server-sessions.ts, every function reaches the shared, cross-request state (the
// board registry, the fsState-pinned threadLogs / emittedMembers / durableMembers maps) THROUGH
// getServerContext() — the same pinned singletons the shell holds, injected once via setServerContext at
// plugin load. server-context.ts stays type-imports-only, so importing the accessor (a value) here is not a
// runtime cycle; only TYPES come from vite-fs-plugin. Each moved function is byte-identical to its former
// shell definition save for a getServerContext()/binding preamble (and the fsState-pinned maps are `??=`-init
// where first read, exactly like server-delivery's announcedMemberships).

export const MAX_THREAD_MSGS = 200; // bounded TAIL — the feed republishes the whole buffer, so keep it modest

// The in-memory log for a thread, lazily seeded from the ledger on first touch. seedThreadLogs
// (startBoardFeeds) covers a MOUNTED board at boot, but a board can also be merely re-REGISTERED from
// boards.json with no tab ever mounting it — its endpoints resolve, its logs were never seeded. An
// append that started from an empty map would mint seq 1 onto a ledger whose real tail may be hundreds
// of messages on, corrupting order and every member's read cursor. Same tail trim as the boot seed.
export function threadLog(boardId: string, threadId: string): ThreadMsg[] {
  const { boards, fsState } = getServerContext();
  const threadLogs = fsState.threadLogs;
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
export function seedThreadLogs(repoPath: string): void {
  const { fsState, boardIdentity } = getServerContext();
  const threadLogs = fsState.threadLogs;
  const durableMembers = (fsState.durableMembers ??= new Map<string, Set<string>>());
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
  const records = boardStoreRecords(boardIdentity(repoPath).boardId, repoPath) ?? [];
  for (const r of records)
    if (r.typeName === RECORD_TYPE.edge && String(r.type) === EDGE_TYPE.memberOpen) {
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
const EMITTED_MEMBER_TTL = 60_000;
// A session card carries its sid in the node id under TWO vintages: `node:live:<sid>` (spawn/summon) and
// `node:session:<sid>` (a reopen from the rail, loader.ts). Both resolve to the same sid — so id-based sid
// resolution (the leave-vs-card-delete discriminator, boot-time durable-member adoption) stays correct
// across a spawn→close→reopen, where the reopened card is the node:session: vintage. (Title-based
// resolution — nodeSessionId — was already robust to both; this is its id-based twin catching up.)
export const sidFromSessionNode = (node: string): string | null =>
  node.startsWith("node:live:") ? node.slice("node:live:".length)
  : node.startsWith("node:session:") ? node.slice("node:session:".length)
  : null;
// Non-expired emitted memberships, pruning stale ones in passing.
export function liveEmittedMembers(): Array<{ thread: string; sid: string }> {
  const emittedMembers = (getServerContext().fsState.emittedMembers ??= new Map<string, { thread: string; sid: string; ts: number }>());
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
export function trackEmittedMembership(cmd: { type: string; payload?: Record<string, unknown> }): void {
  const emittedMembers = (getServerContext().fsState.emittedMembers ??= new Map<string, { thread: string; sid: string; ts: number }>());
  const p = cmd.payload ?? {};
  if (cmd.type === "removeEdge") {
    if (typeof p.id === "string") emittedMembers.delete(p.id);
    return;
  }
  if (cmd.type !== "addEdge" || String(p.type ?? "") !== EDGE_TYPE.memberOpen) return;
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
// Record sid as a durable member of a thread (in-memory + marker). Idempotent; needs the board's repoPath.
export function recordDurableMember(repoPath: string | undefined, threadId: string, sid: string, ts: number): void {
  const durableMembers = (getServerContext().fsState.durableMembers ??= new Map<string, Set<string>>());
  let set = durableMembers.get(threadId);
  if (!set) durableMembers.set(threadId, (set = new Set<string>()));
  set.add(sid);
  if (repoPath) addThreadMember(repoPath, threadId, sid, ts);
}
// Forget a durable membership (in-memory + marker) — the REAL-leave companion, never called on a card delete.
export function forgetDurableMember(repoPath: string | undefined, threadId: string, sid: string): void {
  const durableMembers = (getServerContext().fsState.durableMembers ??= new Map<string, Set<string>>());
  const set = durableMembers.get(threadId);
  if (set) { set.delete(sid); if (set.size === 0) durableMembers.delete(threadId); }
  if (repoPath) removeThreadMember(repoPath, threadId, sid);
}

export function sessionThreads(records: Array<Record<string, unknown>>, sid: string): string[] {
  const durableMembers = (getServerContext().fsState.durableMembers ??= new Map<string, Set<string>>());
  const out: string[] = [];
  const node = sessionNodeForSid(records, sid);
  if (node)
    for (const r of records)
      if (r.typeName === RECORD_TYPE.edge && r.from === node && String(r.type) === EDGE_TYPE.memberOpen && threadNode(records, String(r.to)))
        out.push(String(r.to));
  for (const m of liveEmittedMembers()) if (m.sid === sid && !out.includes(m.thread)) out.push(m.thread);
  // Durable members whose card/edge is gone: still a member of these threads (the card was only a view).
  for (const [threadId, set] of durableMembers) if (set.has(sid) && !out.includes(threadId)) out.push(threadId);
  return out;
}

// The threads `sid` is a member of BY THE LEDGER ALONE (marker ∪ in-memory durable ∪ emitted bridge) — no
// snapshot-edge-derived entries, unlike sessionThreads. This is the REOPEN/REDRAW source: the client
// repaints member:open edges from it (openSession → redrawMemberEdges), and an entry here that the ledger
// doesn't back would be re-onboarded as a fresh join by the announce funnel the moment the redrawn edge hits
// a snapshot save — the pill-click-on-a-Done-session spurious join. A display repaint may only ever MIRROR
// the ledger, so its source must be the ledger. (Read paths — inbox, delivery — keep sessionThreads' wider
// union: there a stale extra entry is harmless, a missing one loses messages.) The marker sweep also covers
// the in-memory map going cold across a plugin re-eval; membership reads stay marker-honest either way.
export function durableSessionThreads(repoPath: string | undefined, sid: string): string[] {
  const durableMembers = (getServerContext().fsState.durableMembers ??= new Map<string, Set<string>>());
  const out: string[] = [];
  for (const m of liveEmittedMembers()) if (m.sid === sid && !out.includes(m.thread)) out.push(m.thread);
  for (const [threadId, set] of durableMembers) if (set.has(sid) && !out.includes(threadId)) out.push(threadId);
  if (repoPath)
    for (const meta of listThreads(repoPath))
      if (meta.threadId && !out.includes(meta.threadId) && threadMembersFromMeta(meta).includes(sid)) out.push(meta.threadId);
  return out;
}

// ── relative-offset layout (P2) ─────────────────────────────────────────────────────────────────────
// The PRIMARY thread of a session is the one it joined EARLIEST (min joinedAt across its memberships) — a
// session's card is anchored to (moves with / reopens relative to) this thread only; a secondary thread
// moving must NOT move it. Ties (equal joinedAt) break on the smaller threadId so the choice is stable. The
// joinedAt lives on each thread's marker (`members[sid].joinedAt`), so this reads one marker per membership;
// callers keep it off hot paths (used on reopen + the debounced offset capture). Returns null when the
// session has no durable memberships. `repoPath` is the board's canonical home; `records` the snapshot.
export function primaryThreadForSession(
  repoPath: string,
  records: Array<Record<string, unknown>>,
  sid: string,
): string | null {
  let best: string | null = null;
  let bestJoinedAt = Infinity;
  for (const threadId of sessionThreads(records, sid)) {
    const rec = (readThreadMeta(repoPath, threadId)?.members ?? {})[sid] as { joinedAt?: number } | undefined;
    const joinedAt = typeof rec?.joinedAt === "number" ? rec.joinedAt : Infinity;
    if (joinedAt < bestJoinedAt || (joinedAt === bestJoinedAt && (best === null || threadId < best))) {
      best = threadId;
      bestJoinedAt = joinedAt;
    }
  }
  return best;
}

// The session's PRIMARY thread id + its stored relative offset {dx,dy}, for the reopen-at-offset placement
// (loader.ts openSession). `offset` is null when the primary membership carries no offset yet (a never-moved
// card whose spawn placement hasn't been captured, or a session with no memberships) — the client then falls
// back to its cascade/spawn spot. Pure read: touches no server state, keeping reopen display-only.
export function sessionAnchor(
  repoPath: string,
  records: Array<Record<string, unknown>>,
  sid: string,
): { primaryThread: string | null; offset: { dx: number; dy: number } | null } {
  const primaryThread = primaryThreadForSession(repoPath, records, sid);
  const offset = primaryThread ? memberOffsetFromMeta(readThreadMeta(repoPath, primaryThread), sid) : null;
  return { primaryThread, offset };
}

// The x,y of a node's layout record in a snapshot, or null (a node with no layout / off-canvas). Pure.
function nodeLayoutPos(records: Array<Record<string, unknown>>, nodeId: string): { x: number; y: number } | null {
  const l = records.find(
    (r) => r.typeName === RECORD_TYPE.layout && (r as { nodeId?: unknown }).nodeId === nodeId,
  ) as { x?: unknown; y?: unknown } | undefined;
  return l && typeof l.x === "number" && typeof l.y === "number" ? { x: l.x, y: l.y } : null;
}

// Capture each durable member's relative offset from its PRIMARY thread card — called from the board-persist
// SNAPSHOT-save hook (beside announceNewMemberships), so it runs on the debounced save that follows a
// drag-end, NOT the per-frame drag (the brief's "persist on drag-end, not every pointermove"). For every
// session that has a card on the board AND whose primary thread card is on the board, recompute
// dx = sessionCardX - primaryThreadCardX (dy likewise) and store it on the primary membership. setMemberOffset
// is idempotent (skips the write when unchanged), so a save where nothing moved — and, crucially, a
// move-with-thread where the session card AND its thread card shifted by the SAME delta (offset preserved) —
// writes nothing. This is also what SEEDS a freshly-spawned card's offset: the first save after a spawn
// captures the server's placeWorkerCard placement. Best-effort; never throws (a bad marker just skips a sid).
export function captureMemberOffsets(boardId: string, records: Array<Record<string, unknown>> | null): void {
  const { boards } = getServerContext();
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath || !records) return;
  // Every session card currently on the board, by sid (a session card carries its full sid as the title).
  const seen = new Set<string>();
  for (const r of records) {
    if (r.typeName !== RECORD_TYPE.node || r.type !== NODE_TYPE.session || typeof r.title !== "string" || !r.title) continue;
    const sid = r.title;
    if (seen.has(sid)) continue;
    seen.add(sid);
    const cardPos = nodeLayoutPos(records, String(r.id));
    if (!cardPos) continue;
    const primaryThread = primaryThreadForSession(repoPath, records, sid);
    if (!primaryThread) continue; // no membership → nothing to anchor to
    const threadPos = nodeLayoutPos(records, primaryThread);
    if (!threadPos) continue; // primary thread card closed → keep the last-known offset
    try {
      setMemberOffset(repoPath, primaryThread, sid, cardPos.x - threadPos.x, cardPos.y - threadPos.y);
    } catch {
      /* best-effort — a single bad marker must not abort the whole capture pass */
    }
  }
}

// Capture each OPEN thread card's reopen-set (P4) — the twin of captureMemberOffsets, called from the same
// board-persist SNAPSHOT-save hook. For every THREAD card currently on the board, record the set of member
// sids whose session card is ALSO on the board (an open member:open edge → a present session card). Stored
// idempotently on the thread marker (setReopenSet skips the write when unchanged). Only threads PRESENT in
// the snapshot are touched, so a closed thread's set is FROZEN at its last-open state — which is exactly the
// set that was open at the moment of close, the thing reopen must restore. Display-only: it reads the
// snapshot and writes a VIEW fact; durable membership is never touched. Best-effort; never throws.
export function captureReopenSets(boardId: string, records: Array<Record<string, unknown>> | null): void {
  const { boards } = getServerContext();
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath || !records) return;
  // Every thread card currently on the board, by id.
  const threadIds = new Set<string>();
  for (const r of records) {
    if (r.typeName === RECORD_TYPE.node && (r.type === NODE_TYPE.thread || r.type === NODE_TYPE.channel)) threadIds.add(String(r.id));
  }
  for (const threadId of threadIds) {
    // Open members: the source session card of each member:open edge pointing at this thread that is itself
    // present in the snapshot (a closed card's edge was removed by display-only close, so this is precisely
    // the open set). nodeSessionId resolves the card node → its sid, returning null for a non-session/absent
    // node, so a dangling edge contributes nothing.
    const open: string[] = [];
    for (const r of records) {
      if (r.typeName !== RECORD_TYPE.edge || r.to !== threadId || String(r.type) !== EDGE_TYPE.memberOpen) continue;
      const sid = nodeSessionId(records, String(r.from));
      if (sid && !open.includes(sid)) open.push(sid);
    }
    try {
      setReopenSet(repoPath, threadId, open);
    } catch {
      /* best-effort — a single bad marker must not abort the whole capture pass */
    }
  }
}

// The records of a board's live server-materialized store (board-engine, §9 stage 1 — hydrated from
// snapshot.json + the events.jsonl tail and kept current as events land), or null if the board has
// nothing persisted yet. Used for all server-side node/edge resolution (thread membership, session-card
// lookup, spawn positioning); it no longer needs a live tab, and no longer lags by the ~400ms snapshot
// debounce — a read reflects the event tail the cache hasn't absorbed.
export function boardSnapshotRecords(boardId: string): Array<Record<string, unknown>> | null {
  const { boards } = getServerContext();
  const b = boards.get(boardId);
  if (!b) return null;
  return boardStoreRecords(boardId, b.repoPath);
}

// A session card carries its session id as the node title (loader.ts: node id node:session:<sid> /
// node:live:<sid>, title = the full sid). Resolve a node id to its session id, or null if the node isn't
// a session card. Reading the title (not parsing the id) keeps this robust to the id scheme.
export function nodeSessionId(records: Array<Record<string, unknown>>, nodeId: string): string | null {
  const n = records.find((r) => r.typeName === RECORD_TYPE.node && r.id === nodeId) as SnapNode | undefined;
  return n && n.type === NODE_TYPE.session && typeof n.title === "string" && n.title ? n.title : null;
}

// The reverse: a session id → its card's node id (so an agent that knows only its own sid can join/leave
// without ever handling a node id). Null if no session card on the board carries that title.
export function sessionNodeForSid(records: Array<Record<string, unknown>>, sid: string): string | null {
  const n = records.find(
    (r) => r.typeName === RECORD_TYPE.node && r.type === NODE_TYPE.session && r.title === sid,
  ) as SnapNode | undefined;
  return n ? String(n.id) : null;
}

// The channel card by id (or null if that id isn't a channel node).
export function threadNode(records: Array<Record<string, unknown>>, threadId: string): SnapNode | null {
  const n = records.find((r) => r.typeName === RECORD_TYPE.node && r.id === threadId) as SnapNode | undefined;
  // "thread" is the node type since §8 step 2; "channel" is the carried-over legacy type (existing
  // channels live on as long-lived threads — same card, same machinery).
  return n && (n.type === NODE_TYPE.thread || n.type === NODE_TYPE.channel) ? n : null;
}

// A session card's display NAME (the new `name` field a role-spawned card carries, `<RoleName>.<short-sid>`),
// or null if it has none. The renderer falls back to the short sid; tag resolution uses it so `@RoleName`
// reaches a role by its handle. Found by the same title===sid convention as sessionNodeForSid.
export function sessionNameForSid(records: Array<Record<string, unknown>>, sid: string): string | null {
  const n = records.find(
    (r) => r.typeName === RECORD_TYPE.node && r.type === NODE_TYPE.session && r.title === sid,
  ) as (SnapNode & { name?: unknown }) | undefined;
  return n && typeof n.name === "string" && n.name ? n.name : null;
}

// The session ids of a channel's OPEN members (from each member:open edge session→channel).
export function threadMemberSids(records: Array<Record<string, unknown>>, threadId: string): string[] {
  const durableMembers = (getServerContext().fsState.durableMembers ??= new Map<string, Set<string>>());
  const out: string[] = [];
  for (const r of records) {
    if (r.typeName === RECORD_TYPE.edge && r.to === threadId && String(r.type) === EDGE_TYPE.memberOpen) {
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
export const historyKey = (threadId: string, sid: string): string => `${threadId}|${sid}`;
// The read cursor that gives `sid` the chosen visibility of `log`: full ⇒ 0 (everything is unread), future
// ⇒ the current tail (only messages from here on). The single source of "how much backlog replays".
export const seedCursor = (mode: "full" | "future", log: ThreadMsg[]): number =>
  mode === "future" && log.length ? log[log.length - 1]!.seq : 0;
