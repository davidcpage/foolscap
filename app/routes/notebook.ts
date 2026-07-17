import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { re, type GlobalRoute } from "./router.js";
import { MAX_SESSION_BYTES } from "../server-sessions.js";

// ── notebook outputs (docs/notebook-card.md §7, step-3 agent-legibility) — god-file split ───────────
// A notebook card's cell OUTPUTS are off-log signia atoms living in the BROWSER (notebook-runtime.ts), so
// they're absent from the file tree AND the /api/canvas snapshot — an agent reads a notebook's source with
// `Read` but otherwise can't see what a cell PRODUCED. The runtime relays them here exactly as agentBus
// relays the canvas snapshot, and the server is the same dumb relay: it holds only the last push, PER
// (board, node id). So GET returns data only WHILE A TAB IS LIVE pushing (404 cold) — the deliberate
// step-3 scope, a window onto a live run rather than a durable artefact (that's the step-4 memo-cache /
// shadow store). The blob is already value-bounded at the browser's serialization point; we cap the whole
// push as a memory safety, matching the file-write 413. Last-push map lives on the pinned fsState (reached
// via getServerContext) so it survives a hot re-eval like every other pinned singleton.
//
//   POST /api/notebook/<id>/outputs ?board=  { ts, root, path, cells:[…], exports:{…} } (stored verbatim)
//   GET  /api/notebook/<id>/outputs ?board=  → that card's last push, or 404 until one has arrived
const nbOutKey = (boardId: string, id: string): string => boardId + "\0" + id;

// key: boardId \0 nodeId → the pushed blob. `??=` so a fsState pinned before this field existed adopts it.
function lastNotebookOutputs(): Map<string, string> {
  const { fsState } = getServerContext();
  return (fsState.lastNotebookOutputs ??= new Map<string, string>());
}

async function handleNotebookOutputsPush(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  id: string,
): Promise<void> {
  const body = await readBody(req);
  if (Buffer.byteLength(body, "utf8") > MAX_SESSION_BYTES) return sendJson(res, 413, { error: "too large" });
  lastNotebookOutputs().set(nbOutKey(boardId, id), body);
  sendJson(res, 200, { ok: true });
}

function handleNotebookOutputsGet(res: ServerResponse, boardId: string, id: string): void {
  const blob = lastNotebookOutputs().get(nbOutKey(boardId, id));
  if (blob == null) return sendJson(res, 404, { error: "no outputs pushed for this notebook (is a tab open on it?)" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(blob);
}

export const notebookRoutes: GlobalRoute[] = [
  // Notebook outputs (§7 agent-legibility). The id is a node id carrying colons + a slashed path, so the
  // client percent-encodes it — match a non-slash segment and decode, exactly like channels.
  {
    match: re(/^\/api\/notebook\/([^/]+)\/outputs$/),
    run: (req, res, url, g) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      const id = decodeURIComponent(g[0]!);
      if (req.method === "POST") return void handleNotebookOutputsPush(req, res, b.boardId, id);
      return handleNotebookOutputsGet(res, b.boardId, id);
    },
  },
];
