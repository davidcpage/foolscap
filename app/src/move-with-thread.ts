// Move-with-thread (P2 relative-offset layout): when a THREAD card moves, its OPEN member session cards move
// with it by the SAME delta, so a task's whole cluster travels as a unit and the relative layout is
// preserved. This is the DEFAULT, reactive behaviour — driven off the store's layout query (signia), so it
// tracks a live drag frame-by-frame, not just the drag-end.
//
// A session moves only with its PRIMARY (earliest-joined) thread: a multi-thread session anchored to thread A
// must NOT move when a secondary thread B is dragged. Primacy is resolved via content.primaryThreadOf (the
// board-wide sid→primaryThread map the server computes from `members[sid].joinedAt`). A single-membership
// session — the common case — needs no server data: it's anchored to its one thread whether or not the map
// has loaded yet, so the behaviour degrades gracefully offline.
//
// The DURABLE offset lives on the ledger and is captured server-side on the debounced snapshot save
// (captureMemberOffsets); this reactor never writes it. When it shifts a session by the same delta its thread
// moved, the stored offset is unchanged, so that capture is a no-op — the two never fight.
//
// The decision logic (planThreadMoves) is a PURE function in move-with-thread-plan.ts — no store, no DOM — so
// the delta / double-move / primacy rules are unit-tested directly; installMoveWithThread is the thin
// plumbing that feeds it the store state and applies the result.
import { type Id, type InteractionManager, type LayoutRecord } from "./lib";
import { isThreadNode, MEMBER_OPEN } from "./threads";
import { primaryThreadOf } from "./content";
import { planThreadMoves, type Pos } from "./move-with-thread-plan";

// Install the reactor on an InteractionManager. Returns an unsubscribe. Idempotent per manager is the
// caller's concern (App mounts it once, in an effect keyed on `m`).
export function installMoveWithThread(m: InteractionManager): () => void {
  const store = m.editor.store;
  const layoutQuery = store.query({ typeName: "layout" });
  // Last-seen WORLD position of every node with a layout — the baseline each pass diffs against to detect a
  // thread that moved. Seeded on first sighting (no move fired for a card that simply appeared).
  let prevPos = new Map<string, Pos>();
  let applying = false; // re-entrancy guard: our own moveNodes commit re-fires the query subscription

  const pass = (): void => {
    if (applying) return;
    // Only WORLD cards participate — screen-anchored HUD chrome moves by its own path, never with a thread.
    const posById = new Map<string, Pos>();
    for (const l of layoutQuery.get() as LayoutRecord[]) if (l.anchor !== "screen") posById.set(l.nodeId, { x: l.x, y: l.y });

    // member:open adjacency: sessionNode → the thread ids it is an open member of.
    const memberThreads = new Map<string, string[]>();
    for (const e of store.query({ typeName: "edge" }).get()) {
      if (e.type !== MEMBER_OPEN) continue;
      const list = memberThreads.get(e.from) ?? [];
      list.push(e.to);
      memberThreads.set(e.from, list);
    }

    const { moves, nextPrev } = planThreadMoves({
      posById,
      prevPos,
      isThread: (nodeId) => isThreadNode(m.editor, nodeId),
      memberThreads,
      // Resolve a session card's primary thread: its sid is the node title; primaryThreadOf maps it via the
      // board-wide anchors map (undefined when unknown → the sole-membership fallback in planThreadMoves).
      primaryOf: (sessionNode) => {
        const sid = store.get<"node">(sessionNode as Id<"node">)?.title;
        return typeof sid === "string" && sid ? primaryThreadOf(sid) : undefined;
      },
    });

    prevPos = nextPrev; // advance the baseline before applying (a re-entrant pass then sees zero delta)
    if (moves.length === 0) return;
    applying = true;
    try {
      m.editor.commit({ type: "moveNodes", actor: "system", payload: { moves: moves as { id: Id<"node">; x: number; y: number }[] } });
    } finally {
      applying = false;
    }
  };

  pass(); // seed the baseline from the current board
  return layoutQuery.subscribe(pass);
}
