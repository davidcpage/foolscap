# app — the canvas (filesystem & agent sessions, file-backed + reactive)

The live React renderer over the unchanged `core/` + `interaction/` engines. An infinite canvas whose
cards are backed by real files and by Claude Code sessions, all flowing through the engines' public seams.
Design notes: file-backed cards in [`../docs/file-trees-on-canvas.md`](../docs/file-trees-on-canvas.md),
card types as data in [`../docs/card-types-as-data.md`](../docs/card-types-as-data.md), and agent sessions
in [`../docs/agent-sessions-on-canvas.md`](../docs/agent-sessions-on-canvas.md).

> **Security — read before running.** This is a single-user local dev tool. The dev-server middleware
> (`vite-fs-plugin.ts`) is **unauthenticated** and, on the machine it runs on, it serves the repo's text
> files, accepts board-mutation commands (`POST /api/command`), and can **spawn Claude Code agents that
> edit files and run commands unattended** (`POST /api/session/spawn`). It is bound to `127.0.0.1` and
> **must stay there** — never run it with `--host` or otherwise expose it to a network. Anyone who can
> reach the port can read your files and execute code as you.

## Run

```bash
cd core && npm install      # provides the single @tldraw/state copy
cd app  && npm install && npm run dev
```

Never copy `node_modules` between machines — native deps (rollup) are code-signed per host; reinstall.

You start with an empty, persisted canvas. Populate it from the **right-click canvas menu**:

- **＋ New session** — spawn a live Claude Code session as a card; type into it, watch it stream.
- **Open session ▾** — reopen any historical session (the list is read straight off disk, so a session
  card you deleted reappears here and reopens; recommencing resumes it live in place).
- **Add files ▾** — drop a folder of the repo onto the board as a column-clustered block of file cards.
- **Add widget ▾** — the demo widgets (clock, git HEAD / HN feeds, computed, intent log), opt-in.

Cards drag/resize/select like any canvas; ⌫ deletes the selected, ⌘Z undoes *your* last act. The board
persists to IndexedDB, so a reload brings it back.

## What it's testing

The design note's split: **spatial state is the canvas's, content lives in files.**

- A file card is an ordinary node (`type: "file"`) — **the engines (`core/`, `interaction/`) are
  untouched.** Position/size/selection/camera are records the canvas owns; the card's `text` is a *cached
  projection* of the file (or transcript), which is the source of truth. On boot the arrangement
  hydrates from the durable log and content is re-derived from disk.
- The filesystem watch is the **git-aware-ingest path in miniature**: an out-of-band edit arrives as a
  channel-3 event (`actor: "remote"`) and becomes a `setText` command — the same path an agent editing a
  file in its own session takes.
- It rides the engines' existing **per-entity reactivity**: a change commits `setText` on one card, so only
  that card's `NodeView` re-renders.

## Persistence

The board is durably backed: the `Editor`'s log is core's `Persistence` (event-sourced log + a debounced
document-snapshot cache) over IndexedDB backends (`src/idb.ts`). The camera is session-tier state in
localStorage (`src/session.ts`), kept out of the document/log. The filesystem-of-markdown backend the
design note describes is a future swap behind the same `EventStore`/`SnapshotStore` interfaces.

## Live dashboard widgets

On top of the file/session cards, the opt-in widgets exercise feeds × computed × agent with zero engine
changes (one small core change: selective undo):

- **Feed cards** (`src/feeds.ts`, off-log): **git HEAD** (chokidar on `.git/HEAD` + `.git/logs/HEAD` →
  `git log -1`, over SSE `/api/feeds`) and the current **HN top story** (polled server-side, keyless).
  Values ride channel 1 only, never the log.
- **A computed card**: *time since last commit* = clock × git HEAD. The card and its two input
  `EdgeRecord`s are authored (logged, undoable — dashed wires on the canvas); the counting value is
  derived in the view and stored nowhere. Delete/undo a wire and it degrades to "missing input".
- **The provenance card** (`src/provenance.ts`): the intent log, live on the canvas — it moves only when
  the log grows.
- **The agent bus** (`src/agentBus.ts`): `POST /api/command` → SSE `/api/bus` → `editor.commit`
  (attributed, default `actor: "claude"`); the browser pushes snapshot + recent intent back so
  `GET /api/canvas` reads the live board.

```bash
curl localhost:5173/api/canvas   # read: snapshot + recent intent
curl -X POST localhost:5173/api/command \
     -d '{"type":"addNode","actor":"claude","payload":{"title":"hello","text":"from outside","x":900,"y":300}}'
```

## How it's wired

- `vite-fs-plugin.ts` — Node dev-server middleware (the only part that needs Node): file serving
  (`/api/ls`, `/api/file`, `/api/watch`), sessions (`/api/sessions`, `/api/session`, the live-session
  registry under `/api/session/*`), card-type assets (`/api/card-types`, `/card-types/*`), the feed hub
  (`/api/feeds`), and the agent-bus relay (`/api/bus` + `/api/command` + `/api/canvas`). It is bound to
  `127.0.0.1` only (see the security note above).
- `src/loader.ts` — the bridge: fetch a folder's tree → `addNode` per file; open/spawn sessions; subscribe
  to the watch stream → `setText`/`removeNode`; re-project content on boot. Everything goes through the
  public `Editor`.
- `src/App.tsx` — engine construction (durable hydrate → manager → attach → undo), the right-click
  add menu, and the one DOM-coupled wire (`bindDom`).
- `src/NodeView.tsx` / `src/CanvasView.tsx` — the render layer: the box host + the camera/grid/selection
  plumbing. Interiors are runtime-loaded templates.
- `src/lib.ts` — the engine import seam (the renderer touches the engines only through this).
- `card-types/` + `src/templates.ts` — card types as runtime-loaded data
  (`../docs/card-types-as-data.md` §7): `type.yaml` is the capability grant, `render.js` the card's interior —
  real JS over the vendored `/vendor/lit-html.js`, loaded with a browser-native `import()`, no build step.
  The host owns the box (drag never touches the template); a read-tracking reactor re-renders the interior
  only when a granted signal it read changes. The registry re-imports a type when its files change on disk
  (the `cardtypes` feed). `npm test` runs the headless template × mock-card contract tests.
