# Card Types as Data — templates, plugins, and the rendering seam

*Prepared 2026-06-10. A direction note, companion to
`architecture-review-2026-06-09.md` (§9.3). Captures the current thinking on card-type
extensibility: what survives of [research-notebook](https://github.com/davidcpage/research-notebook)'s `template.yaml` once its rendering is left
behind, what TiddlyWiki's "everything is a tiddler" teaches and where it went wrong, and the
architecture we're circling — card types as runtime-loaded data + code in the canvas folder,
behind a capability-scoped contract. Ends with the costs we are consciously accepting, pin vs.
defer, and the smallest experiment.*

---

## 1. The question

Two admired prior systems offer extensibility without forking the core:

- **research-notebook**: card types as `template.yaml` modules (schema + layout + editor fields +
  extension registry), with a per-notebook override layer (`.notebook/card-types/`).
- **TiddlyWiki**: full homoiconicity — content, templates, stylesheets, config, and the UI itself
  are all tiddlers; you personalise the app by editing tiddlers *in* the app. Its computed
  tiddlers dynamically build the interface — a reactive core avant la lettre.

The canvas wants that property: define and personalise card rendering inside the system, in the
system's own data model, without forking either renderer. The question is what to import and what
to refuse.

A forcing observation from the spike: `app/src/NodeView.tsx` is already a 260-line,
seven-way hardcoded type switch (clock, githead, hn, computed, provenance, note, file), and two
of those views (`ComputedView`, `ProvenanceView`) receive the whole `InteractionManager` and
query the store directly. Every new card type today means editing renderer source, twice (React
and Solid mirrors), with unbounded store access. The pressure for a type seam is not
hypothetical.

## 2. TiddlyWiki decomposed — four failures, one strength

The strength: **the extension surface lives inside the system's own data model.** No fork, no
build, no plugin SDK distinct from the content model. That is what we want.

The failures, decomposed so we can refuse them individually:

1. **Language invention.** In 2011 there was no embeddable, reactive, runtime-loadable HTML
   language, so TiddlyWiki invented wikitext widgets/macros. The forcing function is gone:
   tagged template literals (lit-html, `solid-js/html`, htm) are real JavaScript, declarative,
   compiler-free, runtime-loadable as ES modules.
2. **Interpreter lock-in.** Rendering-as-data makes the renderer an interpreter for the template
   language, forever — TiddlyWiki can never leave its widget tree. The lesson is not "don't put
   rendering in data" but **choose an evaluation model whose lock-in you can live with**. If the
   model is "ES module exporting a render function against the DOM," the lock-in is to the web
   platform, not to an invention of ours.
3. **Coarse refresh.** Wikitext templates can read anything, so the refresh cycle must
   conservatively re-render on broad change sets. Signals fix this automatically: a template that
   reads `card.fields.title` through a signia handle gets fine-grained dependency tracking
   without declaring anything. We can deliver TiddlyWiki's model better than TiddlyWiki does.
4. **Ambient authority.** A tiddler template has `$tw` — the whole store, read/write. No way to
   say "this template may read these fields and commit nothing." A correctness hole now, a
   security hole when agents author templates.

Research-notebook's `template.yaml`, stripped of its layouts/editor-config/CSS (which presuppose
its app), reduces to two durable things: the **codec** (extension registry: `.md` →
yaml-frontmatter → `bodyField`) and the **schema** (fields + types, what `nb schema` returns).
Its headline "zero code per type" dies in a world with renderers-as-code; what survives is the
placement: **type definitions are data in the store, not code in the app.**

## 3. The architecture

A card type is a folder entry, resolved through layers (§5):

```
card-types/{type}/
├── type.yaml     # codec (file-extension → parser → field mapping) + schema (fields, types)
└── render.js     # ES module: the card's interior, in a standard language
```

- **Loaded at runtime** via `import()` — no build step (matches the repo's ethos), live-editable,
  versioned in git, diffable, authorable by agents through the same commit pipeline as any
  content. A template edit is an authored act: it coalesces into a commit referenced by a log
  entry, so *rendering changes are provenance-stamped and undoable* via the same git-restore
  dispatch as content.
- **The host owns space; the template owns the interior of the rectangle.** Templates never see
  x/y/w/h/z, camera, selection, or the spatial index. This is the disjoint-state invariant a
  third time (space in log / content in files / space in host / interior in template), and it
  protects the 60fps edge: the drag hot path renders the box in the host; templates re-render
  only on content/derived changes.
- **Capability-scoped contract.** A template receives only what is passed in — channel-1 pull
  handles for its fields and wired inputs, and (for types that edit) the validated `commit`
  surface. Never the store, never the editor. The capability boundary and the channel-discipline
  boundary are the same boundary. The spike enumerates the capabilities real types actually
  need: node fields, off-log feed signals (`feedSignal`, `nowSignal`), edge-resolved inputs
  (the computed card's wiring query), and a read-only log view (the provenance card). That list
  is the contract's v1 surface, derived from working code rather than speculation.

```js
// card-types/weather/render.js — illustrative
import { html } from "/vendor/lit-html.js";

export default {
  render(card) {
    // reads are channel-1 pull handles; reading inside render auto-tracks deps
    return html`<div class="wx">${card.fields.location} — ${card.inputs.temp}°</div>`;
  },
};
```

- **lit-html as the native path** (vendored, pinned — vendoring is the no-build-step way and
  freezes the contract's substrate). The host wraps `render` in a signia reactor: signal read →
  tracked → fine-grained re-render, lit-html diffs template parts. *Note on borrowing policy:
  the "signia is the only borrowed substrate" convention is about what we take from tldraw
  (restrictive license); permissively-licensed modular code (lit-html is BSD-3) is welcome.*
- **The vendored substrate is `/vendor/*`, not just lit-html.** The capability boundary is "a
  template imports from `/vendor/` and nothing else" — not core, not interaction, not the shell,
  and no relative reach into a sibling card type. lit-html was the only member for a while, but a
  shared *pure-rendering codec* belongs there too: it couples to nothing but lit-html, so two
  templates can share it without learning about each other. First instance is the **markdown
  codec** (`vendor/markdown.js`, exporting `renderMd`) — a markdown→lit pass where every leaf is
  an escaped text binding (no `unsafeHTML`). It started inline in the session card's turn renderer;
  when `.md` file cards also needed prose it was lifted to `/vendor/` rather than duplicated. The
  headless import-graph test enforces `/vendor/`-only (it was once a literal `["/vendor/lit-html.js"]`
  equality). A shared codec is NOT a place for host capabilities or engine access — that line is
  unchanged; it is only for substrate-pure helpers a template could have inlined.
- **Web components as the import door, not the only door.** The render-function path is the
  low-ceremony native route; a type may instead declare a custom element to mount, which is how
  a whole ecosystem of existing rendered widgets becomes importable. Two tiers, because CE-only
  would tax simple types with ceremony, and shadow DOM fights folder-level theming.
- **HTML-only declarative templates and HTMX were considered and refused**: logic-less templates
  grow conditionals → loops → expressions and re-invent wikitext (the Helm/Jinja death spiral);
  HTMX's request/response model has nothing to attach to in a local-first signals substrate.
  JSX is refused for templates specifically because it needs compilation, which kills
  "agent edits a file, card updates live."

## 4. Sharing vs. personalisation — the layering answer

The tension (seen live in research-notebook: individual notebooks accrete render functionality
that belonged in the core) is universal — Emacs configs vs. MELPA, TiddlyWiki tiddlers vs. its
plugin library, Obsidian snippets vs. community plugins. No mechanism dissolves it; the systems
that cope converge on three things:

1. **A resolution chain**: builtin → shared/user-level → per-canvas, nearest wins (research-
   notebook's deep-merge override, generalised one layer up). Personalisation is a local
   override; the default home for a good type is a shared layer.
2. **Promotion as a cheap, deliberate act.** Because a conforming template consumes *only* the
   contract — no canvas-specific paths, no ambient store — promoting it is literally `git mv`
   up a layer. **The capability contract is also the portability guarantee.** Research-
   notebook's real failure wasn't a missing override layer; it was that types could quietly
   depend on notebook context, making promotion a porting job nobody did.
3. **Namespaced type identity** (`core/note` vs `local/wx`), so divergence is explicit and two
   canvases' divergent `paper` types collide loudly rather than silently.

Honest residual: layering does not prevent divergent forks of a shared type; only versioning and
habit do. Accepted.

## 5. Costs we are consciously accepting (the critical pass)

1. **Lock-in moves; it doesn't vanish.** The template contract becomes forever-API — TiddlyWiki's
   failure #2 reduced, not eliminated. Mitigation: brutally minimal v1 (`render(card)` returning
   a lit-html template, plus dispose), a contract version field in `type.yaml`, vendored pinned
   substrate. Every future addition (editing affordances, focus/keyboard, intrinsic size,
   transclusion, async) is permanent — heavyweight needs route to web components / iframes
   rather than widening the core contract.
2. **Runtime `import()` sharp edges.** Module cache vs. live template edits (cache-busting query
   params); modules can't be unloaded (trivial leak per edit-reload); relative imports inside
   template modules need path discipline; serving the data folder couples "open a canvas" to a
   local server (already true — the vite fs-plugin — and the same constraint research-notebook
   accepts).
3. **The folder becomes code.** Anyone (or any agent) who can write the folder can execute JS in
   every collaborator's browser. Fine local-only solo; a real decision before shared canvases.
   The capability contract is what keeps the future cheap: trusted layers run natively,
   untrusted per-canvas types can graduate to iframe sandboxes (which the DOM-per-shape renderer
   bought cheaply — review §9.4) without changing the contract.
4. **Schema/template drift vs. persistent card files.** Templates evolve; card files outlive
   them. Render leniently (unknown fields ignored, missing fields placeholder), version schemas,
   never hard-fail a card.
5. **Losing the dual-renderer guard.** With card interiors in portable templates, the React and
   Solid apps shrink to spatial shells (camera, box, selection chrome, interaction binding) —
   and the honest move is to declare the Solid renderer spike's architecture check **passed** (it
   proved the `Subscribable<T>` seam) and collapse to one shell. The risk is shell-coupling creeping into
   the contract with no second shell to catch it. The replacement guard is cheaper than a second
   renderer: a **headless contract test** — render every template against a mock `card`
   capability object in node, no shell at all. If it passes headless, it isn't shell-coupled.
6. **Per-card template re-renders are coarser than per-binding.** lit-html part-diffing within a
   card is plenty at hundreds of cards; the drag hot path is untouched by construction. The
   clock remains the stress test: a tick must re-render one card's interior and commit nothing.

## 6. Pin vs. defer

**Protect now:**
1. **Host owns space; templates own the interior.** Templates never see layout, camera,
   selection, or the spatial index.
2. **Capability-passing, never ambient.** A template receives handles and (optionally) the
   validated commit surface; it can import nothing from the shell or core. One boundary serves
   channel discipline, portability/promotion, and future sandboxing.
3. **Type definitions are authored content.** They live in the folder, ride the same
   commit → log-entry pipeline, and are therefore provenance-stamped and undoable like any
   content edit.
4. **A standard language.** Template logic is real JS (tagged-template HTML); no bespoke
   template language, ever — refuse the first conditional in any declarative layer.

**Defer:** exact contract surface beyond the spike-derived v1 capability list; web-component
tier details; the sharing layers' physical form (user-global directory vs. git submodule vs.
copy-with-provenance); sandboxing untrusted types; what happens to in-canvas editing (any editor
is just another producer of file commits — single ingest path, no privileged in-app route, so
editors can arrive late, per type, without architectural change).

## 7. Smallest viable experiment

Extract **the clock card** from `app/src/NodeView.tsx` into a runtime-loaded
`card-types/clock/render.js` under the v1 contract (lit-html + signia reactor; `nowSignal`
passed as a capability, not imported). The clock is the house stress test — off-log signal,
ticks every second, must commit nothing. Acceptance:

1. The card renders and ticks identically; dragging stays on the host hot path (template
   re-render only on tick, never on drag).
2. Editing `render.js` on disk live-updates the card, and the edit arrives as a commit-backed
   log entry with provenance — *rendering changes are now authored acts*.
3. The template module passes the headless contract test (renders against a mock card in node).
4. `grep` proves the module imports nothing from core/interaction/shell — only the `/vendor/`
   substrate (originally just `/vendor/lit-html.js`; now any `/vendor/*` — see the vendored-substrate
   note in §3, e.g. the shared `vendor/markdown.js` prose codec).

Second card after that: the **note/file card** (exercises fields + codec instead of feeds), then
the **computed card** (exercises edge-wired inputs — the capability that replaces today's
direct `store.query` from inside a view). When all seven spike types are template modules,
`NodeView.tsx` should be ~40 lines of box + dispatch, and the question of collapsing to one
shell can be decided on evidence.

> **Status (2026-06-10): built.** `app/card-types/clock/` (type.yaml + render.js) +
> `app/src/templates.ts` (registry, capability grant, read-tracking reactor over
> `Subscribable<T>` — no signia import, the substrate stays hidden) + a `TemplateCard` host in
> `NodeView.tsx`; lit-html 3.3.3 vendored at `app/vendor/`. Acceptance: (1) box on the host
> hot path, interior re-renders per tracked read, by construction; (3) headless contract test and
> (4) import-graph grep pass via `npm test`; (2) live edit → re-import rides a `cardtypes` feed,
> and the same disk event lands on the log as a `remote` setText on render.js's own file card —
> verify (1)/(2) in the browser walkthrough. One honest delta from §3: auto-tracking comes from a
> ~15-line read-tracker at the Subscribable seam, not a signia reactor — signia can't track our
> hand-rolled off-log signals; in production, off-log signals become signia atoms behind
> `toSubscribable` and the tracker collapses into the reactor.
