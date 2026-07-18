# Card types

A **card type** is the interior of a card on the canvas, shipped as data in a folder rather than code
in the renderer. The host (React, `app/src/NodeView.tsx`) owns the *box* — position, size, z, selection
ring, the `c-<color>` theme class — and a card type owns only what goes *inside* it. This is the
"card-types-as-data" contract; the rationale is in `docs/card-types-as-data.md`, the rules
are enforced by `app/test/card-templates.test.mjs`, and the host that loads them is `app/src/templates.ts`.

This README is the procedure. Read it before adding a type; you shouldn't need to sweep the codebase.

## Anatomy

A type is a folder under `app/card-types/<type>/` with exactly two files:

```
card-types/<type>/
  type.yaml     # name, contract version, and the capabilities the interior may use
  render.js     # the interior, an ES module loaded live by the browser
```

The dev server (`app/vite-fs-plugin.ts`) discovers every folder here and serves it; `templates.ts`
imports each `render.js` at runtime (with a cache-busting query, so editing it live-updates the card).
Nothing is registered in code — dropping the folder in is the registration.

### `type.yaml`

```yaml
name: <type>
contract: 1
capabilities: [capA, capB]   # omit or [] for a pure read-only card
```

Parsed by a deliberately minimal flat-YAML reader (`parseTypeYaml` in `templates.ts`): `key: value`
lines and one inline list. No nesting — if a type ever needs more, that parser becomes the place to grow.

### `render.js`

```js
import { html } from "/vendor/lit-html.js";   // the ONLY import a template may make

export default {
  contract: 1,
  render(card) {
    return html`<div class="note-body">${card.fields.text}</div>`;
  },
  // dispose() {}   // optional: cleanup on unmount
};
```

The import rule is hard: a template may import **only** `/vendor/lit-html.js`. The contract test greps
for this. No reaching into `core`, `interaction`, the store, or the editor — a template's whole world is
the `card` object it's handed.

## The `card` object (the contract surface)

`render(card)` receives exactly:

```ts
card.fields   // { title, text, color } — the node record's content
card.signals  // only the capabilities this type's type.yaml declared
```

**Reading is subscribing.** Touching `card.fields.text` or `card.signals.now` *inside* `render` is what
subscribes the card to that source; when it changes, only this one interior re-renders (the host's box
doesn't, and a drag re-renders the box but not the interior). Don't cache reads outside `render` — that
breaks the subscription. Dependencies are re-collected every render, so conditional reads track correctly.

## Capabilities

A capability is a named power a type requests in `type.yaml` and receives on `card.signals`. They are
**granted, never ambient** — the only ones a type gets are the ones it named, and the only ones it *can*
name are whitelisted in `templates.ts`. To add a brand-new capability you edit `buildCard` /
`CAPABILITY_SIGNALS` there; that's the single chokepoint by design.

Current capabilities:

| Capability | Shape | What it is |
|---|---|---|
| `now` | signal | off-log clock tick (`nowSignal`) |
| `githead`, `hn`, `usage` | signal | off-log feeds (`feeds.ts`) — external data, never on the canvas log |
| `dataFeed` | callable | generic off-log feed read, keyed by a `data:*` name — `dataFeed("data:git-log")`; refuses any non-`data:*` name (the git-log card) |
| `dataFeedHistory` | callable | a `data:*` feed's FULL-history disk mirror (`.canvas/feeds/<name>.json`), parsed + live via the file-watch — `dataFeedHistory("data:git-stats")`; the companion to `dataFeed`'s bounded tail (the git-stats card) |
| `session` | per-card signal | this card's live transcript tail, keyed by its title |
| `sessionInput`, `sessionResume` | per-card action | POST into this card's live session (session-internal, not the canvas log) |
| `setText`, `setTitle` | per-card **write** action | commit an edit to this card's own record |

**Read vs write.** Signals are read-only inputs. The `set*` capabilities are the write surface: each is a
bound function scoped to *this card's* id and *one* command, e.g. `card.signals.setText(value)` →
`editor.commit({ type: "setText", actor: "user", payload: { id, text } })`. So an edit lands on the
intent log, undoable and provenance-tagged, and the template never sees the editor or the id. The
matching commands (`setText`, `setTitle`, `setColor`, …) already exist in `core/src/commands.ts`.

To grant a write capability to a type, add its name to `capabilities` in `type.yaml` **and** make sure
`buildCard` in `templates.ts` knows how to mint it (the `set*` branch maps the capability name to its
command payload key).

## Worked examples

- **`note/`** — the minimum: pure fields, `capabilities: []`. Renders `card.fields.title`/`text`,
  read-only.
- **`clock/`** — one signal: `capabilities: [now]`, body reads `card.signals.now`, re-renders on the tick,
  commits nothing.
- **`sticky/`** — the write card: `capabilities: [setTitle, setText]`, an editable title + body that
  commit on blur. The reference for any interactive type.
- **`session/`** — the full duplex: a live feed (`session`) plus actions (`sessionInput`,
  `sessionResume`), with a real jsonl→turns codec. The reference for live + interactive.
- **`git-log/`** — a generic DATA-FEED timeline: its title is a `data:*` feed name read through the
  `dataFeed` callable + `setTitle`. Default title `data:git-log` (the board repo's commit log, published
  server-side under the `data:*` namespace) renders commit rows; retitle it to any other `data:*` feed
  (e.g. one an agent publishes via `POST /api/feed/data:demo`) to watch that stream. The reference for the
  generic feed capability.
- **`git-stats/`** — a live code-growth + churn VISUALIZATION: its title is a `data:*` feed name read through
  the `dataFeedHistory` callable + `setTitle`. Default title `data:git-stats` (the board repo's per-file/
  per-commit stats, derived server-side by `startGitStatsFeed` and written FULL-history to
  `.canvas/feeds/data-git-stats.json`) renders a hand-rolled SVG stacked-area LOC-growth chart (by top-level
  directory) + a top-file churn bar list. The reference for the full-history feed capability and for a chart
  card drawn with lit-html alone (no vendored chart lib).

## Interacting inside a card

The host contains native events over interactive elements so the canvas doesn't hijack them
(`NodeView.tsx`, the interior-interaction seam): a `pointerdown` on a `summary`, `a`, `button`, `input`,
`textarea`, or any `[data-interactive]` element focuses/clicks natively instead of starting a card drag,
and a `wheel` over a scrollable region scrolls it instead of zooming the canvas. So inputs, buttons, and
disclosures "just work" — but a keystroke in a focused input still bubbles to the canvas shortcut handler,
so call `e.stopPropagation()` in your `@keydown` (otherwise Backspace deletes the card, `v`/`h` switch
tools). See `sticky/render.js` and `session/render.js`.

## Checklist for a new type

1. `card-types/<type>/type.yaml` + `render.js` (default export with `render`, lit-html import only).
2. If it writes, declare the `set*` capability and teach `buildCard` its payload key.
3. A creator in `app/src/loader.ts` (`addX(m)`) — use `spawnAt(m, w, h)` so the card lands in the
   current viewport — and an entry in the right-click add menu in `app/src/App.tsx`.
4. `.node.<type>` styling in `app/src/style.css`.
5. A headless render test in `app/test/card-templates.test.mjs` (assert your fields/capabilities render).
6. `cd app && npm test && npm run typecheck`.
