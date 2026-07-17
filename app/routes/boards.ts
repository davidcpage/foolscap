import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { isTmpdirRepo, forgetBoard } from "../server-boards.js";
import { exact, type GlobalRoute } from "./router.js";

// ── /api/boards — the board registry (god-file split, Phase 1) ──────────────────────────────────────
// List the mounted boards (GET) and mount a target repo as a board (POST). The board identity, the
// durable registry (readBoardRegistry/recordBoardOpened), the .canvas/ git-exclude, and the per-board
// feeds all live in the god-file — this module reaches them through the ServerContext, so the mount
// ORCHESTRATION stays where its shared state does while the HTTP handlers move out. `boardJson` moved
// here with its only two callers; it reads the default-board id off the context.

function boardJson(boardId: string, b: { name: string; repoPath: string }): {
  boardId: string;
  name: string;
  repoPath: string;
  default: boolean;
} {
  return { boardId, name: b.name, repoPath: b.repoPath, default: boardId === getServerContext().defaultBoardId };
}

function handleBoards(res: ServerResponse): void {
  const ctx = getServerContext();
  // lastOpened rides along from the registry (0 for the default board / anything unrecorded) so the
  // picker can sort by recency without a second endpoint.
  const opened = new Map(ctx.readBoardRegistry().map((e) => [e.boardId, e.lastOpened]));
  // Tmpdir scratch boards (the http-contract suite's mount) stay OUT of the listing: they're never
  // persisted, never picker-worthy, and would linger in the menu until a restart. The mount itself still
  // works — a test tab reaches its board via ?repo=, not the picker.
  sendJson(res, 200, {
    boards: [...ctx.boards.entries()]
      .filter(([, b]) => !isTmpdirRepo(b.repoPath))
      .map(([id, b]) => ({ ...boardJson(id, b), lastOpened: opened.get(id) ?? 0 })),
  });
}

// Mount a target repo as a board (POST /api/boards { repoPath }). Idempotent: the boardId is a pure
// function of the realpath, so re-mounting the same repo returns the same id without duplicating. The dev
// server runs with full fs privileges and is 127.0.0.1-only, but we still validate the path exists and is
// a directory before adding it — the canvas serves a real folder, not an arbitrary string.
async function handleBoardMount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = getServerContext();
  let body: { repoPath?: unknown; noSessions?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.repoPath !== "string" || !body.repoPath)
    return sendJson(res, 400, { error: "missing repoPath" });
  let real: string;
  try {
    real = fs.realpathSync(body.repoPath);
  } catch {
    return sendJson(res, 404, { error: "path not found" });
  }
  if (!fs.statSync(real).isDirectory()) return sendJson(res, 400, { error: "not a directory" });
  const id = ctx.boardIdentity(real);
  // { noSessions: true } marks a scratch/test board on which real sessions never spawn (explicit or
  // auto-wake — sessionSpawnRefusal enforces it). STICKY: a later mount without the flag never clears it,
  // so a suite that flags its board once can't be un-flagged by a plain tab re-open.
  const noSessions = body.noSessions === true;
  if (!ctx.boards.has(id.boardId)) {
    ctx.boards.set(id.boardId, { root: real, name: id.name, repoPath: id.repoPath, ...(noSessions ? { noSessions: true } : {}) });
    console.log(`[boards] mounted ${id.boardId} → ${real}${noSessions ? " (noSessions)" : ""}`);
  } else if (noSessions) {
    ctx.boards.get(id.boardId)!.noSessions = true;
  }
  // Every mount POST (a tab opening ?repo=, including a re-open) bumps the registry's lastOpened; the
  // default board is implicit and stays out of the file.
  if (id.boardId !== ctx.defaultBoardId) ctx.recordBoardOpened(id.boardId, id.name, id.repoPath, noSessions);
  ctx.ensureCanvasExcluded(id.repoPath); // keep the target repo's git status clean of `.canvas/`
  ctx.startBoardFeeds(id.boardId, id.repoPath); // git HEAD + sessions-list feeds for this repo
  sendJson(res, 200, boardJson(id.boardId, ctx.boards.get(id.boardId)!));
}

// Forget a board (DELETE /api/boards?board=<id>). Registry removal / unmount ONLY — forgetBoard never
// deletes the board's data, so a removed board can be re-added via `+`. The default board is refused
// (forgetBoard guards it); the picker also never offers a `×` on the current or default board. 400 with no
// id, 404 when nothing matched (an unknown id or the default board), 200 on removal.
function handleBoardForget(url: URL, res: ServerResponse): void {
  const id = url.searchParams.get("board");
  if (!id) return sendJson(res, 400, { error: "missing board id" });
  if (!forgetBoard(id)) return sendJson(res, 404, { error: "not a removable board" });
  console.log(`[boards] forgot ${id} (registry removal / unmount — data untouched)`);
  sendJson(res, 200, { boardId: id, removed: true });
}

export const boardRoutes: GlobalRoute[] = [
  { method: "POST", match: exact("/api/boards"), run: (req, res) => void handleBoardMount(req, res) },
  { method: "DELETE", match: exact("/api/boards"), run: (_req, res, url) => handleBoardForget(url, res) },
  { match: exact("/api/boards"), run: (_req, res) => handleBoards(res) },
];
