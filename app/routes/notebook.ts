import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { re, type GlobalRoute } from "./router.js";
import { MAX_SESSION_BYTES } from "../server-sessions.js";
import { editNotebook, parseEdit } from "../server-notebook.js";

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

// ── the ipynb card's STRUCTURAL-EDIT route (P2, docs/ipynb-card.md) ──────────────────────────────────
// Distinct from the reactive-notebook OUTPUTS relay above: this is the interactive `.ipynb` card editing
// cell SOURCE and adding/deleting/moving cells. The browser names a cell id + a change; the server applies
// it to the freshly-read, full-fidelity ON-DISK notebook by cell id under CAS (server-notebook.ts) — the
// card never ships the notebook body (its read is the lossy RENDER projection, which would erase outputs).
// The notebook file is located through the board's CONFINED root dir, never a caller-supplied path.

// A node id is `node:<root>:<path>` — the root slug is colon-free, the path is the rest.
function parseNodeId(nodeId: string): { rootId: string; relPath: string } | null {
  const m = /^node:([^:]+):(.*)$/.exec(nodeId);
  return m ? { rootId: m[1]!, relPath: m[2]! } : null;
}

// Resolve board + node id → confined notebook (rootDir, relPath), or write the error response and return
// null (mirrors routes/kernel.ts's resolve — the same confinement the file routes rely on).
function resolveNotebook(res: ServerResponse, url: URL, encodedNodeId: string): { rootDir: string; relPath: string } | null {
  const ctx = getServerContext();
  const b = ctx.reqBoard(url);
  if (!b) {
    sendJson(res, 400, { error: "unknown board" });
    return null;
  }
  const parsed = parseNodeId(decodeURIComponent(encodedNodeId));
  if (!parsed) {
    sendJson(res, 400, { error: "bad node id" });
    return null;
  }
  const dir = ctx.rootDir(b.boardId, parsed.rootId);
  if (!dir) {
    sendJson(res, 400, { error: "unknown root" });
    return null;
  }
  return { rootDir: dir, relPath: parsed.relPath };
}

async function handleNotebookEdit(
  req: IncomingMessage,
  res: ServerResponse,
  target: { rootDir: string; relPath: string },
): Promise<void> {
  let body: { op?: unknown } = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  const op = parseEdit(body.op);
  if (!op) return sendJson(res, 400, { error: "bad or missing edit op" });
  try {
    const out = editNotebook(target.rootDir, target.relPath, op);
    // A vanished target cell (a concurrent delete since the card read it) is a 409 the card can rebase on;
    // a genuine read/write failure is a 500. Everything else is the applied edit.
    const status = out.ok ? 200 : out.writeback === "stale-cell" ? 409 : 500;
    sendJson(res, status, out);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) });
  }
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
  // ipynb structural edit (P2). Same node-id-as-path-segment shape as the kernel routes; distinct `/edit`
  // suffix, so it never collides with the `/outputs` relay above.
  {
    method: "POST",
    match: re(/^\/api\/notebook\/([^/]+)\/edit$/),
    run: (req, res, url, g) => {
      const target = resolveNotebook(res, url, g[0]!);
      if (target) void handleNotebookEdit(req, res, target);
    },
  },
];
