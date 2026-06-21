import { atom, transact as signiaTransact, computed, type Atom } from "@tldraw/state";
import type { AnyRecord, RecordOf } from "./records.js";
import { DiffBuffer, emptyDiff, invertDiff, isEmptyDiff, type RecordsDiff } from "./diff.js";
import { toSubscribable, type Subscribable } from "./subscribable.js";

// Who caused a change — rides channel 2 so consumers (undo, persistence, agent-wake) can filter.
export type ChangeSource = "user" | "agent" | "remote";

export interface QuerySpec<TN extends AnyRecord["typeName"]> {
  typeName: TN;
  where?: (r: RecordOf[TN]) => boolean;
}

export interface Snapshot {
  records: AnyRecord[];
  version: number;
}

// The thin store, built ON signia (doc §2.2). signia gives the reactive substrate (one atom per
// record = finest granularity) + transactions; everything here — record-level diff assembly, the
// three channels, snapshots, the version token — is ours.
//
//   channel 1  reactive handles (pull)  -> get / getSignal / query   [signia computeds]
//   channel 2  record diff stream (push)-> listen                    [assembled at commit, ours]
//   (channel 3 — the intent log — lives one layer up, in Editor)
export class Store {
  private atoms = new Map<string, Atom<AnyRecord>>();
  private idsAtom = atom<string[]>("store:ids", []); // changes ONLY on structural add/remove
  private listeners = new Set<(diff: RecordsDiff, source: ChangeSource) => void>();

  // A buffer is open while inside transact() or a gesture; nested mutations join it (one diff).
  private buffer: DiffBuffer | null = null;
  private _version = 0;

  /** Monotonic; bumps once per non-empty commit. The base token for optimistic concurrency (§10.2). */
  get version(): number {
    return this._version;
  }

  // ── channel 1: reactive handles (pull) ────────────────────────────────────────────
  /** Tracked read — call inside a computed/gesture to establish a dependency. */
  get<TN extends AnyRecord["typeName"]>(id: string): RecordOf[TN] | undefined {
    return this.atoms.get(id)?.get() as RecordOf[TN] | undefined;
  }

  /** A per-entity handle. Re-fires on this record's own changes (and on its add/remove). */
  getSignal<TN extends AnyRecord["typeName"]>(id: string): Subscribable<RecordOf[TN] | undefined> {
    const c = computed(`store:sig:${id}`, () => {
      this.idsAtom.get(); // depend on structural changes so add/remove re-resolves the atom
      return this.atoms.get(id)?.get() as RecordOf[TN] | undefined;
    });
    return toSubscribable(c);
  }

  /**
   * Reactive query → a computed. Recomputes from scratch (reads every record), per the documented
   * decision (doc §8.3.1): deltas are latent capacity, realized first at the projection seam, not here.
   * If a profile ever says a specific query is hot, swap THIS computed for an incremental one.
   */
  query<TN extends AnyRecord["typeName"]>(spec: QuerySpec<TN>): Subscribable<RecordOf[TN][]> {
    const c = computed(`store:query:${spec.typeName}`, () => {
      const out: RecordOf[TN][] = [];
      for (const id of this.idsAtom.get()) {
        const r = this.atoms.get(id)?.get();
        if (r && r.typeName === spec.typeName) {
          const rec = r as RecordOf[TN];
          if (!spec.where || spec.where(rec)) out.push(rec);
        }
      }
      return out;
    });
    return toSubscribable(c);
  }

  // ── write path ────────────────────────────────────────────────────────────────────
  // Every mutation flows through transact(): atoms update atomically (signia), the buffer records
  // what changed, and ONE RecordsDiff is emitted at the close. Returns that diff (empty if nested).
  transact(fn: () => void, source: ChangeSource = "user"): RecordsDiff {
    if (this.buffer) {
      fn(); // nested — the outer transact/gesture owns the diff
      return emptyDiff();
    }
    this.buffer = new DiffBuffer();
    let diff: RecordsDiff;
    try {
      signiaTransact(fn);
    } finally {
      diff = this.buffer.build();
      this.buffer = null;
    }
    if (!isEmptyDiff(diff)) {
      this._version++;
      this.emit(diff, source);
    }
    return diff;
  }

  put(records: AnyRecord[], source: ChangeSource = "user"): RecordsDiff {
    return this.transact(() => {
      for (const r of records) this.rawPut(r);
    }, source);
  }

  update<R extends AnyRecord>(id: R["id"], patch: Partial<R>, source: ChangeSource = "user"): RecordsDiff {
    return this.transact(() => this.rawUpdate(id, patch), source);
  }

  remove(ids: string[], source: ChangeSource = "user"): RecordsDiff {
    return this.transact(() => {
      for (const id of ids) this.rawRemove(id);
    }, source);
  }

  /** Apply a diff as a real change (used by undo/redo and remote sync). Emits one diff; returns it. */
  applyDiffAsChange(d: RecordsDiff, source: ChangeSource = "user"): RecordsDiff {
    return this.transact(() => {
      for (const id in d.added) this.rawPut(d.added[id]!);
      for (const id in d.updated) this.rawPut(d.updated[id]![1]);
      for (const id in d.removed) this.rawRemove(id);
    }, source);
  }

  // ── channel 2: record diff stream (push) ────────────────────────────────────────────
  listen(fn: (diff: RecordsDiff, source: ChangeSource) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── durability: document tier (doc §8.4) ────────────────────────────────────────────
  getSnapshot(): Snapshot {
    return { records: [...this.atoms.values()].map((a) => a.get()), version: this._version };
  }

  loadSnapshot(s: Snapshot): void {
    signiaTransact(() => {
      this.atoms.clear();
      for (const r of s.records) this.atoms.set(r.id, atom(`rec:${r.id}`, r));
      this.idsAtom.set(s.records.map((r) => r.id));
    });
    this._version = s.version; // a load is not a diff; consumers re-read from the snapshot
  }

  // ── gesture support (driven by Editor.beginGesture) ─────────────────────────────────
  // Opens a buffer that stays silent on channel 2 across many frames; channel 1 stays LIVE (atoms
  // update each frame), so the renderer sees 60fps while persistence/undo see ONE diff at the end.
  beginGesture(): void {
    if (this.buffer) throw new Error("Store: cannot begin a gesture inside another change");
    this.buffer = new DiffBuffer();
  }
  gestureFrame(fn: () => void): void {
    if (!this.buffer) throw new Error("Store: gestureFrame outside a gesture");
    signiaTransact(fn); // atoms live this frame; buffer accumulates via rawUpdate
  }
  endGesture(source: ChangeSource): RecordsDiff {
    if (!this.buffer) throw new Error("Store: endGesture outside a gesture");
    const diff = this.buffer.build();
    this.buffer = null;
    if (!isEmptyDiff(diff)) {
      this._version++;
      this.emit(diff, source); // the one coalesced diff for the whole gesture
    }
    return diff;
  }
  cancelGesture(): void {
    if (!this.buffer) throw new Error("Store: cancelGesture outside a gesture");
    const inverse = invertDiff(this.buffer.build());
    this.buffer = null;
    // Revert the live atoms so the renderer snaps back; no version bump, nothing emitted on ch2.
    signiaTransact(() => this.applyDiffToAtoms(inverse));
  }

  // ── internals ───────────────────────────────────────────────────────────────────────
  private emit(diff: RecordsDiff, source: ChangeSource): void {
    for (const fn of this.listeners) fn(diff, source);
  }

  // rawPut handles both add and full-replace; touches the active buffer.
  private rawPut(r: AnyRecord): void {
    const existing = this.atoms.get(r.id);
    const prev = existing?.get();
    if (existing) {
      existing.set(r);
    } else {
      this.atoms.set(r.id, atom(`rec:${r.id}`, r));
      this.idsAtom.set([...this.idsAtom.get(), r.id]);
    }
    this.buffer!.touch(r.id, prev, r);
  }

  private rawUpdate(id: string, patch: Partial<AnyRecord>): void {
    const a = this.atoms.get(id);
    if (!a) return;
    const prev = a.get();
    const next = { ...prev, ...patch } as AnyRecord;
    a.set(next);
    this.buffer!.touch(id, prev, next);
  }

  private rawRemove(id: string): void {
    const a = this.atoms.get(id);
    if (!a) return;
    const prev = a.get();
    this.atoms.delete(id);
    this.idsAtom.set(this.idsAtom.get().filter((x) => x !== id));
    this.buffer!.touch(id, prev, undefined);
  }

  // Apply a diff straight to atoms with NO buffer/diff bookkeeping (cancel-gesture revert only).
  private applyDiffToAtoms(d: RecordsDiff): void {
    for (const id in d.added) {
      const r = d.added[id]!;
      const a = this.atoms.get(id);
      if (a) a.set(r);
      else {
        this.atoms.set(id, atom(`rec:${id}`, r));
        this.idsAtom.set([...this.idsAtom.get(), id]);
      }
    }
    for (const id in d.updated) this.atoms.get(id)?.set(d.updated[id]![1]);
    for (const id in d.removed) {
      this.atoms.delete(id);
      this.idsAtom.set(this.idsAtom.get().filter((x) => x !== id));
    }
  }
}
