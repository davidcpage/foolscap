import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody, openSse, type SseClient } from "../server-http.js";
import { getBusClients, getEmittedMembers, getServerContext } from "../server-context.js";
import { exact, type GlobalRoute } from "./router.js";
import { ensureCommandId } from "../server-delivery.js";
import { connectedEdgeIds } from "../node-cascade.js";
import { boardPersistMtime, describeBoardEvents, readBoardPersist } from "../board-persist.js";
import { boardStoreCanvasSnapshot } from "../board-engine.js";

// ── the board read/write/subscribe endpoints (agent bus core) — god-file split ─────────────────────
// GET /api/canvas (the agents' board read), POST /api/command (commit a bus command), and /api/bus (the
// SSE compat stream). All board-scoped: ?board=<id> picks which mounted repo, defaulting to the dev repo.
// Reached shared state (boards, fsState client sets, the durable store, the live-session snapshot, the
// membership bridge) THROUGH getServerContext(), so this module never imports the shell — no runtime cycle.

// The bus-client set for a board, created on first subscribe. (The SSE close handler in openSse deletes
// the client from the set but leaves the empty set in the map — harmless; one entry per ever-seen board.)
function busClientsFor(boardId: string): Set<SseClient> {
  const busClients = getBusClients(getServerContext().fsState);
  let set = busClients.get(boardId);
  if (!set) busClients.set(boardId, (set = new Set<SseClient>()));
  return set;
}

// T3c helper: tear down every edge touching `nodeId` before its removeNode lands. Emits a removeEdge over
// the bus for each connected edge (connectedEdgeIds off the durable snapshot) so the cascade is server-
// authoritative, and — for a session card — also drops its member edges from the emitted-membership bridge,
// including any join still inside the ~400ms save window (the snapshot wouldn't list those yet). Idempotent:
// re-removing an edge the store already dropped is a no-op.
function cascadeNodeEdges(boardId: string, nodeId: string, actor: string, origin: string): void {
  const { fsState, boardSnapshotRecords, nodeSessionId, dispatchBusCommand } = getServerContext();
  const emittedMembers = getEmittedMembers(fsState);
  const records = boardSnapshotRecords(boardId) ?? [];
  const ids = new Set(connectedEdgeIds(records, nodeId));
  const sid = nodeSessionId(records, nodeId);
  if (sid)
    for (const [edgeId, m] of emittedMembers)
      if (m.sid === sid) {
        ids.add(edgeId);
        emittedMembers.delete(edgeId); // clear the bridge even with no live tab to apply the removeEdge
      }
  for (const id of ids) dispatchBusCommand(boardId, { type: "removeEdge", actor, payload: { id } }, origin);
}

async function handleCommand(req: IncomingMessage, res: ServerResponse, boardId: string, origin: string): Promise<void> {
  const { dispatchBusCommand } = getServerContext();
  let cmd: { type?: unknown; payload?: unknown; actor?: unknown };
  try {
    cmd = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof cmd.type !== "string") return sendJson(res, 400, { error: "missing command type" });
  // T3c: a removeNode CASCADES its edges server-side, so "delete edges before nodes" is no longer a rule the
  // operator carries. The browser store already tears a node's wires down (core removeNode), but re-deriving
  // the edge set here and emitting a removeEdge for each FIRST makes the cascade client-independent and — the
  // part only the server owns — lets us clear the in-memory emitted-membership bridge, so a deleted session
  // card stops counting as a thread member at once rather than after the 60s TTL.
  if (cmd.type === "removeNode") {
    const nodeId = typeof (cmd.payload as { id?: unknown } | undefined)?.id === "string" ? String((cmd.payload as { id: string }).id) : null;
    if (nodeId) cascadeNodeEdges(boardId, nodeId, typeof cmd.actor === "string" ? cmd.actor : "system", origin);
  }
  // Bug B/C: mint the created node/edge id SERVER-side when the caller omits it, so a headless caller can
  // ADDRESS what it just created. ensureCommandId writes the id into `cmd.payload` (so the tab we broadcast
  // to uses it rather than minting its own) and returns it to echo in the response. null for non-create
  // commands, which carry no created id.
  const createdId = ensureCommandId(cmd as { type?: string; payload?: unknown });
  // §9 stage 2: COMMIT the command server-side (durable + folded into the live store + diff broadcast to
  // tabs) and echo the created id + the authoritative seq. No live tab is required any more — the mutation
  // is durable and visible to GET /api/canvas the instant this returns (the old 503-on-no-tab is retired).
  // A durable-write failure throws out to the route error boundary (→ 500, the client retries); an unknown
  // command type is a clean reject (null → 400).
  const event = dispatchBusCommand(boardId, cmd as { type: string; payload?: Record<string, unknown>; actor?: string }, origin);
  if (!event) return sendJson(res, 400, { error: `unknown command type: ${cmd.type}`, board: boardId });
  sendJson(res, 200, { ok: true, board: boardId, seq: event.seq, ...(createdId ? { id: createdId } : {}) });
}

// The agents' board read, served from the DURABLE store (unification: the browser used to push a
// second, near-identical snapshot here just for this read — retired; remote-store.ts's persistence
// save is the one write path now). `tabs` is a human-presence signal only: a successful read no longer
// implies a live tab (that was the old 404's meaning), and a WRITE no longer needs one either (§9 stage 2
// above — /api/command commits server-side). 404 only for a board with nothing persisted yet.
function handleCanvasGet(res: ServerResponse, boardId: string): void {
  const { boards, tabCountFor } = getServerContext();
  const b = boards.get(boardId);
  if (!b) return sendJson(res, 400, { error: "unknown board" });
  const { events, snapshot } = readBoardPersist(b.repoPath);
  if (!snapshot && events.length === 0)
    return sendJson(res, 404, { error: "no board state persisted yet" });
  // Records served from the live server-materialized store (board-engine, §9 stage 1): fresher than the
  // debounced snapshot.json cache — it already reflects the event tail. version/seq ride for shape-compat;
  // `live` is non-null past the 404 guard, the fallbacks are belt-and-braces.
  const live = boardStoreCanvasSnapshot(boardId, b.repoPath);
  sendJson(res, 200, {
    ts: boardPersistMtime(b.repoPath),
    tabs: tabCountFor(boardId),
    snapshot: live ?? snapshot ?? { records: [], version: 0 },
    recentIntent: describeBoardEvents(events),
  });
}

export const canvasRoutes: GlobalRoute[] = [
  // The agent bus IS board-scoped (Phase 3): ?board=<id> picks which board's tabs a command reaches and
  // which board's snapshot is read back (default board if omitted).
  {
    match: exact("/api/bus"),
    run: (req, res, url) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return void openSse(req, res, busClientsFor(b.boardId));
    },
  },
  {
    method: "POST",
    match: exact("/api/command"),
    run: (req, res, url) => {
      const { reqBoard, originOf } = getServerContext();
      const b = reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return void handleCommand(req, res, b.boardId, originOf(req));
    },
  },
  {
    match: exact("/api/canvas"),
    run: (_req, res, url) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      return handleCanvasGet(res, b.boardId);
    },
  },
];
