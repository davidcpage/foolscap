# Sessions — spawn, drive, tear down

> Substitute `<base>`, `<board>`, `<your-sid>` with your own values from the identity block in your core
> brief (server, board id, session id).

A session is a server-owned `claude -p` child; its canvas card is a view over its stdout feed. These
endpoints drive the process. **Session ids are global UUIDs** — `input` / `interrupt` / `terminate` /
`done` / `inbox` need no `?board=`; `spawn` / `resume` / `session` / `sessions` do (they pick the cwd /
transcripts dir). Prefer the **`scripts/canvas spawn`** wrapper (allow-listed; raw `/api/session/spawn` is
permission-gated).

## Spawn

`POST /api/session/spawn?board=<board>` `{ prompt?, roleId?, thread?, card?, model? }` → `{ id, carded }`.
- `thread:<id>` → the SERVER drops the worker's session card + `member:open` edge, positions it by the
  thread card, and onboards it to *await its task on the thread* — you then assign via a tagged thread post.
  **Never put the task in the spawn prompt.** `card:true` → a standalone card, no edge.
- `model:<id>` (or `scripts/canvas spawn --model <id>`) picks the Claude model the session runs. Precedence:
  explicit spawn param > the role's `model:` frontmatter (role.md) > the server default `claude-opus-4-8`.
  Role-based spawns (mention-spawn, the Coordinator heartbeat) pick up the role's `model:` automatically —
  the shipped Coordinator/pm role pins `claude-fable-5`. Which model a worker gets is the spawner's
  (usually the Coordinator's) call.
- `429` when the live-session cap (`MAX_LIVE_SESSIONS=12`, across all boards) is hit — `terminate` one to
  free a slot.

## Drive

- **Prompt (as the human):** `POST /api/session/<id>/input {text}` writes to stdin — this **reads AS the
  human** (interrupts the turn, full trust). Peer/thread comms do NOT use this (that's a thread message +
  nudge + inbox pull). `409` if not live.
- **Interrupt:** `…/interrupt` halts the current turn; the process stays live (`409` if idle).
- **Terminate:** `…/terminate` kills the process and frees the cap slot (`409` if not live). Prefer over an
  OS-level `kill`.
- **Done:** `…/done` = terminate **plus** a durable `endReason:"done"` marker → the card reads a calm
  "✓ done". (Terminate → "terminated"; an unmanaged death → "crashed", a loud red band.)
- **Resume:** `…/resume?board=<board>` respawns a historical session in place (`--resume`) — an anti-pattern
  for *continuing* work (a resumed session re-concludes done from replayed backlog); spawn fresh instead.
- **Read / probe:** `GET /api/session?id=<sid>&board=<board>` → transcript tail; `GET /api/sessions?board=
  <board>` lists them; `GET /api/inbox?session=<sid>` is `200` live / `404` not (a liveness probe).

## Gotchas

- **A bare curl / shell spawn leaves NO canvas card** — only the browser tab drops it. Pass `thread` or
  `card:true` so the SERVER creates the card + edge for you. (Card id = `node:live:<sid>`, title = the sid.)
- Sessions run in a sidecar that survives dev-server restarts; a leaked spawn lingers until the sidecar
  stops. Running and stopping that sidecar is dev-ops — see `CLAUDE.md`.
