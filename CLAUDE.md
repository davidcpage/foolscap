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

## Driving the board from outside (the agent bus)

The live board lives in the **browser** (the signia store + IndexedDB). The dev server holds no board — only
the last snapshot a browser pushed. So to read or mutate canvas state from a shell/agent, go through the
agent bus (`app/src/agentBus.ts`, `vite-fs-plugin.ts`), never the filesystem:

- **Read:** `GET /api/canvas` → `{ ts, snapshot, recentIntent }`, the last snapshot the browser pushed
  (debounced ~500ms after a change; stale if nothing changed, and overwritten by *whichever* tab pushed
  last). `snapshot.records` are the nodes/edges/layouts.
- **Write:** `POST /api/command {type, actor, payload}` → broadcast over SSE to every connected browser,
  where it runs through the same `editor.commit` a gesture uses — validated, diffed, logged, attributed,
  persisted. E.g. remove a card: `{type:"removeNode", actor:"user", payload:{id}}`.

Gotchas (learned the hard way):
- **No connected tab → the command goes nowhere:** `POST /api/command` returns **HTTP 503
  `{delivered:0}`**. Confirm `delivered>0` before trusting a broadcast; there is no shell path to the board
  if no browser is live.
- **Target the right port.** The app runs on whatever port Vite bound. If you `npm run dev` while the
  user's server is already up, yours grabs **5174** and theirs stays **5173** — point the API at the port
  the user's browser is actually on (`lsof -ti tcp:5173`).
- **Removing cards:** edges before nodes (no dangling wires); file-card ids are deterministic
  `node:repo:<path>`, so a set to remove can be derived without reading the board.
- **Attribution & undo:** bus commits land under their `actor`; selective undo means the user's ⌘Z only
  pops their own `actor:"user"` acts — bus acts and loader `actor:"system"` acts are **not** undoable.
