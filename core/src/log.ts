import { summarizeDiff, type RecordsDiff } from "./diff.js";

// Channel 3 (doc §8.1.1 / §10.3): the append-only, attributed, causally-ordered INTENT LOG.
// One event per *gesture* (not per frame). This is the seam nothing in signia provides, and the
// one that keeps the conflict policy deferrable: ship LWW now, swap to optimistic/CRDT later
// without touching this contract. It also backs the future SQL/provenance read model
// (Datomic/event-sourcing precedent, doc §deep-dive).
//
// Two orderings live on an event, deliberately distinct:
//   seq    — position in the log's TOTAL order, assigned at append. The master-timeline clock:
//            since(), hydration tails, and snapshot watermarks key off seq alone.
//   parent — the store.version the act was BASED on (its causal basis): the input to the
//            conflict policy (§10.2) and, later, the edge structure of a commit graph. It
//            coincides with seq only while history is strictly linear (single writer, hard
//            tryCommit) — never use it as a sequence number.

export interface Command {
  type: string; // "addNode" | "moveNode" | "setTitle" | ...
  payload: unknown;
  actor: string; // "human" | "claude" | ...
}

export interface IntentEvent extends Command {
  id: string;
  ts: number;
  seq: number; // position in the log's total order (1-based) — assigned by append()
  parent: number; // store.version this was based on → optimistic-concurrency check (§10.2)
  diff: RecordsDiff; // materialized effect: fast replay/audit, and what undo inverts
}

/** An event not yet placed in the timeline. `seq` is present only when rebuilding from a durable log. */
export type UnsequencedIntentEvent = Omit<IntentEvent, "seq"> & { seq?: number };

export interface IntentLog {
  /** Place in the timeline (assign the next seq — or adopt a pre-assigned one when rebuilding
   *  from a durable log) and append. Returns the sequenced event. */
  append(e: UnsequencedIntentEvent): IntentEvent;
  /** Events strictly after position `seq` in the log's total order — for sync / catch-up. */
  since(seq: number): IntentEvent[];
  all(): IntentEvent[];
  /** Compact recent-intent summary for the agent (doc §9). */
  describe(n?: number): string;
}

// In-memory log. The durable tier (IndexedDB / SQLite-backed) is a drop-in that implements the
// same interface; deliberately not built yet (doc §8.4 log tier).
export class MemoryIntentLog implements IntentLog {
  private events: IntentEvent[] = [];
  private _lastSeq = 0;

  /** Seq of the newest event (0 = empty) — the watermark a snapshot taken now covers. */
  get lastSeq(): number {
    return this._lastSeq;
  }

  append(e: UnsequencedIntentEvent): IntentEvent {
    const seq = e.seq ?? this._lastSeq + 1;
    this._lastSeq = Math.max(this._lastSeq, seq);
    const event: IntentEvent = { ...e, seq };
    this.events.push(event);
    return event;
  }

  /** Advance the watermark to a seq assigned elsewhere (the server, once it is the single append
   *  point — design §10 seq handover). A no-op if we're already at/ahead of it. Keeps this tab's
   *  next locally-minted seq above the server's authoritative one, and its snapshot save stamping a
   *  watermark that reflects the events the server has appended (so compaction keeps its clock). */
  adopt(seq: number): void {
    this._lastSeq = Math.max(this._lastSeq, seq);
  }

  since(seq: number): IntentEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  all(): IntentEvent[] {
    return [...this.events];
  }

  describe(n = 10): string {
    const recent = this.events.slice(-n);
    if (recent.length === 0) return "(no intent yet)";
    return recent
      .map((e) => `${e.ts} ${e.actor} ${e.type} [${summarizeDiff(e.diff)}]`)
      .join("\n");
  }
}
