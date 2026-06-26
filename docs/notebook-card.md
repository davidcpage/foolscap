# The notebook card: a reactive, in-browser, agent-legible compute surface

*Prepared 2026-06-24. Companion to `card-types-as-data.md` (the runtime-loaded template contract this rides),
`agent-sessions-on-canvas.md` (the server-owned-process / card-as-view duality the *kernel* path would reuse),
`agent-to-agent-messaging.md` (§15 channels — where coordination flows, as opposed to data), and
`shadow-git-ledger.md` (the content tier + memo cache this leans on). Decides how humans and agents spin up
temporary or persistent coding/data-analysis surfaces on the board and collaborate on them inline. The
headline: **a notebook is a reactive dataflow graph, not a REPL — cell source lives in a file (the open
Observable Notebooks 2.0 HTML format, shadow-git versioned), the card is a *view* over that file, cell
outputs are derived (off-log projections), and the dependency graph is always live while re-execution is a
per-cell policy.** This is the Observable model fitted onto the existing signia store, chosen over a Jupyter
kernel for the first cut because in-browser JS proves the genuinely-new thing — reactivity across cards —
without paying for process management. We adopt Observable's open *format* (ISC, `@observablehq/notebook-kit`)
but run cells on our own signia scheduler, not Observable's runtime (§2, §4).*

---

## 1. The reframe: a notebook is dataflow, not a REPL

The instinct is "put a Jupyter cell on the canvas." That instinct imports the wrong execution model. A REPL
(and Jupyter) is **one mutable namespace mutated in time**: cell order matters, `x = 1` in cell 3 is visible
to cell 5 only because 3 ran first, and re-running anything is fraught because state has already moved on.
That model fights reactivity — there is no safe graph to re-run, only a history to replay.

The canvas already *is* a reactive store. So the notebook should be too:

- **A cell is a pure-ish function of its named inputs**, defining named outputs. No hidden accumulating
  namespace.
- **Cells form a dependency DAG**, discovered from which names a cell reads vs defines.
- **Changing an input invalidates its dependents**, exactly as a signia read does today.

This is the **Observable notebook** model, and it is the closest proven prior art to "reactive notebook." It
resolves cycles (detect → error), cancellation (abort a superseded run), and topological dirty-invalidation
— all problems a REPL-on-canvas would have to solve from scratch and badly.

The corollary that makes the whole thing tractable: **separate dependency *tracking* from execution
*triggering*.** Most "should it be reactive?" hand-wringing conflates these. Kept apart, the cost question
(§6) dissolves: tracking is always on and cheap; *triggering* is opt-in per cell.

## 2. What this is NOT

Recorded so the detours are not re-walked:

- **Not a REPL / not a shared mutable kernel namespace.** No `x = 1` in one cell silently visible in the
  next without a declared edge. If a scratch-REPL feel is ever wanted, that is a *second, non-reactive* card
  type, not this one. (§1.)
- **Not a Python kernel — yet.** Path B (a server-owned IPython kernel reusing `ensureLiveSession`,
  `agent-sessions-on-canvas.md`) is real and deferred, *not* rejected. It slots behind the same
  execution-policy + cache interface (§6) once the dataflow semantics are settled. The first cut is
  in-browser JS because the hard new question is reactivity-across-cards, not process lifecycle.
- **Not a new reactive substrate, and *not* Observable's runtime.** The dependency graph is signia,
  read-tracked at the existing `Subscribable<T>` seam (`templates.ts` `mountTemplate` already does exactly
  this for renders). The notebook adds a *scheduler* over that seam, not a parallel reactivity engine. We
  adopt Observable's **format** (`@observablehq/notebook-kit`'s `.` export: `deserialize`/`serialize`, ISC)
  but **not its `./runtime`** — bringing in `@observablehq/runtime` would violate CLAUDE.md's "signia is the
  only borrowed substrate," and it auto-runs the whole graph, which can't express the per-cell `manual |
  debounced` policy that §6 makes the master cost lever. We need our own scheduler regardless; we borrow only
  the file format and (later) the acorn free-variable *dependency-inference* technique (§5). The parser is
  simple HTML-over-DOM, so we **vendor `deserialize`/`serialize` into `/vendor/`** (ISC permits, matches the
  `/vendor/*` convention) rather than take the heavy full package (jsdom, lezer, runtime, fonts).
- **Not "messaging between cells to set values."** Values flow through the reactive graph (import); events
  flow through channels (§5). A cell does not post a message to another cell to hand it a number — that is
  what a reactive import is for.
- **Not execution inside the card template.** Templates are pure render (lit-html + `/vendor/*` only, no
  ambient power, `card-types-as-data.md`). The runtime is a new *app subsystem*; the template only displays
  cells and outputs.

## 3. Topology: main-thread scheduler + stateless worker pool

Execution splits across two locations, dictated by where reactivity has to live:

- **Main thread = the reactive scheduler.** Owns the dependency DAG, decides what is dirty, schedules runs,
  owns the export atoms. signia lives here, so reactivity must too. New module, `app/src/notebook-runtime.ts`.
- **Worker pool = stateless cell execution.** A run is `postMessage({source, inputs})` → `{exports,
  display}`. The worker holds **no namespace between runs.**

The stateless worker is not just isolation — it *enforces* the Observable model for free. A cell physically
*cannot* carry hidden state across runs, so the DAG is necessarily the only source of truth. The thing you
give up (typing `x = 1` and using `x` next cell with no ceremony) is the thing you *want* gone for safe
re-execution.

```
notebook.html (file in tree, shadow-git)   notebook-runtime.ts (main thread)        worker pool
  <notebook><title>…</title>     ──watch──▶  deserialize → build DAG, topo-sort  ──▶  eval(source, inputs)
   <script id type=module …>             ──▶  dirty-track, own export atoms (off-log) ◀── {exports, display}
  (Observable 2.0 format)                     publish exports + display feeds
```

Trust boundary, named explicitly: in-browser-worker JS is reasonably contained (no fs; can `fetch`). A
future Path-B Python kernel runs with full machine access — but so do the `claude -p` sessions already
(`agent-sessions-on-canvas.md`), so it is the same posture already accepted, made deliberate.

## 4. State: source is a file, outputs are off-log

The notebook is **content**, and the codebase already decided where content lives: *"content lives in
files/git"* (`shadow-git-ledger.md` §2, which records that putting file edits on the intent log "was
wrong"). Cell source is code; code is content. So a notebook is **a file in the working tree, and the card
is a *view* over it — the file card's exact shape**, not a sticky note. The sticky analogy (source in
`record.text`, on the intent log) was the wrong analogy: a sticky genuinely *is* a canvas-native object with
no underlying file; a notebook full of code is content with every property the file/git tier exists to serve.

| Notebook tier | Lives in | Durable? | Precedent |
|---|---|---|---|
| Cell **source** + structure + per-cell metadata | a `.html` file (Observable 2.0 format), shadow-git versioned | yes — files/git, *not* the intent log | the file card's content/record split |
| Cell **outputs** / exports | runtime export atoms + a feed | no — derived, recomputed, cached | `fileContentSignal` off-log projection |
| The **node** (exists, position, claims, view→path) | the intent log (channel 3) | yes — gesture-shaped arrangement | every card |

**Source is a file in the Observable Notebooks 2.0 format.** We adopt the open, ISC-licensed HTML format
(`@observablehq/notebook-kit`) rather than invent JSON:

```html
<!doctype html>
<notebook>
  <title>Sales analysis</title>
  <script id="a1" type="text/markdown">
    # Q2 sales
  </script>
  <script id="a2" type="module" pinned>
    const sales = await FileAttachment("data.csv").csv({typed: true})
  </script>
  <script id="a3" type="module">
    Plot.barY(sales, {x: "month", y: "revenue"}).plot()
  </script>
</notebook>
```

Why this format earns adoption:
- **It's HTML** — human-readable, diffable, find-and-replaceable, source-control-friendly. Exactly what a
  file-backed, shadow-git-versioned artefact wants.
- **`id` per cell** gives stable cell identity across edits — what reactive editing needs.
- **Cells are vanilla JS** (Observable dropped its dialect in 2.0), with standard `import` — aligns with the
  in-browser-JS Path A.
- **Per-cell `type`** (`module`, `text/markdown`, `text/html`, `application/sql`, `text/x-python`, …) and
  flags (`pinned`, `hidden`, `output`) carry display intent; our per-cell execution *policy* (§6) rides as a
  `data-policy` attribute the format ignores and we own.
- **Open + ISC + portable** — notebooks move to/from the Observable ecosystem; we're not locked to a bespoke
  schema. The card parses with vendored `deserialize`, writes back with `serialize` (§2).

**Ecosystem — what the format buys, honestly.** Notebook Kit ships a converter
(`notebooks download https://observablehq.com/@user/nb > nb.html`) that pulls any existing observablehq.com
notebook into this format. So the legacy gallery is *reachable*: a converted notebook **parses and renders
its structure** (title, markdown, code cells as text) on our card for free — real portability and a genuine
demo surface. But **running** a gallery notebook faithfully is *not* free: Observable notebooks lean on the
**Observable Runtime + standard library** (`display`, `viewof`/`view`, `FileAttachment`, `Generators`,
`Mutable`, `Plot`/`d3` conventions, the implicit reactive cell lifecycle), and many legacy ones convert to
"Observable JS cell mode" which *requires* that runtime. On our bare signia scheduler those symbols are
undefined. So the format gives us **read/edit/port for free; live execution of arbitrary gallery notebooks
is gated on the open question in §12** (how much of Observable's runtime/stdlib, if any, we adopt — fork A
vs B). This does not block step-0, which runs only vanilla-JS cells we author.

Everything in that file inherits the content tier for free: **agents edit it with normal `Edit`/`Write`
tools** (no bespoke `setCell` bus command — the watcher → `fileContentSignal` → re-parse → re-run loop just
fires), **shadow git versions every edit** with per-actor attribution and `git revert` undo
(`shadow-git-ledger.md` §5–§7), and it's diffable/runnable outside the canvas. Ephemeral scratch notebooks
live in `.canvas/artefacts/`; deliverables get promoted to `notebooks/` — the temp-vs-persistent split is
just *which path you write to*, already designed in `shadow-git-ledger.md` §8 (which literally names
`notebooks/` as the promote case).

**Outputs are off-log projections.** Each cell's named exports become signia atoms keyed by name, published
the way `fileContentSignal` is — derived state, never persisted (the format stores source + display flags,
*not* computed outputs), recomputed on demand, **memoized by content hash** (§6). Other cells *and other
card types* read an export through the normal Subscribable mechanism, so a cross-card import is just a
subscription.

**The node stays on-log.** Only the canvas/arrangement facts — the card exists, its position/size, claims,
and which file path it views — are gesture-shaped channel-3 events, exactly like every other card. Source is
*not* among them.

This is the same split as session feed (`session:<id>`) vs `.jsonl`, and file content vs the shadow ledger.
Streaming console chatter stays off the durable log; the durable record of source is the file's git history,
not the intent log.

## 5. Wiring: reactive pull for data, channels for events

Two wiring styles, deliberately kept separate — they map onto the system's existing dual nature (reactive
store + channel/intent log):

- **Reactive pull for *data* dependencies.** A cell declares outputs (the names it defines) and depends on
  inputs (names it reads). The signia graph wires invalidation. This is "import state": importing `df` from
  another cell — even in another notebook card — or reading a file card's content is a subscription, and a
  file card's content is *already* a reactive projection (`fileContentSignal`) you feed in identically.
- **Push / message for *coordination and side effects*.** A cell posts to a **channel**
  (`agent-to-agent-messaging.md` §15) — "analysis done, artefact at X" — or an agent drops a cell into a
  notebook and triggers a run. Async, side-effecting, agent-shaped, and already built.

**The rule: values flow through the reactive graph; events flow through channels.** Reserve messaging for
the genuinely event-shaped (an agent dropping work in, a completion signal). Never let a cell "message"
another cell to assign it a value.

**Dependency discovery**, two stages:
- **Explicit first.** A cell's export names and inputs are declared (a `data-` attribute on the `<script>`,
  outside what the format interprets). No parser; ship in a day.
- **Inferred later (the magic).** Parse the cell's JS with acorn (`/vendor/`-able; it's already in
  notebook-kit's own dep list), find free identifiers matching names exported elsewhere → those are the
  edges. This is Observable's *native* dataflow model and what makes it feel seamless. We borrow the
  *technique*, not their runtime (§2). Add it once the explicit form proves the graph; it does not change the
  model, only the ergonomics. **This spans three scopes — see §11 step-4 for the breakdown:** (4a)
  same-notebook free-variable inference retires `data-in`/`data-out` for intra-notebook deps; (4b)
  cross-notebook moves from the step-2 `data-in="q=./nb#export"` attribute to an `import {…} from "./nb"`
  *statement in the cell*, which acorn parses — but this needs the worker to run statement blocks + `import`
  (it currently evaluates a single expression, §13), so 4b = acorn parse **+** a richer worker; (4c) a bare
  ambient `notebook1.df` with no import line is deferred (it needs card naming + accepts a hidden namespace,
  against §1/§2). The cross-card path→card resolution + export bus from step-2 are reused unchanged by 4b;
  only the authoring *syntax* moves from attribute to code.

The collaboration payoff lands here, and the file-backing sharpens it: the notebook is a real file, so an
**agent edits it with its normal `Edit`/`Write` tools** — add a cell, tweak a cell — and the watcher →
re-parse → re-run loop fires; the human edits the same cells inline in the card; both watch outputs stream.
The notebook becomes the **shared artefact** between human and agent — the stated use case — and every edit
is a shadow-git commit attributed to its actor (`shadow-git-ledger.md` §5), so provenance and agent-legibility
come from the file's history, not a bespoke log.

## 6. Cost: tracking is free, triggering is policy

Because triggering is decoupled from tracking (§1), the cost levers are concrete and orthogonal:

- **Per-cell execution policy: `auto | debounced(ms) | manual`.** Cheap pure cells default `auto`; a cell
  that hits the network, is heavy, or runs long defaults `manual` and shows a "stale — inputs changed" badge
  with a run button. *This is the master cost lever* — nothing expensive auto-runs unless asked.
- **Dirty-only, topological.** Re-run only cells whose inputs actually changed; signia's fine-grained
  invalidation gives this directly.
- **Content-addressed memoization.** Cache output keyed by `hash(source) + hash(input values)`; skip the run
  on a hit. A huge lever, and it dovetails with the **shadow-git ledger** (`shadow-git-ledger.md` §8): cell
  outputs/artefacts can be committed into the shadow repo, making provenance and the cache one mechanism.
- **Debounce upstream edits** so typing in a source cell does not fire N runs.
- **Cancellation** of superseded runs (abort the worker job when inputs change again mid-flight; generators
  as streams, Observable-style).
- **Concurrency cap** on in-flight worker jobs (the `MAX_LIVE_SESSIONS` precedent), plus a per-actor budget
  so an agent cannot spin hundreds of re-runs.

Per the repo's truncation discipline (CLAUDE.md): when an output is capped for display, keep the **tail**
for append-only console streams, surface a `truncated` flag, and bound size at one place.

## 7. Agent-legibility of outputs (the one real new surface)

Cell *source* needs no special surface now: it's a file in the tree, so an agent reads it with `Read` and
edits it with `Edit`/`Write` like any other file (the file-backed flip, §4, dissolved the snapshot-of-source
problem). But **outputs** are off-log feeds — not in any file, not in the `/api/canvas` snapshot. For the
collaboration story an agent must read what a cell *produced*, not just its source. Two options:

- **Commit a text/JSON render of outputs as a shadow-git artefact** (e.g. alongside the notebook, or in
  `.canvas/artefacts/`) — then an agent reads outputs the same way it reads any file, and they're versioned.
  This unifies output-legibility with the §6 memo cache (`shadow-git-ledger.md` §8).
- **Add `GET /api/notebook/<id>/outputs`** — a live tail of in-flight run output, mirroring the session-feed
  precedent (`GET /api/session?id=…`), with a `truncated` flag.

**Lean: both, for different needs** — the committed artefact for durable, diffable, agent-readable results;
the endpoint for watching a run *in flight*. Either way, the durable log stays gesture-only.

## 8. Output rendering surface

A cell returns a value; the template renders it. Tiers:

- **Text / JSON / tables** — trivial in lit-html.
- **DOM / SVG** — charts, sketches. Most of the "data analysis on the board" payoff. Doable in lit-html,
  gated as a capability. This is where a JS notebook earns its place over a static artefact.

Render-by-type reuses the existing card-type template machinery (`card-types-as-data.md`) — the same
render-by-extension move the shadow-git artefact card uses (`shadow-git-ledger.md` §8). It also aligns with
the format's own **cell `type`s**: `text/markdown` and `text/html` cells are *content* cells we render
directly (not executed), while `module` cells execute and render their return value — so the same
render-by-type dispatch covers both "this cell is prose" and "this cell is a chart."

## 9. Channel-discipline check

- **Channel 1 (renderer / feeds):** cell source (`fileContentSignal` over the `.html`), cell outputs
  (export atoms), the rendered display, the stale/running badges. Derived, never persisted to the log. The
  notebook scheduler is a channel-1 consumer + producer.
- **Channel 2 (persistence / index / undo):** arrangement diffs for the node (position/size). Source edits
  do *not* ride channel 2 — they're file edits, undone via `git revert` against the shadow ledger
  (`shadow-git-ledger.md` §7), per-actor. Execution itself is a side effect, undoable only by reverting the
  source edit that caused it.
- **Channel 3 (intent log):** place/remove the card, claims, arrangement — gesture-only. **Cell source is
  *not* on the log** (it's a file; §4) — the §2 "content lives in files/git" rule holds, no new event kinds.
- **Source is the content tier (a file), outputs are a second off-log tier** — both outside the three store
  channels. Source's durable ledger is the shadow git; outputs are recomputed/cached. The scheduler sits
  over channel 1.

## 10. What already exists vs what is new

**Free inventory:**

- The card-type contract — folder + `type.yaml` (capabilities) + `render.js` (`templates.ts:461`), hot
  reload, headless template test harness (`app/test/card-templates.test.mjs`). A notebook is a new type
  folder, not registry code.
- The `Subscribable<T>` read-tracker (`templates.ts` `mountTemplate`) — the exact fine-grained reactivity
  the scheduler needs; the scheduler is a second consumer of the same seam.
- `fileContentSignal(root, path)` + the `/api/watch` stream + `fileNodeId(root, path)` — the **entire
  file-card view path**: a notebook is a file card over a `.html` file, so reading source, reacting to edits,
  and re-rendering are already built. This is what makes the file-backed flip (§4) cheap rather than
  expensive.
- The agent bus (`/api/command`: `addNode`/`removeNode`, `agentBus.ts`) — for the *node* (place/remove the
  card); **source edits need no bus command at all** — agents use `Edit`/`Write` on the file.
- Channels + inbox/ask (`agent-to-agent-messaging.md`) — the event/coordination wire (§5), already built.
- The shadow-git memo/provenance substrate (`shadow-git-ledger.md`) — versions the notebook file, attributes
  edits, and is the cache + artefact home (§4, §6, §7).
- The **Observable Notebooks 2.0 format** (`@observablehq/notebook-kit`, ISC) — the file format +
  `deserialize`/`serialize`, vendorable into `/vendor/` (§2). Open, diffable, portable; not ours to maintain.

**New:**

- The **format adapter** — vendored `deserialize`/`serialize` (`/vendor/notebook-format.js`) and a thin
  bridge from the parsed `Notebook` object to the runtime's cell list + our `data-policy` attribute (§4).
- The **notebook runtime** (`app/src/notebook-runtime.ts`) — DAG build, topo dirty-tracking, scheduler,
  per-cell policy, export atoms, worker pool, cancellation, memo cache.
- A **worker** for stateless JS cell execution (`postMessage({source, inputs})` → `{exports, display}`).
- The **notebook card type** — `app/card-types/notebook/{type.yaml, render.js}`: a file-card-style view that
  parses the `.html`, renders cells + outputs + stale/run badges, and writes edits back to the file.
- **`GET /api/notebook/<id>/outputs`** — live output tail (§7).
- A **creator + menu entry** (`loader.ts` / `App.tsx`) — writes a starter `.html` notebook to the chosen
  path and drops the card — plus styling.
- Later: acorn-based dep inference (§5), Path-B Python kernel behind the same interface (§2).

## 11. Staged path

Each step is independently useful; the runtime (step 1) is the anchor.

0. **The card shell over a file, no reactivity.** A `notebook` card type that views a `.html` file in the
   Observable 2.0 format (vendored `deserialize`), renders the cells, and writes edits back (`serialize`),
   with a per-cell "run" button that evals one `module` cell in a worker and shows its output. No DAG, no
   auto-run. Proves the format adapter + file-card view + worker + display loop end-to-end. (Reuses the
   file-card path; no `record.text` shortcut.)
1. **The reactive runtime.** DAG from explicit declared inputs/exports (`data-` attrs); export atoms as
   off-log projections; topological dirty-tracking; per-cell `auto | debounced | manual` policy;
   cancellation. Two cells where editing the upstream re-runs the downstream — the moment reactivity is real.
2. **Cross-card import + file-card inputs.** *(DONE.)* A cell reads an export from another notebook and a
   data file's content — the cross-card dataflow question, answered. **Addressing is by RELATIVE FILE PATH,
   not a name registry** (a notebook IS a file, §4 — the filesystem is already the namespace): the `data-in`
   grammar grew `name=./rel` (import a sibling notebook **as an object** of its exports, `name.df`, or a
   data file's text content) and `name=./rel#export` (one export). `.html` is inferred — an **extensionless**
   path means a notebook, any other extension (`.csv`, `.json`, …) a data file read from disk by
   `fileContentSignal` (which needn't be an open card). The runtime gained a board-wide path→card index +
   cross-card export bus; a target export change / file change re-dirties the importer per its policy, and an
   importer opened before its producer simply re-runs when the producer opens (no deadlock). General
   **card naming** (friendlier session/channel handles than the full id hash — valuable for messaging
   ergonomics) is decoupled from imports and **deferred** to a later pass; paths cover the import case.
3. **Agent-legibility + collaboration.** Agents `Read`/`Edit` the notebook file directly; outputs surfaced
   as a committed shadow-git artefact and/or `GET /api/notebook/<id>/outputs`; edits ride shadow-git
   attribution (§7).
4. **Ergonomics + reach.** acorn dependency inference (see §5 for the three tiers it spans); DOM/SVG output
   (charts); memo cache wired into the shadow-git ledger; then — separately — the Path-B Python kernel behind
   the same execution interface.

   **acorn inference, sharpened (refines the §5 "inferred later" bullet).** "Add acorn" is really three
   distinct moves at three scopes, and only the first is what acorn *alone* buys:

   - **(4a) Same-notebook inference — the core win.** Parse each cell, find its *free variables*, match them
     to names *defined* (exported) by sibling cells → that's the edge. This **eliminates `data-in`/`data-out`
     entirely** for intra-notebook deps: write `x * 2` and it auto-wires to the cell that defines `x`. The
     declarations from step-1/step-2 become an *optional override*, not the authoring surface. Unambiguous;
     this is Observable's native model and the headline ergonomic payoff.
   - **(4b) Cross-notebook via an `import` STATEMENT — the clean replacement for the `data-in` import
     grammar.** The step-2 attribute `data-in="q=./notebook1#df"` becomes a line *in the cell code* that
     acorn parses for the cross-card edge: `import {df} from "./notebook1"` (path-based, resolved exactly as
     §11.2 does today; bare-object form `import * as nb1 from "./notebook1"` → `nb1.df`). Explicit,
     path-addressed, no attribute — and how Observable itself does cross-notebook. **Dependency: the worker
     must support statements + `import`**, which it does NOT yet (step-13 worker evaluates a single
     expression; statements/top-level-await/`import` were deferred). So 4b is two pieces — the acorn
     import-statement parse **and** a richer worker (a small module-rewrite so a cell can be a statement block
     with imports, not just one expression). The runtime's path→card resolution + cross-card export bus
     (built in step-2) are reused unchanged; only the *syntax* moves from attribute to code.
   - **(4c) Bare `notebook1.df` with NO import line — deliberately NOT done here (ties to card naming).**
     For `notebook1` to be in scope as an object with no declaration, it must be an **ambient binding** — a
     board-wide registry of notebook *names* injected as globals (the general card-naming feature, parked in
     §11.2's note). This (i) reintroduces a hidden namespace, exactly what §1/§2's "explicit deps, no shared
     mutable namespace" rule protects against, and (ii) depends on naming landing. Observable deliberately
     requires the `import` line rather than ambient names for this reason. Kept as a *later opt-in* gated on
     the naming decision, not part of step-4.

   So step-4's dependency-inference target is **4a + 4b**: free-variable inference for same-notebook, and
   `import`-statement parsing (+ the richer worker) for cross-notebook. Together they retire the
   `data-in`/`data-out` attributes as the *primary* surface (keeping them as an override). 4c stays deferred.

## 12. Pin vs defer

**Protect now:**

1. **Notebook = reactive dataflow, not a REPL** (§1) — pure-ish cells, named in/out, DAG, no shared mutable
   namespace. The stateless worker enforces it.
2. **Separate tracking from triggering** (§1, §6) — graph always live; re-execution is per-cell policy. This
   is what makes cost manageable.
3. **Source is a file, outputs off-log, node on-log** (§4) — content lives in files/git (the card is a view,
   the file-card shape); derived/cached outputs; only canvas facts on the intent log. *Not* a sticky note.
4. **Adopt the Observable 2.0 format, not its runtime** (§2, §4) — borrow the open ISC HTML format +
   `deserialize`/`serialize` (vendored) and the acorn dep-inference technique; run cells on signia.
   *Open question (the ecosystem fork, §4):* this gives read/edit/port of the legacy gallery for free, but
   **not** live execution of arbitrary gallery notebooks (those need Observable's runtime + stdlib). Fork
   **A** (signia-native, doc default) vs **B** (adopt their runtime+stdlib for fidelity, bridge to signia at
   the card boundary, harder cost story) is **deliberately deferred** — step-0 is neutral to it; decide once
   the format is felt.
5. **Values through the graph, events through channels** (§5) — never message a cell to set a value.
6. **Runtime is an app subsystem, not the template** (§2, §3) — templates stay pure render.
7. **Reuse signia at the existing seam** (§2) — no parallel reactivity engine (this is *why* we decline
   `@observablehq/runtime`).

**Defer:**

- Path-B Python kernel (§2) — behind the same execution-policy + cache interface; real, not rejected.
- acorn dep inference (§5, §11 step-4) — explicit `data-` declarations / the `data-in` import grammar first;
  step-4 then does (4a) same-notebook free-var inference + (4b) cross-notebook `import` statements (which also
  needs a statement-capable worker), retiring the attributes as the primary surface. (4c) ambient
  `notebook1.df` stays deferred behind card naming.
- Whether to depend on `@observablehq/notebook-kit` vs vendor a thin own parser (§2) — start vendored;
  revisit if the format grows features we want to track.
- DOM/SVG output + the memo/shadow-git cache + committed-output artefact (§6, §7, §8) — once the graph is
  proven.
- Where notebook files live by default (`.canvas/artefacts/` vs `notebooks/`) and the board-persistence
  representation — inherits the decisions deferred in `shadow-git-ledger.md` §8.

## 13. Step-0 spec (the spike's brief)

The thinnest end-to-end slice: **a notebook card that views a `.html` file, renders its cells, and runs a
`module` cell on a button click in a worker, showing the value.** No DAG, no auto-run, no reactivity, no
imports, no cross-card anything. Goal: prove the format-adapter → file-card-view → worker → display loop on
the real engines. Fork A/B (§12.4) stays untouched — step-0 runs only vanilla-JS cells we author.

**First moves (confirm the seams against code before writing):** the build session should read the
card-type + capability wiring before coding — `app/src/templates.ts` (the capability allow-list ~`:76-94`
`CAPABILITY_SIGNALS`, per-card binding ~`:207-286`, registry/hot-reload ~`:461`), how the **file card** gets
its content + path (the `fileContent` capability keyed by node identity, and `fileNodeId(root, path)` /
`fileContentSignal(root, path)` in `loader.ts`/`content.ts`), and where `/vendor/*.js` files live (the
templates import `/vendor/lit-html.js`). Mirror the file card and the session card; do not invent new seams.

**Files:**

- `app/card-types/notebook/type.yaml` — `name: notebook`, `contract: 1`, `capabilities:` the file-content
  read (as the file card uses) + two new ones: `runCell` (action) and `cellOutputs` (signal). *Add `runCell`
  / `cellOutputs` to the host capability allow-list in `templates.ts` — they will not be granted otherwise.*
- `app/card-types/notebook/render.js` — default export `{ contract: 1, render(card) }`. Imports **only**
  `/vendor/lit-html.js` and `/vendor/notebook-format.js`. `render`: read the file content
  (`card.signals`/`card.fields`), `deserialize` it to cells, and render — `text/markdown` cells as prose
  (a minimal md render is fine; even `<pre>` for step-0), `module` cells as a source `<textarea>` + a **Run**
  button (`@click` → `card.signals.runCell(cellId, source)`) + an output `<pre>` reading
  `card.signals.cellOutputs.get()[cellId]`. On source edit (blur/change), `serialize` the cell list back and
  write it to the file via the same write path the file card uses.
- `app/public/vendor/notebook-format.js` (confirm the real `/vendor/` dir) — a **thin own** parser for the
  subset (per §12 "start vendored… or thin own"): `deserialize(html)` → `{title, cells:[{id, type, source,
  pinned}]}` via `DOMParser` over `<notebook>` → `script[id]` (trim the 4-space indent); `serialize(nb)` →
  the HTML string. **Escape `</script>` as `<\/script>`** in cell source (format requirement). Keep it ~50
  lines; swap for real `@observablehq/notebook-kit` `deserialize`/`serialize` later if wanted.
- `app/src/notebook-runtime.ts` (step-0 minimal) — a worker-backed `runCell`: create/reuse a `Worker`, post
  `{source}`, await `{ok, value, error}`, write the result into an off-log per-card output projection
  (cellId → `{status:"ok"|"error", value, error}`) that backs the `cellOutputs` signal. **No DAG.** This is
  the only place a `Worker` is created — *not* the template (keeps §2/§6 "runtime is an app subsystem").
- `app/public/notebook-worker.js` — receives `{source}`, evaluates it as an **async function body whose last
  expression is the value** (`new Function('return (async()=>{ return ('+source+') })()')` for the
  expression case; document that statement-blocks, top-level `await`, and `import` are step-1+). Returns
  `{ok:true, value}` where `value` is made structured-clone-safe (stringify non-cloneable values for now), or
  `{ok:false, error: String(e)}`. No fs, no network needed for step-0.
- `app/src/loader.ts` — `addNotebookCard(...)`: write the starter `.html` (below) to a path under the chosen
  root (default a scratch dir; the `.canvas/artefacts/` vs `notebooks/` default is deferred — pick one and
  note it), then add the node via the file-card path so the card views that file.
- `app/src/App.tsx` — a right-click/menu "Add notebook" entry calling the creator.
- `app/src/style.css` — `.node.notebook { … }` (cells stacked; source mono; output below).
- `app/test/card-templates.test.mjs` — extend: render the notebook template against a mock `card`, assert
  `contract === 1`, capabilities valid, and imports only `/vendor/*`.

**Starter notebook** (`hello.html`, Observable 2.0 format — all cells self-contained vanilla JS so they run
on a bare worker):

```html
<!doctype html>
<notebook>
  <title>Hello, notebook</title>
  <script id="a1" type="text/markdown">
    # Hello, notebook
    Step-0 demo — edit a cell and click **Run**.
  </script>
  <script id="a2" type="module">
    1 + 2
  </script>
  <script id="a3" type="module">
    Array.from({length: 5}, (_, i) => i * i)
  </script>
</notebook>
```

**Acceptance check:**

1. "Add notebook" drops a card that renders the markdown cell as prose and `a2`/`a3` as source + Run + empty
   output.
2. Run `a2` → output shows `3`; Run `a3` → output shows `[0, 1, 4, 9, 16]`.
3. Edit `a2`'s source to `2 * 21`, blur → the **`.html` file on disk changes** (`serialize` wrote back; grep
   the file). Re-run → `42`. Confirms source lives in the file, not `record.text`.
4. A bad cell (`oops(`) Runs to an error string in its output, not a crashed card.
5. `cd app && npm test` (card-template contract test) passes; `npm run typecheck` clean.

**Explicitly out of scope for step-0** (do not build): the DAG / dependency tracking, auto/debounced
re-run, cross-cell or cross-card references, `import`/`await`/Observable stdlib, DOM/SVG output, the
`/api/notebook/<id>/outputs` endpoint, acorn inference, the memo cache. Those are steps 1–4.
