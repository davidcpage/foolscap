import { layoutId, type LayoutRecord, type Store, type Subscribable } from "./core.js";
import { Observable } from "./observable.js";
import { boxUnion, type Box } from "./geometry.js";

// Selection is session-tier (a set of NODE ids), reactive through the same Subscribable seam. Every
// mutator installs a NEW Set so the Observable's Object.is guard fires correctly; callers read the
// live set via `ids()` / `has()` and subscribe via `signal` (renderer draws outlines from it).
export class Selection {
  private obs = new Observable<ReadonlySet<string>>(new Set());

  get signal(): Subscribable<ReadonlySet<string>> {
    return this.obs;
  }
  ids(): string[] {
    return [...this.obs.get()];
  }
  has(id: string): boolean {
    return this.obs.get().has(id);
  }
  get size(): number {
    return this.obs.get().size;
  }

  set(ids: Iterable<string>): void {
    this.obs.set(new Set(ids));
  }
  add(ids: Iterable<string>): void {
    const next = new Set(this.obs.get());
    for (const id of ids) next.add(id);
    this.obs.set(next);
  }
  remove(ids: Iterable<string>): void {
    const next = new Set(this.obs.get());
    for (const id of ids) next.delete(id);
    this.obs.set(next);
  }
  toggle(id: string): void {
    const next = new Set(this.obs.get());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.obs.set(next);
  }
  clear(): void {
    if (this.obs.get().size > 0) this.obs.set(new Set());
  }
}

/**
 * Which lone node a selection's resize handles belong to: the single selected node, or — for a
 * CLUSTER (one seed whose directed expansion covers every other selected card, e.g. a thread and its
 * open member cards) — the seed itself. null for any other multi-selection. Shared by the select
 * tool's corner hit-test and the renderer's handle overlay so they can never disagree about where
 * handles live: without this, selecting a thread auto-pulls its members in and the size-1 handle gate
 * made every populated thread card permanently unresizable.
 */
export function resizeTargetId(ids: readonly string[], expand?: (nodeId: string) => string[]): string | null {
  if (ids.length === 1) return ids[0]!;
  if (ids.length < 2 || !expand) return null;
  let target: string | null = null;
  for (const id of ids) {
    const cluster = expand(id);
    if (!cluster.length) continue;
    const covered = new Set([id, ...cluster]);
    if (!ids.every((other) => covered.has(other))) continue;
    if (target) return null; // two seeds each cover the whole selection — ambiguous, no handles
    target = id;
  }
  return target;
}

/**
 * Bounding box of the selected nodes in page space (null if empty / no layouts) — drives the
 * selection rectangle + resize handles a renderer would draw. Recomputed on demand from the store's
 * layout records (a coarse op, not a hot path), reading current handle values so it reflects a drag.
 */
export function selectionBounds(store: Store, ids: Iterable<string>): Box | null {
  const boxes: Box[] = [];
  for (const nodeId of ids) {
    const l = store.get<"layout">(layoutId(nodeId as `node:${string}`)) as LayoutRecord | undefined;
    if (l) boxes.push({ x: l.x, y: l.y, w: l.w, h: l.h });
  }
  return boxUnion(boxes);
}

/**
 * Bounding box of EVERY node on the board in page space (null for an empty board) — what "zoom to fit
 * all" frames. Reads the layout records straight off the snapshot (a coarse, on-demand op, not a hot
 * path). A `skip` predicate drops layouts that aren't world content — screen-anchored (floating)
 * cards store their x/y in screen pixels, so including them would warp the fit; the renderer passes a
 * predicate that excludes them.
 */
export function worldBounds(store: Store, skip?: (l: LayoutRecord) => boolean): Box | null {
  const boxes: Box[] = [];
  for (const r of store.getSnapshot().records) {
    if (r.typeName !== "layout") continue;
    const l = r as LayoutRecord;
    if (skip?.(l)) continue;
    boxes.push({ x: l.x, y: l.y, w: l.w, h: l.h });
  }
  return boxUnion(boxes);
}
