import type { InteractionManager } from "./lib";
import { onBusCommand } from "./feeds";

// The browser end of the agent bus (demo §10 step 4). Inbound: commands posted to /api/command
// arrive over the tab's shared WebSocket (feeds.ts owns it; a standing SSE stream per tab was what
// starved the browser's six-per-host connection pool) and run through editor.commit — the same
// one-mutation-API a gesture or the loader uses, so an agent's act is validated, diffed, logged and
// attributed exactly like everyone else's (actor defaults to "claude"; selective undo means Ctrl-Z
// never pops it).
//
//   curl 'localhost:5173/api/canvas?board=<id>'
//   curl -X POST 'localhost:5173/api/command?board=<id>' -d '{"type":"addNode","actor":"claude","payload":{...}}'
//
// The READ side (GET /api/canvas) needs nothing from this module any more: the server serves it from
// the durable board store, which core's Persistence already writes on every change (remote-store.ts).
// This tab used to push a second, near-identical snapshot here just for that read — retired.
//
// PER BOARD (Phase 3): this tab subscribes under its own activeBoardId (the socket carries ?board= at
// connect), so a command only reaches the tabs showing that repo.

export function connectAgentBus(m: InteractionManager): () => void {
  const editor = m.editor;

  return onBusCommand((cmd) => {
    try {
      editor.commit({ type: cmd.type, payload: cmd.payload ?? {}, actor: cmd.actor ?? "claude" });
    } catch (err) {
      // an unknown command type — the Editor's validation IS the bus's validation
      console.warn("[agent-bus] rejected:", cmd.type, err);
    }
  });
}
