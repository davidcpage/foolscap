# Agent bus — read & mutate canvas state, mount boards

> Substitute `<base>`, `<board>`, `<your-sid>` with your own values from the identity block in your core
> brief (server, board id, session id).

The board's live state is the signia store in the browser; the durable copy is server-side. You read and
mutate it **only through the agent bus** — never by touching `.canvas/` files (they lag and their layout is
private). Reads are served from the durable store and work with **no tab live**; writes are broadcast to
the board's connected tabs and only land if one is live.

**Per-board.** Every bus endpoint takes `?board=<board>` (defaults to the dev board when omitted). `GET
/api/boards` lists mounted boards; a command for board X reaches only X's tabs.

## Read the board

`GET /api/canvas?board=<board>` → `{ ts, tabs, snapshot, recentIntent }`.
- `snapshot.records` are the nodes/edges/layouts.
- `tabs` is the **liveness signal** — `0` means nobody can act on this board (an outage); a successful read
  does NOT mean the board is live.
- `404` only for a board that has never persisted anything.

## Mutate the board

`POST /api/command?board=<board>` `{ type, actor, payload }` — runs through the same validated / diffed /
logged / attributed / persisted path a gesture uses. E.g. remove a card:
`{ type:"removeNode", actor:"<your-sid>", payload:{ id } }`.

- **Confirm it landed:** a command with no live tab for that board returns **503 `{delivered:0}`** — it
  went nowhere. Check `delivered>0`. (An unknown `?board=` → 400.)
- **Removing cards:** just `removeNode` — the server cascades its edges (no dangling wires, no delete-edges-
  first dance). File-card ids are deterministic `node:repo:<path>`, so a removal set can be derived without
  reading the board.
- **Attribution / undo:** commits land under their `actor`; a user's ⌘Z pops only their own `actor:"user"`
  acts — bus (`actor:"<sid>"`) and `actor:"system"` acts are not undoable.

## Mount an external repo as a board

Open `http://<base>/?repo=<abs-path>` — the tab registers the board (idempotent; boardId =
`<slug(basename)>-<sha256(realpath)[:8]>`, stable across restarts) and it gets its own served root,
`.canvas/` home, session cwd, and IndexedDB. Mounts are recorded in the dev repo's `.canvas/boards.json`
and re-registered at boot; mounting also appends `.canvas/` to the target repo's `.git/info/exclude`. Don't
curl-write a board's persist endpoints — it blocks the one-time IndexedDB adoption of a pre-existing board.
