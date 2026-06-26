import type { LayoutRecord, RecordsDiff, Store } from "./core.js";
import { boxContainsPoint, boxIntersects, type Box, type Vec } from "./geometry.js";

// Hit-testing & marquee need to answer "what's under this page point?" and "what's inside this page
// box?" over node bounds. That's a spatial-index job. We define the INTERFACE and ship a brute-force
// default, because:
//   - this is the one genuinely-modular, genuinely-hard-to-do-well piece, so it's the right thing to
//     keep swappable (a stated value);
//   - at this product stage the DOM renderer caps interesting N around 10–20k anyway (browser spike),
//     where a linear scan of node boxes is microseconds — premature to pull a dependency;
//   - BUT when profiling demands it, **rbush** (MIT, ~3kB R-tree) is the documented drop-in: wrap its
//     insert/remove/search behind this same interface and nothing else in the layer changes.
//
// Keys are NODE ids (selection/hit results are node ids); boxes + stacking come from LayoutRecords
// (layout:<nodeId>). z-order is the record's explicit `z` (not insertion order): hitPoint returns the
// highest-z node containing the point, with insertion order as the tiebreak for equal z.
export interface SpatialIndex {
  insert(nodeId: string, box: Box, z?: number): void;
  update(nodeId: string, box: Box, z?: number): void;
  remove(nodeId: string): void;
  /**
   * Topmost (highest-z) node whose box contains the point, or undefined. `margin` (page units,
   * default 0) grows each box outward before the test, so clicks a few px outside an edge still land
   * — the equivalent of tldraw's hitTestMargin. Callers pass a screen-px margin divided by zoom so
   * it's constant on screen regardless of camera scale.
   */
  hitPoint(p: Vec, margin?: number): string | undefined;
  /** All node ids whose box intersects the query box (marquee), in ascending z-order. */
  hitTest(box: Box): string[];
  boxOf(nodeId: string): Box | undefined;
  /**
   * Highest z currently in the index (−1 when empty) — the base for "bring to front". `exclude`
   * skips a set of node ids, so a caller can ask "the top z among everything I'm NOT raising" and
   * tell whether a selection is already on top (no restack needed).
   */
  topZ(exclude?: ReadonlySet<string>): number;
  clear(): void;
}

export class BruteForceIndex implements SpatialIndex {
  // Insertion-ordered Map; each entry carries its box + stacking z. Iteration order breaks z ties.
  private entries = new Map<string, { box: Box; z: number }>();

  insert(nodeId: string, box: Box, z = 0): void {
    this.entries.set(nodeId, { box, z });
  }
  update(nodeId: string, box: Box, z = 0): void {
    this.entries.set(nodeId, { box, z }); // Map.set keeps the original slot → stable tiebreak order
  }
  remove(nodeId: string): void {
    this.entries.delete(nodeId);
  }
  boxOf(nodeId: string): Box | undefined {
    return this.entries.get(nodeId)?.box;
  }
  topZ(exclude?: ReadonlySet<string>): number {
    let top = -1;
    for (const [id, { z }] of this.entries) {
      if (exclude?.has(id)) continue;
      if (z > top) top = z;
    }
    return top;
  }
  clear(): void {
    this.entries.clear();
  }

  hitPoint(p: Vec, margin = 0): string | undefined {
    let hit: string | undefined;
    let hitZ = -Infinity;
    for (const [id, { box, z }] of this.entries) {
      const b = margin ? { x: box.x - margin, y: box.y - margin, w: box.w + 2 * margin, h: box.h + 2 * margin } : box;
      // `z >= hitZ` (not >) so equal-z ties resolve to the LAST in insertion order — preserving the
      // old "later-added sits on top" behavior when nothing has been explicitly restacked.
      if (boxContainsPoint(b, p) && z >= hitZ) {
        hit = id;
        hitZ = z;
      }
    }
    return hit;
  }

  hitTest(box: Box): string[] {
    const out: { id: string; z: number }[] = [];
    for (const [id, { box: b, z }] of this.entries) {
      if (boxIntersects(box, b)) out.push({ id, z });
    }
    return out.sort((a, b) => a.z - b.z).map((e) => e.id);
  }
}

const layoutBox = (l: LayoutRecord): Box => ({ x: l.x, y: l.y, w: l.w, h: l.h });

/**
 * Keep a SpatialIndex in lock-step with the store's LayoutRecords by consuming channel 2 — the same
 * "downstream consumer speaks only RecordsDiff" pattern as undo.ts. Seeds from the current snapshot,
 * then maintains incrementally. Returns an unsubscribe. NOTE: channel 2 is silent during a gesture,
 * so the index updates ONCE at gesture end (after a drag) — which is correct: you don't hit-test the
 * thing you're dragging mid-drag, and the renderer tracks live moves via channel 1 atoms regardless.
 */
export function syncIndexFromStore(store: Store, index: SpatialIndex): () => void {
  // A floating (anchor "screen") card is chrome, not world content: its x/y are SCREEN pixels, so
  // indexing it would plant a phantom hit-box at those page coordinates. We skip it on insert and,
  // crucially, REMOVE it on update — so flipping a live card to "screen" (pin) takes it out of
  // hit-testing, and flipping back ("world") re-inserts it.
  const sync = (r: LayoutRecord): void => {
    if (r.anchor === "screen") index.remove(r.nodeId);
    else index.update(r.nodeId, layoutBox(r), r.z);
  };
  for (const r of store.getSnapshot().records) {
    if (r.typeName === "layout") sync(r);
  }
  const onLayout = (d: RecordsDiff) => {
    for (const id in d.added) {
      const r = d.added[id]!;
      if (r.typeName === "layout") sync(r);
    }
    for (const id in d.updated) {
      const r = d.updated[id]![1];
      if (r.typeName === "layout") sync(r);
    }
    for (const id in d.removed) {
      const r = d.removed[id]!;
      if (r.typeName === "layout") index.remove(r.nodeId);
    }
  };
  return store.listen(onLayout);
}
