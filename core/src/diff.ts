import type { AnyRecord } from "./records.js";

// Channel 2 unit (doc §8.1.1 / §2.2): the record-level diff. This is the "composable signed
// delta" realized over records. signia gives delta PLUMBING (computeDiff/getDiffSince/withDiff)
// but NOT this — WE define what a diff *is* (record granularity) and how it composes. The store
// assembles exactly one of these per committed transaction / per gesture.
export interface RecordsDiff {
  added: Record<string, AnyRecord>;
  updated: Record<string, readonly [from: AnyRecord, to: AnyRecord]>;
  removed: Record<string, AnyRecord>;
}

export function emptyDiff(): RecordsDiff {
  return { added: {}, updated: {}, removed: {} };
}

export function isEmptyDiff(d: RecordsDiff): boolean {
  for (const _ in d.added) return false;
  for (const _ in d.updated) return false;
  for (const _ in d.removed) return false;
  return true;
}

// Inverse: what undoes the diff (doc §10.3 — undo is invert + apply). added↔removed swap;
// each update flips [from, to] → [to, from].
export function invertDiff(d: RecordsDiff): RecordsDiff {
  const updated: Record<string, readonly [AnyRecord, AnyRecord]> = {};
  for (const id in d.updated) {
    const [from, to] = d.updated[id]!;
    updated[id] = [to, from];
  }
  return { added: { ...d.removed }, updated, removed: { ...d.added } };
}

// Apply a diff to a plain record map (for incremental projections / the SQL read model, doc §9.2).
// This is the PULL→PUSH realization at the OUTPUT seam; the store keeps its own atoms separately.
export function applyDiff(records: Map<string, AnyRecord>, d: RecordsDiff): void {
  for (const id in d.added) records.set(id, d.added[id]!);
  for (const id in d.updated) records.set(id, d.updated[id]![1]);
  for (const id in d.removed) records.delete(id);
}

// Accumulates writes across a transaction / gesture and computes ONE net diff at the close.
// Tracking only first-seen `origin` + latest `current` per id makes coalescing associative and
// O(touched): 60 drag frames → one diff; add-then-remove → nothing; add-then-update → one add.
export class DiffBuffer {
  private origin = new Map<string, AnyRecord | undefined>(); // value before this txn (undefined = absent)
  private current = new Map<string, AnyRecord | undefined>(); // latest value (undefined = removed)

  touch(id: string, prev: AnyRecord | undefined, next: AnyRecord | undefined): void {
    if (!this.origin.has(id)) this.origin.set(id, prev);
    this.current.set(id, next);
  }

  get size(): number {
    return this.origin.size;
  }

  build(): RecordsDiff {
    const diff = emptyDiff();
    for (const [id, o] of this.origin) {
      const c = this.current.get(id);
      if (!o && c) diff.added[id] = c;
      else if (o && !c) diff.removed[id] = o;
      else if (o && c && o !== c) diff.updated[id] = [o, c];
      // o&&c&&o===c (touched, unchanged) and !o&&!c (added then removed) → no-ops
    }
    return diff;
  }
}

// Associative coalesce of an already-emitted sequence (e.g. persistence throttling N diffs → 1).
export function squashDiffs(diffs: RecordsDiff[]): RecordsDiff {
  const buf = new DiffBuffer();
  for (const d of diffs) {
    for (const id in d.added) buf.touch(id, undefined, d.added[id]!);
    for (const id in d.updated) buf.touch(id, d.updated[id]![0], d.updated[id]![1]);
    for (const id in d.removed) buf.touch(id, d.removed[id]!, undefined);
  }
  return buf.build();
}

// Compact human/agent-readable counts for an intent-log line (doc §9).
export function summarizeDiff(d: RecordsDiff): string {
  const n = (o: object) => Object.keys(o).length;
  const parts: string[] = [];
  if (n(d.added)) parts.push(`+${n(d.added)}`);
  if (n(d.updated)) parts.push(`~${n(d.updated)}`);
  if (n(d.removed)) parts.push(`-${n(d.removed)}`);
  return parts.length ? parts.join(" ") : "no-op";
}
