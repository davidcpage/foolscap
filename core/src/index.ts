// @canvas/core — the reactive serializable core store.
//
//   channel 1  reactive handles (pull)   Store.get / getSignal / query  → Subscribable<T>
//   channel 2  record diff stream (push) Store.listen                    → (RecordsDiff, source)
//   channel 3  intent log (per gesture)  Editor.commit / Gesture.end     → IntentEvent
//
// See ./README.md and ../core-store-sketch.ts for the [signia] vs [ours] boundary.

export type { Subscribable } from "./subscribable.js";
export { toSubscribable } from "./subscribable.js";

export type {
  AnyRecord,
  BaseRecord,
  EdgeRecord,
  Id,
  LayoutRecord,
  NodeRecord,
  NoteColor,
  RecordId,
  RecordOf,
} from "./records.js";
export { edgeId, layoutId, nodeId, NOTE_COLORS, uid } from "./records.js";

export type { RecordsDiff } from "./diff.js";
export { applyDiff, emptyDiff, invertDiff, isEmptyDiff, squashDiffs, summarizeDiff } from "./diff.js";

export type { ChangeSource, QuerySpec, Snapshot } from "./store.js";
export { Store } from "./store.js";

export type { Command, IntentEvent, IntentLog, UnsequencedIntentEvent } from "./log.js";
export { MemoryIntentLog } from "./log.js";

export type { CommandHandler } from "./commands.js";
export { defaultCommands } from "./commands.js";

export type { EditorOptions, Gesture } from "./editor.js";
export { Editor } from "./editor.js";

export { UndoManager } from "./undo.js";

export type {
  EventStore,
  SnapshotStore,
  HydrateResult,
  PersistedSnapshot,
  PersistenceOptions,
} from "./persist.js";
export { Persistence, MemoryEventStore, MemorySnapshotStore } from "./persist.js";
