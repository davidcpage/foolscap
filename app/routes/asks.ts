import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { exact, type GlobalRoute } from "./router.js";

// ── §16 ask/reply + the pending-ask queue — god-file split, Phase 3 ─────────────────────────────────
// A synchronous binary consultation over channel membership: /ask parks the asker's connection and nudges
// ONLY the answerer; /reply (addressee only) resolves it and echoes a card-only Q→A summary; /api/asks is
// the answerer's pending-consultation queue (parallel to /api/inbox). The held asks live in the shared
// `fsState.pendingAsks` registry (reached via ServerContext — pinned + ??=-initialized at god-file load, so
// always present by request time; the pendingPermissions precedent). settleAsk (resolve-once) is concern-
// owned and moved here with the handlers. The ask/reply handlers are exported so the thread-action route
// (routes/threads.ts) dispatches them from the shared `/api/thread/<id>/<action>` arm.

const ASK_TIMEOUT_DEFAULT = 30_000;
const ASK_TIMEOUT_MAX = 60_000; // capped under the agent's Bash tool timeout so the socket never out-waits it

// Resolve a parked /ask connection exactly once (reply or timeout), clearing its timer and registry entry.
export function settleAsk(askId: string, payload: Record<string, unknown>): void {
  const pendingAsks = getServerContext().fsState.pendingAsks!;
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
export async function handleThreadAsk(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  const { boardSnapshotRecords, threadNode, threadMemberSids, liveSessions, flushNudge } = getServerContext();
  const pendingAsks = getServerContext().fsState.pendingAsks!;
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
  const pendingAsks = getServerContext().fsState.pendingAsks!;
  if (!sid) return sendJson(res, 400, { error: "missing ?session=" });
  const asks = [...pendingAsks.values()]
    .filter((a) => a.to === sid)
    .map((a) => ({ askId: a.askId, channel: a.threadId, from: a.from, text: a.text, ts: a.ts }));
  sendJson(res, 200, { asks, count: asks.length });
}

// POST /api/thread/<id>/reply { from, askId, text } — ONLY the addressee answers. Resolves the asker's
// held connection and echoes a card-only Q→A summary (kind:"ask") so the channel card stays legible
// without waking the other members (§16 seam).
export async function handleThreadReply(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  threadId: string,
): Promise<void> {
  const { appendThreadMsg } = getServerContext();
  const pendingAsks = getServerContext().fsState.pendingAsks!;
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

// §16: the answerer's pending-consultation queue (session id is a global UUID, so no ?board=).
export const askRoutes: GlobalRoute[] = [
  { method: "GET", match: exact("/api/asks"), run: (_req, res, url) => handleAsksRead(res, url.searchParams.get("session")) },
];
