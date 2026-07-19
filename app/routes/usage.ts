import type { ServerResponse } from "node:http";
import { sendJson } from "../server-http.js";
import { forceUsagePoll } from "../server-orchestration.js";
import { exact, type GlobalRoute } from "./router.js";

// ── POST /api/usage/refresh — force an immediate plan-usage poll ─────────────────────────────────────
// The server side of the usage card's top-right refresh button. GLOBAL (not board-scoped): the usage feed
// is a single global poller across all boards, mirroring `/api/weather`'s self-contained shape. It just
// kicks forceUsagePoll() — which routes THROUGH the existing pollClaude/pollCodex cycle, so the 401/429
// gate + backoff are re-checked server-side and a refresh during a rate-limit hold does NOT hit the
// upstream endpoint (it re-checks locally and keeps the last-good value). The fresh reading arrives on the
// `usage` feed as usual; this endpoint only triggers the pull, so a bare `{ ok: true }` is the whole reply.
function handleUsageRefresh(res: ServerResponse): void {
  forceUsagePoll();
  sendJson(res, 200, { ok: true });
}

export const usageRoutes: GlobalRoute[] = [
  { method: "POST", match: exact("/api/usage/refresh"), run: (_req, res) => handleUsageRefresh(res) },
];
