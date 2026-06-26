import type { InteractionManager } from "./lib";
import { activeBoardId } from "./board";

// The browser end of the agent bus (demo §10 step 4). Inbound: commands posted to /api/command
// arrive over SSE and run through editor.commit — the same one-mutation-API a gesture or the loader
// uses, so an agent's act is validated, diffed, logged and attributed exactly like everyone else's
// (actor defaults to "claude"; selective undo means Ctrl-Z never pops it). Outbound: every channel-2
// diff schedules a debounced push of the snapshot + recent intent to /api/canvas, so an agent can
// READ the live board with one GET. Together they're the MCP server's dress rehearsal:
//
//   curl 'localhost:5173/api/canvas?board=<id>'
//   curl -X POST 'localhost:5173/api/command?board=<id>' -d '{"type":"addNode","actor":"claude","payload":{...}}'
//
// Both legs are PER BOARD (Phase 3): this tab subscribes and pushes under its own activeBoardId, so a
// command only reaches the boards showing that repo and each board's snapshot is read back on its own id.

const PUSH_DEBOUNCE_MS = 500;

export function connectAgentBus(m: InteractionManager): () => void {
  const editor = m.editor;
  // One tab = one board; resolved before the engine built, so it's stable for this connection's life.
  const board = activeBoardId();

  const es = new EventSource(`/api/bus?board=${board}`);
  es.onmessage = (ev) => {
    let cmd: { type?: string; payload?: unknown; actor?: string };
    try {
      cmd = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!cmd.type) return;
    try {
      editor.commit({ type: cmd.type, payload: cmd.payload ?? {}, actor: cmd.actor ?? "claude" });
    } catch (err) {
      // an unknown command type — the Editor's validation IS the bus's validation
      console.warn("[agent-bus] rejected:", cmd.type, err);
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    void fetch(`/api/canvas?board=${board}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ts: Date.now(),
        snapshot: editor.store.getSnapshot(),
        recentIntent: editor.log.describe(20),
      }),
    }).catch(() => {}); // server gone (dev restart) — the next change re-pushes
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(push, PUSH_DEBOUNCE_MS);
  };
  const off = editor.store.listen(schedule);
  schedule(); // make the freshly-loaded board readable without waiting for a change

  return () => {
    es.close();
    off();
    if (timer) clearTimeout(timer);
  };
}
