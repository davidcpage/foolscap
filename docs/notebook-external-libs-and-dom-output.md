# Notebook cards: external libraries + DOM/SVG output — implementation & limitations

**Status:** shipped on `main` (Phase 1 commit `2309e85`, Phase 2 commit `f1ca959`).
**Audience:** review doc for smoothing the remaining rough edges.
**Source:** thread `node:mrc94xcb-17`; durable record in `.canvas/memory/notebook-card.md`; design in `docs/notebook-card.md`.

This documents what actually shipped for two features — (a) importing external ESM libraries (d3,
Observable Plot) in notebook cells, and (b) rendering a chart's DOM/SVG node on the card — the concrete
limitations, whether anything was lost in the DOM-output design, and a feasibility sketch for the two
improvements raised: **default imports for common libs** and **import-once-per-notebook**.

---

## 1. How library loading works today (A2)

All of it lives in one file: `app/vendor/notebook-infer.js`. The worker and runtime were left untouched.

- **Imports are rewritten, not stripped.** Historically every `import` statement was blanked out of the
  runnable source, so `d3`/`Plot` were undefined free variables. Now, when a cell has any import (which
  forces "block mode"), each *non-relative* import is rewritten into a dynamic-import **prologue** prepended
  to the cell body — e.g. `import * as d3 from "d3"` becomes `const d3 = await import("https://esm.sh/d3")`.
  All import forms are handled: namespace, named, aliased, default, default+named, default+namespace, and
  side-effect-only.
- **The import spans stay blanked in place.** The original `import …` text is overwritten with spaces but
  newlines are kept, and the prologue is emitted on a single line — so every other character keeps its byte
  offset and runtime error line numbers stay accurate.
- **One resolver, one CDN base.** `resolveSpecifierUrl(spec, base = "https://esm.sh/")` is the single
  bare→URL conversion point. A specifier with a URL scheme (`https:`, `//cdn`) passes through unchanged; a
  bare specifier (`d3`, `d3-array`, `@scope/pkg`) maps to `base + spec`. `analyzeCell` already accepts an
  `opts.cdnBase` override — this is the deliberate seam for a future import-map (see feasibility below),
  though nothing passes `opts` today.
- **Relative imports are unchanged.** `./nb`, `../x`, `/data.csv` still become cross-card dependency edges
  exactly as before; they are never routed through `import()`. A specifier is *either* a cross-card edge or
  a lib-prologue entry, never both.
- **The template contract is untouched.** CDN code loads only in the execution realm (worker or main
  thread), never in the template. `render.js` still imports only from `/vendor/`.

**Net:** a cell can `import * as d3 from "d3"` (bare) or `import {mean} from "https://esm.sh/d3-array"`
(URL) and compute with it. Verified by unit tests plus real-`import()` end-to-end tests (a `data:` URL
stubs the CDN, so no network in tests).

---

## 2. How DOM/SVG chart output works today (B2)

The core problem: cells run in **one shared, DOM-less, stateless module Web Worker**, and return values
cross a structured-clone `postMessage`. A DOM node can't be built there (no `document`) and can't survive
the clone. Observable Plot in particular needs the *real* browser layout engine (`getBBox` /
`getComputedTextLength`) to size margins and place tick labels — a layout-less DOM shim (the rejected
option B1) would mis-size those, which was the whole reason the human insisted plots must "look correct".

The shipped answer (B2) is a **second, main-thread execution realm** for chart-producing cells:

- **A main-thread twin of the worker** — `app/src/notebook-main-exec.js` — runs a cell via a scoped
  `new Function(...inputs)` with the real `document` available. It re-establishes statelessness *identically*
  to the worker (inputs injected only as named params, no shared namespace), but returns the **raw** value,
  which may be a live DOM node. It's a separate module (not an import of the worker) because the worker is a
  `/public` asset loaded by URL and importing it would fire its `self.onmessage`.
- **Hybrid, static routing.** The worker stays the *default* realm. A cell is routed to the main thread
  only if it's a "view candidate" (`domCandidate`), decided **statically** in `analyzeCell`: the cell
  imports any external (non-relative) lib, **or** it free-reads `document`/`window`. It has to be static
  because Plot throws in the DOM-less worker before any node could be observed — you can't run-then-detect.
  Markdown cells and parse failures are never view candidates.
- **A typed output variant.** `CellOutput.view = { kind: 'svg'|'html'|'dom'; node?; markup }`. `node` is
  the **live** node — browser-only, mounted directly, never serialized. `markup` is the serialized
  `outerHTML`, which is what rides the outputs relay so agents reading `/api/notebook/<id>/outputs` still
  see the chart's markup.
- **The mount seam.** `render.js` mounts the live node as a raw lit-html child inside a
  `<div class="nb-view" data-interactive @keydown=stopPropagation>` — no new template import (contract
  intact). `data-interactive` keeps a pointer-press on the chart off the canvas drag; `stopPropagation` on
  keydown stops a key typed inside a focused chart (brush/zoom) from bubbling out and deleting the card or
  switching tools.
- **Lifecycle.** A fresh node is produced per run; on re-run lit swaps the old node out (its listeners GC'd)
  — no stale node or leak. The `view` field is cleared on a realm switch, supersede, edit-to-plain, empty
  cell, or error.

**Net:** a cell returning `Plot.plot(...)` or a d3 SVG node renders correctly on the card with real layout.
Human visually confirmed a real Plot line chart (axes, ticks, margins) — "All looks right".

---

## 3. The rough edge you flagged: imports are per-cell

**Yes — a bare-import binding is cell-local, so the `import` line must be repeated in every cell that uses
the lib.** This is inherent to the current design, not an oversight:

- The rewrite operates on **one cell's source** — the `const d3 = await import(...)` prologue is prepended
  to *that* cell's function body, so `d3` is a local `const` inside that cell's scoped `new Function`.
- There is no shared namespace between cells (the stateless-worker invariant). The only cross-cell value
  channel is an explicit export atom — and an imported binding is not exported unless the cell explicitly
  defines it as a named output. So `d3` in cell 1 is invisible to cell 2.

**Important nuance:** the *network* cost is already paid only once. `import()` self-caches per realm, so
repeating `import * as d3 from "d3"` across cells re-fetches nothing. What's repeated is only the
*syntax/binding*, not the download. (There are up to two realms — worker and main thread — each with its
own module cache.) So the rough edge is purely ergonomic, not a performance problem.

---

## 4. Did we lose anything in the DOM-output implementation?

A "view" cell (routed to the main thread) is not a strict superset of a normal worker cell. The trade-offs,
all documented as known/intended:

| Aspect | Worker cell (default) | View cell (main-thread) |
|---|---|---|
| Statelessness | Enforced | **Same** — re-established identically, not relaxed |
| Blocks the UI thread | No (off-thread) | **Yes** — a heavy/long view cell freezes the UI; no timeout/abort |
| Real DOM + layout | No | **Yes** — the whole point (Plot/d3 charts) |
| Export to downstream cells | Structured-clone-safe value | If the value is a **DOM Node**, the export **degrades to the markup string** (a node can't clone into a downstream worker cell). Non-Node values behave identically. |
| Live node serialization | n/a | Live `node` is browser-only, **never serialized**; only `markup` rides the relay |
| Crash recovery | A worker crash respawns and fails in-flight jobs | No separate process to crash; errors are caught to a string |

So, concretely, the three things a view cell gives up versus a worker cell:

1. **It runs on the UI thread** — a slow chart cell can jank the app. Mitigated by routing *only* view
   candidates to the main thread; pure compute stays in the worker.
2. **A node export degrades to a string** — if a view cell is also consumed by a downstream cell, the
   downstream cell receives the chart's markup string, not a live node. (Matches the pre-existing
   "non-clone-safe value → string" rule.)
3. **Over-routing** — a pure-compute cell that merely *imports* a lib (e.g. `d3.max`) is routed to the main
   thread even though it returns a plain value. Harmless (it takes the normal text path), but it does run on
   the UI thread unnecessarily.

Nothing else was lost: statelessness, the DAG, agent-legibility (via `markup`), and the worker itself are
all intact. The worker was not modified.

---

## 5. Feasibility of the two improvements you raised

### (i) Default / ambient imports for common libs (d3, Plot, …)

Idea: preload common libs so a user never writes an import line — they're just always-available cell
inputs (this is design option "A1").

What it would touch:
- **Input assembly** in `notebook-runtime.ts` `startRun` — seed `inputs` with the ambient libs before the
  execution call, for cells that don't already bind those names. Both realm entry points already inject
  inputs as named params, so the execution wrappers themselves don't change.
- **BUT the preloaded value must be transportable to the worker.** A module namespace full of functions
  won't cleanly survive the worker's clone/rehydrate boundary. Realistically each realm would need to
  `await import()` the ambient lib itself (an ambient list consulted at both worker and main-exec entry) —
  i.e. an eager prologue rather than a passed-in value.
- **Inference must exclude ambient names** from the `domCandidate` trigger and from free-variable/producer
  matching — otherwise every cell touching `d3` would route to the main thread, and `d3` might be mistaken
  for a sibling cell's export.

Costs: **worker/realm bloat** (every realm eagerly loads d3+Plot even for cells that never use them);
**version pinning** (an ambient `d3` fixes one version globally, versus per-cell `import "d3@7"`); and it
reintroduces a hidden namespace, which the design has deliberately resisted. Recorded as deferred in the
design doc, gated behind general card-naming.

**Assessment:** feasible and high-value ergonomically, but not free — the transport constraint pushes toward
an eager per-realm import rather than a simple injected value, and the inference exclusions are a required
part of the work, not an afterthought. A pragmatic middle ground worth considering: a small, opt-in ambient
set (just `d3` + `Plot`) loaded lazily on first reference rather than eagerly for every cell.

### (ii) Import-once-per-notebook (shared binding across cells)

Idea: write the import once, share the binding everywhere in the notebook.

Two distinct things are bundled in "import once":
- **Import once (network/version):** already largely solved. `import()` self-caches per realm, so the
  *download* happens once regardless. The remaining piece is version consistency, which is exactly what the
  **A3 import-map seam** (`resolveSpecifierUrl` + the already-plumbed `analyzeCell` `opts.cdnBase`) is for:
  a notebook-level map pins which URL each bare specifier resolves to across all cells. Wiring this is
  relatively contained — thread `opts` from `computeEffective` into `analyzeCell` and surface a
  notebook-level map. **This is the cheaper, lower-risk win.**
- **Import once (syntax/binding):** the genuinely hard part — sharing the *binding* so cell 2 sees cell 1's
  `d3` without its own import line. This needs either (a) the ambient-input machinery from (i), or (b)
  treating a lib import as a cross-cell *export* (a producer other cells read). Option (b) touches the graph
  builder and runs into the same transport problem — a live module namespace can't cleanly cross the
  worker `postMessage` boundary, so a downstream worker cell would likely have to re-`import()` anyway.

**Assessment:** I'd recommend splitting this. The **import-map (version pinning across cells)** is a clean,
self-contained improvement using an existing seam. The **shared-binding ergonomic** is better delivered via
the ambient-imports work in (i) than via cross-cell export plumbing, because the transport constraint makes
the export route fragile.

---

## 6. Recommendation summary

If we pursue the rough-edge smoothing, a sensible ordering (lowest risk / highest value first):

1. **Notebook-level import map (A3).** Uses the existing `resolveSpecifierUrl` / `opts.cdnBase` seam;
   pins lib versions once per notebook; contained change. Solves "import once" in the network/version sense.
2. **Opt-in ambient imports for d3 + Plot.** The biggest ergonomic win (no import line for the common case).
   Non-trivial: needs a per-realm eager/lazy import path and inference exclusions. Best done as a small,
   fixed, opt-in set rather than an open ambient namespace.
3. **(Deferred) cross-cell live-binding sharing** — lower priority; the transport constraint makes it
   fragile and (2) covers most of the ergonomic need.

None of the above is committed work — this doc is for your review to decide what (if anything) to staff as
a follow-up thread.
