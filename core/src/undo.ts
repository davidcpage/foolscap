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
// A diff's record-id signature — the sorted ids it adds / removes / updates. A good discriminator for
// matching a stack entry to a rolled-back edit (two unrelated edits rarely touch the exact same id set)
// without a deep value compare. Used by UndoManager.forget.
function keyOf(d: RecordsDiff): string {
  return JSON.stringify([Object.keys(d.added).sort(), Object.keys(d.removed).sort(), Object.keys(d.updated).sort()]);
}

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

  /** Drop the undo entry for a committed diff that was ROLLED BACK out-of-band (design §9 stage 3, §4): a
   *  server 4xx reject re-applies the edit's inverse as a "remote" change (not itself undoable) — but the
   *  original "user" commit already pushed its inverse onto this stack, and a later Ctrl-Z would then revert
   *  something already gone (double-apply). So forget that void entry. Matches by the record-id keysets of
   *  the inverse (the stack holds invertDiff(committed)); removes the TOPMOST match (the rejected edit is the
   *  most recent), or no-ops if it was already undone/superseded. Returns whether an entry was removed. */
  forget(committed: RecordsDiff): boolean {
    const target = keyOf(invertDiff(committed));
    for (let i = this.undos.length - 1; i >= 0; i--) {
      if (keyOf(this.undos[i]!) === target) {
        this.undos.splice(i, 1);
        return true;
      }
    }
    return false;
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
