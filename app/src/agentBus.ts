import type { InteractionManager, Persistence } from "./lib";
import { onBusDiff } from "./feeds";

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

  return onBusDiff((diff, seq) => {
    // Apply the server-committed change as a REMOTE diff (channel 2) — the ChangeSource the channel model
    // reserves for ingesting peer/agent commits. Then adopt the server's authoritative seq (§10) so this
    // tab's Persistence mirror keeps its snapshot watermark honest and its next locally-minted seq above
    // the server's (no dual-sequencer collision on the /event echo).
    store.applyDiffAsChange(diff, "remote");
    persistence.adoptSeq(seq);
  });
}
