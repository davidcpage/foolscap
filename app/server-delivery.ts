import { randomUUID } from "node:crypto";
import { getPendingAsks, getPendingHistoryMode, getServerContext, getWsClients } from "./server-context.js";
import { bufferBusReplay, takeBusReplay, MAX_PENDING_BUS_REPLAY } from "./bus-replay-buffer.js";
import {
  appendThreadLine,
  fillSeat,
  readPins,
  readSeenMentions,
  readThreadMeta,
  seatForSid,
  threadLevelForSid,
  untaggedSeatNudgeTarget,
  upsertThreadMeta,
  type PinnedMsg,
} from "./thread-ledger.js";
import { threadMemberSids } from "./server-snapshot.js";
import { humanWaiting, cardOnly } from "./thread-waiting.js";
import { wakesSeat } from "./notification-levels.js";
import { COORDINATOR_ROLE } from "./coordinator-heartbeat.js";
import type { WorkIntent } from "./work-intent.js";
import type { LiveSession, PendingBusCommand, SnapNode, ThreadMsg } from "./vite-fs-plugin.js";

// ── the channel-delivery / wake engine (P5 sub-step 1) ─────────────────────────────────────────────
// The first ENGINE module of the P5 god-file split. Where server-context.ts is the DI seam and
// server-http.ts / server-fs.ts hold stateless helpers, this module owns the cross-cutting DELIVERY and
// WAKE machinery the shell used to define inline: appending a thread message, publishing a thread's feed,
// waking its live members (seat-gated), the content-free stdin nudge, the bus-command broadcast, and the
// membership-announce onboarding (both the bus trigger and the snapshot-diff trigger).
//
// These functions reach the shared, cross-request state (the board/live-session registries, the feed bus,
// the thread logs, the membership registry) THROUGH getServerContext() — the exact same pinned singletons
// the shell holds, injected once via setServerContext at plugin load. server-context.ts stays type-imports
// only, so there is no runtime import cycle: this module imports the accessor (a value) from server-context,
// but only TYPES from vite-fs-plugin. Each moved function is byte-identical to its former shell definition
// save for a getServerContext()/binding preamble at its top; the private helpers below moved with them.

// Membership phases already intro'd, keyed `<edgeId>|<member:type>`, so an idempotent re-put doesn't
// re-announce. Two triggers now race to announce the SAME edge — the bus command (agent POST join) and
// the snapshot-diff (a human-drawn join, which never crosses the bus; see announceNewMemberships) — and
// the `announcedMemberships` Set (fsState-pinned, initialized where it is first read) is what makes the
// second a no-op. The phase is part of the key so a pending→open UPGRADE still fires the open onboarding
// even though the pending intro already fired. Cleared on removeEdge (both phases) so a rejoin re-announces.
const announceKey = (id: string, type: string): string => `${id}|${type}`;

// A channel node's `text` is its (optional) DESCRIPTION — Slack-topic style, blank by default. Empty ⇒ "",
// so the onboarding messages can omit the line entirely rather than print a "(none)" placeholder.
const descriptionOf = (chan: SnapNode): string =>
  typeof chan.text === "string" ? chan.text.trim() : "";

// Is `sid` a LIVE session right now (running or idle, not exited / not gone)? The synchronous liveness
// predicate the seat machinery reaches for — an exited session (or one never seen) fails it, which is what
// lets a departed-occupant seat re-fill on respawn while a live occupant is never displaced.
const isSidLive = (sid: string): boolean => {
  const s = getServerContext().liveSessions.get(sid);
  return !!s && s.status !== "exited";
};

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

// Publish a thread's conversation feed (the card's view). Carries the message tail PLUS the thread's PINS
// (R-PIN head context) so the card's pinned tray stays live on every message and every pin/unpin — the pin
// state rides the same feed the log does, no second subscription. Pins live on the durable marker (read
// best-effort; [] when there's no repo/marker). Used by appendThreadMsg, seedThreadLogs, and the pin handler.
export function publishThreadFeed(boardId: string, threadId: string, messages: ThreadMsg[], truncated: boolean): void {
  const { boards, publishFeed, boardSnapshotRecords, sessionStatus } = getServerContext();
  const repoPath = boards.get(boardId)?.repoPath;
  const pins: PinnedMsg[] = repoPath ? readPins(repoPath, threadId) : [];
  // The board owner's unseen-mention signal (user waiting-state + you-pill): an @you/@human mention the human
  // has not yet VIEWED (thread-waiting.js × the durable per-thread `seenMentions`). On the OPEN thread card
  // this no longer paints the "you" pill (that is presence-only now); it drives the client's viewport
  // observer, which marks a mention seen once it scrolls into view. So the card feed carries only what that
  // observer needs — `youWaitingSeqs`, EVERY still-unseen mention seq to watch — plus the count for parity
  // with the rail. The rail popover's preview/more ride /api/threads (handleThreads), not this feed.
  const seen = repoPath ? readSeenMentions(repoPath, threadId) : [];
  const { waiting: youWaiting, count: youWaitingCount, seqs: youWaitingSeqs } = humanWaiting(messages, seen);
  // The DURABLE member roster (sid + role/seat display name), so the card can paint a pill for a member
  // whose session card was deleted — the edge (and its edge-derived pill) vanished, but the membership and
  // seat outlived them (server-snapshot's threadMemberSids folds those cardless durable members in). The
  // card unions this with its edge-derived members: a durable sid with no member:open edge → a CLOSED,
  // clickable pill that reopens the session (the P4 pill-open path). Each entry also carries the member's
  // live STATUS — the SAME canonical sessionStatus() band the session card's frame and the open-member pill
  // (via /api/sessions) derive from, NOT a second derivation — so a CLOSED-but-running session's pill still
  // paints its live colour instead of a misleading neutral (a closed card ≠ an inactive session). Kept lean
  // — sid + name + status only — so this per-frame feed payload stays small (the name is formatted like a
  // live card's node.name so both pills render the same handle through displayHandle). `[]` when there's no
  // repo/marker.
  const seats = (repoPath ? readThreadMeta(repoPath, threadId) : null)?.seats;
  const records = boardSnapshotRecords(boardId) ?? [];
  const members = threadMemberSids(records, threadId).map((sid) => {
    const seat = seatForSid(seats, sid);
    const role = seat ? (seats?.[seat]?.role ?? seat) : null;
    return {
      sid,
      name: role ? `${role}.${sid.slice(0, 8)}` : null,
      status: repoPath ? sessionStatus(repoPath, sid) : null,
    };
  });
  publishFeed("thread:" + threadId, {
    messages,
    truncated,
    pins,
    youWaiting,
    youWaitingCount,
    youWaitingSeqs,
    members,
  });
}

// Append to a channel's log, trim to the tail, republish its feed (the card's conversation view), and
// PERSIST the message to the board's `.canvas/channels/` ledger so it survives a cold restart (the in-memory
// `threadLogs` only survives a hot re-eval). `boardId` resolves which board's `.canvas/` home to write to —
// every caller already has it. The marker upsert also makes the channel appear in the channels-list rail and
// keeps its title/description fresh from the live snapshot. Both disk writes are best-effort (thread-ledger).
export function appendThreadMsg(
  boardId: string,
  threadId: string,
  from: string,
  text: string,
  extra?: { kind: "ask" } | { kind: "intent"; intent: WorkIntent },
): ThreadMsg {
  const { boards, threadLog, boardSnapshotRecords, threadNode, MAX_THREAD_MSGS } = getServerContext();
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
export function wakeThreadMembers(
  boardId: string,
  threadId: string,
  exceptSid: string,
  opts: { broadcast: boolean; mentioned?: Set<string>; origin?: string },
): number {
  const { boards, liveSessions, boardSnapshotRecords, threadMemberSids, maybeRespawnDormantSeat } = getServerContext();
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
  // Untagged → the thread's Coordinator seat (Option B). An untagged post wakes no member above (neither
  // broadcast nor a mention — principle 3's ambient case). But the Coordinator is the thread's STEWARD and is
  // expected to sweep its state, so it should learn of untagged activity on a thread it owns without waiting
  // for the next heartbeat. So nudge the Coordinator seat here — but ONLY when it is LIVE (the same cheap
  // content-free stdin nudge an @-tag gives a live idle seat). A DORMANT Coordinator is deliberately NOT
  // respawned per untagged post: that per-message spawn is the exact cost principle 3 guards against, and it
  // is unnecessary — the Coordinator is already a member, so the message is logged to its inbox and it catches
  // it on its next heartbeat sweep. Scope is strictly the Coordinator seat; every OTHER member's untagged
  // semantics stay unchanged. The pure decision (untagged? seat present? not the sender? live?) lives in
  // untaggedSeatNudgeTarget — here we just apply the nudge to the sid it returns (null when it shouldn't fire).
  const coordSid = untaggedSeatNudgeTarget(meta, COORDINATOR_ROLE, {
    broadcast: opts.broadcast,
    mentioned: opts.mentioned,
    exceptSid,
    isLive: (sid) => { const cs = liveSessions.get(sid); return !!cs && cs.status !== "exited"; },
  });
  if (coordSid) {
    const cs = liveSessions.get(coordSid)!;
    cs.nudge = true;
    woken++;
    if (cs.status === "idle") flushNudge(cs);
  }
  return woken;
}

// The content-free wake: one coalesced user-text line naming the channels with unread + the read recipe.
// Message CONTENT is deliberately absent — the agent fetches it with the tool call, so it lands in tool
// output. Clears the nudge flag; re-armed only when new traffic calls wakeThreadMembers again.
export function flushNudge(s: LiveSession): void {
  const { fsState, boardIdentity, boardSnapshotRecords, sessionThreads, threadNode, sendSessionInput } = getServerContext();
  const threadLogs = fsState.threadLogs;
  const pendingAsks = getPendingAsks(fsState);
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

// Bug B/C — make a headless-CREATED node/edge ADDRESSABLE. A create command's id is otherwise minted
// TAB-side (core addNode/addEdge: `p.id ?? nodeId()`), so a headless POST /api/command that omits
// `payload.id` can never learn the id of the node/edge it just created — the un-addressable orphan (David's
// lost thread/session card). So mint the id SERVER-side here when it's absent, write it INTO the payload
// we're about to broadcast (the tab then uses `p.id` verbatim instead of minting its own), and hand it back
// so handleCommand can echo it in the HTTP response. The id is then deterministic + known to the caller for
// EVERY create — and identical whether a live tab applies it now or the persist-gap buffer replays it later
// (both carry this same payload). addShape delegates to addNode in core, so it takes a node id too. A
// non-create command returns null (there is no created id to report) and its payload is left untouched.
// `mkUuid` is injectable so the pure minting is deterministically testable.
export function ensureCommandId(
  cmd: { type?: string; payload?: unknown },
  mkUuid: () => string = randomUUID,
): string | null {
  const isNode = cmd.type === "addNode" || cmd.type === "addShape";
  const isEdge = cmd.type === "addEdge";
  if (!isNode && !isEdge) return null;
  const payload = cmd.payload && typeof cmd.payload === "object" ? (cmd.payload as Record<string, unknown>) : {};
  if (typeof payload.id !== "string" || !payload.id) payload.id = `${isEdge ? "edge" : "node"}:${mkUuid()}`;
  cmd.payload = payload;
  return String(payload.id);
}

// Broadcast a command to a board's tabs (the board lives in the browser, so a mutation is an addEdge/
// removeEdge the tab applies) and fire the membership-announce side-effect. Returns the tab count it
// reached — 0 means no tab of this board is live, so the command went nowhere. Shared by the generic bus
// (handleCommand) and the channel join/leave/invite endpoints, so a UI-drawn join and an agent's POST
// /join both announce identically.
export function dispatchBusCommand(
  boardId: string,
  cmd: { type: string; payload?: Record<string, unknown>; actor?: string },
  origin: string,
): number {
  const { fsState, trackEmittedMembership } = getServerContext();
  const busClients = fsState.busClients!;
  const wsClients = getWsClients(fsState);
  const clients = busClients.get(boardId); // SSE compat path — the app's tabs ride /api/ws now
  const sockets = [...wsClients].filter((c) => c.boardId === boardId);
  const delivered = (clients?.size ?? 0) + sockets.length;
  const frame = `data: ${JSON.stringify(cmd)}\n\n`;
  if (clients) for (const c of clients) c.res.write(frame);
  for (const c of sockets) c.send({ ch: "bus", cmd });
  // Persist-gap guard (Bug A summon card/edge loss + Bug C headless-created node invisible): the bus is a
  // broadcast relay — it never writes the durable store GET /api/canvas serves; only a tab's debounced
  // Persistence save does. So a CREATION command (addNode/addEdge) that reached no live tab is lost forever
  // unless we hold it for replay. A remove for the same id prunes any buffered create (even when a tab WAS
  // live for the remove) so a create-then-delete with no persisting tab in between nets to nothing.
  if (cmd.type === "removeNode" || cmd.type === "removeEdge") bufferOrPruneBusCommand(boardId, cmd);
  else if (delivered === 0) bufferOrPruneBusCommand(boardId, cmd);
  // Only announce if a tab actually applied it — a command that reached no tab (delivered=0) didn't change
  // the board, so announcing a join/invite that never landed would be a phantom (and double-fire on retry).
  // A buffered member:open edge self-heals its onboarding via the snapshot-diff path (announceNewMemberships)
  // once the replay tab persists it — the same path a human-drawn join takes.
  if (delivered > 0) {
    trackEmittedMembership(cmd); // front-run the snapshot so a post right after a spawn/join wakes the new member
    maybeAnnounceMembership(boardId, cmd, origin);
  }
  return delivered;
}

// ── the spawn/create persist-gap buffer (Bug A + Bug C) ─────────────────────────────────────────────
// The buffer ALGEBRA (which commands to hold, prune-on-remove, the cap) is the pure, hermetically-tested
// module bus-replay-buffer.js (like node-cascade.js); here we own only the fsState wiring. The per-board
// buffer Map lives on fsState so it survives a hot re-eval (THE RULE).
function bufferOrPruneBusCommand(
  boardId: string,
  cmd: { type: string; payload?: Record<string, unknown>; actor?: string },
): void {
  const { fsState } = getServerContext();
  const pending = (fsState.pendingBusReplay ??= new Map<string, PendingBusCommand[]>());
  const { dropped } = bufferBusReplay(pending, boardId, cmd);
  if (dropped > 0)
    console.warn(
      `[bus] pending-replay buffer for ${boardId} exceeded ${MAX_PENDING_BUS_REPLAY}; dropped ${dropped} oldest ` +
        `command(s) — no live tab has attached to persist them`,
    );
}

// Drain (and CLEAR) a board's buffered creation commands — the ws-attach handler replays these to the
// freshly-attached tab right after feedValues. First attacher wins: clearing stops a second tab re-applying
// a duplicate addNode (it hydrates the now-persisted records instead).
export function drainPendingBusReplay(boardId: string): PendingBusCommand[] {
  return takeBusReplay(getServerContext().fsState.pendingBusReplay, boardId) as PendingBusCommand[];
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
export function announceNewMemberships(
  boardId: string,
  before: Array<Record<string, unknown>> | null,
  after: Array<Record<string, unknown>> | null,
  origin: string,
): void {
  const { boards, fsState, sidFromSessionNode, forgetDurableMember } = getServerContext();
  const announcedMemberships = (fsState.announcedMemberships ??= new Set<string>());
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
  const {
    boards,
    liveSessions,
    fsState,
    boardSnapshotRecords,
    threadNode,
    threadMemberSids,
    sessionNameForSid,
    sendSessionInput,
    persistSessionState,
    seedCursor,
    historyKey,
    threadLog,
    nodeSessionId,
    recordDurableMember,
    ensureCoordinatorHeartbeat,
  } = getServerContext();
  const announcedMemberships = (fsState.announcedMemberships ??= new Set<string>());
  const pendingHistoryMode = getPendingHistoryMode(fsState);
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
    // REOPEN GUARD (card-close/reopen is display-only, P1): if `sid` is ALREADY a durable member, this
    // member:open is a REDRAW of an existing membership — a reopened session card repainting its wire — NOT
    // a fresh join. Onboarding here would re-push the welcome text, re-wake peers, reseed the read cursor,
    // and re-fill the seat: all forbidden on a display-only reopen. So record (idempotent) + mark announced,
    // then stop. Checked BEFORE recordDurableMember so a genuine first join reads false. A real RE-join after
    // a leave still onboards (leave dropped the membership → wasMember is false). The dedup Set alone can't
    // stand in for this test: a card delete's removeEdge clears the key, so a reopen would slip through.
    const repoPath = boards.get(boardId)?.repoPath;
    const wasMember = !!(repoPath && readThreadMeta(repoPath, thread.id)?.members?.[sid]);
    recordDurableMember(repoPath, thread.id, sid, Date.now());
    if (wasMember) {
      announcedMemberships.add(announceKey(String(p.id), type));
      return;
    }
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
      if (role && repoPath) {
        const r = fillSeat(repoPath, thread.id, role, sid, Date.now(), isSidLive);
        if (r.blocked)
          sendSessionInput(
            sid,
            `[canvas] The ${role} seat on thread ${thread.id} is held by a live session (${r.heldBy}); ` +
              `you joined SEATLESS (a sid-identified member). @${role} mentions still route to the seated ${role}.`,
          );
        else if (role === COORDINATOR_ROLE && r.seat?.fills === 1)
          // Part 1 — heartbeat DEFAULT-ON: the FIRST staffing of a Coordinator seat auto-enables its sweep.
          ensureCoordinatorHeartbeat(repoPath, thread.id);
      }
    }
  }
}
