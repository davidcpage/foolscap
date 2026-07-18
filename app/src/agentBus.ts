import type { InteractionManager, Persistence } from "./lib";
import { onBusDiff, onFeedsReconnect } from "./feeds";
import { activeBoardId } from "./board";
import { fetchBoardLogSince } from "./remote-store";
import { classifyInbound, foldCatchUp } from "./bus-convergence";

// The browser end of the agent bus (demo §10 step 4). Since design §9 stage 2 the SERVER owns command
// authority: a command POSTed to /api/command is validated + committed + made durable server-side, and
// what arrives here over the tab's shared WebSocket (feeds.ts owns it; a standing SSE stream per tab was
// what starved the browser's six-per-host connection pool) is the resulting DIFF + its authoritative seq,
// NOT the command. So this tab applies the diff as a "remote" channel-2 change — it is NOT re-committed,
// so it produces no second IntentEvent, isn't echoed back to the server, and Ctrl-Z never pops it
// (selective undo ignores "remote"). Exactly one IntentEvent per command exists, minted at the server.
//
//   curl 'localhost:5173/api/canvas?board=<id>'
//   curl -X POST 'localhost:5173/api/command?board=<id>' -d '{"type":"addNode","actor":"claude","payload":{...}}'
//
// The READ side (GET /api/canvas) needs nothing from this module: the server serves it from its live
// board store. Command DEFAULTS a bus caller used to rely on the tab for (e.g. a thread card's legible
// size) now live on the server commit path (server-delivery.withServerCommandDefaults), since the tab no
// longer sees the command — only its already-materialized diff.
//
// PER BOARD (Phase 3): this tab subscribes under its own activeBoardId (the socket carries ?board= at
// connect), so a diff only reaches the tabs showing that repo.

export function connectAgentBus(m: InteractionManager, persistence: Persistence): () => void {
  const store = m.editor.store;

  // §9 stage 3 (D4) — INBOUND CATCH-UP. The outbound side is already an offline queue (remote-store's
  // serialized infinite retry); the missing half was inbound: a tab that was offline while peers/agents
  // committed silently diverged until reload, because the bus only pushes LIVE diffs and never backfills the
  // ones missed while the socket was down. So on every (re)connect — and on a live SEQ GAP — we fetch
  // `since(watermark)` and fold the missed events in order.
  let catchingUp = false;
  async function catchUp(): Promise<void> {
    if (catchingUp) return; // one at a time — a second trigger during a run is covered by the in-flight fetch
    catchingUp = true;
    try {
      // Loop until drained: a fetch can itself lag behind new live commits, so re-ask while the watermark
      // keeps advancing (bounded — it terminates as soon as a pass returns nothing past the watermark).
      for (;;) {
        const events = await fetchBoardLogSince(activeBoardId(), persistence.watermark());
        if (foldCatchUp(events, store, persistence) === 0) break;
      }
    } catch {
      // A failed catch-up leaves the tab where it was; the next reconnect / gap retries. Never throw into
      // the socket handler (it would break the feed).
    } finally {
      catchingUp = false;
    }
  }

  const offReconnect = onFeedsReconnect(() => void catchUp()); // the socket dropped and came back — backfill

  const offBus = onBusDiff((diff, seq) => {
    switch (classifyInbound(seq, persistence.watermark())) {
      case "have":
        return; // already reflected (a resend, or a catch-up beat this frame) — nothing to do
      case "gap":
        // Frames were missed (a dropped WS message, or a boot/reconnect window). Do NOT apply out of order —
        // an absolute diff applied ahead of an earlier one it depends on can revert state (LWW). Treat the
        // gap as a catch-up trigger, which delivers the whole missing range in seq order.
        void catchUp();
        return;
      case "next":
        // In order: apply the server-committed change as a REMOTE diff (channel 2) — the ChangeSource
        // reserved for peer/agent commits — then adopt the authoritative seq (§10) so the mirror watermark
        // stays honest and the next locally-minted seq stays above the server's.
        store.applyDiffAsChange(diff, "remote");
        persistence.adoptSeq(seq);
        return;
    }
  });

  return () => {
    offReconnect();
    offBus();
  };
}
