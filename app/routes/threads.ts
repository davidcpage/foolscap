import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getPendingHistoryMode, getServerContext } from "../server-context.js";
import { re, type GlobalRoute } from "./router.js";
import { classifyMentionSpawn, resolveTags } from "../thread-tags.js";
import { unreadMentions, senderCursorAfterPost } from "../cas-guard.js";
import { isWorkIntent, intentLine, WORK_INTENTS, type WorkIntent } from "../work-intent.js";
import { isNotificationLevel, NOTIFICATION_LEVELS } from "../notification-levels.js";
import { listRoles } from "../role-ledger.js";
import { isSurfaceClaimed, seatSurfaceKey } from "../auto-wake.js";
import { readJobs, removeJob, upsertJob } from "../standing-jobs.js";
import { listWorktrees as listThreadWorktrees, mergeWorktree, removeWorktree, workItemKey, realpath as wtRealpath } from "../worktrees.js";
import {
  markSeenMentions,
  pinMessage,
  readReopenSet,
  readThreadLog,
  readThreadMeta,
  releaseSeat,
  seatForSid,
  setThreadLevel,
  threadMembersFromMeta,
  unpinMessage,
  upsertThreadMeta,
  type PinnedMsg,
} from "../thread-ledger.js";
import { handleThreadAsk, handleThreadReply } from "./asks.js";
import type { ThreadMsg } from "../vite-fs-plugin.js";

// ── the thread action routes (message / membership / history / intent / level / pin / seen / worktree /
// job) + the standing-jobs & worktrees reads — god-file split, Phase 3 ──────────────────────────────
// The biggest GLOBAL-stage cluster: the POST `/api/(thread|channel)/<id>/<action>` verb-dispatch arm plus
// the `GET .../jobs` and `GET .../worktrees` reads. These are the LIVE coordination path (this is the API
// the board's own threads run on), so behaviour-preservation is byte-exact: each handler body is identical
// to its god-file original, the only delta being a `getServerContext()` preamble that binds the shared
// state + delivery/wake/spawn ENGINE operations (defined in the shell, Phase-5 territory) to the local
// names the body already used. The concern-owned helpers (memberEdge, waitForEdgePersisted, historyMode,
// spawnMentionedWorkers/mentionSpawnBrief, recordThreadIntent) move here with the handlers. The ask/reply
// action handlers live in routes/asks.ts and are dispatched from the shared action arm below.

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
  const { boardSnapshotRecords } = getServerContext();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = boardSnapshotRecords(boardId);
    if (recs && recs.some((r) => r.typeName === "edge" && r.id === edgeId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, JOIN_PERSIST_POLL_MS));
  }
}

// The read cursor that gives `sid` the chosen visibility of `log`: full ⇒ 0 (everything is unread), future
// ⇒ the current tail (only messages from here on). NB: seedCursor itself lives on ServerContext (the shell
// still uses it in the onboarding path); historyMode is concern-owned to the membership/history routes.
const historyMode = (v: unknown): "full" | "future" | undefined => (v === "full" || v === "future" ? v : undefined);

async function handleThreadMessage(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  const {
    boards,
    boardSnapshotRecords,
    threadNode,
    threadMemberSids,
    sessionNodeForSid,
    sessionNameForSid,
    liveSessions,
    appendThreadMsg,
    persistSessionState,
    publishSession,
    wakeThreadMembers,
    originOf,
  } = getServerContext();
  const threadLogs = getServerContext().fsState.threadLogs;
  let body: { from?: unknown; text?: unknown; force?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.text !== "string" || !body.text) return sendJson(res, 400, { error: "missing text" });
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const records = boardSnapshotRecords(boardId);
  // Existence gate is the LEDGER marker, falling back to the canvas node (the seen pattern, 6100261): a
  // thread persists in `.canvas/threads/` with no card on the board, and a card-only brand-new thread has a
  // node but no marker until its first post. Requiring the node 404'd posts to any off-canvas thread.
  const meta = readThreadMeta(boards.get(boardId)?.repoPath ?? "", threadId);
  if (!meta && !(records && threadNode(records, threadId)))
    return sendJson(res, 404, { error: "channel not found" });

  const from = body.from;
  // Membership is the snapshot ∪ ledger union: the marker is authoritative (it survives a snapshot that
  // never carried the member's edge — a headless join — and an fsState re-eval), the snapshot covers the
  // just-drawn-edge window before its announce lands in the ledger.
  const members = records ? threadMemberSids(records, threadId) : [];
  for (const sid of threadMembersFromMeta(meta)) if (!members.includes(sid)) members.push(sid);
  // Consent: a SESSION must have joined to post (symmetry with receiving). A non-session `from` (the human
  // at the channel card) is the board owner and may post to any channel — §7, legibility not authz.
  if (records && sessionNodeForSid(records, from) && !members.includes(from))
    return sendJson(res, 403, { error: "sender is not a member of this channel" });

  // W11 — mention-gated CAS guard (compare-and-swap on the poster's read cursor). A live SESSION poster may
  // not post over a message that @-mentioned it and still sits unread past its cursor: it must read the
  // thread first (structurally, not just by norm). Exempt a non-session `from` (the human at the card sees
  // the whole thread), and honor an explicit `force:true` override. The 409 hands back the blocking unread
  // so one read-then-repost clears it (no archaeology — the poster GETs /api/inbox to advance its cursor,
  // then reposts). Card-only intents/pins go through their own handlers, so this path is real messages only.
  const posting = liveSessions.get(from);
  if (posting && body.force !== true) {
    const memberEntries = members.map((sid) => ({ sid, name: records ? sessionNameForSid(records, sid) : null }));
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
  // anyone's stdin. The sender has "seen" its own message (cursor advance below, guarded); the NAMED others
  // are woken.
  // HONEST ACCEPT (BUG-6): appendThreadMsg persists to the fsync'd ledger BEFORE it publishes the feed and
  // throws if it can't be made durable — so a 200 here MEANS the post is on disk and survives a restart. A
  // durable-append failure returns 500 (nothing published, no one woken) rather than a dishonest 200 that
  // loses the message; the caller can retry.
  let msg: ThreadMsg;
  try {
    msg = appendThreadMsg(boardId, threadId, from, body.text);
  } catch (e) {
    return sendJson(res, 500, { error: "message could not be persisted — not accepted, retry", detail: String((e as Error)?.message ?? e) });
  }
  // @-tags decide the wake set: `@all` (or a non-tagging client) wakes the whole room (null), a tagged post
  // wakes only the named members, an untagged post wakes no one (ambient — still logged for the cursor read).
  // Pair each member sid with its card name so `@RoleName` resolves by handle, not just sid prefix.
  const memberEntries = members.map((sid) => ({ sid, name: records ? sessionNameForSid(records, sid) : null }));
  const { wakeAll, human, members: tagged, unknown } = resolveTags(body.text, memberEntries);
  const ss = liveSessions.get(from);
  if (ss) {
    // The sender has "seen" its own message — but advancing to msg.seq must NOT skip anything that arrived
    // from OTHERS since the sender's last read (a durably-appended interleaved message would be silently
    // swallowed). senderCursorAfterPost advances only when the sender was caught up (cursor == msg.seq-1),
    // else holds the cursor so the interleaved unread is served next read (W11's read-cursor invariant, write
    // half). The W11 CAS guard above only blocks unread @-MENTIONS; untagged interleaved messages reach here.
    ss.read[threadId] = senderCursorAfterPost(ss.read[threadId] ?? 0, msg.seq);
    // Blue "waiting on an agent": the sender named a specific peer (not @all, not the human) and will idle
    // after this turn waiting on them. Inferred from the tag — no self-report. Each of the sender's posts
    // OVERWRITES this: tagging a peer sets it; a broadcast / human-directed / untagged post clears it (the
    // sender's intent moved on). It then persists across nudges (sendSessionInput keepWaitingOn) until the
    // awaited peer replies (below) — so the blue holds instead of evaporating on the next bit of traffic.
    const peers = tagged.filter((sid) => sid !== from);
    ss.waitingOn = !wakeAll && !human && peers.length ? peers : null;
    persistSessionState(ss);
    // Instant path (mrcmofwf-10): the sender's own band just moved (idle+waitingOn ⇒ blue "waiting-agent",
    // or cleared ⇒ back to orange). It's the sender's own post, not a process event, so nothing else would
    // republish its card until the loopTick safety net — push now so the card matches the pill immediately.
    publishSession(ss);
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
  const { boards, boardSnapshotRecords, threadNode, serverSpawnWorker } = getServerContext();
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
  const {
    boardSnapshotRecords,
    threadNode,
    threadMemberSids,
    sessionNodeForSid,
    boards,
    dispatchBusCommand,
    forgetDurableMember,
    appendThreadMsg,
    publishFeed,
    historyKey,
  } = getServerContext();
  const pendingHistoryMode = getPendingHistoryMode(getServerContext().fsState);
  let body: { from?: unknown; target?: unknown; history?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const repoPath = boards.get(boardId)?.repoPath;
  const records = boardSnapshotRecords(boardId);

  // For join/leave the actor is the joining session; for invite it's the target being proposed.
  const subjectSid = action === "invite" ? (typeof body.target === "string" ? body.target : "") : body.from;
  if (!subjectSid) return sendJson(res, 400, { error: "missing target" });

  if (action === "leave") {
    // LEAVE is LEDGER-FIRST. Durable membership is the record and the member:open edge only its view — and
    // since the snapshot diff no longer infers a leave from a vanished edge, this endpoint (with the
    // done-member detach sweep) is the ONLY way a membership ends. It must therefore work for a member whose
    // card/edge never reached the snapshot (a headless join) or is gone (card closed): existence-gate on the
    // ledger marker, membership on the union (snapshot ∪ durable), and treat the edge removal as best-effort
    // display cleanup — its absence, or the absence of a live tab, must not block the durable mutation.
    if (!readThreadMeta(repoPath ?? "", threadId) && !(records && threadNode(records, threadId)))
      return sendJson(res, 404, { error: "channel not found" });
    const isMember =
      (records ? threadMemberSids(records, threadId).includes(body.from) : false) ||
      threadMembersFromMeta(readThreadMeta(repoPath ?? "", threadId)).includes(body.from);
    if (!isMember) return sendJson(res, 404, { error: "not a member of this channel" });
    // Release the seat this leaver holds (§5): a seat survives a process EXIT (respawn re-fills it), but an
    // explicit LEAVE is a deliberate departure — give the seat back so the next same-role join fills fresh,
    // and self-heal a seat stuck to a departed sid. Best-effort; keyed on the leaver's sid, not the role.
    if (repoPath) releaseSeat(repoPath, threadId, body.from);
    forgetDurableMember(repoPath, threadId, body.from);
    // Membership changes are never silent (the 2026-07-12 drops were): log the departure for the record.
    // Best-effort: appendThreadMsg throws on a durable failure (BUG-6), but the durable LEAVE already landed
    // above (releaseSeat/forgetDurableMember) — a failed system line must not un-leave the member or 500 the
    // leave. Log it and continue.
    try {
      appendThreadMsg(boardId, threadId, "system", `${body.from} left the thread.`);
    } catch (e) {
      console.warn(`[thread] leave system line for ${body.from} on ${threadId} not persisted:`, (e as Error)?.message ?? e);
    }
    publishFeed("threads:" + boardId, { ts: Date.now() }); // rail roster refresh
    const sessionNode = records ? sessionNodeForSid(records, body.from) : null;
    const edgeId = sessionNode && records ? memberEdge(records, sessionNode, threadId) : null;
    if (edgeId) dispatchBusCommand(boardId, { type: "removeEdge", actor: body.from, payload: { id: edgeId } }, origin);
    return sendJson(res, 200, { ok: true, channel: threadId, action, subject: subjectSid });
  }

  // join/invite still need the canvas: they CREATE the membership's view (an edge needs a session node to
  // hang off), and the member:open onboarding funnel resolves the joiner through the snapshot.
  if (!records) return sendJson(res, 409, { error: "no canvas state for this board yet" });
  if (!threadNode(records, threadId)) return sendJson(res, 404, { error: "channel not found" });
  const sessionNode = sessionNodeForSid(records, subjectSid);
  if (!sessionNode) return sendJson(res, 400, { error: `no session card on this board for ${subjectSid}` });

  // An optional history choice rides the invite/join — stash it for the member:open onboarding to consume
  // when it seeds the cursor (a pending invite carries it through to the eventual accept). Absent ⇒ default.
  const mode = historyMode(body.history);
  if (mode) pendingHistoryMode.set(historyKey(threadId, subjectSid), mode);

  const id = memberEdge(records, sessionNode, threadId) ?? `edge:${crypto.randomUUID().slice(0, 8)}`;
  const type = action === "join" ? "member:open" : "member:pending";
  const cmd = { type: "addEdge", actor: body.from, payload: { id, from: sessionNode, to: threadId, type } };
  // §9 stage 2: the edge is committed + made durable server-side here (no live tab required — the old
  // 503-on-no-tab is retired). commitBoardCommand folds it into the live store synchronously, so the
  // member:open edge is visible to server reads (threadNode / waitForEdgePersisted) the instant this returns.
  dispatchBusCommand(boardId, cmd, origin);
  // T3b: a join doesn't return until its member:open edge is visible in the live store (waitForEdgePersisted),
  // so the caller can message/ask straight away. Now durable at commit, this resolves on the first poll.
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
  const { boardSnapshotRecords, threadNode, liveSessions, threadMemberSids, seedCursor, threadLog, flushNudge, historyKey } =
    getServerContext();
  const pendingHistoryMode = getPendingHistoryMode(getServerContext().fsState);
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
  const { boardSnapshotRecords, threadNode, sessionNodeForSid, threadMemberSids } = getServerContext();
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
  // Honest accept (BUG-6): the intent's card entry persists via appendThreadMsg (throws on a durable failure),
  // so an un-persistable declaration returns 500 rather than a dishonest 200 that loses the work-intent.
  let declared: { msg: ThreadMsg; seat: string | null };
  try {
    declared = recordThreadIntent(boardId, threadId, body.from, body.intent, note);
  } catch (e) {
    return sendJson(res, 500, { error: "intent could not be persisted — not recorded, retry", detail: String((e as Error)?.message ?? e) });
  }
  const { msg, seat } = declared;
  sendJson(res, 200, { ok: true, thread: threadId, channel: threadId, from: body.from, seat, intent: body.intent, seq: msg.seq });
}

// Record a work-intent typed act — the shared core of a declaration (the HTTP handler above) AND the
// server's own auto-freshen (clearBlockedIntents, in the shell): append the card entry (kind:"intent", so
// it renders on the thread and the roster pill reads it, but never wakes the room) AND replace the
// latest-per-participant slot on the meta marker. Full-object replace onto the marker — appendThreadMsg's
// own meta upsert shallow-merges around it, so activity bumps never clobber it (pinned by the ledger test).
// Keyed by the declarer's SEAT when it holds one (§5: the declared state must survive an occupant respawn —
// a fresh session re-fills the seat and inherits/overwrites the same slot), else by sid; the record's own
// `sid` field says which occupant actually spoke.
function recordThreadIntent(
  boardId: string,
  threadId: string,
  from: string,
  intent: WorkIntent,
  note?: string,
): { msg: ThreadMsg; seat: string | null } {
  const { appendThreadMsg, boards, publishSession, liveSessions } = getServerContext();
  const msg = appendThreadMsg(boardId, threadId, from, intentLine(intent, note), { kind: "intent", intent });
  const repoPath = boards.get(boardId)?.repoPath;
  let seat: string | null = null;
  if (repoPath) {
    const meta = readThreadMeta(repoPath, threadId);
    seat = seatForSid(meta?.seats, from);
    const prior = meta?.intents ?? {};
    upsertThreadMeta(repoPath, threadId, {
      intents: { ...prior, [seat ?? from]: { intent, ts: msg.ts, sid: from, ...(note ? { note } : {}) } },
    });
    // Instant path (mrcmofwf-10): a declared blocked:human/blocked:peer refines the declarer's idle band
    // (orange/blue), but a declaration is card-only bookkeeping — it fires no process event, so the card's
    // pushed band would otherwise wait for the loopTick safety net. Republish the declarer now if it's live.
    const declarer = liveSessions.get(from);
    if (declarer) publishSession(declarer);
  }
  return { msg, seat };
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
  const { boardSnapshotRecords, threadNode, sessionNodeForSid, threadMemberSids, boards, publishFeed } = getServerContext();
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
  const { boardSnapshotRecords, threadNode, sessionNodeForSid, threadMemberSids, boards, threadLog, publishThreadFeed, publishFeed } =
    getServerContext();
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
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });
  // Existence gate is the LEDGER marker, canvas-node fallback (the seen pattern, 6100261): pinning is a
  // durable ledger op that must not need the thread's card on the board.
  const records = boardSnapshotRecords(boardId);
  const meta = readThreadMeta(repoPath, threadId);
  if (!meta && !(records && threadNode(records, threadId)))
    return sendJson(res, 404, { error: "thread not found" });
  // Consent mirrors message/seen: a SESSION must be a member, judged on the snapshot ∪ ledger union — a
  // ledger member whose edge never reached the snapshot (headless join) must not 403; the human always may.
  if (
    records &&
    sessionNodeForSid(records, body.from) &&
    !threadMemberSids(records, threadId).includes(body.from) &&
    !threadMembersFromMeta(meta).includes(body.from)
  )
    return sendJson(res, 403, { error: "sender is not a member of this thread" });

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

// POST /api/thread/<id>/seen { from, seqs } — mark @you/@human MENTION seqs the human has now VIEWED (user
// waiting-state + you-pill). Driven by the thread card's viewport observer: when a still-unseen mention
// scrolls into the log while the card is focused, its seq is POSTed here and unioned into the durable
// `seenMentions` set (thread-ledger.markSeenMentions), which drops it from the unseen count individually
// (per-viewed-message clearing — NOT clear-on-reply, NOT clear-on-focus). Idempotent: re-marking a seen seq is
// a no-op. Consent mirrors handleThreadPin — a member (or the human at the card, who is not a session node)
// may mark seen. `seqs` must be an array of positive integers.
async function handleThreadSeen(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  const { boards, boardSnapshotRecords, sessionNodeForSid, threadMemberSids, threadLog, publishThreadFeed, publishFeed } =
    getServerContext();
  let body: { from?: unknown; seqs?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  if (!Array.isArray(body.seqs) || !body.seqs.every((s) => Number.isInteger(s) && (s as number) >= 1))
    return sendJson(res, 400, { error: "seqs must be an array of positive integers" });
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });
  // Existence gate is the LEDGER marker, NOT a canvas node. A thread persists in `.canvas/threads/` with no
  // card on the board — the rail lists EVERY thread, and opening one adds its card CLIENT-side, which may not
  // have reached the server snapshot yet (a thread deleted from the canvas still lists too). Requiring the
  // node 404'd every seen-POST for an off-canvas thread, so a rail-badged thread never cleared on open — only
  // a later deselect/reselect worked, once the client's addNode had persisted. Marking mentions seen is a
  // durable ledger op that doesn't need the node.
  if (!readThreadMeta(repoPath, threadId)) return sendJson(res, 404, { error: "thread not found" });
  // Consent mirrors handleThreadPin: a SESSION sender must be a member (checked against the live snapshot when
  // one exists); the human at the card is not a session node and always may. An absent/node-less snapshot
  // therefore never blocks the human — the only caller the rail badge depends on.
  const records = boardSnapshotRecords(boardId);
  if (
    records &&
    sessionNodeForSid(records, body.from) &&
    !threadMemberSids(records, threadId).includes(body.from) &&
    !threadMembersFromMeta(readThreadMeta(repoPath, threadId)).includes(body.from)
  )
    return sendJson(res, 403, { error: "sender is not a member of this thread" });
  const seen = markSeenMentions(repoPath, threadId, body.seqs as number[]);
  // Republish the card feed (shrinks youWaitingSeqs) + nudge the rail (clears/decrements signal (a)) so both
  // surfaces reflect the newly-viewed mentions live, exactly like a pin does.
  publishThreadFeed(boardId, threadId, threadLog(boardId, threadId), false);
  publishFeed("threads:" + boardId, { ts: Date.now() });
  sendJson(res, 200, { ok: true, thread: threadId, channel: threadId, from: body.from, seen });
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
  const { boardSnapshotRecords, threadNode, sessionNodeForSid, threadMemberSids, boards, publishFeed, liveSessions } = getServerContext();
  let body: { from?: unknown; op?: unknown; key?: unknown; roleId?: unknown; force?: unknown; base?: unknown; noVerify?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.from !== "string" || !body.from) return sendJson(res, 400, { error: "missing from" });
  const op = typeof body.op === "string" ? body.op : "list";
  if (op !== "list" && op !== "remove" && op !== "merge") return sendJson(res, 400, { error: `unknown op "${op}" (list|remove|merge)` });
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return sendJson(res, 409, { error: "no repo for this board" });
  // Existence gate is the LEDGER marker, canvas-node fallback (the seen pattern, 6100261): worktree ops are
  // git+marker acts, tab-independent by design — they must not need the thread's card on the board.
  const records = boardSnapshotRecords(boardId);
  const meta = readThreadMeta(repoPath, threadId);
  if (!meta && !(records && threadNode(records, threadId)))
    return sendJson(res, 404, { error: "thread not found" });
  // Consent on the snapshot ∪ ledger union. The 2026-07-12 merges 403'd here: the workers were LEDGER
  // members whose member:open edges never reached the snapshot (headless joins), and the old gate read the
  // snapshot alone. The marker is the authoritative membership tier — honor it directly.
  if (
    records &&
    sessionNodeForSid(records, body.from) &&
    !threadMemberSids(records, threadId).includes(body.from) &&
    !threadMembersFromMeta(meta).includes(body.from)
  )
    return sendJson(res, 403, { error: "sender is not a member of this thread" });

  if (op === "list") return sendJson(res, 200, { thread: threadId, worktrees: listThreadWorktrees(repoPath, threadId) });
  const explicitKey = typeof body.key === "string" && body.key ? body.key : null;
  const roleId = typeof body.roleId === "string" && body.roleId ? body.roleId : null;
  const key = workItemKey({ threadId, roleId, explicitKey });

  // BUG-8 occupancy guard: never tear down a worktree a LIVE session is currently cwd-ed in (yanking its cwd
  // makes the process exit code=1 → a false "crashed" band). Build the predicate from the live-session
  // registry; teardown defers (stamps pendingReap) while it's true, and reapPendingWorktreesTick cleans up
  // once the occupant exits.
  const occupants = new Map<string, string>(); // realpath(cwd) → occupying session sid
  for (const s of liveSessions.values()) if (s.status !== "exited") occupants.set(wtRealpath(s.cwd), s.id);
  const isOccupied = (wtPath: string) => occupants.get(wtRealpath(wtPath)) ?? null;

  if (op === "merge") {
    const base = typeof body.base === "string" && body.base ? body.base : "main";
    const result = mergeWorktree(repoPath, threadId, key!, { base, noVerify: body.noVerify === true, force: body.force === true, isOccupied });
    publishFeed("threads:" + boardId, { ts: Date.now() }); // rail re-pull (a merged worktree drops off the marker)
    return sendJson(res, result.merged ? 200 : 409, { thread: threadId, key, ...result });
  }

  const result = removeWorktree(repoPath, threadId, key!, { force: body.force === true, isOccupied });
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
  const { boardSnapshotRecords, threadNode, sessionNodeForSid, threadMemberSids, boards, publishFeed, republishThreadSeatOccupants } =
    getServerContext();
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
    if (removed) republishThreadSeatOccupants(repoPath, threadId); // mrcmofwf-10: the seat's `scheduled` band may have dropped
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
  republishThreadSeatOccupants(repoPath, threadId); // mrcmofwf-10: the seat's occupant may now read `scheduled`
  sendJson(res, 200, { ok: true, thread: threadId, job, jobs });
}

// Threads (§8 step 2 — /api/thread/… is canonical; /api/channel/… stays a working alias). The thread id
// is a node id carrying a colon, so the client percent-encodes it — match any non-slash segment and decode.
// Registered into GLOBAL_ROUTES at the exact positions the inline arms held: the action verb-dispatch first,
// then the jobs read, then the worktrees read (both board-scoped GETs). reqBoard/originOf resolve at request
// time through the ServerContext seam.
export const threadRoutes: GlobalRoute[] = [
  {
    method: "POST",
    match: re(/^\/api\/(?:thread|channel)\/([^/]+)\/(message|join|leave|invite|history|ask|reply|intent|level|pin|seen|job|worktree)$/),
    run: (req, res, url, g) => {
      const ctx = getServerContext();
      const b = ctx.reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      const threadId = decodeURIComponent(g[0]!);
      const action = g[1]!;
      if (action === "message") return void handleThreadMessage(req, res, b.boardId, threadId);
      if (action === "history") return void handleThreadHistory(req, res, b.boardId, threadId);
      if (action === "ask") return void handleThreadAsk(req, res, b.boardId, threadId);
      if (action === "reply") return void handleThreadReply(req, res, b.boardId, threadId);
      if (action === "intent") return void handleThreadIntent(req, res, b.boardId, threadId);
      if (action === "level") return void handleThreadLevel(req, res, b.boardId, threadId);
      if (action === "pin") return void handleThreadPin(req, res, b.boardId, threadId);
      if (action === "seen") return void handleThreadSeen(req, res, b.boardId, threadId);
      if (action === "job") return void handleThreadJob(req, res, b.boardId, threadId);
      if (action === "worktree") return void handleThreadWorktree(req, res, b.boardId, threadId);
      return void handleThreadMembership(req, res, b.boardId, threadId, action as "join" | "leave" | "invite", ctx.originOf(req));
    },
  },
  // GET /api/thread/<id>/jobs — read this thread's standing jobs (R6/W6, for the CLI + smoke test).
  {
    method: "GET",
    match: re(/^\/api\/(?:thread|channel)\/([^/]+)\/jobs$/),
    run: (_req, res, url, g) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      const threadId = decodeURIComponent(g[0]!);
      return sendJson(res, 200, { thread: threadId, jobs: readJobs(b.repoPath, threadId) });
    },
  },
  // GET /api/thread/<id>/worktrees — read this thread's recorded work-item worktrees (Stage 1, for the CLI).
  {
    method: "GET",
    match: re(/^\/api\/(?:thread|channel)\/([^/]+)\/worktrees$/),
    run: (_req, res, url, g) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      const threadId = decodeURIComponent(g[0]!);
      return sendJson(res, 200, { thread: threadId, worktrees: listThreadWorktrees(b.repoPath, threadId) });
    },
  },
  // GET /api/thread/<id>/reopen-set — the member sids whose card was open when this thread's card last
  // closed (P4). The client reads it on reopen (openChannel) to restore that exact set of session cards.
  // [] ⇒ restore the thread card alone (never recorded, or closed with no members open — incl. first open).
  {
    method: "GET",
    match: re(/^\/api\/(?:thread|channel)\/([^/]+)\/reopen-set$/),
    run: (_req, res, url, g) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      const threadId = decodeURIComponent(g[0]!);
      // Filter the frozen reopen-set to sids that are STILL durable members (P5): a member DETACHED (done →
      // dropped from the roster) after this thread card closed is in the frozen set but must NOT be restored —
      // reopening the thread would otherwise resurrect a card the detach auto-closed. When the thread card was
      // open at detach the set self-heals (the reconciler removed the card → next capture drops it); this
      // covers the closed-at-detach case where the set was frozen with the now-gone member.
      const meta = readThreadMeta(b.repoPath, threadId);
      const members = new Set<string>(threadMembersFromMeta(meta));
      for (const s of Object.values(meta?.seats ?? {})) if (s?.sid) members.add(s.sid); // seat-only members count too
      const sids = readReopenSet(meta).filter((sid) => members.has(sid));
      return sendJson(res, 200, { thread: threadId, sids });
    },
  },
];
