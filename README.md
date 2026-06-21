# Foolscap

A local-only, infinite-canvas note app built on a reactive, serializable, **agent-legible** core.
*(Foolscap — an old sheet-of-paper size; here, an endless sheet to think on.)*

Cards on the canvas are backed by real files on disk and by live [Claude Code](https://claude.com/claude-code)
sessions. The board is event-sourced: every gesture becomes one attributed entry in a durable **intent
log**, so its history is legible to humans, to undo, and to agents alike.

This is a working exploration rather than a finished product. The design grew out of a study of
[tldraw](https://tldraw.dev)'s architecture — see
[`docs/tldraw-architecture-and-feasibility.md`](docs/tldraw-architecture-and-feasibility.md).

## Architecture

One signia (`@tldraw/state`) store, hidden behind a `Subscribable<T>` seam, exposing **three channels**:

1. **Pull handles** — per-entity reactive reads, for the renderer.
2. **A push diff stream** — `RecordsDiff` events, for persistence, undo, and indexes.
3. **A durable intent log** — one attributed `IntentEvent` per gesture, for provenance, agents, and sync.

| Package | Role |
|---------|------|
| [`core/`](core) | The store: records, diff algebra, command + intent log, gesture coalescing, undo, persistence. |
| [`interaction/`](interaction) | Input → gestures/commands: tools, camera, selection, spatial index. Framework- and DOM-agnostic (one DOM-coupled file). |
| [`app/`](app) | The React renderer over the engines: file-backed cards, runtime-loaded card-type templates, agent sessions, IndexedDB persistence, and a Vite dev-server middleware. |

The engines never learn about the renderer; `app/` imports them directly from source, with no build step.
Deeper background and rationale live in [`docs/`](docs) and [`CLAUDE.md`](CLAUDE.md).

## Quick start

Requires Node 20+ and — for the agent-session and usage cards — the Claude Code CLI signed in locally.

```bash
cd core && npm install        # provides the single @tldraw/state copy
cd ../app && npm install && npm run dev
```

Open the printed `http://127.0.0.1:5173`. You start with an empty, persisted canvas; **right-click** it to
add cards. (Don't copy `node_modules` between machines — native deps are code-signed per host; reinstall.)

Run the checks:

```bash
cd core        && npm test && npm run typecheck
cd interaction && npm test && npm run typecheck
cd app         && npm test && npm run typecheck
```

## Security — local use only

This is a **single-user local tool.** The Vite dev-server middleware (`app/vite-fs-plugin.ts`) is
**unauthenticated** and, on the machine it runs on, it:

- serves the repo's text files to the browser,
- accepts board-mutation commands (`POST /api/command`), and
- can **spawn Claude Code agents that edit files and run commands unattended** (`POST /api/session/spawn`).

It is bound to `127.0.0.1` and **must stay there.** Never run it with `--host` or otherwise expose it to a
network: anyone who can reach the port can read your files and execute code as you.

## Acknowledgements

The architecture was inspired by [tldraw](https://github.com/tldraw/tldraw). The only borrowed runtime
substrate is signia (`@tldraw/state`, MIT) — the geometry, diff algebra, intent log, and interaction layer
are original. [lit-html](https://lit.dev) (BSD-3-Clause) is vendored for card templates.

## License

[MIT](LICENSE) © 2026 David Page.
