import { invertDiff, type RecordsDiff } from "./diff.js";
import type { ChangeSource, Store } from "./store.js";

// A downstream consumer (doc §5 of the sketch): undo/redo built purely on channel 2 + the diff
// algebra. It subscribes to the store's diff stream and pushes the INVERSE of each committed diff.
// Because the store emits one diff per gesture, one drag = one undo step "for free". Nothing here
// reaches into atoms or signia — it only speaks RecordsDiff, which is the point of the seam.
//
// SELECTIVE undo (review §7): the stack holds only diffs whose ChangeSource matches this manager's
// `source` — Ctrl-Z means "undo MY last act", so an agent's commit or a remote ingest landing
// between two of my drags is never popped by my undo. A filtering decision over the linear channel-2
// stream (the tag is already there); the inverse still applies record-wise, so it composes with the
// interleaved foreign changes — unless they removed the record, in which case the inverse update is
// a no-op rather than a resurrection. `source` keeps its second job: undo/redo writes are emitted
// back onto channel 2 attributed to the same source they undo.
export class UndoManager {
  private undos: RecordsDiff[] = [];
  private redos: RecordsDiff[] = [];
  private applying = false;
  private readonly off: () => void;

  constructor(
    private readonly store: Store,
    private readonly source: ChangeSource = "user",
  ) {
    this.off = store.listen((diff, source) => {
      if (this.applying) return; // our own undo/redo writes must not re-enter the stack
      if (source !== this.source) return; // not ours — leave it for its author's undo
      this.undos.push(invertDiff(diff));
      this.redos.length = 0;
    });
  }

  get canUndo(): boolean {
    return this.undos.length > 0;
  }
  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  undo(): void {
    const inverse = this.undos.pop();
    if (!inverse) return;
    this.apply(inverse);
    this.redos.push(invertDiff(inverse));
  }

  redo(): void {
    const diff = this.redos.pop();
    if (!diff) return;
    this.apply(diff);
    this.undos.push(invertDiff(diff));
  }

  dispose(): void {
    this.off();
  }

  private apply(diff: RecordsDiff): void {
    this.applying = true;
    try {
      this.store.applyDiffAsChange(diff, this.source);
    } finally {
      this.applying = false;
    }
  }
}
