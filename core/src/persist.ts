import { applyDiff, isEmptyDiff } from "./diff.js";
import {
  MemoryIntentLog,
  type IntentEvent,
  type IntentLog,
  type UnsequencedIntentEvent,
} from "./log.js";
import type { AnyRecord } from "./records.js";
import { Store, type Snapshot } from "./store.js";

// Persistence — the durability tiers (doc §8.4) realized as a downstream consumer, in the same spirit
// as undo.ts: it speaks only the public seams (channel 2 + the IntentLog contract + getSnapshot/
// loadSnapshot) and never reaches into atoms or signia.
//
// SOURCE OF TRUTH = the intent log (event-sourced). The document snapshot is a fast-load CACHE: on
// boot we load the snapshot and REPLAY the tail of events committed after it (fold applyDiff over the
// log), so a crash between a committed gesture and the debounced snapshot loses nothing. This is the
// one choice that keeps BOTH downstream futures open (per the design notes): because the log is
// authoritative and each event is an attributed, parent-versioned, causally-ordered fact (≈ a commit),
//   • git-style branching/merge for multi-agent coordination becomes "interpret the log", not "add one";
//   • file-per-note (markdown + sidecar) becomes a backend swap below — see EventStore/SnapshotStore.
//
// The two backends are the SWAP POINT. v1 ships an IndexedDB pair (in the apps); a different
// instantiation supplies a filesystem-of-markdown pair behind the SAME interfaces — the semantic
// NodeRecord → a markdown file (frontmatter + body), the LayoutRecord/edges → a `.canvas` sidecar.
// Per-record granularity (not one opaque blob) is what keeps that swap a backend change, not a rewrite.

/** The authoritative tier: an append-only, ordered store of attributed intent events (doc §8.4 log). */
export interface EventStore {
  append(e: IntentEvent): Promise<void>;
  /** All events, in commit order. */
  loadAll(): Promise<IntentEvent[]>;
  /** Drop everything (used by tests / a "reset board" affordance). */
  clear(): Promise<void>;
}

/** What the cache tier stores: the document snapshot stamped with the LOG WATERMARK — the seq of
 *  the last event reflected in it. hydrate replays exactly the events with seq > watermark; it never
 *  filters on `parent` (a causal basis, which lags commit order once optimistic/merged commits
 *  exist). `seq` is optional only for snapshots persisted before the watermark existed. */
export type PersistedSnapshot = Snapshot & { seq?: number };

/** The cache tier: the latest materialized document snapshot for fast load (doc §8.4 document). */
export interface SnapshotStore {
  load(): Promise<PersistedSnapshot | null>;
  save(s: PersistedSnapshot): Promise<void>;
  clear(): Promise<void>;
}

// ── in-memory reference backends (the Node-test + reference impls, like MemoryIntentLog) ──────────────
export class MemoryEventStore implements EventStore {
  private events: IntentEvent[] = [];
  async append(e: IntentEvent): Promise<void> {
    this.events.push(e);
  }
  async loadAll(): Promise<IntentEvent[]> {
    return [...this.events];
  }
  async clear(): Promise<void> {
    this.events = [];
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  private snap: PersistedSnapshot | null = null;
  async load(): Promise<PersistedSnapshot | null> {
    return this.snap;
  }
  async save(s: PersistedSnapshot): Promise<void> {
    this.snap = s;
  }
  async clear(): Promise<void> {
    this.snap = null;
  }
}

export interface HydrateResult {
  /** The store version after hydration (snapshot.version + non-empty tail events). */
  version: number;
  /** How many tail events were replayed on top of the snapshot (0 = snapshot was current / none). */
  replayed: number;
  /** True when there was nothing persisted at all — the app should seed its starting board. */
  fresh: boolean;
}

export interface PersistenceOptions {
  events: EventStore;
  snapshots?: SnapshotStore;
  /** Debounce window (ms) for coalescing a burst of edits into one snapshot save. Default 400. */
  debounceMs?: number;
  /** Surface a durable-write failure (otherwise rejections are swallowed). */
  onError?: (err: unknown) => void;
}

// Implements IntentLog so it drops straight into `new Editor({ log: persistence })` — the durable log
// tier MemoryIntentLog promised. Reads (since/all/describe) hit an in-memory mirror (sync, like before);
// every append also enqueues a durable write. The snapshot half attaches to channel 2 separately.
export class Persistence implements IntentLog {
  private readonly mem = new MemoryIntentLog();
  private readonly events: EventStore;
  private readonly snapshots: SnapshotStore | null;
  private readonly debounceMs: number;
  private readonly onError: (err: unknown) => void;

  // Durable writes (events + snapshots) are serialized onto one promise chain so they land in order and
  // flush() can await the lot. A timer coalesces snapshot saves; `store` is captured in attach().
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private store: Store | null = null;
  private off: (() => void) | null = null;

  constructor(opts: PersistenceOptions) {
    this.events = opts.events;
    this.snapshots = opts.snapshots ?? null;
    this.debounceMs = opts.debounceMs ?? 400;
    this.onError = opts.onError ?? (() => {});
  }

  // ── IntentLog (channel 3) ───────────────────────────────────────────────────────────────────────
  append(e: UnsequencedIntentEvent): IntentEvent {
    const event = this.mem.append(e); // sync mirror assigns the seq + keeps since()/all()/describe() instant
    this.enqueue(() => this.events.append(event)); // and durably persist the SEQUENCED event
    return event;
  }
  since(seq: number): IntentEvent[] {
    return this.mem.since(seq);
  }
  /** Adopt a seq the server assigned (design §10): once the server is the single append point it mints
   *  the authoritative seq for every event — this tab's own gestures (returned by the durable append)
   *  and peer/agent commits (carried on the inbound diff). Advancing the mirror's watermark keeps the
   *  next locally-minted seq above the server's and the debounced snapshot stamping an honest watermark. */
  adoptSeq(seq: number): void {
    this.mem.adopt(seq);
  }
  all(): IntentEvent[] {
    return this.mem.all();
  }
  describe(n?: number): string {
    return this.mem.describe(n);
  }

  // ── boot: load snapshot + replay the tail (event-sourced) ─────────────────────────────────────────
  // Fills the in-memory log mirror from the durable log (so history survives reload), then folds the
  // post-snapshot tail into the store with ONE loadSnapshot — no channel-2 emits, so undo/the index
  // aren't polluted (the host re-seeds its index from the loaded snapshot via manager.start()).
  async hydrate(store: Store): Promise<HydrateResult> {
    const [snap, loaded] = await Promise.all([
      this.snapshots ? this.snapshots.load() : Promise.resolve(null),
      this.events.loadAll(),
    ]);
    // Rebuild the readable history. Events from the durable log keep their stored seq; events
    // persisted before seq existed get one assigned in load order — which IS commit order, the
    // backends being append-only.
    const all = loaded.map((e) => this.mem.append(e));

    // Adopt the snapshot's watermark into the mirror. The durable log may carry ONLY the post-watermark
    // tail (the app's boot payload ships just that — the absorbed prefix hydrates nothing and is fetched
    // lazily for provenance), so the mirror can be empty or start above 0. Without this, lastSeq would be
    // the last tail event's seq — or 0 when the tail is empty — and the next debounced snapshot would stamp
    // a watermark BELOW the real one, rolling it backwards (the remote store rejects that as a stale 409).
    // A no-op when the tail already carries a higher seq (adopt takes the max).
    if (snap?.seq !== undefined) this.mem.adopt(snap.seq);

    const records = new Map<string, AnyRecord>();
    if (snap) for (const r of snap.records) records.set(r.id, r);

    // The tail = events not yet baked into the snapshot, keyed on the snapshot's seq WATERMARK
    // (the log's total order) — never on `parent`, whose causal basis may lag commit order
    // arbitrarily once optimistic/merged commits exist. Pre-watermark snapshots fall back to the
    // parent≡order coincidence that held while history was strictly linear.
    const base = snap?.seq;
    const tail =
      base !== undefined
        ? all.filter((e) => e.seq > base)
        : all.filter((e) => e.parent >= (snap?.version ?? 0));
    let version = snap?.version ?? 0;
    for (const e of tail) {
      applyDiff(records, e.diff);
      if (!isEmptyDiff(e.diff)) version++;
    }
    store.loadSnapshot({ records: [...records.values()], version });

    const fresh = !snap && all.length === 0;
    return { version, replayed: tail.length, fresh };
  }

  // ── snapshot cache: save on change, debounced (channel 2 consumer) ────────────────────────────────
  attach(store: Store): void {
    this.store = store;
    if (!this.snapshots || this.off) return;
    this.off = store.listen(() => this.scheduleSnapshot());
  }

  private scheduleSnapshot(): void {
    if (!this.snapshots) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveSnapshotNow();
    }, this.debounceMs);
    // In Node the timer would hold the process open; unref so a host (or test) can still exit while a
    // debounce is pending. No-op in the browser, where setTimeout returns a number.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private saveSnapshotNow(): void {
    if (!this.snapshots || !this.store) return;
    // Stamp the log watermark: every event with seq ≤ this is reflected in the snapshot. Safe to
    // read here because an event appends in the same synchronous tick as its channel-2 emit, so
    // the mirror is never behind the store when the debounce timer fires.
    const snap: PersistedSnapshot = { ...this.store.getSnapshot(), seq: this.mem.lastSeq };
    this.enqueue(() => this.snapshots!.save(snap));
  }

  /** Await all queued durable writes (events + any scheduled snapshot) WITHOUT forcing a new snapshot. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  /** Force any pending snapshot + all queued durable writes to complete (beforeunload / tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saveSnapshotNow();
    await this.chain;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  // Append to the serialized write chain; never let one rejection break the chain for the next write.
  private enqueue(op: () => Promise<void>): void {
    this.chain = this.chain.then(op).catch((err) => this.onError(err));
  }
}
