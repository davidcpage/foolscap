import { sendJson } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { exact, type BoardRoute } from "./router.js";

// ── /api/roots — the board's roots list (god-file split, Phase 2) ───────────────────────────────────
// The board's ROOTS: its canonical checkout + any git worktrees (worktree-activity slice B). The
// file/ls/watch endpoints take `?root=<id>` to pick which; `/api/roots` lists them. The roots derivation
// closes over the boards registry + the worktree scan, so it lives on ServerContext (boardRoots) and this
// BOARD-stage handler just formats it. Same arm/position the inline entry held.
export const rootsBoardRoutes: BoardRoute[] = [
  { match: exact("/api/roots"), run: (_req, res, _url, _g, boardId) => sendJson(res, 200, { roots: getServerContext().boardRoots(boardId) }) },
];
