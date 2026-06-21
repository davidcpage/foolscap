# @canvas/interaction — the interaction layer

Open follow-up #2: the layer that turns raw input into **gestures/commands** on `@canvas/core`. Per the
design docs this is *the product* — "the canvas IS the interaction layer" — so it is owned, not borrowed.
It sits on top of the core built in `../core` and is a **client of the three channels**:

```
input (pointer/wheel/key)
        │  bindDom() normalizes → InputEvent      ← the ONE DOM-coupled file (input.ts)
        ▼
InteractionManager ── routes → active Tool (state machine)
        │                         │
        │ camera/selection        │ editor.beginGesture(...).update(...).end()   → channel 3 (intent log)
        │ (session-tier, our      │ editor.store.update(...)                      → channel 1 (live atoms)
        │  Observable)            ▼
        └── SpatialIndex ◀── store.listen (channel 2: diff stream) keeps hit-test boxes in sync
```

- **channel 1 (pull)** — the renderer reads live atoms; a drag's per-frame layout writes show at 60fps.
- **channel 2 (diff)** — the spatial index is a consumer, exactly like `core/undo.ts`.
- **channel 3 (intent log)** — one drag = one `beginGesture/update*/end` = **one `IntentEvent`** of type
  `moveNodes` (cancel reverts the atoms and emits nothing). The agent can replay that same intent via the
  `moveNodes` command (added to `core/commands.ts`) — "one mutation API, three clients" holds.

## What's here

```
src/
  observable.ts   session-tier reactive value implementing Subscribable<T> (NOT signia — see below)
  geometry.ts     Vec + Box, plain data + free functions (owned; tldraw's are nice but copying pulls licence)
  camera.ts       screen↔page transform (translate + uniform zoom), reactive CameraState; pan/zoom-about-anchor
  spatial.ts      SpatialIndex interface + BruteForceIndex default + syncIndexFromStore (channel-2 consumer)
  selection.ts    reactive Set<nodeId> + selectionBounds()
  input.ts        framework-agnostic InputEvent vocabulary + bindDom() (the only DOM code)
  tools/
    tool.ts       Tool interface (pointer/key lifecycle) + InteractionContext + DRAG_THRESHOLD
    select-tool.ts  click / shift-toggle / marquee / drag-move (the bulk of the canvas feel)
    hand-tool.ts    camera pan (the minimal 2nd tool — proves the tool seam is real)
  manager.ts      InteractionManager: owns session state + index + active tool; routes input; wheel zoom/pan, Escape
  index.ts        public surface
```

## Design decisions (and the OSS-reuse question)

- **Owned vs borrowed.** The interaction logic is owned (it's the product). OSS is borrowed only at the
  **primitive level, behind swappable interfaces**. The one genuinely-hard, genuinely-modular piece is the
  spatial index: shipped as `BruteForceIndex` (zero-dep, microseconds at the DOM renderer's ~10–20k ceiling
  from the browser spike) with **rbush** (MIT, ~3kB R-tree) as the documented drop-in — wrap its
  insert/remove/search behind `SpatialIndex` and nothing else changes. We deliberately did **not** pull
  `@use-gesture` (React-bound; we stay framework-agnostic for React *or* Solid — native Pointer Events are
  already well-normalized) or a matrix lib (a notes canvas needs only translate + uniform zoom). This
  matches the prior decision to drop tldraw component reuse and reuse it only as patterns (the tool
  state-chart / pointer lifecycle here are tldraw-shaped but written, not copied).
- **No signals library here.** Session-tier state (camera, selection, marquee, hover) uses our own
  `Observable<T>`, not signia. The drag hot path still goes through the store's signia atoms via gestures;
  session changes are coarse and single-writer, so a value+listener set is enough. This keeps the package
  free of `@tldraw/state` and proves `Subscribable<T>` is genuinely library-agnostic (a stated goal).
- **DOM-agnostic core.** Everything except `bindDom()` is pure logic, so the whole layer is unit-tested in
  Node with synthetic `InputEvent`s (mirroring core's `node:test` suites) — the renderer choice stays
  orthogonal. Wire it up by calling `bindDom(canvasEl, m.dispatch)` and rendering from `m.camera.signal`,
  `m.selection.signal`, `m.marquee`, plus the store's per-entity handles.

## Run

```sh
npm install
npm test        # 25 tests: geometry, camera, spatial, selection, + end-to-end interaction
npm run typecheck
```

It imports `@canvas/core` directly from `../core/src` (single seam in `src/core.ts`); core's transitive
`@tldraw/state` resolves from `../core/node_modules`, so this package needs no runtime deps of its own.

## Deliberately not here yet

- **Resize / rotate** handles — the select tool covers click/marquee/move; resize is the same gesture
  shape against `selectionBounds` + handle hit-testing (next increment).
- **Snapping / alignment guides** — a geometry concern; reuse tldraw's *algorithms* as reference.
- **Renderer integration** — this layer is renderer-agnostic; wiring it into a renderer (with viewport
  virtualization) is the `app/` package's job, a separate step.
- **Keyboard nudge / shortcuts, additional tools** (draw, connector) — straightforward additions on the
  `Tool` seam.
