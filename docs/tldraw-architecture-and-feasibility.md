# tldraw Architecture Deep Dive + Build-Our-Own Feasibility Study

*Prepared 2026-06-07. Context: evaluating foundations for a local-only, infinite-canvas
note-taking app that may grow toward rich object-linking / compute-graph behaviour
(à la tldraw-computer). Priorities: own the structural architecture, serializable state
as a design principle, ability to embed pre-canned components but swap them later.*

---

## 1. TL;DR

- **tldraw's architecture is genuinely well-designed**, and most of its good decisions are
  *patterns you can adopt without adopting tldraw itself*. The core ideas — a reactive
  signals layer, a typed serializable record store as the single source of truth, behaviour
  separated from data, an interaction state-machine, and rendering as a pure function of the
  store — are portable.
- **The single most important reframe:** the architecturally load-bearing choice is the
  **reactive store + signals core**, which is *framework-agnostic TypeScript*. The view
  framework (React/Solid/Svelte/vanilla) is a comparatively thin, swappable layer on top.
  tldraw itself reflects this: it built its own signals library (**signia**) precisely
  because React's built-in state model is too coarse for a canvas at scale.
- **Feasibility: building something architecturally similar is realistic** for the *core*
  (store, geometry, state machine, serialization) — this is mostly "principled TypeScript"
  and is where most of the value and most of the genuinely hard work live. The expensive,
  easy-to-underestimate parts are spatial indexing/culling, the interaction state machine,
  geometry/hit-testing, and migrations.
- **Recommendation:** build a **framework-agnostic reactive core** (you own this), and put a
  **thin rendering/UI adapter** on top behind an interface. For the adapter, **React is the
  safe default** (max ecosystem, max coding-agent reliability, and tldraw's own React code is
  a reference you can read), but **Solid.js is the more "principled" option** and is fully
  viable. Because the core is framework-agnostic, this choice is cheap to defer and cheap to
  change — which is exactly the property you want.
- A useful bonus: **signia is MIT-licensed** and published standalone, so you could reuse
  tldraw's actual signals engine as your reactive backbone without the SDK's restrictive
  licence. (Verify the licence on the exact package/version you adopt.)

---

## 2. tldraw architecture, layer by layer

tldraw is best understood as a stack of layers, each depending only on the ones below it.
The bottom three layers are framework-agnostic; React only appears at the top.

```
┌─────────────────────────────────────────────────────────────┐
│  UI / Chrome        toolbar, menus, panels (React)           │  replaceable
├─────────────────────────────────────────────────────────────┤
│  Rendering          shapes as React components, culling,     │  replaceable
│                     viewport transforms, fine-grained subs   │
├─────────────────────────────────────────────────────────────┤
│  Tools / Interaction   StateNode state-chart, pointer/key    │  framework-agnostic
│                        event routing, gestures               │
├─────────────────────────────────────────────────────────────┤
│  Editor             facade API: selection, camera, history,  │  framework-agnostic
│                     CRUD on shapes/bindings, batching        │
├─────────────────────────────────────────────────────────────┤
│  Domain behaviour   ShapeUtil (per shape type),              │  framework-agnostic
│                     BindingUtil (per relationship type)      │
├─────────────────────────────────────────────────────────────┤
│  Store              typed records, schema, migrations,       │  framework-agnostic
│                     queries, side-effects, history/diffs     │
├─────────────────────────────────────────────────────────────┤
│  Reactive core      signia signals: atoms, computed,         │  framework-agnostic
│                     reactions, transactions (clock-based)    │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Reactive core — signals (signia / `@tldraw/state`)

At the bottom is a signals library. Signals are the now-dominant model for fine-grained
reactivity (Solid, Svelte 5 runes, Vue, Angular all converged here by 2026). tldraw built its
own, **signia**, "to meet performance demands that other reactive signals libraries could
not."

The notable design choice is **clock-based lazy reactivity**: rather than eager dirty-flag
propagation, signia keys everything off a single global logical clock that increments on each
root-state change. This lets it cache computed values indefinitely without memory-leak risk,
and lets expensive `computed` values update **incrementally** by collecting *diffs* of their
dependencies and applying them to the previous value. For a canvas — where you constantly
re-derive "what's selected", "what's on screen", spatial indexes, etc. — incremental computed
values are a big deal.

Primitives: `atom(...)` (writable signal), `computed(...)` (derived), `react(...)` /
`EffectScheduler` (run a side-effect when dependencies change), and `transact(...)` (batch
mutations into one clock tick).

> **Takeaway for us:** this layer is the heart of the architecture and it is *pure TypeScript,
> framework-agnostic, and MIT-licensed*. We can reuse signia directly, or use Preact Signals /
> Solid's signals / any equivalent. This is not the hard part to build, but it *is* the part
> everything else depends on, so the choice should be deliberate.

### 2.2 The store — `@tldraw/store`

The whole document is a **reactive database of typed records**. A "record" is a plain object
stored under a typed id (e.g. `shape:abc`, `binding:xyz`, `page:1`). Records are JSON. The
store is built *on* signals, so any query over it is reactive.

Key capabilities, each of which you'd otherwise have to invent:

- **Typed schema** describing every record type and its props.
- **Migrations**: records and shape props are versioned; loading old data runs migrations to
  bring it to the current schema automatically. This is what makes "serializable state" safe
  *over time* rather than a one-shot export.
- **Queries / indexes**: reactive queries over records (e.g. "all shapes on page X").
- **Side-effects API**: register `beforeCreate` / `afterChange` / `beforeDelete` handlers per
  record type — the hooks that let you keep derived state (or *your own external model*)
  consistent.
- **History as diffs**: the store emits `RecordsDiff` objects (added/updated/removed). This is
  the substrate for undo/redo *and* for syncing to an external model or a server.
- **Snapshots**: `getSnapshot(store)` → a JSON blob; `loadSnapshot(store, snap)` restores it.
  Snapshots split **document** state (shapes/pages/bindings — what you persist) from
  **session** state (camera/selection/current tool — ephemeral, per-user).

> **This directly answers your serializable-state concern:** the document *is* serializable
> records, and rendering is a pure function of them. State is not hidden inside components.
> The honest caveats: (a) *behaviour* lives in classes, not data; (b) transient interaction
> state (mid-drag, active tool node) lives in the state machine and is intentionally not
> serialized; (c) you must keep custom props JSON-serializable — the schema/migrations system
> enforces this discipline.

### 2.3 The Editor

`Editor` is a facade over the store: a large, imperative-looking API (`createShapes`,
`updateShapes`, `select`, `setCamera`, `getViewportPageBounds`, `batch`, undo/redo, …). It
mutates the store inside transactions. It does **not** hold a second copy of the document —
the store remains the single source of truth; the Editor is ergonomics + invariants on top.
Importantly, there is **no "controlled component" mode**: tldraw always owns its store. You
integrate by listening to store diffs and writing back, not by rendering tldraw purely from
external state.

### 2.4 Shapes — `ShapeUtil`

Behaviour is separated from data. The *data* for a shape is a record; the *behaviour* is a
`ShapeUtil` subclass registered per shape `type`. A `ShapeUtil` defines:

- `getDefaultProps()` — initial serializable props.
- `component(shape)` — how it renders (a React component in tldraw's case).
- `indicator(shape)` — the selection outline.
- `getGeometry(shape)` — geometry used for hit-testing, snapping, bounds.
- resize/rotate/crop behaviour, event callbacks, flags (can it bind? can it be cropped?), and
  optional migrations for its props.

The Editor keeps a registry of `type → ShapeUtil` and delegates. This is a clean
strategy-pattern: the engine is generic; each shape type plugs in its behaviour.

### 2.5 Bindings — `BindingUtil`

A binding is a **typed relationship record** (`fromId`, `toId`, `type`, custom props) with a
`BindingUtil` that provides **lifecycle hooks**: when the "from" or "to" shape changes/moves,
or is about to be deleted, you get callbacks to keep the relationship (or the bound shape)
consistent. Arrows are themselves implemented as bindings. This is the primitive that makes
"objects linked in rich ways" — and tldraw-computer's data-carrying wires — cheap: the engine
maintains the graph's integrity for you.

### 2.6 Tools / interaction — the state chart

Interactions (drawing, dragging, resizing, drawing an arrow) are modelled as a **hierarchical
state machine** of `StateNode`s: a root state with child tool states, each with their own
children (e.g. `select.idle`, `select.pointing`, `select.dragging`). Raw pointer/keyboard
events are routed to the *current* state node, which decides transitions and mutations. This
is where the genuinely *imperative*, ephemeral interaction state lives — and correctly so: you
don't want mid-gesture pointer deltas in your serialized document.

This pattern is one of tldraw's quietly excellent decisions: canvas interaction logic becomes
unmanageable as a pile of `if` statements and boolean flags; a state chart keeps it tractable.

### 2.7 Rendering

Each shape renders as a **React component positioned via CSS transforms** in an HTML/SVG
layer — i.e. **retained-mode, DOM-per-shape**. Two things make this perform:

1. **Fine-grained subscriptions.** Components subscribe to *just* the signals they read (via
   `track` / `useValue`), so changing one shape re-renders only that shape, not the tree. This
   is the entire reason tldraw needs signia rather than plain React state.
2. **Viewport culling.** Only shapes intersecting the viewport are rendered; off-screen shapes
   are skipped. This needs a spatial index to be fast.

The deliberate trade-off: DOM-per-shape gives you **rich interactive objects for free**
(a shape can be any React tree — inputs, iframes, live widgets) and the browser handles
text, accessibility, and event routing. The cost is a **scaling ceiling**: DOM/SVG typically
degrades somewhere around a few thousand on-screen elements. (See §5.2.)

### 2.8 Persistence & sync

Local persistence is snapshot-based (e.g. to IndexedDB via a `persistenceKey`), driven by a
throttled store-diff listener. Multiplayer is a separate concern (`tldraw sync` / `useSync`)
layered on the same diff stream — not relevant to a local-only app, but it shows the diff
stream is the universal integration seam.

### 2.9 Why these are good decisions (worth stealing regardless)

1. **Serializable record store as single source of truth** — clean persistence, undo, sync.
2. **Behaviour separated from data** (`*Util` strategy classes) — generic engine, pluggable types.
3. **Fine-grained signals** — only re-render/recompute what changed.
4. **Interaction as a state chart** — keeps the messiest code tractable.
5. **Bindings as first-class typed relationships with lifecycle hooks** — rich linking without bespoke graph plumbing.
6. **Diffs everywhere** — one mechanism powers undo, persistence, and sync.
7. **Migrations** — serializable state stays loadable as the schema evolves.

---

## 3. What is genuinely hard here

If we build our own, these are the parts that are easy to underestimate (roughly in order of
"looks easy, isn't"):

1. **Spatial indexing + culling.** A quadtree / R-tree / spatial hash kept in sync with the
   store, used for culling, hit-testing, and snapping. Non-trivial to make correct *and* fast
   under constant mutation.
2. **Geometry & hit-testing.** Point-in-shape, segment intersection, bounds, snapping,
   handles. A surprising amount of computational geometry.
3. **The interaction state machine.** Drag vs click vs double-click, modifier keys, escape,
   nudging, multi-select marquee, drag-to-create. The combinatorics bite.
4. **Incremental reactivity at scale.** Getting subscriptions fine-grained enough that 1,000+
   shapes stay at 60fps. This is *the* reason to reuse a proven signals lib rather than naïve
   state.
5. **Undo/redo as diffs**, including coalescing and what counts as one undo step.
6. **Migrations**, once you have real saved documents you can't break.
7. **Camera / coordinate math** (screen ↔ page space, zoom, pan, DPR) — fiddly but bounded.

Everything else (CRUD, selection, copy/paste, export) is comparatively routine.

---

## 4. Feasibility of building something architecturally similar

**Verdict: feasible and sensible — provided we are disciplined about *reusing* the hard
primitives rather than reinventing all of them.** The architecture decomposes cleanly, which
is exactly what makes a from-scratch core realistic without it becoming a multi-year canvas-
engine project.

### 4.1 Guiding principle — framework-agnostic core, swappable renderer

Put everything in §2's bottom four layers (signals, store, behaviour, editor, state machine)
in **plain TypeScript with no framework imports**. The renderer and UI sit above an interface.
This gives you: the architectural ownership you want, serializable state by construction, and
a view layer you can swap (or run two of — e.g. a tldraw adapter *and* an own-renderer adapter)
without touching the brain.

```
        your owned, framework-agnostic core (TypeScript)
        ┌───────────────────────────────────────────────┐
        │ signals · store · schema/migrations · editor   │
        │ geometry · spatial index · state machine       │
        └───────────────────────────────────────────────┘
                         ▲            ▲
            RenderAdapter│            │RenderAdapter
        ┌────────────────┴───┐   ┌────┴────────────────┐
        │ React renderer     │   │ (later) Solid /      │
        │ (fast start)       │   │ Canvas / WebGL       │
        └────────────────────┘   └─────────────────────┘
```

### 4.2 Buy-vs-build map (don't reinvent the proven bits)

| Layer | Recommendation | Why |
|---|---|---|
| Signals core | **Reuse — signia (`@tldraw/state`, MIT)** | Spike-confirmed (§8.3.1): hot-path winner, drag p99 0.012ms at N=5000 |
| Record store + diffs | **Build thin, on signals** | Small, and it's the heart of *your* ownership; the spike's `StoreAdapter` is the starting contract. Beat-this baseline won — no unified DB displaced it |
| Persistence / agent seam | **Build on an event/intent log** (LiveStore-style; SQLite optional) | Spike (§8.3.1): the log is where SQL agent-legibility + atomic multi-writer come from — put it *downstream* of the reactive core, one event per gesture, not per tick |
| Schema + migrations | **Build minimal**, grow later | Don't over-engineer before you have saved docs |
| Geometry / hit-testing | **Reuse libraries** where possible | Lots of solved computational geometry |
| Spatial index | **Reuse** (e.g. an R-tree/quadtree lib) | Don't hand-roll |
| State machine | **Build, or use a small FSM lib** | The *shape* is yours; the mechanism is generic |
| Editor facade | **Build** | This is your API; you want to own it |
| Shape/Binding "Util" pattern | **Build** (it's just a registry + interface) | Cheap, and central to your domain |
| Renderer + UI | **Build thin adapter; optionally embed tldraw early** | Swappable by design |

### 4.3 Suggested phasing

- **Phase 0 — Spike (days).** Stand up signals + a tiny record store + a single shape type +
  basic pan/zoom + render via React. Prove the loop: mutate store → only changed shape
  re-renders. This validates the perf model before committing.
- **Phase 1 — Core (weeks).** Store with diffs + undo/redo, snapshots, 2–3 shape types via the
  Util pattern, selection, a minimal state machine (idle/pointing/dragging), camera math.
- **Phase 2 — Linking (weeks).** Bindings as typed relationship records with lifecycle hooks;
  arrows/wires; your domain graph model. This is where you validate the tldraw-computer-style
  direction *on your own architecture*.
- **Phase 3 — Scale & polish.** Spatial index + culling, migrations, persistence to IndexedDB,
  export. Only now consider a canvas/WebGL renderer *if* profiling demands it.

A pragmatic hybrid: **embed tldraw as the Phase-1 renderer** behind the adapter to get a fast,
polished surface while you build out the core, then swap to your own renderer once the core is
proven. This requires the dual-model sync (store ⇄ tldraw store) discussed previously and
carries its known reconciliation cost — treat it as a temporary accelerator, not the
destination.

### 4.4 Risks & ceilings

- **Reconciliation bugs** if you run the embed-tldraw hybrid (two sources of truth). Mitigate
  by keeping *your* model authoritative and tldraw strictly downstream.
- **Scope creep in the state machine** — cap the interaction surface early.
- **Premature renderer optimization** — DOM/SVG is almost certainly fine for a note app (you
  rarely have thousands of notes on screen). Don't reach for WebGL until profiling says so.
- **Migrations debt** — once real documents exist, schema changes get expensive. Introduce a
  version field from day one even if migrations are trivial at first.

---

## 5. React, or something else?

### 5.1 The key reframe

For a canvas app, **the view framework matters less than it does for a typical app**, in both
directions. You are *not* leaning on a framework to manage your application state — your state
lives in the signals/store core. The view layer mostly does: "given the set of visible shape
records, render a positioned node per shape, each subscribed to its own signal." That is a
thin, mechanical responsibility. So:

- The framework's headline benefit (declarative, framework-managed state trees) is **partly
  wasted** here — your state isn't in the framework.
- The framework's "baggage" is also **partly irrelevant** here — you bypass most of it.

This means the framework choice is lower-stakes than it first appears, *and* it should be made
on different criteria than usual: rendering-target fit, fine-grained-update story, and
(for an agent-built project) corpus/tooling reliability — not "which has the nicest state model".

### 5.2 The decision that actually matters: rendering target

Independent of framework, you choose how shapes hit the screen:

- **DOM/SVG (retained mode).** Browser handles repaint, text, accessibility, events. **Rich
  interactive shapes are trivial.** Ceiling: degrades past ~a few thousand on-screen elements.
  *This is what tldraw uses, and it's almost certainly right for a note-taking app.*
- **Canvas 2D (immediate mode).** You redraw each frame; far faster for big scenes, but **you**
  implement hit-testing, text editing, and interactive widgets yourself (this is exactly why
  Excalidraw's rich-object story is weaker). Worth it around 3k–5k+ elements.
- **WebGL (immediate mode).** 100k+ simple elements, but you reimplement almost everything and
  rich interactivity needs a DOM overlay. Overkill unless you're at true scale.
- **Hybrid** (WebGL/Canvas for bulk geometry + DOM overlay for the few editable/interactive
  things) — the common end-state for apps that truly need scale.

**Guidance for your project:** start DOM/SVG. A notes canvas rarely shows thousands of live
elements; the rich-interactive-object upside is exactly what you want; and culling buys
headroom. Keep the renderer behind the adapter so canvas/WebGL remains a future option, not a
rewrite.

### 5.3 View-framework options (2026)

The industry converged on signals/fine-grained reactivity (Solid, Svelte 5 runes, Vue, Angular
signals, and React's compiler all acknowledge "re-render everything" needs help). Against that
backdrop:

- **React.** Largest ecosystem and corpus by far; the React Compiler eases (but doesn't erase)
  its coarse re-render model. You'd lean on a signals lib (signia/Preact Signals) for the
  fine-grained canvas updates — exactly as tldraw does. **Biggest practical advantage for us:
  tldraw is React, so its source is a directly-readable reference, and an embed-as-accelerator
  path exists.**
- **Solid.js.** Signals are *native* and finest-grained; surgical DOM updates, no component
  re-render, minimal "baggage". **Philosophically the closest to the principled, simple system
  you said you'd reach for.** Smaller ecosystem and corpus than React.
- **Svelte 5 (runes).** Compiler-based fine-grained reactivity, very good DX, gentler curve
  than Solid, maturing ecosystem. Slightly awkward fit if you want a *runtime*, framework-
  agnostic signals core shared with non-Svelte code (its reactivity is compiler-bound).
- **Vanilla + a signals library.** Maximum control and minimum baggage; you write the DOM
  reconciliation for shapes yourself (which, for "one positioned node per visible shape", is
  not much). Most principled, most DIY.

### 5.4 The Claude-fluency factor (honest take)

You raised this directly, so here is the unvarnished version:

- **React is where I (and the broader corpus) am strongest.** Most training data, most
  examples, most libraries, most debugging references, and — uniquely here — **tldraw's own
  code is React, so I can read and adapt real patterns from the system we're studying.** For an
  agent-driven build, that translates into more reliable generation and faster debugging. It is
  a *material* advantage, not a tie-breaker.
- **Solid: I'm genuinely capable and it's conceptually clean** (and arguably a *better* match
  for a signals-centric canvas), but there's less corpus, so expect marginally more friction
  and fewer copy-pasteable references.
- **Svelte 5 runes: capable, less corpus than React**; the newest API surface, so the smallest
  body of battle-tested examples.
- **Vanilla + signals: fine for me**, and the *core* work (store, geometry, state machine) is
  framework-agnostic TS where my fluency is high regardless of the view choice.

Crucial mitigation: **most of the hard, agent-assisted work lives in the framework-agnostic
core**, where the framework choice is irrelevant to my reliability. So the fluency
consideration only really applies to the thin view layer — which lowers the stakes of picking
React purely for my benefit.

### 5.5 Recommendation

1. **Build the core framework-agnostic** (signals + store + geometry + state machine). This is
   most of the value and most of the difficulty, and it's where "principled and simple" pays
   off most. Reuse signia (MIT) or Preact Signals for the reactive layer.
2. **Render DOM/SVG** to start (right for a notes app; keep canvas/WebGL as a deferred option
   behind the adapter).
3. **For the view layer, default to React** — for ecosystem, agent reliability, and the ability
   to read/borrow from (or temporarily embed) tldraw. **Consider Solid if you want the most
   principled fit** and are happy to trade some corpus depth; because the core is
   framework-agnostic, you can even prototype both adapters cheaply and decide from experience.
4. Whatever the view choice, **keep it behind a `RenderAdapter` interface** so it stays a
   detail, not a foundation — which is precisely the ownership/swappability property you asked
   for.

The elegant part: this plan reconciles your two instincts. "Own the architecture / principled
/ swappable" is satisfied by the framework-agnostic core and the adapter seam. "Use what Claude
is fluent in" is satisfied by defaulting the *thin* view layer to React — without letting React
become the architecture.

---

## 6. Concretely, the architecture I'd propose

```
core/                         (framework-agnostic TypeScript — you own all of this)
  reactive/    signia or Preact Signals: atom, computed, react, transact
  store/       Record<T>, Store, schema, migrations, RecordsDiff, snapshots
  model/       ShapeUtil-style registry, BindingUtil-style registry
  geometry/    bounds, hit-testing, snapping (reuse libs where possible)
  spatial/     quadtree/R-tree index kept in sync via store side-effects
  editor/      Editor facade: CRUD, selection, camera, history/undo
  interaction/ StateNode-style state machine; event → state → mutation
  persistence/ IndexedDB snapshot save/load (throttled diff listener)

adapters/
  react/       RenderAdapter impl: one component per visible shape,
               culled by spatial index, each subscribed to its own signal
  (later) solid/ or canvas/ or tldraw/  — alternative RenderAdapters

app/
  shapes/      your concrete shape types (note card, image, group, …)
  bindings/    your concrete relationships (wire, contains, references, …)
  ui/          toolbar, panels (in the chosen view framework)
```

Source of truth = `core/store`. Renderer is a pure function of it. Persistence and (if ever)
sync ride the same `RecordsDiff` stream. Your domain/compute logic lives in `app/` +
`core/model`, never inside the renderer — so the brain is portable across canvases.

---

## 7. Things to verify before committing

- **signia / `@tldraw/state` licence** on the exact package+version you'd adopt (the standalone
  `tldraw/signia` repo is MIT; confirm before depending on it). Same check for `@tldraw/store`
  if you'd reuse it rather than build your own.
- **Spatial-index + geometry libraries** you'd reuse (licences, maintenance, TS support).
- A **Phase-0 perf spike** with your chosen signals lib + React (or Solid): render ~2–5k shapes,
  mutate one, confirm only that one re-renders at 60fps. This de-risks §5.2/§5.4 empirically.
- If you might run the **embed-tldraw accelerator**: confirm the dual-model sync ergonomics are
  acceptable on a small prototype before relying on it.

---

## 8. Reactive foundation: signals, and "unified reactive databases"

### 8.1 Is the signals layer just a React patch?

It's two jobs under one word:

- **Rendering updates.** React re-renders top-down with a VDOM and has no native "update only
  this one shape"; signals are *bolted on* (a signals lib + a bridge hook). **In Solid this is
  native** — signals *are* the rendering model. So Solid removes this half out of the box.
- **The data/computation engine.** signia also powers the *document model*: derived values,
  incremental `computed` (via diffs), transactions with rollback. You need a reactive engine
  for this **regardless of view framework**. Solid's signals *can* do it, but they're coupled
  to Solid's runtime (reactive roots, automatic disposal) and `@solidjs/signals` (Solid 2.0) is
  currently **beta**. signia was purpose-built as a *standalone* engine for exactly this.

So "patch" applies to **React specifically**. Signals are otherwise the industry-converged
model — Angular native, Vue, Svelte 5 runes, Solid, and a **Stage-1 TC39 proposal** to put
signals in the language. Design *toward* that standard (hide the lib behind an interface);
don't depend on the unstable polyfill yet.

#### 8.1.1 Does the signals API leak into the rest of the architecture?

A recurring worry: must the signals API propagate through the whole stack (for efficiency), or
can the store stay encapsulated and expose only diffs? The right model is neither extreme. **A
reactive store has two dual output channels, and which one a consumer uses is set by whether
that consumer is pull-shaped or push-shaped:**

- **Reactive-handle channel (signals-shaped)** — "give me the live value of this entity/query
  and re-run me when it changes." The minimal, efficient interface for any consumer that
  *mirrors* current state, above all the renderer: it's minimal because the consumer does *no*
  routing — the store delivers change to exactly the subscribed handle, so mutating shape 4,999
  re-runs only its view.
- **Diff channel (push-shaped)** — "tell me what changed (added/updated/removed)." The right
  interface for consumers that *process events* or maintain a *projection* rather than a mirror:
  persistence, undo, sync, derived external models, and the agent. Minimal because they get the
  delta, not a re-query.

These are two views of one underlying event. So it is not "signals *or* diffs"; the store owns
both as first-class outputs.

What you can fully hide is the signals *library* (behind your own `Subscribable<T>` with
`.get()`/`.subscribe()`), preserving swappability and the TC39-future point. What you cannot
hide — and shouldn't try to — is the reactive *contract*: transaction boundaries (don't react
mid-batch), glitch-free consistent reads within a tick, and subscription disposal/lifecycle.
**That contract is the real "leak," not the API surface;** anyone consuming the reactive-handle
channel inherits those semantics. Contain it with a rule of altitude:

- **Default seam everywhere: diffs.** Persistence, the agent path, history, the semantic/layout
  split (§9.3), any derived model — all ride the diff stream. Most of the architecture only ever
  talks diffs: encapsulated, serializable, framework-agnostic, agent-legible.
- **Opt-in exception, by necessity: reactive handles at the render edge** (and internal derived
  indexes like the spatial/culling set), behind your own interface. This is the one place where
  replacing signals with diffs just means rebuilding a *worse* signals engine — routing
  "shape:abc changed → the component for shape:abc" at 60fps over thousands of entities is
  exactly what a signals system does well. tldraw made this choice deliberately (`track` /
  `useValue` per-shape subscriptions, *not* diff-to-component reconciliation), which is empirical
  evidence for the split.

A signia-relevant bonus: there the diff stream and the reactive handle are the *same*
clock-based mechanism (a `computed` is a cached signal that updates by applying *diffs* of its
dependencies), so one engine yields both channels — a genuine point for signia on the
hot-path/reactivity axes.

### 8.2 Pure signals libraries

These give *only* reactivity — not the store (records, queries, persistence, undo, migrations):

| Lib | Model | Standout | Watch-out |
|---|---|---|---|
| `@preact/signals` | push-pull | Tiny, mature, best DX, de-facto standard | No incremental computed |
| `signia` (tldraw) | clock-based, lazy | Incremental `computed` via diffs; transactions w/ rollback; built for this workload; MIT | Smaller community |
| `@vue/reactivity` | proxy, deep | Ergonomic deep reactivity, standalone-usable | Proxy semantics |
| `@solidjs/signals` | runtime fine-grained | Native *if* you pick Solid for the view | Beta; coupled to Solid runtime |
| TC39 polyfill | standard-track | Future-proof; everyone converging | Stage 1, unstable |

**Call:** `preact-signals` as the safe lightweight default; `signia` if you specifically want
incremental derivations + transactions (useful deriving over thousands of shapes). Either way,
hide behind an interface so the eventual TC39 standard is a cheap swap.

### 8.3 Unified reactive databases (signals/reactivity + store + persistence + undo)

This is a real product category, and adopting one could replace "build a thin store by hand":

- **TinyBase** — reactive in-memory store bundling a **reactive query engine**
  (select/join/filter/group), indexing, a built-in **undo stack**, **persistence**
  (IndexedDB/SQLite/…), and **native CRDT sync**; ~6–13kB, zero deps. Listener-based (but
  effectively fine-grained) reactivity; tabular data model.
- **SignalDB** — **signals-native**, MongoDB-like query API, framework adapters
  (React/Solid/Vue/Preact), in-memory + pluggable persistence + optional sync. Closest
  philosophical match to "signals + store, unified."
- **CRDT document stores — Yjs / Loro / Automerge** — serializable, *observable* documents with
  built-in undo, persistence providers, and a free path to multiplayer. Loro (Rust/WASM) is the
  fastest (a design tool reportedly runs a canvas at 120fps / 100 users on it); Yjs is the safe
  incumbent. Caveats: observer reactivity is *coarser* than signals (often layer signals on top
  for surgical rendering); the CRDT model shapes your schema and adds overhead; sync-oriented.

### 8.4 The governing caveat: the canvas hot path

Dragging mutates `x`/`y` many times per second. Keep a **fast in-memory reactive layer** and
push persistence **downstream and throttled** — tldraw never writes to disk on every drag tick.
Some local-first DBs assume "every change is a transaction to persist/sync," which fights
interactive mutation. **This is the single most important spike criterion.**

**Typed durability tiers (generalizing session-vs-document).** §2.2's snapshot split (durable
*document* state vs ephemeral *session* state) is the seed of the right structure. What may be
dropped/coalesced at the throttle boundary depends on the data's *durability class*, so make
that class explicit per record type (or per channel):

- **session** — ephemeral: live cursor, mid-drag position, selection, transient UI. In-memory,
  throttled, lossy-OK, often never persisted.
- **document** — durable current state: shapes, pages, bindings. Snapshot-persisted, throttled
  but not lossy.
- **log** — durable *ordered* intent: an append-only event record (see §10). Append-on-commit,
  no loss, no coalescing.

For a single-user canvas the first two suffice; the third becomes load-bearing once agents are
in the picture (§10). Designing the tier in from the start is cheap insurance.

#### 8.3.1 Spike result (2026-06-07) — measured, not guessed

A throwaway benchmark harness implemented all four candidates + a naive baseline against a shared
`StoreAdapter` contract (extended with the §10 concurrency probes + the §8.4 durability tier).
Headline (Node, store-only, N=5000, 60fps = 16.6ms):

- **signia (`@tldraw/state`)** — drag p99 **0.012ms**, granular reactive query (3 fires), atomic
  read-modify-write via a *hand-built* version check. The hot-path + ownership winner; you build
  the indexes/undo/queries/concurrency yourself. Rubric 4.10.
- **TinyBase** — p99 0.025ms, best batteries (checkpoints undo, persisters incl. SQLite, CRDT
  sync). Its multi-writer answer is cross-replica CRDT, so the *shared-store* async race has no
  in-process remedy. Rubric **4.36** (narrow top).
- **LiveStore** — p99 **3.12ms** (the event-sourcing-per-move risk did *not* blow the budget at
  5000), and the **only** candidate strong on both strategic axes: real SQL **and** a legible
  intent/event log, with native atomic RMW. Costs: ~920ms init, heaviest deps, fastest-moving API,
  event-per-mutation. Rubric 4.08.
- **SignalDB** — **disqualified**: reactive cursor is O(N)/mutation (~80µs/doc), 16ms/move already
  at N=200, never completes at N=5000 (+ a listener leak). Native Mongo queries can't rescue it.

**Verdict:** no unified DB decisively beats "signia + thin store." **Build the reactive core on
signia behind the `StoreAdapter` interface (it owns the largest axis and the ownership goal), and
take LiveStore's *event-log-as-intent* as the downstream persistence/agent seam (§8.1.1 dual
channels) — one attributed event per *gesture*, not per frame — rather than paying for it on the
hot path.** TinyBase is the batteries-now fallback; SignalDB is out.

## 9. Designing the store to be agent-legible (a first-class goal)

A pre-agent canvas app optimizes the store for the *renderer*. We additionally want **Claude as
a copilot that reads and mutates the store directly**, while the human works at a higher level
through the rendered editor. Designing for that is a concrete advantage of owning the
architecture, and it drives specific decisions:

1. **One mutation API, three clients.** The Editor/command layer (the validated operations that
   change the document) should be the *same* surface used by (a) the human via the renderer,
   (b) your own compute logic, and (c) the agent. The agent should call commands, **not** poke
   raw JSON — so invariants, undo, and migrations apply uniformly. The state-machine/Editor
   design already sets this up; it's an elegant unification.

2. **A standard query interface beats a verbose custom JSON blob.** Agents are far more fluent
   in **SQL** or a **MongoDB-like** language than in parsing a bespoke nested snapshot. If the
   store is queryable in a standard dialect (or trivially wrappable as one), Claude can
   introspect schema and ask precise questions ("nodes linked to X within region Y") instead of
   ingesting megabytes of coordinates. This tilts the store choice toward standard-query
   options and is the concrete reason a tldraw-style snapshot (typed ids, fractional z-index,
   nested props, migration metadata) is *legible but not agent-optimized*.

3. **Separate semantic content from presentation.** The agent mostly cares about *meaning* —
   notes, text, links — not pixels. Model a **semantic graph (nodes + edges + content)**
   distinct from a **layout layer (positions, sizes, styles)**, linked by id. The agent
   reads/writes semantics; the human + renderer own layout; layout can be (re)derived. This
   also matches the bindings model (edges as first-class relationship records) and keeps the
   agent's working set small and meaningful.

4. **Stable, human-meaningful addressing.** Stable ids plus readable titles/labels so the agent
   can refer to and locate objects deterministically.

5. **Expose it over MCP.** With a clean query + command API, a thin **MCP server** can surface
   "query the canvas" and "apply a command" tools to Claude directly — turning the copilot idea
   into a few hundred lines rather than a research project.

**Implication for the spike:** add an explicit **agent-legibility** scoring axis (standard query
language? clean/compact serialization? MCP-wrappable command API?), and include at least one
**SQL-backed** candidate (**LiveStore** — reactive SQLite + event-sourcing, where the event log
doubles as a legible record of intent) alongside the signals-native and document options.

---

## 10. A second use case as a design foil: realtime multi-agent workflows

The motivating example so far is a single-user infinite canvas with tldraw-computer-style
connectivity. A second use case is worth holding alongside it **as a design foil, not a second
thing to build**: a realtime UI for *cooperating coding agents* — a human observing progress and
steering several agents that work and communicate concurrently.

**It is the same core shape, not scope creep.** That UI is literally a tldraw-computer compute
graph: nodes are live/active elements (agents, tasks, artifacts, messages), edges carry data and
dependencies, a human observes and steers, and non-human actors mutate the store. So it is the
*same* "reactive graph of semi-autonomous nodes with data-carrying edges, rendered live, human-
observed, agent-mutated" — validated against a second domain. Good pressure-testing rather than
dilution. But it stresses three things the single-user canvas lets you ignore:

1. **Multi-writer concurrency.** The canvas is essentially single-writer (one human, occasional
   copilot, low contention). A multi-agent UI has *N concurrent asynchronous writers* hitting the
   store from outside any render loop. This stresses the transaction model (ownership,
   interleaving without breaking invariants) and forces a conflict-semantics decision (two agents
   touch one record) the canvas lets you skip. **Honest implication:** taking the agent case
   seriously turns "multiplayer-someday" into "multi-writer-now" — not "adopt a CRDT today," but
   TinyBase's CRDT sync and LiveStore's event log stop being irrelevant to a "local-only" app.

2. **Provenance / causality → event-sourcing.** Here the human observes *progress and reasoning
   over time* — who did what, why, in what order — not just a final layout. That favors an
   **append-only event log as (part of) the substrate**, with current state a *projection* of the
   log (LiveStore's model; §9 noted the log "doubles as a legible record of intent"). The fork:
   the canvas is **state-centric** (snapshot is truth; intermediate diffs are disposable
   scaffolding); agents are **event-centric** (the log is truth; state is materialized from it).
   Reconciliation serving both: an **event-sourced store with throttled snapshot
   materialization** — events are the durable, attributed, queryable truth (provenance, audit,
   human time-travel/replay); an in-memory reactive projection serves the canvas hot path;
   periodic snapshots bound replay cost.

3. **The throttle boundary becomes *semantic*.** What may be dropped at the in-memory→persistent
   boundary now depends on durability class, not perf alone — exactly the **session / document /
   log** tiers of §8.4. Ephemeral progress ticks and streaming output coalesce like drag deltas;
   committed agent decisions, messages, and artifacts must hit the log in order with no loss.

**A unification that strengthens §8.1.1.** Agents are *both writers and reactive consumers* —
agent B wants to "wake when agent A finishes task X." That is the **diff channel** again,
filtered and delivered to an agent. So the renderer and the cooperating agents are structurally
*the same kind of consumer* (subscribe to a filtered view, react to coalesced change), which is
exactly what makes the agent-coordination story cheap. Agents want both channels: one-shot
SQL/Mongo for introspection (§9.2) and a reactive subscription for coordination.

### 10.1 What "multi-writer" actually means (and how to test it)

There are no threads racing over the store. JS runs on one event loop, and a *synchronous*
function runs to completion before anything else gets a turn — so a bare `store.commit(...)` is
atomic by construction. The **only** place another writer interleaves is at an `await` (or any
yield). That single fact splits "multi-writer" into two very different tests:

- **(1) Rapid sequential commits from N logical actors** — loop over W writers firing mutations
  back-to-back, all synchronous, each tagged with a different actor id. Nothing overlaps; the
  final state is **deterministic**. This measures *throughput* under many sources, per-actor
  **attribution**, index/notification scaling, and subscriber **coalescing**. It cannot reveal
  anything about concurrency *safety* — it's a fast serial stream wearing N hats.
- **(2) True async interleaving** — each writer is an async task that **reads, yields, then
  writes** (`const cur = read(); await think(); commit(next(cur))`), modelling an agent that
  reads the store, does a tool/LLM call, and comes back to write. Now the loop genuinely
  interleaves and the hard questions appear: **lost updates** (A and B both read 5, both write
  6, one update vanishes), **ordering/causality** (commit order is nondeterministic, so
  correctness now depends on the store's concurrency model), and the sharp finding —
  **atomicity across an `await`**: a signals-library transaction is *synchronous*
  (`transact(() => …)`) and **cannot span an await**, so "read → think → write" is not atomic
  unless the store offers something more (an optimistic-commit/version check, a queue, an
  event-log serialization point, or CRDT merge).

**Use both, for different jobs:** (1) as the *quantitative* benchmark (clean, comparable
throughput/p99/coalescing across candidates); (2) as a *qualitative* race probe whose real
output is **whether atomic read-modify-write is even expressible** in each store — that is the
discriminating signal, and a single-writer canvas framing misses it entirely.

### 10.2 The conflict-resolution spectrum

Once writes can conflict, you need a policy. It helps to separate three things git bundles
together: **(A) history structure** (linear log vs commit-DAG-with-branches), **(B) conflict
strategy** (last-write-wins vs auto-merge vs explicit three-way merge), and **(C) isolation**
(agents on isolated snapshots vs a shared live store). The valuable kernel of a "git for agents"
idea is **(C)+(A)**; the overkill-prone part is the *manual* bit of **(B)**.

The gem is **isolation, not conflict handling**. On its own branch an agent's whole multi-step
read-modify-write runs against a *frozen, consistent snapshot* — nothing shifts under it
mid-operation; reconciliation happens only at merge. That is a clean answer to §10.1's
atomicity-across-await problem, and it suggests a *UX*: agents propose on branches, a human or
lead agent reviews and merges to `main` (a PR-review flow) — a natural way to observe and steer
cooperating agents, and something you'd often *want* in a coding workflow.

The reframe that matters: **git and CRDTs answer the same question with opposite ergonomics.** A
CRDT is "git where merge never conflicts because the merge function is baked into the datatype";
git is "a CRDT where you refuse to auto-resolve and demand explicit resolution." Automerge and
Loro expose version DAGs and branch/merge APIs — so you can get isolation + history + branching
with *automatic* merge, skipping the "who resolves the conflict" burden (which, for autonomous
agents, means an agent capable of resolving merges or escalating to the human). The spectrum,
lightest to heaviest:

| Model | Conflict handling | Good when |
|---|---|---|
| **LWW / domain-partitioned ownership** | none — agents touch disjoint records by design | few agents, work partitions cleanly (often the real answer) |
| **Optimistic concurrency (MVCC)** | per-agent staged changeset vs a base version, checked at commit | want no lost updates + atomic agent ops, minimal machinery |
| **CRDT (Automerge/Loro)** | automatic, deterministic merge | concurrent edits common, no human-in-loop wanted, branch+history for free |
| **Git-style explicit merge** | branches + manual three-way resolution | review-before-merge is a *desired feature*; full replayable intent |

**The 80/20 is optimistic concurrency.** A "branch" is just `(base version, list of diffs)` — a
staging area, no persistent DAG. On commit, version-check the touched records against `main`:
unchanged → fast-forward apply; conflict → LWW or escalate. That buys the two things that matter
(no lost updates, atomic multi-step agent ops) without a merge engine or resolution UX. Climb to
full git-style only when review-before-merge is a product feature you want — plausible for the
multi-agent coding UI, clearly overkill for the single-user notes app + copilot (where LWW or
ownership is plenty). Heavy materialization is the failure mode to avoid: a branch must be a
cheap pointer + changeset (structural sharing), never a deep clone of the canvas per agent.

### 10.3 Keeping the choice deferrable: the change-unit as an attributed causal diff

All of this stays deferrable if the core's **change-unit is a first-class, attributed,
causally-ordered diff/event** (`parent version + actor + payload`) — which §10's event-log
direction already implies. Given that, you can ship **LWW now** and adopt optimistic-concurrency,
CRDT, or full branching later *without re-architecting*: the conflict model is a swappable policy
behind the same diff/event seam (§8.1.1). This is the concrete insurance that lets the canvas
app stay simple while keeping the multi-agent door open.

It also sharpens the candidate read, because stores differ sharply in what they hand you here:
**Automerge / Loro** give branch + merge + DAG natively; **LiveStore** gives a linear event log
(history yes, branching no, but rebaseable); **TinyBase** has CRDT sync; **signia + thin store**
gives none of it — you build the whole concurrency model yourself. A single-user-canvas framing
would treat that as irrelevant; the §10 lens makes it decision-relevant.

### 10.4 Recommendation

Keep the canvas note app as the **primary, shippable driver** (single-user, concrete). Use the
multi-agent workflow only to *avoid foreclosing* — buy cheap insurance now (event-log-first
option, typed durability tiers, the attributed-causal-diff change-unit of §10.3, diff-stream as
the shared renderer+agent seam) and ship the simplest conflict policy (LWW/ownership) without
building any agent UI. The honest cost: the agent lens re-opens two decisions deferred elsewhere
(CRDT/multi-writer and event-sourcing), raising the stakes of the store choice — which is
precisely why it belongs in the spike rather than after it.

---

## Sources

- tldraw signals (signia): https://signia.tldraw.dev/ · https://github.com/tldraw/signia · https://tldraw.substack.com/p/introducing-signia · https://www.npmjs.com/package/@tldraw/state
- tldraw store & persistence: https://tldraw.dev/reference/store/Store · https://tldraw.dev/docs/persistence · https://www.npmjs.com/package/@tldraw/store
- Snapshots / load: https://tldraw.dev/examples/snapshots · https://tldraw.dev/reference/editor/getSnapshot · https://tldraw.dev/reference/editor/loadSnapshot
- Shapes / ShapeUtil / bindings: https://tldraw.dev/docs/shapes · https://tldraw.dev/reference/editor/ShapeUtil · https://tldraw.dev/examples/sticker-bindings · https://tldraw.dev/examples/layout-bindings
- Driving the editor externally: https://tldraw.dev/examples/external-ui
- Reactivity landscape 2026: https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026 · https://leapcell.io/blog/next-gen-reactivity-rethink-preact-solidjs-signals-vs-svelte-5-runes
- Rendering-target tradeoffs: https://medium.com/@codetip.top/svg-vs-canvas-vs-webgl-for-diagram-viewers-tradeoffs-bottlenecks-and-how-to-measure-8cedbd3b7499 · https://www.svggenie.com/blog/svg-vs-canvas-vs-webgl-performance-2025
- Unified reactive stores: https://tinybase.org/ · https://github.com/tinyplex/tinybase · https://signaldb.js.org/ · https://github.com/maxnowack/signaldb
- CRDT stores: https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026 · https://github.com/yjs/yjs · https://github.com/loro-dev/loro
- Signals landscape & TC39: https://github.com/tc39/proposal-signals · https://github.com/solidjs/signals · https://github.com/transitive-bullshit/ts-reactive-comparison
- SQL/event-sourced local-first: https://livestore.dev/ (verify current API)
