import type { ServerResponse } from "node:http";
import { sendJson, windowParam, nonNegParam, DEFAULT_INBOX_BYTES } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { exact, type GlobalRoute } from "./router.js";
import { cardOnly } from "../thread-waiting.js";
import { readThreadLog, readPins } from "../thread-ledger.js";
import type { ThreadMsg } from "../vite-fs-plugin.js";

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

// The read shape (query params → behavior). All optional; the DEFAULT (nothing passed) is a consuming read
// of the whole unread tail, self-bounded to DEFAULT_INBOX_BYTES so no caller ever needs a client-side
// `| head -c` (which consumes the cursor and loses the cut tail — the footgun this hardening retires).
export interface InboxOpts {
  limit: number | null; // opt-in max message COUNT (kept from the tail)
  bytes: number | null; // opt-in byte budget, OVERRIDING the default (kept from the tail)
  since: number | null; // RECOVERY: replay from this per-channel seq, ignoring the cursor; NON-consuming
  peek: boolean; // RECOVERY: read the current unread tail WITHOUT advancing the cursor
}

// GET /api/inbox?session=<sid> — the read tool, as a pure computation over the ServerContext (no `res`, so it
// is unit-testable against a fake context with a live session + thread log). Returns this session's UNREAD
// channel messages (across all channels it's joined to), grouped by channel. On a CONSUMING read it advances
// the session's per-thread cursors; on a RECOVERY read (?since or ?peek) it leaves them untouched, so a lost
// read is re-fetchable in ONE GET with no leave+rejoin dance. The agent fetches this with Bash, so the
// messages land in TOOL OUTPUT, never as a user turn — the whole point of 4e.
export function computeInbox(sid: string | null, opts: InboxOpts): { status: number; body: unknown } {
  const { liveSessions, boardIdentity, boardSnapshotRecords, sessionThreads, threadLog, threadNode, persistSessionState } =
    getServerContext();
  if (!sid) return { status: 400, body: { error: "missing ?session=" } };
  const s = liveSessions.get(sid);
  if (!s) return { status: 404, body: { error: "no such live session" } };
  // A recovery read never mutates state: ?since replays from an arbitrary seq (so consuming it would clobber
  // the real cursor); ?peek previews the current tail without spending it. Either ⇒ the cursor is untouched.
  const consuming = opts.since == null && !opts.peek;
  // The ONE byte bound on this read (CLAUDE.md size-caps): the caller's explicit &bytes, else the generous
  // default. Always applied — every inbox read is self-bounded, so client-side truncation is never needed.
  const bytesBudget = opts.bytes != null ? opts.bytes : DEFAULT_INBOX_BYTES;
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
      // The per-channel floor: a ?since replay overrides the stored cursor DOWNWARD (re-serve messages the
      // cursor has already passed); otherwise it's the cursor (the normal unread frontier).
      const floor = opts.since != null ? opts.since : s.read[threadId] ?? 0;
      if (log.length && log[0]!.seq > floor + 1) {
        // The in-memory tail (MAX_THREAD_MSGS — a feed-republish bound, not a read cap) starts past this
        // floor: older messages live only on disk. Serve THIS read from the full ledger instead of
        // re-dropping content a memory bound already paid for (CLAUDE.md truncation rule — only the caller's
        // own &limit/&bytes window may cut, and it surfaces `truncated`). Also the ?since=0 replay-all path.
        const full = readThreadLog(s.repoPath, threadId);
        if (full.length) log = full;
      }
      const fresh = log.filter((mng) => mng.seq > floor && !cardOnly(mng)); // ask-echoes / intent acts are card-only
      // Keep the recent TAIL within the byte budget (+ opt-in count). The omitted are OLDER; on a consuming
      // read the cursor advances past them (below), so recover them in ONE GET with a larger &bytes= or a
      // &since=<seq> replay (non-consuming) — never a leave+rejoin. Surfaced as `truncated`, never dropped.
      const { kept, omitted } = windowTail(fresh, opts.limit, bytesBudget);
      if (kept.length) {
        const out: OutChan = {
          channel: threadId,
          title: threadNode(records, threadId)?.title || "",
          messages: kept.map((m) => ({ seq: m.seq, t: fmtTs(m.ts), from: inboxHandle(records, m.from), text: m.text })),
        };
        if (omitted > 0)
          out.truncated = {
            omitted,
            hint: `${omitted} older message(s) omitted by the ${bytesBudget}-byte budget; re-read with a larger &bytes= (one GET), or &since=${floor} to replay this range (non-consuming). Never pipe through | head -c.`,
          };
        // Head context: attach the pins so a woken agent re-reads the task/done-condition/framing (R-PIN).
        const pins = readPins(s.repoPath, threadId);
        if (pins.length)
          out.pinned = pins.map((p) => ({ seq: p.seq, t: fmtTs(p.ts), from: inboxHandle(records, p.from), text: p.text }));
        channels.push(out);
      }
      if (consuming && log.length) s.read[threadId] = log[log.length - 1]!.seq; // mark all read (incl. skipped card-only entries)
    }
    if (consuming) persistSessionState(s); // a recovery read (?since/?peek) mutates nothing — nothing to persist
  }
  const count = channels.reduce((n, c) => n + c.messages.length, 0);
  return { status: 200, body: { channels, count } };
}

function handleInboxRead(res: ServerResponse, sid: string | null, opts: InboxOpts): void {
  const { status, body } = computeInbox(sid, opts);
  sendJson(res, status, body);
}

// The channel-message read tool (session id is a global UUID, so no ?board= needed).
export const inboxRoutes: GlobalRoute[] = [
  {
    method: "GET",
    match: exact("/api/inbox"),
    run: (_req, res, url) =>
      handleInboxRead(res, url.searchParams.get("session"), {
        limit: windowParam(url, "limit"),
        bytes: windowParam(url, "bytes"),
        since: nonNegParam(url, "since"),
        peek: url.searchParams.get("peek") === "1" || url.searchParams.get("peek") === "true",
      }),
  },
];
