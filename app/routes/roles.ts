import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { exact, type GlobalRoute } from "./router.js";
import { listRoles, createRole } from "../role-ledger.js";

// ── /api/roles (god-file split, Phase 1) ───────────────────────────────────────────────────────────
// The role picker's server half: a cheap read of this board's `.canvas/roles/` markers (GET), and role
// creation (POST). The board is resolved by the shared reqBoard on the ServerContext; the create path
// nudges any open picker via the context's publishFeed effect (the feed's board suffix is the resolved
// boardId, byte-identical to the god-file's old boardIdentity(repoPath).boardId — that id IS derived from
// the board's realpath'd repoPath, so passing the already-resolved boardId preserves the exact feed name).

// GET /api/roles → every role this board has on disk (by name), for the role-picker on "new session".
// Mirrors handleThreads: name/colour only, NOT the charters — a charter is read on instantiation.
function handleRoles(res: ServerResponse, repoPath: string): void {
  sendJson(res, 200, { roles: listRoles(repoPath) });
}

// POST /api/roles { name, charter?, colour? } → create a role (writes `.canvas/roles/<roleId>/role.md`).
// 400 on a bad/missing name, 409 if a role with that id already exists. Returns the created role.
async function handleRolesCreate(req: IncomingMessage, res: ServerResponse, repoPath: string, boardId: string): Promise<void> {
  let body: { name?: unknown; charter?: unknown; colour?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.name !== "string" || !body.name) return sendJson(res, 400, { error: "missing name" });
  try {
    const role = createRole(repoPath, {
      name: body.name,
      charter: typeof body.charter === "string" ? body.charter : "",
      colour: typeof body.colour === "string" ? body.colour : undefined,
    });
    getServerContext().publishFeed("roles:" + boardId, { ts: Date.now() }); // nudge any open picker to re-pull
    sendJson(res, 200, { role });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    return sendJson(res, /already exists/.test(msg) ? 409 : 400, { error: msg });
  }
}

export const roleRoutes: GlobalRoute[] = [
  {
    match: exact("/api/roles"),
    run: (req, res, url) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      if (req.method === "POST") return void handleRolesCreate(req, res, b.repoPath, b.boardId);
      return handleRoles(res, b.repoPath);
    },
  },
];
