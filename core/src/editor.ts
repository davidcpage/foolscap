import { emptyDiff, type RecordsDiff } from "./diff.js";
import { MemoryIntentLog, type Command, type IntentEvent, type IntentLog } from "./log.js";
import { uid } from "./records.js";
import { Store, type ChangeSource } from "./store.js";
import { defaultCommands, type CommandHandler } from "./commands.js";

function actorToSource(actor: string): ChangeSource {
  return actor === "human" || actor === "user" ? "user" : actor === "remote" ? "remote" : "agent";
}

export interface EditorOptions {
  store?: Store;
  log?: IntentLog;
  /** Extra command handlers, merged over the defaults. */
  handlers?: Record<string, CommandHandler>;
}

// The write authority over the store. Owns channel 3 (the intent log) and the gesture boundary.
// Reads still go straight through editor.store (channel 1) / store.listen (channel 2).
export class Editor {
  readonly store: Store;
  readonly log: IntentLog;
  private handlers: Map<string, CommandHandler>;

  constructor(opts: EditorOptions = {}) {
    this.store = opts.store ?? new Store();
    this.log = opts.log ?? new MemoryIntentLog();
    this.handlers = new Map(Object.entries({ ...defaultCommands, ...(opts.handlers ?? {}) }));
  }

  register(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  // Apply one intent: run the handler inside ONE store transaction (→ one diff), then append ONE
  // attributed event carrying that diff. The single path for human, agent, and internal writes.
  commit(cmd: Command): IntentEvent {
    const handler = this.handlers.get(cmd.type);
    if (!handler) throw new Error(`Editor: no handler for command "${cmd.type}"`);
    const parent = this.store.version;
    const diff = this.store.transact(() => handler(this.store, cmd.payload), actorToSource(cmd.actor));
    return this.record(cmd, parent, diff);
  }

  // Optimistic variant (§10.2/§10.4): rejects if the store moved past `base`. null → caller retries.
  // The 80/20 concurrency primitive; carrying parent-version per event keeps the policy swappable.
  tryCommit(cmd: Command, base: number): IntentEvent | null {
    if (this.store.version !== base) return null;
    return this.commit(cmd);
  }

  // GESTURE COALESCING (doc §8.1.1): the interaction layer opens a gesture; each frame's update()
  // mutates atoms live (channel 1 fires) while channel 2 stays silent; end() emits ONE diff and
  // appends ONE IntentEvent. This is what holds the log at one-event-per-gesture under a 60fps drag.
  beginGesture(type: string, actor: string): Gesture {
    const parent = this.store.version;
    this.store.beginGesture();
    return new GestureHandle(this, type, actor, parent);
  }

  /** @internal — used by the gesture handle to finalize. The log assigns the event's seq. */
  record(cmd: Command, parent: number, diff: RecordsDiff): IntentEvent {
    return this.log.append({
      id: `evt:${uid()}`,
      ts: Date.now(),
      parent,
      type: cmd.type,
      payload: cmd.payload,
      actor: cmd.actor,
      diff,
    });
  }
}

export interface Gesture {
  /** Mutate the store for one frame; channel 1 fires, channel 2 waits for end(). */
  update(frame: () => void): void;
  /** Commit the coalesced gesture: one diff on channel 2, one IntentEvent on channel 3. */
  end(payload?: unknown): IntentEvent;
  /** Abort: revert the live atoms; nothing reaches channel 2 or the log. */
  cancel(): void;
}

class GestureHandle implements Gesture {
  private done = false;
  constructor(
    private readonly editor: Editor,
    private readonly type: string,
    private readonly actor: string,
    private readonly parent: number,
  ) {}

  update(frame: () => void): void {
    if (this.done) throw new Error("Gesture: update after end/cancel");
    this.editor.store.gestureFrame(frame);
  }

  end(payload: unknown = {}): IntentEvent {
    if (this.done) throw new Error("Gesture: end after end/cancel");
    this.done = true;
    const diff = this.editor.store.endGesture(actorToSource(this.actor));
    return this.editor.record({ type: this.type, payload, actor: this.actor }, this.parent, diff);
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.editor.store.cancelGesture();
  }
}

// Re-export for convenience; emptyDiff used by callers that need a placeholder.
export { emptyDiff };
