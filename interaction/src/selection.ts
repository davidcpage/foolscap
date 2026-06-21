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
