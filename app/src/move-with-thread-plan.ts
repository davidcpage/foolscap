// Move-with-thread (P2) — the PURE decision logic, deliberately in its own module with NO imports (no store,
// no DOM, no server) so the delta / primacy / double-move rules are unit-testable headlessly. The plumbing
// that feeds it store state and applies the result lives in move-with-thread.ts. See that file's header for
// the behaviour rationale.

export interface Pos {
  x: number;
  y: number;
}
export interface Move {
  id: string;
  x: number;
  y: number;
}

// A move is "the same" as the thread's delta within a whole pixel — used to detect a session card that ALREADY
// moved this tick (it was in the same multi-select drag as its thread, or a prior re-entrant pass already
// shifted it), so we don't double-apply the delta.
function sameDelta(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.round(ax) === Math.round(bx) && Math.round(ay) === Math.round(by);
}

// Given the current WORLD positions, the last-seen baseline, which nodes are threads, the member:open
// adjacency (sessionNode → thread ids), and a primacy resolver (sessionNode → its primary thread id, or
// undefined when unknown), return the session-card moves to apply AND the next baseline to store.
//
// Rules: a thread that shifted since the baseline drags its anchored open sessions by the same delta. A
// session anchors to a thread when that thread is its PRIMARY (known primacy → exact match; unknown primacy →
// only a SOLE-membership session anchors, so an ambiguous multi-thread session is never moved by guess). A
// session that already moved by this delta this tick is skipped (it was dragged along in the same
// multi-selection — moving it again would double the delta). The next baseline is the current positions with
// each moved session overwritten to its post-move position, so the following pass (including the re-entrant
// one our own commit triggers) diffs against where things actually end up.
export function planThreadMoves(input: {
  posById: Map<string, Pos>;
  prevPos: Map<string, Pos>;
  isThread: (nodeId: string) => boolean;
  memberThreads: Map<string, string[]>;
  primaryOf: (sessionNode: string) => string | undefined;
}): { moves: Move[]; nextPrev: Map<string, Pos> } {
  const { posById, prevPos, isThread, memberThreads, primaryOf } = input;

  const anchoredTo = (threadId: string): string[] => {
    const out: string[] = [];
    for (const [sessionNode, threads] of memberThreads) {
      if (!threads.includes(threadId) || !posById.has(sessionNode)) continue;
      const primary = primaryOf(sessionNode);
      const anchored = primary !== undefined ? primary === threadId : threads.length === 1;
      if (anchored) out.push(sessionNode);
    }
    return out;
  };

  const shift = new Map<string, Pos>(); // sessionNode → delta to apply
  for (const [nodeId, cur] of posById) {
    if (!isThread(nodeId)) continue;
    const prev = prevPos.get(nodeId);
    if (!prev) continue; // first sighting — seed only, don't move
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (dx === 0 && dy === 0) continue; // thread didn't move (a resize, or an unrelated layout change)
    for (const sessionNode of anchoredTo(nodeId)) {
      const sPrev = prevPos.get(sessionNode);
      const sCur = posById.get(sessionNode)!;
      if (sPrev && sameDelta(sCur.x - sPrev.x, sCur.y - sPrev.y, dx, dy)) continue; // already moved this tick
      shift.set(sessionNode, { x: dx, y: dy });
    }
  }

  const nextPrev = new Map(posById);
  const moves: Move[] = [];
  for (const [sessionNode, d] of shift) {
    const cur = posById.get(sessionNode)!;
    const next = { x: cur.x + d.x, y: cur.y + d.y };
    nextPrev.set(sessionNode, next);
    moves.push({ id: sessionNode, x: next.x, y: next.y });
  }
  return { moves, nextPrev };
}
