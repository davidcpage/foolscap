import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { exact, re, type GlobalRoute } from "./router.js";

// ── permissions (--permission-prompt-tool: the held tool-call prompts) — god-file split, Phase 1 ────
// The server half of --permission-prompt-tool: the MCP relay's held POST parks here, the card's decision
// buttons (or a shell twin via /api/permissions) resolve it, and a hold timeout denies-by-default. The
// held prompts live in the shared registry `fsState.pendingPermissions` (reached via ServerContext — the
// map is ??=-initialized at god-file load, so it is always present by request time). The concern-owned
// `settlePermission` moved here with its handlers (3 callers, all permission/teardown-scoped); the god-
// file's teardown path (denySessionPermissions) imports it back. The cross-cutting `publishSession` +
// `liveSessions` stay in the god-file and are reached through the context. PERMISSION_HOLD_MS lives here
// now too — its natural home — and the god-file's spawn path imports it to size the relay's MCP timeout.

// The default hold before an unanswered prompt is denied. Long enough that a human who stepped away can
// still answer; the relay's MCP_TOOL_TIMEOUT is set to exceed this (see the spawn path in the god-file).
export const PERMISSION_HOLD_MS = 10 * 60_000;

// Resolve a held prompt (decision or timeout): answer the parked relay connection, drop the entry, and
// repaint the blocked session's card. A no-op if the id is already gone (double-settle, close-after-decide).
export function settlePermission(permId: string, payload: Record<string, unknown>): void {
  const ctx = getServerContext();
  const pending = ctx.fsState.pendingPermissions!;
  const p = pending.get(permId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(permId);
  try {
    sendJson(p.res, 200, payload);
  } catch {
    /* relay disconnected — the CLI already gave up on this prompt; nothing left to answer */
  }
  const s = ctx.liveSessions.get(p.sid);
  if (s) ctx.publishSession(s);
}

// POST /api/permission/request { session, toolName, input, toolUseId? } — the MCP relay's held call.
// Only a LIVE registry session may hold a prompt (404 otherwise — the relay turns that into its own
// fail-closed deny). No sendJson on the success path: the response parks until /decision or timeout.
async function handlePermissionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = getServerContext();
  const pending = ctx.fsState.pendingPermissions!;
  let body: { session?: unknown; toolName?: unknown; input?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.session !== "string" || !body.session) return sendJson(res, 400, { error: "missing session" });
  if (typeof body.toolName !== "string" || !body.toolName) return sendJson(res, 400, { error: "missing toolName" });
  const s = ctx.liveSessions.get(body.session);
  if (!s || s.status === "exited") return sendJson(res, 404, { error: "not a live canvas session" });
  const permId = crypto.randomUUID();
  const timer = setTimeout(
    () =>
      settlePermission(permId, {
        behavior: "deny",
        message:
          `no human decision within ${Math.round(PERMISSION_HOLD_MS / 60_000)} minutes — denied by default. ` +
          "The human never saw or refused this; retry when they're around, or post in your thread.",
      }),
    PERMISSION_HOLD_MS,
  );
  pending.set(permId, { permId, sid: s.id, toolName: body.toolName, input: body.input ?? {}, ts: Date.now(), res, timer });
  // The relay side can drop first (claude killed mid-hold, or its MCP tool timeout fired despite our
  // margin): un-park without answering, so the card doesn't keep offering a decision nobody is owed.
  // Fires on the success path too (every response's socket eventually closes) — the map guard makes
  // that a no-op because settlePermission already removed the entry.
  res.on("close", () => {
    const gone = pending.get(permId);
    if (!gone || gone.res !== res) return;
    clearTimeout(gone.timer);
    pending.delete(permId);
    const live = ctx.liveSessions.get(gone.sid);
    if (live) ctx.publishSession(live);
  });
  ctx.publishSession(s); // paint the prompt (and flip the band to waiting) immediately
}

// POST /api/permission/<permId>/decision { behavior: "allow"|"deny", message? } — the card's buttons
// (or a shell twin via /api/permissions). Allow echoes the tool input back unchanged (updatedInput is
// the CLI's contract); deny carries the human's message when given.
async function handlePermissionDecision(req: IncomingMessage, res: ServerResponse, permId: string): Promise<void> {
  let body: { behavior?: unknown; message?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (body.behavior !== "allow" && body.behavior !== "deny")
    return sendJson(res, 400, { error: 'behavior must be "allow" or "deny"' });
  const p = getServerContext().fsState.pendingPermissions!.get(permId);
  if (!p) return sendJson(res, 404, { error: "no such pending permission (already decided or timed out)" });
  settlePermission(
    permId,
    body.behavior === "allow"
      ? { behavior: "allow", updatedInput: p.input }
      : {
          behavior: "deny",
          message:
            typeof body.message === "string" && body.message
              ? body.message
              : "denied by the human on the canvas card",
        },
  );
  sendJson(res, 200, { ok: true, id: permId, behavior: body.behavior });
}

// GET /api/permissions[?session=<sid>] — the pending prompts, board-wide or per session: the headless
// twin of the card's block, so a shell can see (and answer, via /decision) prompts without a tab.
function handlePermissionsRead(res: ServerResponse, sid: string | null): void {
  const permissions = [...getServerContext().fsState.pendingPermissions!.values()]
    .filter((p) => !sid || p.sid === sid)
    .sort((a, b) => a.ts - b.ts)
    .map((p) => ({ id: p.permId, session: p.sid, toolName: p.toolName, input: p.input, ts: p.ts }));
  sendJson(res, 200, { permissions, count: permissions.length });
}

// Ids are global UUIDs — no ?board= anywhere here.
export const permissionRoutes: GlobalRoute[] = [
  { method: "POST", match: exact("/api/permission/request"), run: (req, res) => void handlePermissionRequest(req, res) },
  { method: "POST", match: re(/^\/api\/permission\/([\w-]+)\/decision$/), run: (req, res, _url, g) => void handlePermissionDecision(req, res, g[0]!) },
  { method: "GET", match: exact("/api/permissions"), run: (_req, res, url) => handlePermissionsRead(res, url.searchParams.get("session")) },
];
