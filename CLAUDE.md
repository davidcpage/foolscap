# CLAUDE.md

A local-only, infinite-canvas note app on a reactive, serializable, agent-legible core. One signia
(`@tldraw/state`) store, hidden behind `Subscribable<T>`, exposing **three channels**: pull handles for
the renderer, a push diff stream for persistence/undo/indexes, and a durable **intent log** (one event
per gesture) for provenance/agents/sync. Design rationale: `docs/tldraw-architecture-and-feasibility.md`
(and the rest of `docs/`).

> **Scope of this file.** CLAUDE.md is the reference for working on **this repo's code** — architecture,
> build, conventions, and where things live. How a session *behaves on the board* is NOT here — it's the
> **harness** (`app/harness.md` + `app/harness/*.md`). See "Agent behaviour lives in the harness" below.

## Packages

| Package | Role |
|---------|------|
| `core/` | The store: records, diff algebra, command + intent log, gesture coalescing, undo, persistence. |
| `interaction/` | Input → gestures/commands. Tools, camera, selection, spatial index; `input.ts` is the only DOM-coupled file. |
| `app/` | The renderer (React) over the unchanged engines: file-backed cards, runtime-loaded card-type templates, the agent-sessions work, IndexedDB persistence. A Node dev-server middleware (`vite-fs-plugin.ts`) serves the file tree + watch stream. All ongoing development happens here. |

No monorepo tooling — each package is standalone with its own `node_modules`. The app imports the sibling
engines directly from `../core/src` / `../interaction/src` (no build step). `@tldraw/state` resolves
transitively from `core/node_modules` — keep it a single copy.

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
- Single renderer: `app/` (React), chosen for momentum and ecosystem; the choice stays cheap to reverse
  because the engines never learned about the renderer. (History — the retired Solid port that once
  demonstrated swappability: `docs/architecture-history.md`.)
- Develop on `main` (local-only, solo); no feature branches unless a change is genuinely risky.

## Size caps & truncation (a repeatedly-stubbed toe)

Defensive truncation has caused more hard-to-debug "where did my content go?" bugs in this app than the
memory pressure it guards against. The pattern each time: a cap silently kept the *wrong end* or stacked a
*second redundant cap*, and the missing content looked like a stale/forked/desynced state. Before adding or
trusting one:

- **Bound size in ONE place — the byte read** (`MAX_SESSION_BYTES`, `MAX_SESSION_FEED_BYTES` in
  `server-sessions.ts`; `MAX_BYTES` in `server-http.ts`). That string IS the memory bound; a downstream cap
  on *turns/rows/items* frees no
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

## Running & operating the app (dev-ops)

- **Run:** `npm run dev` (in `app/`) runs the **supervisor** (`app/dev-supervisor.js`) — a tiny long-lived
  owner that launches Vite + the fs middleware (always **port 5173**, `strictPort`; a second `npm run dev`
  fails loudly rather than binding 5174 — IndexedDB is per-origin, so a port slide makes boards look empty).
  If it won't start, free the port (`lsof -ti tcp:5173`); don't override it.
- **One Ctrl-C reaps the whole stack.** The supervisor owns Vite as a process-group child and, on its own
  SIGINT/SIGTERM (or `npm run dev:stop`), tears down in order — Vite, then the sidecars — so there are no
  orphaned processes to hunt. It does **not** spawn the sidecars: they keep their auto-start-on-first-attach
  path (below); the supervisor just *tracks + reaps* them via their existing stop verbs. Caveat: a `kill -9`
  of the *supervisor* can't be trapped — its children reparent to launchd and keep running (macOS has no
  subreaper; accepted, use Ctrl-C / `dev:stop`, not `kill -9`).
- **Sessions run in a sidecar** (`app/session-host.js`, socket in tmpdir keyed by checkout, log
  `app/.session-host.log`), auto-started on first attach. The dev server is a *client*: restarting it
  re-attaches and **adopts** running sessions rather than killing them (history from the transcript,
  running/idle from the busy bit). A long-running sidecar keeps its OLD code across upgrades — a protocol
  bump fails loudly, a non-protocol change runs stale until you restart it.
- **Targeted restart** (supervisor verbs): `npm run dev:restart-server` bounces **only** the Vite child —
  the sidecars and every live agent session survive (they're owned by the untouched session-host) and the
  fresh Vite re-attaches + re-adopts them. `npm run dev:restart-jupyter` drops the gateway (kernels
  relaunch on demand). There is deliberately **no session-host restart** — the host owns the child stdin
  pipes in-process, so bouncing it kills every live session; that IS "stop everything" (`dev:stop`), not a
  targeted bounce. `dev-supervisor.js status` reports the current Vite pid + socket. Note the supervisor's
  full-process restart is heavier than Vite's own same-pid re-eval (edit a plugin/config file → Vite
  re-evaluates the module in-process, `globalThis` state adopted, sidecars untouched) — **that stays the
  primary iterate loop**; `restart-server` is for a wedged server or a change Vite can't hot-eval.
- **Bare / opt-out paths (no supervisor):** `npm run dev:bare` runs Vite directly (the pre-supervisor
  path — sidecars still auto-start and adopt, but Ctrl-C leaves them running; reap with
  `npm run session-host:stop` / `jupyter-host:stop`). `npm run dev:local` (`CANVAS_SESSION_HOST=0`): sessions
  run **in-process** and die with the server; a local-mode server won't adopt the sidecar's sessions — don't
  mix modes. Contract tests / CI reach a session-host through the same auto-start path, so they need no
  supervisor.
- **Board records persist server-side** in `<repo>/.canvas/board/` (`events.jsonl` + `snapshot.json`), so a
  board hydrates the same in any browser and travels with the repo. IndexedDB is a read-once adoption
  source, not a durable tier — don't curl-write a board's persist endpoints (it blocks that adoption).

## The canvas / agent-bus code (where things live)

The agent bus and its features ARE this repo's product; the implementation map (usage of these lives in the
harness leaves, not here):
- `vite-fs-plugin.ts` — the dev-server middleware: serves the file tree + watch stream and hosts the agent
  bus and session endpoints (implementations split into `server-*.ts` + `routes/*.ts`; the collab-brief
  injection — `harness.md` with `{{base}}`/`{{boardId}}`/`{{sessionId}}`/`{{harnessDir}}` substituted —
  lives in `server-sessions.ts`).
- `src/agentBus.ts` — browser side of the bus; `src/remote-store.ts` — HTTP persistence stores;
  `board-persist.js` (+ `/api/board/persist`) — the server-side board record store (`.canvas/board/`). The
  bus runs over one `/api/ws` WebSocket per tab (feeds + bus + file-watch) — standing SSE streams starved
  the browser's 6-per-host connection pool.
- `app/thread-ledger.js` (+ `.canvas/threads/`) — thread conversation state and pins; `app/standing-jobs.js`
  — server-fired jobs; `app/coordinator-heartbeat.js` — the Coordinator heartbeat job spec;
  `app/work-intent.js` — the work-intent enum; `thread-state.js` — the active/waiting/dormant derivation.
- `app/annotations.js` (+ `.canvas/annotations/`) + `app/anchors.js` — doc annotations (standoff, W3C
  quote anchors); `app/src/NodeView.tsx` + `app/src/annotations.ts` — the annotation card UI (host chrome).
- `app/role-format.js` / `app/role-ledger.js` (+ `app/default-roles/`) — role charters (frontmatter + body).
- `app/codex-app-server.js` / `codex-host-runtime.js` / `codex-projection.ts` / `codex-session-router.js` —
  the Codex session provider (sessions run `provider:"claude"|"codex"`).
- `app/dev-supervisor.js` — the thin dev-stack lifecycle owner behind `npm run dev`: owns Vite as a
  process-group child, tracks + reaps the sidecars on its own exit (their existing stop verbs), and serves
  `restart-server` / `restart-jupyter` / `stop` / `status` over a checkout-keyed tmpdir control socket. No
  session-host restart verb (bouncing it kills live sessions). See the dev-ops section above.
- `app/jupyter-host.js` (+ `jupyter-host-protocol.js`) — the Jupyter kernel-gateway sidecar (launch-on-demand,
  tmpdir rendezvous, `--stop`); `app/server-kernel.ts` + `app/routes/kernel.ts` — the `/api/kernel/*` broker
  (kernel-per-notebook on `fsState.liveKernels`, IOPub→nbformat, id-keyed CAS write-back through the codec's
  `mode:"full"` projection); `app/card-types/ipynb/` runs cells + shows the `kernel:<node>:<board>` status feed.
  The interactive `.ipynb` card needs a repo Python env (`docs/ipynb-card.md`: `uv venv && uv pip install
  jupyter_kernel_gateway ipykernel`).
- Design rationale: `docs/threads-as-cards.md`, `docs/agent-to-agent-messaging.md`,
  `docs/doc-annotations.md`, `docs/anchored-async-ask.md`, `docs/wakeable-substrate-plan.md`,
  `docs/harness-constitution.md`, `docs/architecture-history.md`.

## Agent behaviour lives in the harness, not here

This file is **repo-development reference**. How a session *behaves on the board* — both the norms and the
API usage — is the **harness**, not CLAUDE.md:
- `app/harness.md` — the always-loaded **constitution** (seven principles) injected into every session.
- `app/harness/*.md` — on-demand **recipe leaves** with the exact API usage: `agent-bus.md` (read/mutate
  canvas, mount boards), `sessions.md` (spawn/drive/teardown), `thread-comms.md`
  (threads/inbox/ask/pins/intent/seats/jobs), `doc-annotations.md` (comment on / answer docs).
- Coordinator identity + role footguns: `app/default-roles/pm/role.md`.

Change canvas *behaviour* in the harness; document repo *code* here. The bus/session/thread/annotation
**mechanics live once, in the leaves** — this file points at the implementing files, it doesn't restate the
API.
