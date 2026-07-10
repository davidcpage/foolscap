// Bug A (summon card/edge loss) + Bug C (headless-created node invisible to GET /api/canvas) — the shared
// persist-gap buffer. The agent bus is a BROADCAST relay: dispatchBusCommand forwards a command to a board's
// live tabs but never writes the durable store GET /api/canvas serves (only a tab's debounced Persistence
// save does — app/src/remote-store.ts → /api/board/persist). So a CREATION command (addNode/addEdge)
// broadcast when NO tab is live reaches nothing and is lost forever. This holds those additive commands per
// board so the ws-attach handler can replay them to the next tab that connects, which applies + persists
// them into the durable store. A remove for the same id prunes any buffered create.
//
// Pure logic in one module (like node-cascade.js / thread-tags.js) so the buffer algebra is unit-testable
// without a live server; the HTTP wiring (buffer on delivered===0, drain on ws-attach) lives in
// server-delivery.ts / vite-fs-plugin.ts. The per-board buffer Map is owned by fsState there and passed in.

// Only ADDITIVE creation commands are worth buffering: a delivered-nowhere moveNodes/setText targets a node
// a fresh tab hasn't hydrated yet and would be stale by replay time, whereas a lost addNode/addEdge is a
// card/edge that never becomes durable at all.
export const BUFFERABLE_BUS_TYPES = new Set(["addNode", "addEdge"]);
// Generous cap (this repo's stingy caps have all cost more than they saved): holds a no-tab board's spawn
// cards + headless-created nodes until the next attach drains them. Oldest-dropped, never silent.
export const MAX_PENDING_BUS_REPLAY = 500;

const busCmdId = (cmd) => (cmd && cmd.payload && typeof cmd.payload.id === "string" ? cmd.payload.id : null);

/**
 * Enqueue an additive creation command for `boardId`, or prune the buffered create a remove supersedes.
 * `pending` is the per-board buffer Map (boardId → command[]), mutated in place. A removeNode/removeEdge
 * drops any buffered add for the SAME payload id (so a create-then-delete with no persisting tab in between
 * nets to nothing, never resurrecting a deleted node on the next attach). Non-additive, non-remove commands
 * are ignored. Returns `{ buffered, dropped }` for the caller's log (dropped = evicted to the cap).
 */
export function bufferBusReplay(pending, boardId, cmd, maxLen = MAX_PENDING_BUS_REPLAY) {
  const type = cmd && cmd.type;
  const id = busCmdId(cmd);
  if (type === "removeNode" || type === "removeEdge") {
    const buf = pending.get(boardId);
    if (buf && id) {
      const kept = buf.filter((c) => busCmdId(c) !== id);
      if (kept.length) pending.set(boardId, kept);
      else pending.delete(boardId);
    }
    return { buffered: false, dropped: 0 };
  }
  if (!BUFFERABLE_BUS_TYPES.has(type)) return { buffered: false, dropped: 0 };
  const buf = pending.get(boardId) ?? [];
  buf.push({ type, payload: cmd.payload, actor: cmd.actor });
  let dropped = 0;
  if (buf.length > maxLen) dropped = buf.splice(0, buf.length - maxLen).length; // drop OLDEST — recent creations matter most
  pending.set(boardId, buf);
  return { buffered: true, dropped };
}

/** Take + CLEAR a board's buffered commands (first ws-attach drains them; a second tab hydrates the
 *  now-persisted records instead of re-applying a duplicate). Tolerates a null map / empty board → []. */
export function takeBusReplay(pending, boardId) {
  const buf = pending && pending.get(boardId);
  if (!buf || buf.length === 0) return [];
  pending.delete(boardId);
  return buf;
}
