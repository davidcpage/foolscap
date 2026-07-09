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
| Blocks the UI thread | No (off-thread) | **Yes** — a view cell runs on the UI thread; a synchronous runaway still freezes it (unpreemptable). Guarded by the consent gate + async time budget in §5 (Fix A), not eliminated. |
| Real DOM + layout | No | **Yes** — the whole point (Plot/d3 charts) |
| Export to downstream cells | Structured-clone-safe value | If the value is a **DOM Node**, the export **degrades to the markup string** (a node can't clone into a downstream worker cell). Non-Node values behave identically. |
| Live node serialization | n/a | Live `node` is browser-only, **never serialized**; only `markup` rides the relay |
| Crash recovery | A worker crash respawns and fails in-flight jobs | No separate process to crash; errors are caught to a string |

So, concretely, the three things a view cell gives up versus a worker cell:

1. **It runs on the UI thread** — a slow chart cell can jank the app, and a *synchronous* runaway (`while
   (true){}`) freezes it outright with no in-realm interrupt. Mitigated (not eliminated) by §5's trust
   boundary: a view cell no longer auto-runs on open — it needs one-time notebook consent — and an *async*
   overrun hits a time budget. The sync-loop freeze is the residual limit consent is designed around.
2. **A node export degrades to a string** — if a view cell is also consumed by a downstream cell, the
   downstream cell receives the chart's markup string, not a live node. (Matches the pre-existing
   "non-clone-safe value → string" rule.)
3. **Over-routing** — a pure-compute cell that merely *imports* a lib (e.g. `d3.max`) is routed to the main
   thread even though it returns a plain value. Harmless (it takes the normal text path), but it does run on
   the UI thread unnecessarily.

Nothing else was lost: statelessness, the DAG, agent-legibility (via `markup`), and the worker itself are
all intact. The worker was not modified.

---

## 5. The main-thread trust boundary and its guard (Fix A, 2026-07-09)

> Shipped in thread `node:mrdj7o3s-9`, closing the two HIGH-severity gaps a pre-push review found in the
> main-thread realm. This section is the durable statement of the boundary; §4 above is the trade-off it
> guards.

**The boundary.** A `domCandidate` cell runs on the **main thread with full page authority** — the real
`document`, `window`, IndexedDB, `localStorage`, cookies, and credentialed same-origin `fetch`. That is a
genuine privilege escalation over the worker realm (which has none of these), and it is decided
**statically** by `analyzeCell`: a cell earns it merely by importing an external lib (`Plot`/`d3`) or
free-reading `document`/`window` (`notebook-infer.js`, `domCandidate`). Two things made that escalation
dangerous as originally shipped:

1. **It could hang the whole app.** Main-thread code is synchronous UI-thread code; a `while(true){}` or a
   heavy sync compute freezes the tab with no recovery. **There is no in-realm fix for this** — JavaScript
   has no preemption, so a synchronous loop cannot be interrupted from the thread it runs on. A watchdog
   timer, an `AbortController`, even tearing down a same-origin iframe all require the event loop to turn,
   which the loop is monopolising. The only substrate where arbitrary user compute is truly interruptible is
   a *separate thread* (the Worker, via `terminate()`), and the whole reason this realm exists is that the
   worker lacks the real layout engine Plot needs. So the honest guard is **not auto-running untrusted
   compute here**, not a fictional watchdog.
2. **It escalated silently, on open.** Routing was automatic and cells auto-ran under the default `auto`
   policy — so opening a board with a notebook that imported `d3` handed that notebook full page authority
   with no gate, the instant the card rendered.

**The guard (a single consent gate + an async budget + this doc).**

- **Consent gate.** A `domCandidate` cell does **not run** — not on open, not on a manual Run (the gate is a
  security boundary, not a policy the Run button overrides) — unless the notebook carries explicit consent:
  the attribute **`data-main-realm="allow"`** on its `<notebook>` element. Until then the scheduler parks the
  cell unrun and the card shows a one-time **"Allow page access"** affordance (`render.js`), which writes the
  attribute to the file. One grant covers the whole notebook. Parsed/serialized by `notebook-format.js`,
  threaded through `syncCells` as `mainRealmAllowed`, enforced at the single chokepoint in
  `notebook-runtime.ts` `startRun`. This closes **both** gaps at once: no auto-run-on-open hang, and no
  silent privilege grant.
- **Durable + doc-declarable, not an ephemeral click.** Consent lives in the *file*, so it survives reload
  and is legible in the source — and a **headless/agent author pre-grants** by writing the attribute
  directly, no human click required (important: an agent-opened notebook can be trusted in the record
  without a person present). Toggling it re-syncs (it is in the runtime's spec signature) and re-dirties the
  gated cells, so a grant runs them and a revoke re-parks them.
- **Async time budget.** For runs that *do* yield, a wall-clock budget (`MAIN_THREAD_BUDGET_MS`, 10 s) races
  the run and abandons a never-settling `await` / cooperative-yield loop, surfacing a **"time budget
  exceeded"** error instead of a cell wedged `running` forever (`notebook-main-exec.js`). **Honest limit,
  stated in the error text and here:** this catches *async* overruns only — a purely synchronous infinite
  loop never returns control to the event loop for the timer to fire, which is exactly why the consent gate,
  not the budget, is the primary guard against a hang.

**Deliberately deferred (a good follow-up, not this fix):**

- **A sandboxed null-origin iframe** for the DOM realm would be a *real* privilege drop (no parent cookies /
  IndexedDB / credentialed fetch), not just consent. But a same-origin-null iframe shares the parent event
  loop, so it does **not** solve the hang, and handing a live node back across the frame boundary loses the
  direct-mount fidelity. Worth a dedicated thread as defense-in-depth on top of consent.
- **A terminable worker timeout.** Worker cells also lack a timeout today, but a worker *is* terminable, so a
  `timeout → terminate → respawn` there would be a true interrupt (unlike the main thread). Out of scope for
  the main-thread realm; noted as a candidate.

---

## 6. Feasibility of the two improvements you raised

> **Update after review (2026-07-09):** both of the ideas below collapse into a single, cleaner mechanism —
> **parse-time reference resolution against a notebook-level import map (with defaults)** — suggested in
> review. This section is rewritten around that approach; the earlier "inject a preloaded value" framing is
> kept only as the *rejected* alternative, since it's what runs into the worker-transport wall.

### The unifying approach: resolve references at parse time, synthesize the import

Instead of injecting a preloaded lib *value* into each cell, resolve a bare reference (`d3`, `Plot`) at
parse/analyze time and **synthesize the import statement** into the cell body — reusing the exact mechanism
A2 already ships:

- `analyzeCell` already computes each cell's **free reads** (undeclared variables); today a free read is
  either matched to a sibling cell's export (becomes a cross-card edge) or left unresolved.
- Add a third resolution: a free read that is *not* a sibling export and *is* in the notebook's import
  map / default set → synthesize a prologue entry `const d3 = await import("https://esm.sh/d3")`, reusing
  the existing `resolveSpecifierUrl` + `buildLibPrologue`. **No value crosses `postMessage`** — the
  `import()` runs inside the cell realm exactly like a hand-typed import and self-caches per realm, so the
  network cost is still paid once.

This single mechanism satisfies **both** of the original asks at once: a notebook-level import map (seeded
with a default d3/Plot/… set) supplies the name→URL table, and parse-time resolution means the user never
types an import line in *any* cell — so "default imports for common libs" and "import once per notebook"
are the same feature.

**Where it lives.** The synthesis belongs in `computeEffective` (`notebook-runtime.ts`, the read→producer
step), not in the pure per-cell `analyzeCell`, because only that layer knows both the sibling exports and
the notebook import map. `analyzeCell` hands it the free-reads set; `computeEffective` applies precedence:
**local binding > sibling export > ambient/import-map**. The `opts.cdnBase` hook on `analyzeCell` is the
already-plumbed seam for the map (nothing passes `opts` today, so wiring it is the first step).

**Caveats to decide up front (all small):**
- **Precedence** — a sibling cell that exports `d3` must win over the ambient `d3`, or you'd shadow the
  user's own data (order above).
- **Magic vs explicit** — auto-importing from a bare reference means a typo that happens to match a map
  entry silently imports instead of erroring. Argues for a deliberate, *smallish* default map, not
  "resolve any unknown name."
- **Routing unchanged** — an ambient `d3` read still marks the cell a view-candidate (routes main-thread);
  a pure `d3.max` cell over-routes harmlessly, same as today.

### The rejected alternative (why not "inject a value")

The naive form of "default imports" (design option A1) is to seed `inputs` in `startRun` with a preloaded
lib *value*. This hits a wall: a module namespace full of functions won't cleanly survive the worker's
clone/rehydrate boundary — a live value can't cross `postMessage`. You'd end up making each realm
`await import()` the lib anyway, i.e. reinventing the parse-time synthesis above but with extra machinery.
The parse-time approach is strictly better because it never tries to transport a value.

---

## 7. Recommendation summary

The two ideas are one feature. Suggested ordering:

1. **Notebook-level import map, wired through `opts.cdnBase`.** The foundation — a per-notebook name→URL
   table (with sensible d3/Plot/… defaults), threaded from `computeEffective` into `analyzeCell`. Contained
   change; also pins lib versions consistently across cells.
2. **Parse-time reference resolution on top of it.** Resolve free reads against the map and synthesize the
   import prologue (precedence: local > sibling export > map). This is what removes the per-cell import
   line entirely — the whole ergonomic win — and it reuses the shipped A2 rewrite path rather than adding a
   value-transport mechanism.

Deferred / not needed: cross-cell *live-binding* sharing via the export DAG — the parse-time approach
covers the ergonomic need without the transport fragility.

None of the above is committed work — this doc is for your review to decide what (if anything) to staff as
a follow-up thread.
