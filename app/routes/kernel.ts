import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { re, type GlobalRoute } from "./router.js";
import { runOneCell, runAllCells, interruptKernel, restartKernel, shutdownKernel } from "../server-kernel.js";

// ── the Jupyter kernel BROKER routes (Path B, docs/notebook-card.md §2) ──────────────────────────────
// Same-origin control surface the interactive `.ipynb` card drives: run a cell / run all / interrupt /
// restart / shutdown. The browser NEVER sees the kernel gateway or its token — these POSTs are its only
// reach, and live status/output comes back over the `kernel:<nodeId>` feed (server-kernel.ts). Registered
// GLOBAL-stage and self-resolving the board (like routes/sessions.ts and the notebook-outputs relay), because
// the node id is a PATH segment (percent-encoded — it carries `node:<root>:<path>` colons/slashes) while the
// board is the `?board=` query param. The kernel is keyed by (board,node); the engine owns its lifecycle.

// A node id is `node:<root>:<path>` — the root slug is colon-free, the path is the rest. We locate the
// notebook file through the board's CONFINED root dir (rootDir), never a caller-supplied path — the same
// confinement the file routes rely on.
function parseNodeId(nodeId: string): { rootId: string; relPath: string } | null {
  const m = /^node:([^:]+):(.*)$/.exec(nodeId);
  return m ? { rootId: m[1]!, relPath: m[2]! } : null;
}

interface Resolved {
  boardId: string;
  nodeId: string;
  rootDir: string;
  relPath: string;
}

// Resolve board + node id + confined notebook dir, or write the error response and return null.
function resolve(res: ServerResponse, url: URL, encodedNodeId: string): Resolved | null {
  const ctx = getServerContext();
  const b = ctx.reqBoard(url);
  if (!b) {
    sendJson(res, 400, { error: "unknown board" });
    return null;
  }
  const nodeId = decodeURIComponent(encodedNodeId);
  const parsed = parseNodeId(nodeId);
  if (!parsed) {
    sendJson(res, 400, { error: "bad node id" });
    return null;
  }
  const dir = ctx.rootDir(b.boardId, parsed.rootId);
  if (!dir) {
    sendJson(res, 400, { error: "unknown root" });
    return null;
  }
  return { boardId: b.boardId, nodeId, rootDir: dir, relPath: parsed.relPath };
}

// appDir keys the gateway sidecar + rendezvous (one gateway per app checkout, like the session host) and,
// via its parent, the repo whose `.venv` the kernel runs in. `npm run dev` runs in `app/`, so cwd IS appDir.
const appDir = () => process.cwd();

async function handleRun(req: IncomingMessage, res: ServerResponse, r: Resolved): Promise<void> {
  let body: { cellId?: unknown; cellIndex?: unknown } = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  const sel = {
    cellId: typeof body.cellId === "string" ? body.cellId : undefined,
    cellIndex: typeof body.cellIndex === "number" ? body.cellIndex : undefined,
  };
  try {
    const out = await runOneCell(r.boardId, r.nodeId, appDir(), r.rootDir, r.relPath, sel);
    sendJson(res, out.ok ? 200 : 500, out);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) });
  }
}

async function handleVerb(
  res: ServerResponse,
  r: Resolved,
  fn: () => Promise<{ ok: boolean; error?: string }>,
): Promise<void> {
  try {
    const out = await fn();
    sendJson(res, out.ok ? 200 : 500, out);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) });
  }
}

export const kernelRoutes: GlobalRoute[] = [
  {
    method: "POST",
    match: re(/^\/api\/kernel\/([^/]+)\/run$/),
    run: (req, res, url, g) => {
      const r = resolve(res, url, g[0]!);
      if (r) void handleRun(req, res, r);
    },
  },
  {
    method: "POST",
    match: re(/^\/api\/kernel\/([^/]+)\/run-all$/),
    run: (_req, res, url, g) => {
      const r = resolve(res, url, g[0]!);
      if (r) void handleVerb(res, r, () => runAllCells(r.boardId, r.nodeId, appDir(), r.rootDir, r.relPath));
    },
  },
  {
    method: "POST",
    match: re(/^\/api\/kernel\/([^/]+)\/interrupt$/),
    run: (_req, res, url, g) => {
      const r = resolve(res, url, g[0]!);
      if (r) void handleVerb(res, r, () => interruptKernel(r.boardId, r.nodeId));
    },
  },
  {
    method: "POST",
    match: re(/^\/api\/kernel\/([^/]+)\/restart$/),
    run: (_req, res, url, g) => {
      const r = resolve(res, url, g[0]!);
      if (r) void handleVerb(res, r, () => restartKernel(r.boardId, r.nodeId));
    },
  },
  {
    method: "POST",
    match: re(/^\/api\/kernel\/([^/]+)\/shutdown$/),
    run: (_req, res, url, g) => {
      const r = resolve(res, url, g[0]!);
      if (r) void handleVerb(res, r, () => shutdownKernel(r.boardId, r.nodeId));
    },
  },
];
