import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../server-http.js";
import { appendDataFeed } from "../server-orchestration.js";
import type { BoardInfo } from "../server-types.js";
import { re, type BoardRoute } from "./router.js";

// ── POST /api/feed/<name> — the data-feed publish route (Github-feed thread, stage 2b) ───────────────
// The producer half of the generic `data:*` primitive: an agent or script POSTs a JSON event and it lands
// on the off-log bus (byte-bounded tail, server-data-feeds.ts) + the `.canvas/feeds/` mirror, readable by
// any card through the `dataFeed` capability. Board-scoped like every off-log feed (the shared board gate
// resolves `boardId`, defaulting to the dev board when no ?board= — so a bare `curl /api/feed/data:demo`
// lands on the same board a browser card reads). The `data:` prefix is the ONE allowed namespace — it's the
// security boundary the read capability also enforces, so this route can't be used to overwrite a
// session:/thread:/kernel: feed. The name may carry further colons (`data:git:sub`), just not other junk.
const FEED_NAME_RE = /^data:[A-Za-z0-9._:-]+$/;

// The posted body is the event PAYLOAD (lands in the value's `data`): any JSON, or empty for a bare ping.
// A non-JSON body is a 400 — the one honest error; everything else is a 200 with the folded tail's size so a
// scripting producer can see it took (and whether the tail has begun truncating).
async function handleFeedPublish(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  board: BoardInfo,
  rawName: string,
): Promise<void> {
  const name = decodeURIComponent(rawName);
  if (!FEED_NAME_RE.test(name))
    return sendJson(res, 400, { error: "feed name must match data:* (the only publishable namespace)" });
  const body = await readBody(req);
  let data: unknown;
  try {
    data = body.trim() ? JSON.parse(body) : null;
  } catch {
    return sendJson(res, 400, { error: "body must be JSON (or empty)" });
  }
  const value = appendDataFeed(boardId, board.repoPath, name, data);
  sendJson(res, 200, { ok: true, name, events: value.events.length, truncated: value.truncated, updatedAt: value.updatedAt });
}

export const feedRoutes: BoardRoute[] = [
  {
    method: "POST",
    match: re(/^\/api\/feed\/(.+)$/),
    run: (req, res, _url, g, boardId, board) => void handleFeedPublish(req, res, boardId, board, g[0]!),
  },
];
