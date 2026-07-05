# CLAUDE.md

A local-only, infinite-canvas note app on a reactive, serializable, agent-legible core. One signia
(`@tldraw/state`) store, hidden behind `Subscribable<T>`, exposing **three channels**: pull handles for
the renderer, a push diff stream for persistence/undo/indexes, and a durable **intent log** (one event
per gesture) for provenance/agents/sync. Design rationale: `docs/tldraw-architecture-and-feasibility.md`
(and the rest of `docs/`).

## Packages

| Package | Role |
|---------|------|
| `core/` | The store: records, diff algebra, command + intent log, gesture coalescing, undo, persistence. |
| `interaction/` | Input → gestures/commands. Tools, camera, selection, spatial index; `input.ts` is the only DOM-coupled file. |
| `app/` | The renderer (React) over the unchanged engines: file-backed cards, runtime-loaded card-type templates, the agent-sessions work, IndexedDB persistence. A Node dev-server middleware (`vite-fs-plugin.ts`) serves the file tree + watch stream. All ongoing development happens here. |

No monorepo tooling — each package is standalone with its own `node_modules`. The app imports the sibling
engines directly from `../core/src` / `../interaction/src` (no build step). `@tldraw/state` resolves
transitively from `core/node_modules` — keep it a single copy.

> History: this began as a series of de-risking spikes — a store-only benchmark (which picked signia), a
> render-edge proof (60fps at N=5000), and two renderer proofs (a React reference and a Solid port,
> demonstrating swappability over the unchanged engines). They were removed once their conclusions
> landed; `app/` is the renderer that grew out of them.

## Build & test

```bash
cd core        && npm test && npm run typecheck     # node --test
cd interaction && npm test && npm run typecheck
cd app         && npm test && npm run typecheck     # card-type contract tests
cd app         && npm run dev                        # the live app (Vite + the fs middleware)
```

On a fresh machine: `npm install` in `core/` (provides the single `@tldraw/state`) and in `app/`, then
`npm run dev`. Never copy `node_modules` between machines — native deps (rollup) are code-signed per host.

## Conventions

- Channel discipline: renderer reads channel 1 only; persistence/index/undo consume channel 2; one
  gesture emits exactly one channel-3 `IntentEvent`. Don't cross these wires.
- signia is the only borrowed substrate and stays behind `Subscribable<T>`; geometry, diff algebra,
  intent log, and the interaction layer are owned.
- Single renderer: `app/` (React). Swappability was demonstrated once by a Solid port (its entire delta
  was one `src/reactive.ts`) and then retired — demonstrated, not maintained. React was chosen for
  momentum and ecosystem, and the choice stays cheap to reverse because the engines never learned about
  the renderer.
- Develop on `main` (local-only, solo); no feature branches unless a change is genuinely risky.

## Size caps & truncation (a repeatedly-stubbed toe)

Defensive truncation has caused more hard-to-debug "where did my content go?" bugs in this app than the
memory pressure it guards against. The pattern each time: a cap silently kept the *wrong end* or stacked a
*second redundant cap*, and the missing content looked like a stale/forked/desynced state. Before adding or
trusting one:

- **Bound size in ONE place — the byte read** (`MAX_SESSION_BYTES`, `MAX_SESSION_FEED_BYTES`, `MAX_BYTES`
  in `vite-fs-plugin.ts`). That string IS the memory bound; a downstream cap on *turns/rows/items* frees no
  memory (the string is already bounded) and only re-drops content. The session codec renders **every** turn
  it's given for exactly this reason — don't reintroduce a turn cap.
- **Keep the TAIL for append-only / scroll-to-bottom logs** (transcripts, feeds, the provenance panel): the
  bytes you want are the most recent — where you left off. **Keep the HEAD only for top-down reads** (source
  files). Keeping the wrong end is invisible until someone scrolls; it reads as "truncated before X, full
  after" or "stale card". Codecs already tolerate the ragged first line a tail leaves.
- **Always surface a `truncated` flag** to the UI when a cap bit, and never *guess* truncation from a parse
  failure (a live mid-write tail looks identical). The byte cap that cut is the one honest source.
- **Prefer generous caps.** Responsiveness/memory still matter (the live feed republishes its whole buffer
  per frame — that one stays smallish on purpose), but when unsure, err large: a one-time render of a
  byte-bounded blob is cheaper than the debugging a stingy cap costs. If DOM size ever truly bites, the
  answer is virtualization, not a silent drop.

## Driving the board from outside (the agent bus)

The live board lives in the **browser** (the signia store); the durable copy lives in the repo's
`.canvas/board/` (see "Board records persist SERVER-SIDE" below). To read or mutate canvas state from a
shell/agent, go through the agent bus (`app/src/agentBus.ts`, `vite-fs-plugin.ts`) — reads are served
from the durable store, never read the files directly (they lag and their layout is private).

**The bus is PER BOARD** (one server now hosts many boards — `?board=<boardId>`). Every bus endpoint takes
`?board=<id>` and defaults to the dev repo's board (`foolscap-a9921027`) when omitted, so the dev-repo
examples below work unchanged. `GET /api/boards` lists the mounted boards and their ids; a tab over another
repo subscribes/pushes under *its* board, so a command for board X reaches only X's tabs and X's snapshot is
read back on X's id.

**Mounting an EXTERNAL repo as a board:** open `http://localhost:5173/?repo=<abs-path>` — the tab POSTs
`/api/boards {repoPath}` (idempotent; boardId = `<slug(basename)>-<sha256(realpath)[:8]>`, stable across
restarts) and that board gets its own served root, `.canvas/` home, session spawn cwd, and per-board
IndexedDB. Every mount is recorded in the DEV repo's `.canvas/boards.json` registry (`lastOpened` recency)
and re-registered at boot, so a known `?board=` id resolves right after a server restart (per-board feeds
stay lazy until a tab actually mounts). Mounting also appends `.canvas/` to the target repo's
`.git/info/exclude` (idempotent), keeping its `git status` clean. In the browser, switch boards via the
right-click menu's **Board** section — it lists the registry (plus "Open repo…"); rows navigate with
`?repo=` so switching re-mounts, self-healing a forgotten board.

**Board records persist SERVER-SIDE** (`<repo>/.canvas/board/` — `events.jsonl` intent log +
`snapshot.json` cache, via `board-persist.js` and `/api/board/persist`): the browser's persistence
stores are HTTP clients (`src/remote-store.ts`), so a board hydrates the same in any browser/machine
and its records travel with the repo. IndexedDB is a read-once adoption source for pre-existing
boards, not a durable tier. Don't curl-write a real board's persist endpoints: junk server state
blocks that one-time adoption. (The camera pose stays per-browser in localStorage.) This store also
serves `GET /api/canvas` and every server-side membership/node lookup — the browser no longer pushes a
second snapshot for those.

- **Read:** `GET /api/canvas?board=<id>` → `{ ts, tabs, snapshot, recentIntent }` from the DURABLE store
  (the browser's debounced ~400ms persistence save; `recentIntent` derives from the event log).
  `snapshot.records` are the nodes/edges/layouts. **A read works with NO tab live** — `tabs` is the
  liveness signal (0 = nobody can act on this board; don't treat a successful read as "board is live").
  404 only for a board that has never persisted anything.
- **Write:** `POST /api/command?board=<id> {type, actor, payload}` → broadcast to that board's connected
  tabs (over each tab's `/api/ws` WebSocket — one socket per tab carries feeds + bus + file-watch, because
  standing SSE streams starved the browser's 6-per-host connection pool), where it runs through the same
  `editor.commit` a gesture uses — validated, diffed, logged, attributed, persisted. E.g. remove a card:
  `{type:"removeNode", actor:"user", payload:{id}}`.

Gotchas (learned the hard way):
- **No connected tab *for that board* → the command goes nowhere:** `POST /api/command` returns **HTTP 503
  `{delivered:0}`** judged against that board's tabs only. Confirm `delivered>0` before trusting a broadcast;
  there is no shell path to *mutate* a board if no browser is live on it (reads still work — see above).
  An unknown `?board=` is **400**.
- **The port is always 5173** (`strictPort` in `vite.config.ts`): a second `npm run dev` now **fails
  loudly** instead of silently binding 5174. Deliberate — IndexedDB is per-ORIGIN (port included), so the
  old silent port slide made every board look empty. If the server won't start, stop the process holding
  the port (`lsof -ti tcp:5173`); don't override the port.
- **Removing cards:** edges before nodes (no dangling wires); file-card ids are deterministic
  `node:repo:<path>`, so a set to remove can be derived without reading the board.
- **Attribution & undo:** bus commits land under their `actor`; selective undo means the user's ⌘Z only
  pops their own `actor:"user"` acts — bus acts and loader `actor:"system"` acts are **not** undoable.

## Driving sessions headlessly (spawn / drive / tear down)

A **session** is a server-owned `claude -p` duplex child (`ensureLiveSession` in `vite-fs-plugin.ts`); the
canvas session card is just a *view* over its stdout feed. These endpoints control the process. **Session
ids are global UUIDs**, so `input`/`interrupt`/`terminate`/`done`/`inbox` need no `?board=`; `spawn`/`resume`/
`session`/`sessions` do (they pick the cwd / transcripts dir).

- **Spawn:** `POST /api/session/spawn?board=<id> {prompt?, roleId?, thread?, card?}` → `{id, carded}` (`channel`
  is the pre-rename alias for `thread`). Mints a UUID, spawns the child with the collab brief appended to its
  system prompt, sends `prompt` as the first turn if given. Optional `thread` (a thread id) makes the SERVER
  drop the worker's session card + `member:open` edge and POSITION it next to the thread card (server-side
  cascade — agents place cards badly); `card:true` makes a standalone card with no edge; `carded` reports
  whether a live tab applied it. Prefer the `scripts/canvas spawn` wrapper (it's the allow-listed path; raw
  spawn is permission-gated). **429** when the live-session cap (`MAX_LIVE_SESSIONS=12`, concurrent, all
  boards) is hit — `terminate` one to free a slot.
- **Prompt:** `POST /api/session/<id>/input {text}` writes to stdin — this **reads AS the human** (interrupts
  the turn, full trust). **409** if not live. (Thread messages do NOT use this — see below.)
- **Resume:** `POST /api/session/<id>/resume?board=<id>` respawns a historical session in place (`--resume`),
  same card/id. **404** if no transcript.
- **Interrupt vs terminate vs done:** `…/interrupt` halts the *current turn* (process stays live; **409** if
  idle). `…/terminate` **kills the process** and frees the cap slot (**409** if not live; the card flips to its
  historical/exited state — `removeNode` it separately if wanted). Prefer `terminate` over OS-level `kill`.
  `…/done` is `terminate` PLUS a durable `endReason:"done"` on the session's `.canvas/sessions/<id>.json`
  marker, so the card reads a calm "✓ done" rather than a neutral "✕ exited" — the EXPLICIT "finished" end an
  agent curls when its work is wrapped up, or the head's "✓ end" button fires. (`terminate` records
  `endReason:"terminated"`; a process that dies on its own — not via done/terminate/clean-shutdown — records
  `"crashed"`, painting a loud red band. The reason survives a server restart via the marker.)
- **Read:** `GET /api/session?id=<sid>&board=<id>` → `{id, content, truncated}` (transcript tail);
  `GET /api/sessions?board=<id>` lists them. **Liveness probe:** `GET /api/inbox?session=<sid>` is `200` if
  live, `404` if not.

### Session-host mode (the default: sessions survive dev-server restarts)

`npm run dev` puts the session processes in a **sidecar** (`app/session-host.js`, auto-started on first
attach; socket in tmpdir keyed by checkout, log at `app/.session-host.log`). The dev server is a *client*:
restarting it no longer kills the sessions — on boot it re-attaches and **adopts** whatever is still
running (history re-seeded from the transcript; running/idle taken from the sidecar's busy bit, so a
mid-turn session isn't nudge-interrupted). Read cursors/waitingOn revive from the `.canvas/sessions/`
marker (persisted in both modes). What to know:

- **Stopping the SIDECAR is the explicit stop-everything**: `npm run session-host:stop` (or SIGTERM it) —
  children end clean ("ended", not "crashed"); a `kill -9` of it *does* read as crashed. Ctrl-C on the dev
  server no longer reaps leaked sessions — the stop verb (or per-session `terminate`) is how you clean up.
  (While a dev server is attached, a fresh *empty* sidecar respawns right after — stop kills the sessions,
  not the mode. And a long-running sidecar keeps its OLD code across upgrades: `--stop` detects this and
  tells you to kill the pid.)
- **One attached dev server.** A second server (only possible with the port explicitly overridden —
  strictPort makes the accidental 5174 twin fail at startup) is rejected `busy`, warns, and runs its
  spawns in-process — it never touches the first server's sessions.
- **Opt out** with `npm run dev:local` (`CANVAS_SESSION_HOST=0`): the old model — in-process children,
  killed on server exit. An unreachable sidecar degrades to this by itself (with a warning). Don't mix
  modes casually: a local-mode server won't adopt the sidecar's sessions — they keep running invisibly.

Gotchas:
- **A bare curl spawn leaves NO canvas card.** The *browser tab* that calls spawn is what drops the
  `node:live:<sid>` card; a shell spawn registers the process only. The clean fix is to pass `thread` (or
  `card:true`) so the SERVER drops the card + `member:open` edge for you, positioned by the thread card. Only
  if you spawn without those must you `addNode {id:"node:live:<sid>", type:"session", title:"<sid>"}` + the
  `member:open` edge yourself over `/api/command`. (Session card id = `node:live:<sid>`, title = the full sid.)
- **Spawned children die only with the server** (`killAll` on exit) or via `terminate`. A leaked curl-spawn
  with no terminate lingers until the dev server stops. **Exception:** in session-host mode (below) children
  belong to the sidecar — they survive dev-server restarts, and a leak lingers until the *sidecar* stops.

## Agent session coordination (threads, inbox, ask/reply)

How live sessions talk to each other. Full design: `docs/threads-as-cards.md` (threads/seats; transport
detail in `docs/agent-to-agent-messaging.md` §15/§16). A **thread** is a per-task card — a node
`{type:"thread"}` (legacy `{type:"channel"}` nodes are threads too — carried over, same machinery) whose
`title` is the task and `text` the optional brief; a session **joins** via a `member:open` edge (session
node → thread node). Conversation state is **off-log** but **durable** (`.canvas/threads/` jsonl+meta,
replayed at boot; read cursors persist on the session's `.canvas/sessions/` marker, so they survive
restarts — and in session-host mode the sessions themselves do too). Agents work in **thread ids + their
own sid**; the server resolves nodes/edges. The thread id
carries a colon, so **percent-encode it** in the URL path. Everything below is served under BOTH
`/api/thread/…` (canonical) and `/api/channel/…` (transition alias); `GET /api/threads` (alias
`/api/channels`) lists the markers, each with its `intents`, `seats`, and the DERIVED `state` +
`participants` (`thread-state.js`: **active** — someone running or live+working; **waiting** — nobody
active, ≥1 declared `blocked:human` (survives its declarer's exit via the seat); **dormant** — everyone
done/exited, none blocked:human; unstaffed threads are dormant; computed at read time, never stored).

- **Broadcast:** `POST /api/thread/<id>/message {from, text}` records the message in the thread's off-log
  log (the `thread:<id>` feed the card renders) and **fans out to every other member's inbox**. `from` is a
  member sid, or `"human"` (the card's post box). Members are nudged; they are **not** sent the content.
- **Read (the wake model):** message content **never** enters stdin. A member gets a **content-free nudge**
  (`[canvas] new thread messages: …`) pushed to stdin (idle-immediate or at the turn boundary, coalesced —
  an ignored nudge isn't re-fired until new traffic), then **pulls** the content with `GET /api/inbox?session=
  <sid>` → unread grouped by thread (the response's `channels`/`channel` field names keep their pre-rename
  spelling), advancing a read cursor. Content lands in **tool output, never a user turn** — the whole point.
  Call it when nudged, or **proactively at natural checkpoints during a long turn** — after finishing a
  sub-task, before an expensive or irreversible step — **not** between every tool call (that burns
  context/turn budget). This checkpoint-poll is the **live-agent half of non-interrupting comms**: it lets a
  peer or human redirect a heads-down agent without a hard `/input` interrupt (the dormant-agent half is the
  seat/watch wake machinery). **Peek-and-act, never peek-and-defer:** a `GET /api/inbox` **advances the read
  cursor**, so a mid-turn peek *consumes* the nudge — it won't re-fire. So when you peek, act on what you saw
  this turn (or explicitly note what you saw and will do); a peek you then ignore silently drops that message.
- **Membership:** `join {from, history?}` / `leave {from}` / `invite {from, target, history?}` /
  `history {target, mode:"full"|"future"}` — all under `/api/thread/<id>/`. Server-fulfilled by *emitting*
  addEdge/removeEdge over the bus (so they need `delivered>0`). `history` (default `full`) sets how much
  backlog a joiner replays.
- **Seats (`threads-as-cards.md` §5):** when a **role-spawned** session joins a thread, the server fills the
  role's **seat** on that thread's marker (`seats: {<Role>: {role, sid, createdAt, filledAt, fills}}`) — the
  durable per-thread participant that survives its occupant's respawn (a fresh session of the same role
  RE-FILLS the same seat). 1:1 with roles until labelled multiplicity ships. Plain unnamed sessions take no
  seat and stay sid-identified.
- **Consult one peer and BLOCK for the answer (§16):** `POST /api/thread/<id>/ask {from, to, text,
  timeoutMs?}` — both must be members, `to` must be live; the call **holds open** until the answerer replies
  or it times out (default 30s, cap 60s — under the Bash tool timeout). Returns `{reply:{from,text,ts}}` or
  `{timedOut:true}`. **400** self-ask, **403** non-member, **409** answerer not live. This is the oracle
  pattern (ask a session that answers in `file:line`); use `message` for fire-and-forget.
- **Answer side:** an answerer is nudged (`N pending question(s)`), reads `GET /api/asks?session=<sid>` (its
  pending queue), and answers with `POST /api/thread/<id>/reply {from, askId, text}` (only the addressee
  may; resolves the asker's held call). The Q→A is echoed into the thread log as a **card-only** entry
  (`kind:"ask"`) — it shows on the card but is **skipped** by `inbox`/nudges, so the other members aren't woken.
- **Work-intent (typed act; `threads-as-cards.md` §6):** `POST /api/thread/<id>/intent
  {from, intent:"working"|"blocked:human"|"blocked:peer"|"done", note?}` — a member declares its stance
  toward the thread's work, because `idle+working` / `idle+blocked:human` / `idle+done` are identical at
  the process layer and only the agent knows which. Card-only like the ask echo (`kind:"intent"` — rendered
  as a status line, skipped by `inbox`/nudges, wakes no one). The latest declaration per participant rides
  the thread's meta marker and `GET /api/threads` (`intents` — keyed by the declarer's SEAT handle when it
  holds one, so the state survives a respawn; else by sid); the derived thread `state` (see above) ranges
  over it. Enum lives in `app/work-intent.js`.
- **Pins — the head-context tray (R-PIN, `wakeable-substrate-plan.md` W7):** `POST /api/thread/<id>/pin
  {from, seq, pinned?}` flags a message as **head context** — re-read on every wake, ahead of the recent
  tail (`pinned` defaults true; unpin with `pinned:false`). The pin is a **snapshot** on the thread marker
  (`pins`, chronological), so it survives the log's bounded tail; the message keeps its place in the log.
  The card shows a collapsible pinned tray + a per-message 📌; `GET /api/inbox` returns a channel's `pinned`
  array on any read with fresh messages (re-served, not consumed — so a woken agent always re-reads it).
  **R5 done-discipline (norm, no schema):** a thread's `Done when:` condition should be a **pinned** post,
  and a `done` intent must be accompanied by a thread message posting **proof** against it (test output, a
  diff, a link) — the Coordinator's review is checking proof against the pinned condition, not trusting the
  flag. Helpers in `app/thread-ledger.js` (`readPins`/`pinMessage`/`unpinMessage`).
- **Standing jobs (R6, `wakeable-substrate-plan.md` W6):** a periodic, **server-fired** worker declared on a
  thread's durable marker — the canvas-native heartbeat (a `claude -p` session can't self-schedule, so the
  SERVER fires the timer and the durable RECORD, not the session, owns the schedule). `POST
  /api/thread/<id>/job {from, instruction, intervalMs?, role?, jobId?}` creates/updates a job (`jobId` edits
  in place; a named `role` fires INTO that role's seat, else a bare worker; `intervalMs` is clamped up to a
  **60s floor**); `{from, jobId, remove:true}` removes one; `GET /api/thread/<id>/jobs` lists them. Every
  `intervalMs` the server (`standingJobsTick` on the loop heartbeat) fires the job via the **one**
  `serverSpawnWorker` primitive — **wake-live-else-respawn**: a role-seat job whose seat is still occupied by
  a LIVE session **nudges** that session (cheap, context intact), and only a **dormant** target pays a fresh
  respawn (so the "<5min ⇒ wake existing / >5min ⇒ full respawn" split falls out of the 5-min keep-alive
  window automatically). **Single-flight** (a still-running fire isn't doubled) and **fire-next-due** (a
  boot-time overdue job fires ONCE, never replaying missed fires). Two norms: **"skip days with nothing"** (a
  firing that finds nothing posts nothing and winds down — the worker brief instructs the silence) and **jobs
  survive their creator AND a restart** (they live on the marker, not the session). CLI: `scripts/canvas job
  add|list|rm`. Ledger in `app/standing-jobs.js`.

Gotchas:
- **Membership must be in the saved snapshot before `ask`/`message` will accept it.** Membership is read
  from the durable snapshot (saved debounced ~400ms after the `addEdge`); fire too soon and you get a
  spurious **403**. Poll `/api/canvas` for the `member:open` edge before posting.
- **`ask`/`reply` never touch the broadcast log/cursor** — they're a separate in-memory RPC keyed by `askId`;
  only the final `kind:"ask"` echo lands in the log. Don't add a `to` field to messages (see §16 for why).

## Doc annotations (comment on a file; answer where the question lives)

Standoff, quote-anchored comments on any text file — Notion-style highlight-and-comment on doc cards,
**without the file's bytes ever changing** (design: `docs/doc-annotations.md`). Anchors are W3C
TextQuoteSelector quotes (`{exact, prefix?, suffix?, offset?}`, resolved by `app/anchors.js`: offset
fast-path → exact+context → fuzzy → orphan); storage is an append-only jsonl per annotated file in
`<board repo>/.canvas/annotations/` (`app/annotations.js`, thread-ledger sibling). Reads/writes are
server-side and tab-free.

Prefer the **`scripts/canvas anno`** CLI (allow-listed wrapper) over raw curl for the whole loop:
`anno list [path]` (board sweep, or one file's comments one line each), `anno reply <path> <id>` (text via
arg / `--stdin` / `--text-file` — a long multi-paragraph reply never has to survive shell-escaping),
`anno batch <path> replies.json` (author many replies once as a JSON data file — `[{id,text}]` or
`{id:text}` — instead of an ad-hoc `urllib` script), `anno resolve`/`reopen <path> <id>`,
`anno ask <path> --question "…" --anchor-exact "…" [--options "A|B|C"] [--blocking]` (raise an anchored
question — below), `anno answer <path> <id> [--choice L] [--text "…"]`. Pass `--from`/`--by <your-sid>` to
attribute (default `"human"`). Raw endpoints below for the rare op the CLI omits.

- **Sweep** ("what's awaiting an answer"): `GET /api/annotations?board=<id>` → `{files:[{path, total,
  open, orphaned, awaiting, answered}]}` (read-only; does not reanchor). `awaiting` = questions needing a
  human, `answered` = questions needing an agent to apply. **Per file:** `…&path=<path>` →
  `{annotations:[{id, anchor, text, author, ts, kind, options?, blocking?, resolved, replies, thread?,
  orphaned, range, state?}]}` — `orphaned`/`range`/`state` are derived at read time against the file's
  current bytes, never stored (`state` is `awaiting`/`answered`/`resolved` for a `kind:"question"`). The
  per-file read also **auto-reanchors** drifted comments (see the revision rule).
- **Write:** `POST /api/annotations?board=<id>` `{path, op, …}` — `create {anchor, text, author,
  kind?, options?, blocking?}` (returns `orphaned` immediately: check it — a mistyped `exact` is an orphan
  at birth), `reply {id, from, text}`, `answer {id, by, choice?, text?}` (a decision on a `kind:"question"`;
  400 on a note), `resolve`/`reopen {id, by}`, `reanchor {id, anchor, by}` (manual reanchor is now only for
  re-attaching a *true orphan* — the routine case is automatic), `thread {id, thread}`. Attribution
  (`author`/`from`/`by`) is `"human"` or a session sid, the thread convention.

**ASK ON THE DOC, NOT IN-SESSION (`docs/anchored-async-ask.md`).** When an agent hits a real decision it
can't make alone — a design fork, a choice the human must own — it must **not** reach for the in-session
`AskUserQuestion` block (ephemeral, board-invisible, and it pins the process open waiting). Instead raise an
**anchored question** on the span it concerns: `create`/`canvas anno ask` with `kind:"question"`, optional
multiple-choice `options`, and `--blocking` (the asker is waiting). The question and its answer then live on
the doc forever, next to what they concern; the board sees the decision pending (it rolls up in the sweep's
`awaiting` count); and a fresh session applies the answer later. The human answers where the question lives
(`answer` op / `canvas anno answer`, an option label and/or prose), flipping it `awaiting → answered`.
Continuation is **pull** for now (W1) — a fresh session sweeps `answered` questions and applies them; the
auto-wake-back is W5. Reserve the in-session block for throwaway confirmations, never a decision of weight.

**THE REVISION RULE (the convention that makes standoff anchors work here):** before editing an
annotated file — and `docs/*.md` especially — read its open annotations first (`scripts/canvas anno list
<path>`; cheap, usually empty). As part of the same change: **reply** to what you can answer. You **no
longer hand-reanchor** comments your edit moved — the server auto-reanchors any moved-but-still-resolvable
comment on the next read/write (re-minting its selector against the new bytes, converging in one pass). It
only leaves behind **true orphans** — comments whose quoted text your edit *deleted* — which show as a loud
orphan strip; re-attach those from the quote (a fresh `create`/`reanchor`) or resolve them. "Answer my
comments on `<file>`" means: reply per annotation, and where the right answer is "fix the doc", fix the doc
(the server keeps the surviving comments anchored for you).

**RESOLUTION BELONGS TO THE AUTHOR.** Resolve your own comments freely; **never reply-and-resolve
someone else's question** — resolved comments are hidden from the card by default, so resolving buries
your reply before the asker has read it (learned the hard way: the human watched their comment vanish
and nearly missed the answer). Reply, leave it open, and let the author resolve once satisfied; resolve
another author's comment only when they explicitly say so.

Gotchas:
- `create` 404s on paths the file endpoints wouldn't serve (blocked/internal/non-text) and needs the file
  to exist; other ops 404 on an unknown annotation id.
- Anchors resolve against the same head-capped read the card shows (`MAX_BYTES`, 128KB) — a quote beyond
  the cap reads as orphaned by design.
- The card UI (highlights/popover/orphan strip) is host chrome in `app/src/NodeView.tsx` +
  `app/src/annotations.ts`; canonical root only (worktree copies of a doc share the repo's annotations).
