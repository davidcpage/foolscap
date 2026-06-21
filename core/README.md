# @canvas/core — reactive serializable core store

The core store for the canvas notes app. The design was de-risked end-to-end by two throwaway spikes
before this module was written:

- a store-only benchmark that picked **signia (`@tldraw/state`)** behind a thin store seam;
- a render-edge proof: 60fps DOM at N=5000, exactly 1.00 view-update/frame.

This module is where those conclusions became production code.

## The three channels (doc §8.1.1)

One signia core (one atom per record) with three distinct output seams — different shapes for
different consumers:

| # | Channel | Shape | API | Consumers |
|---|---------|-------|-----|-----------|
| 1 | reactive handles | pull, per-entity | `Store.get` / `getSignal` / `query` → `Subscribable<T>` | the renderer, internal indexes |
| 2 | record diff stream | push | `Store.listen` → `(RecordsDiff, source)` | persistence, undo, projections, sync adapter |
| 3 | intent log | push, durable, **one per gesture** | `Editor.commit` / `Gesture.end` → `IntentEvent` | provenance, agent, SQL read model, sync |

`diffs ≠ log`: a diff is the *effect* of one commit; the log is the *attributed intent*, coalesced to
one event per gesture (not per frame). The throttle sits between hot-path frames and the log.

## What is signia vs ours

- **[signia / `@tldraw/state`]** the reactive substrate: `atom`, `computed`, `transact`, `react`, and
  delta plumbing. Confined to `store.ts` (the layer that binds the substrate) and exposed only as
  `Subscribable<T>` (`subscribable.ts`), so the library is swappable — nothing downstream imports it
  (the entire `interaction/` layer has zero signia imports).
- **[ours]** everything above §2.2: the record store, record-level **diff algebra** (`diff.ts` —
  `squash`/`invert`/`apply`, the part signia does not give), the command + **intent log** (`log.ts`),
  gesture coalescing (`editor.ts`), and downstream consumers (`undo.ts`).

## Layout

```
src/
  subscribable.ts  channel 1 handle interface (the swappable seam over signia)
  records.ts       Node/Edge/Layout — the semantic↔layout split (doc §9.3) + id helpers
  diff.ts          RecordsDiff + DiffBuffer + squash/invert/apply/summarize
  store.ts         the thin store on signia: 3 channels, transact, gestures, snapshot, version
  log.ts           Command / IntentEvent / IntentLog (MemoryIntentLog)
  commands.ts      "one mutation API, three clients" — default canvas command handlers
  editor.ts        write authority: commit / tryCommit / beginGesture (gesture coalescing)
  undo.ts          downstream consumer demo: undo/redo on channel 2 + the diff algebra
  index.ts         public surface
```

## Key behaviors (all covered by `test/`)

- **Per-entity reactivity**: moving node B never fires node A's handle; a semantic title edit never
  fires the layout handle (the split earns its keep).
- **One diff per transaction**; **version** bumps once per non-empty commit (the optimistic-concurrency base).
- **Gesture coalescing**: a 60-frame drag → channel 1 fires 60×, channel 2 + the log fire **once**.
  `cancel()` reverts the live atoms and emits nothing.
- **`tryCommit`** rejects a stale base → the 80/20 concurrency primitive (LWW now, policy swappable).
- **Undo**: one gesture = one undo step, for free, via `invertDiff` over channel 2.

```sh
npm install
npm test        # node --import tsx --test
npm run typecheck
```

## Deliberately not here yet

- Durable log/persistence tier (IndexedDB / SQLite) — `MemoryIntentLog` is the drop-in seam.
- SQL projection / agent MCP surface — a channel-2 consumer, same as `undo.ts`.
- Viewport virtualization — a *renderer* concern (the render-edge spike showed the renderer is the swap
  point, not the store).
- ~~The **interaction layer** (camera, hit-test, selection, drag mechanics, tools)~~ — **built** in
  `../interaction` (`@canvas/interaction`). It drives gestures/commands into this store: a drag = one
  `beginGesture/end` = one `moveNodes` `IntentEvent`; its spatial index is a channel-2 consumer like
  `undo.ts`. The `moveNodes` command handler here is its non-interactive counterpart.
- Incremental queries — `query()` recomputes from scratch by design; swap a single computed if profiled hot.
```
