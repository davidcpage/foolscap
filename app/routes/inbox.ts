import type { ServerResponse } from "node:http";
import { sendJson, windowParam } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { exact, type GlobalRoute } from "./router.js";
import { cardOnly } from "../thread-waiting.js";
import { readThreadLog, readPins } from "../thread-ledger.js";
import type { ThreadMsg } from "../server-types.js";

// ── the inbox read tool (GET /api/inbox) — god-file split, Phase 3 ──────────────────────────────────
// The read side of channel messaging: an agent GETs this with Bash so unread thread messages land in TOOL
// OUTPUT, never a user turn (principle 4e). Content lives only in the off-log channel logs; this reads it,
// windows the tail on request, attaches head-context pins, and advances the session's per-thread cursors.
// The delivery/wake engine stays in the shell — this module reaches its snapshot/log resolvers through the
// ServerContext seam (getServerContext()), exactly as the Phase-1/2 route modules do.

// The agent-facing shape of an inbox message — DENSER and more LEGIBLE than the stored ThreadMsg. Two
// changes vs the raw record: `from` is a short HANDLE not a 36-char UUID (see inboxHandle), and `ts` (an
// opaque 13-digit epoch-ms) becomes `t`, a compact local `MM-DD HH:MM` (see fmtTs) — which is both readable
// AND fewer bytes than the epoch it replaces, while still carrying date + time so timing conflicts and
// natural-language references ("continuing yesterday's work") survive. `seq` still gives strict ordering, so
// seconds/year are dropped as redundant noise. 92% of a backlog read is message text; this is a readability
// win first, a few-percent size win second.
interface InboxMsg {
  seq: number;
  t: string; // compact local timestamp, `MM-DD HH:MM`
  from: string; // a short, @-taggable handle (see inboxHandle), not the full session UUID
  text: string;
}

// A sender's short handle for the agent-facing inbox: its role name (`RoleName.<short-sid>`, when spawned as
// a role) else an 8-char sid prefix — both of which are valid `@`-tag / prefix handles, so a reader can reply
// to or tag the sender straight from what it sees. `human`/`system` pass through unchanged. (The full sid for
// `/ask`'s `to` / `/invite`'s `target` stays available from the channel's member roster, as it always was.)
function inboxHandle(records: Array<Record<string, unknown>>, from: string): string {
  const { sessionNameForSid } = getServerContext();
  if (from === "human" || from === "system") return from;
  return sessionNameForSid(records, from) ?? from.slice(0, 8);
}

// A stored epoch-ms `ts` → compact LOCAL `MM-DD HH:MM`. Local (the board is single-user, on this machine) so
// the time reads as the human/agent would discuss it; minute precision (seq carries exact order, so seconds
// add nothing); month-day so a cross-day reference still resolves; year dropped (rarely ambiguous in a live
// channel — re-add if a board ever spans new year).
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Opt-in WINDOWING of a channel's unread tail (CLAUDE.md truncation discipline: bound in ONE place, keep the
// TAIL — recent matters most for a scroll-to-bottom log — and surface a `truncated` flag; never a silent
// drop). Applies a max message COUNT (`limit`) and/or a max TEXT-BYTE budget (`bytes`) to `fresh`, keeping
// the most recent. Always keeps ≥1 message (a budget smaller than the last message still yields it, flagged).
// Returns the kept tail + how many older messages were omitted (0 ⇒ nothing trimmed).
function windowTail(fresh: ThreadMsg[], limit: number | null, bytes: number | null): { kept: ThreadMsg[]; omitted: number } {
  if (limit == null && bytes == null) return { kept: fresh, omitted: 0 };
  let kept = limit != null && fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh.slice();
  if (bytes != null) {
    const out: ThreadMsg[] = [];
    let used = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(kept[i]!.text, "utf8");
      if (out.length > 0 && used + size > bytes) break; // always keep ≥1, then stop once the budget is spent
      out.unshift(kept[i]!);
      used += size;
    }
    kept = out;
  }
  return { kept, omitted: fresh.length - kept.length };
}

// GET /api/inbox?session=<sid> — the read tool. Returns this session's UNREAD channel messages (across all
// channels it's joined to), grouped by channel, and advances its read cursors. The agent fetches this with
// Bash, so the messages land in TOOL OUTPUT, never as a user turn — the whole point of 4e. Content lives
// only in the off-log channel log; this is the read side of it.
function handleInboxRead(res: ServerResponse, sid: string | null, limit: number | null, bytes: number | null): void {
  const { liveSessions, boardIdentity, boardSnapshotRecords, sessionThreads, threadLog, threadNode, persistSessionState } =
    getServerContext();
  if (!sid) return sendJson(res, 400, { error: "missing ?session=" });
  const s = liveSessions.get(sid);
  if (!s) return sendJson(res, 404, { error: "no such live session" });
  const boardId = boardIdentity(s.repoPath).boardId;
  const records = boardSnapshotRecords(boardId);
  // `pinned` is the thread's HEAD CONTEXT (R-PIN): re-read on EVERY wake ahead of the recent tail, so the
  // task statement / `Done when:` condition / load-bearing framing stay present however far the log has
  // scrolled. Surfaced on any thread that has fresh messages this read (a wake implies fresh content there),
  // in the same compact shape as messages. It does NOT advance the cursor and is not counted as unread.
  type OutChan = {
    channel: string;
    title: string;
    messages: InboxMsg[];
    pinned?: InboxMsg[];
    truncated?: { omitted: number; hint: string };
  };
  const channels: OutChan[] = [];
  if (records) {
    for (const threadId of sessionThreads(records, sid)) {
      let log = threadLog(boardId, threadId);
      const since = s.read[threadId] ?? 0;
      if (log.length && log[0]!.seq > since + 1) {
        // The in-memory tail (MAX_THREAD_MSGS — a feed-republish bound, not a read cap) starts past this
        // member's cursor: the older unread live only on disk. Serve THIS read from the full ledger
        // instead of re-dropping content a memory bound already paid for (CLAUDE.md truncation rule —
        // only the caller's own opt-in ?limit/?bytes window may cut, and it surfaces `truncated`).
        const full = readThreadLog(s.repoPath, threadId);
        if (full.length) log = full;
      }
      const fresh = log.filter((mng) => mng.seq > since && !cardOnly(mng)); // ask-echoes / intent acts are card-only
      // Opt-in window: keep the recent TAIL within the requested caps; the omitted are OLDER (the cursor
      // still advances to the end below, so they're marked read — recoverable by re-joining history:"full",
      // which re-seeds the cursor to 0). Surfaced as `truncated`, never silently dropped (CLAUDE.md).
      const { kept, omitted } = windowTail(fresh, limit, bytes);
      if (kept.length) {
        const out: OutChan = {
          channel: threadId,
          title: threadNode(records, threadId)?.title || "",
          messages: kept.map((m) => ({ seq: m.seq, t: fmtTs(m.ts), from: inboxHandle(records, m.from), text: m.text })),
        };
        if (omitted > 0)
          out.truncated = { omitted, hint: `${omitted} older message(s) windowed out; re-join with history:"full" to replay all` };
        // Head context: attach the pins so a woken agent re-reads the task/done-condition/framing (R-PIN).
        const pins = readPins(s.repoPath, threadId);
        if (pins.length)
          out.pinned = pins.map((p) => ({ seq: p.seq, t: fmtTs(p.ts), from: inboxHandle(records, p.from), text: p.text }));
        channels.push(out);
      }
      if (log.length) s.read[threadId] = log[log.length - 1]!.seq; // mark all read (incl. skipped card-only entries)
    }
    persistSessionState(s);
  }
  const count = channels.reduce((n, c) => n + c.messages.length, 0);
  sendJson(res, 200, { channels, count });
}

// The channel-message read tool (session id is a global UUID, so no ?board= needed).
export const inboxRoutes: GlobalRoute[] = [
  {
    method: "GET",
    match: exact("/api/inbox"),
    run: (_req, res, url) => handleInboxRead(res, url.searchParams.get("session"), windowParam(url, "limit"), windowParam(url, "bytes")),
  },
];
