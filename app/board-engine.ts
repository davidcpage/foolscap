import { Store, type ChangeSource } from "../core/src/store.js";
import { applyDiff, isEmptyDiff, type RecordsDiff } from "../core/src/diff.js";
import { uid, type AnyRecord } from "../core/src/records.js";
import { defaultCommands, type CommandHandler } from "../core/src/commands.js";
import type { Command, IntentEvent } from "../core/src/log.js";
import { appendBoardEvent, readBoardPersist } from "./board-persist.js";
import { getServerContext } from "./server-context.js";

// ── the server-materialized board store (board-engine, design §9 stages 1+2) ────────────────────────
// The server hosts a LIVE core Store per board — hydrated exactly as a tab does (snapshot.json +
// events.jsonl tail fold via core's hydrate path) and kept current by folding each event that lands at
// POST /api/board/persist/event. Every server-side read (handleCanvasGet + the server-snapshot.ts
// resolvers) is served from this store instead of re-reading the debounced snapshot.json cache, so a
// read reflects the event tail the cache hasn't absorbed yet — the freshness win of design §5.
//
// READ AUTHORITY (stage 1) + WRITE AUTHORITY (stage 2, below): the server hosts the authoritative store.
// Stage 1 keeps the mirror live by OBSERVING each event append (foldBoardEvent, after appendBoardEvent),
// the same way the snapshot branch OBSERVES a save to run its membership/offset hooks. Stage 2
// (commitBoardCommand / recordTabEvent) makes the server the single APPEND POINT — /api/command commits
// server-side into this store and mints the authoritative seq, so a read reflects a bus mutation the
// instant its response returns (no live tab, no replay buffer). See the WRITE AUTHORITY section below.
//
// THE RULE: the store map is pinned on fsState (globalThis) so a Vite plugin-graph re-eval doesn't
// orphan it. On any doubt after a reload — or if an incremental fold ever throws — we rehydrate from the
// files (cheap, and bit-identical to the live store by §5, since both fold the same inputs).

// The parsed shapes off disk (board-persist.js): a snapshot is core's PersistedSnapshot (records +
// version + the log-watermark seq); an event is a stored IntentEvent carrying its materialized diff.
interface PersistedSnapshot {
  records?: AnyRecord[];
  version?: number;
  seq?: number;
}
interface StoredEvent {
  seq?: number;
  parent?: number;
  diff?: RecordsDiff;
}

export interface BoardEngineEntry {
  store: Store;
  /** Highest event seq reflected in the store — the incremental-fold dedup watermark. */
  watermark: number;
  /** Whether ANY snapshot/event has ever been seen (a brand-new empty board is not "persisted"). */
  hasPersist: boolean;
}

/**
 * The pure fold — a faithful mirror of core's Persistence.hydrate (core/src/persist.ts:139-166): seed
 * the records map from the snapshot, adopt each event's stored seq (assigning one in append order to any
 * legacy seqless event, exactly as MemoryIntentLog.append does — core/src/log.ts:56-62), replay the tail
 * (seq > snapshot watermark) with the SAME applyDiff, and bump version once per non-empty diff. It cannot
 * call hydrate directly (that path is async and the server resolvers are sync), so the seam test proves
 * this computes the identical records+version as a real hydrate over the same files.
 */
export function foldSnapshotAndEvents(
  snapshot: PersistedSnapshot | null,
  events: StoredEvent[],
): { records: AnyRecord[]; version: number; watermark: number } {
  // Adopt/assign seqs identically to MemoryIntentLog.append: stored seq wins; a seqless event gets the
  // next slot in append order (which IS commit order, the log being append-only).
  let lastSeq = 0;
  const seqd = events.map((e) => {
    const seq = typeof e.seq === "number" ? e.seq : lastSeq + 1;
    lastSeq = Math.max(lastSeq, seq);
    return { ...e, seq };
  });

  const records = new Map<string, AnyRecord>();
  if (snapshot) for (const r of snapshot.records ?? []) records.set(r.id, r);

  // The tail = events not yet baked into the snapshot, keyed on the snapshot's seq WATERMARK — never on
  // parent (a causal basis) — with the same pre-watermark parent≡order fallback core uses for legacy data.
  const base = snapshot && typeof snapshot.seq === "number" ? snapshot.seq : undefined;
  const snapVersion = snapshot && typeof snapshot.version === "number" ? snapshot.version : 0;
  const tail =
    base !== undefined
      ? seqd.filter((e) => e.seq > base)
      : seqd.filter((e) => (e.parent as number) >= snapVersion);

  let version = snapVersion;
  for (const e of tail) {
    if (!e.diff) continue;
    applyDiff(records, e.diff);
    if (!isEmptyDiff(e.diff)) version++;
  }

  return { records: [...records.values()], version, watermark: Math.max(base ?? 0, lastSeq) };
}

function hydrateEntry(repoPath: string): BoardEngineEntry {
  const { events, snapshot } = readBoardPersist(repoPath) as {
    events: StoredEvent[];
    snapshot: PersistedSnapshot | null;
  };
  const folded = foldSnapshotAndEvents(snapshot, events);
  const store = new Store();
  store.loadSnapshot({ records: folded.records, version: folded.version });
  return { store, watermark: folded.watermark, hasPersist: !!snapshot || events.length > 0 };
}

function engineMap(): Map<string, BoardEngineEntry> {
  const fsState = getServerContext().fsState as { boardEngines?: Map<string, BoardEngineEntry> };
  return (fsState.boardEngines ??= new Map<string, BoardEngineEntry>());
}

/** The live store for a board, hydrated from files on first touch (pinned on fsState thereafter). */
export function getBoardEngine(boardId: string, repoPath: string): BoardEngineEntry {
  const map = engineMap();
  let entry = map.get(boardId);
  if (!entry) {
    entry = hydrateEntry(repoPath);
    map.set(boardId, entry);
  }
  return entry;
}

/** Drop the live store from a fresh set of files on next touch (module-identity doubt, §10). */
export function rehydrateBoardEngine(boardId: string, repoPath: string): BoardEngineEntry {
  const entry = hydrateEntry(repoPath);
  engineMap().set(boardId, entry);
  return entry;
}

/** Forget a board's live store (call when files change wholesale out-of-band: clear / import). */
export function dropBoardEngine(boardId: string): void {
  engineMap().delete(boardId);
}

/**
 * Reconcile the live store against a snapshot.json save. Records normally enter the store via event
 * folds, so a debounced save (seq ≤ what the store already reflects) is a no-op. But a snapshot can also
 * carry records that never came through an event echo — a directly-authored save, or an event whose echo
 * was lost — in which case the store must rehydrate to see them (§10 "rehydrate on doubt"; the backwards-
 * save 409 guard upstream keeps snapshot seq monotonic, so seq > watermark is the honest "ahead" signal).
 * A seqless save rehydrates to be safe. If no store is resident, the next read hydrates from files anyway.
 */
export function reconcileBoardEngineOnSnapshot(
  boardId: string,
  repoPath: string,
  snapshot: { seq?: unknown }, // only the watermark seq is read; records are re-read from disk on rehydrate
): void {
  const entry = engineMap().get(boardId);
  if (!entry) return; // no resident store — the next read hydrates fresh from files (incl. this snapshot)
  const snapSeq = typeof snapshot.seq === "number" ? snapshot.seq : undefined;
  if (snapSeq === undefined || snapSeq > entry.watermark) rehydrateBoardEngine(boardId, repoPath);
}

/**
 * Fold one just-appended event into the live store. Called after appendBoardEvent — by then the event is
 * already on disk, so a board hydrated lazily right here already reflects it (skipped by the watermark);
 * a board hydrated earlier folds it now. Idempotent via the seq watermark. On any error, drop the store
 * so the next read rehydrates from the (now-authoritative) files.
 */
export function foldBoardEvent(boardId: string, repoPath: string, ev: StoredEvent): void {
  try {
    const entry = getBoardEngine(boardId, repoPath);
    const seq = typeof ev.seq === "number" ? ev.seq : undefined;
    if (seq !== undefined && seq <= entry.watermark) return; // already reflected (hydrate saw it, or a dup)
    if (ev.diff) entry.store.applyDiffAsChange(ev.diff, "remote");
    entry.hasPersist = true;
    if (seq !== undefined) entry.watermark = Math.max(entry.watermark, seq);
  } catch (err) {
    console.warn(`[board-engine] fold failed for ${boardId}; dropping store to rehydrate from files:`, err);
    dropBoardEngine(boardId);
  }
}

/** The board's live records array, or null if nothing is persisted yet (mirrors the old null contract). */
export function boardStoreRecords(boardId: string, repoPath: string): Array<Record<string, unknown>> | null {
  const entry = getBoardEngine(boardId, repoPath);
  return entry.hasPersist ? (entry.store.getSnapshot().records as unknown as Array<Record<string, unknown>>) : null;
}

/** The /api/canvas snapshot payload (records + version + watermark seq), or null if nothing persisted. */
export function boardStoreCanvasSnapshot(
  boardId: string,
  repoPath: string,
): { records: Array<Record<string, unknown>>; version: number; seq: number } | null {
  const entry = getBoardEngine(boardId, repoPath);
  if (!entry.hasPersist) return null;
  const s = entry.store.getSnapshot();
  return { records: s.records as unknown as Array<Record<string, unknown>>, version: s.version, seq: entry.watermark };
}

// ── WRITE AUTHORITY (design §9 stage 2) ──────────────────────────────────────────────────────────────
// The server is the single APPEND POINT for a board: it commits bus commands into a server-side Editor
// over the live store, mints the authoritative seq (from the entry watermark — the board's one counter,
// already advanced by both bus commits below and the tab-echo fold), and durably appends the IntentEvent
// at commit time. Reads (GET /api/canvas, threadNode, …) therefore reflect a bus mutation the instant
// its HTTP response returns — no tab, no replay buffer, no debounce race. The resulting DIFF (not the
// command) is what the caller broadcasts to tabs; a tab applies it as a "remote" change and never
// re-commits or re-echoes it, so exactly ONE IntentEvent exists per command (§8 channel discipline).

// The actor → ChangeSource mapping (a faithful copy of Editor's private actorToSource): a human/user
// commit is "user", an ingested peer/agent commit is "remote", everything else is "agent". It rides
// channel 2 so undo/persistence/wake can filter — an agent's server-side commit is source "agent", so a
// tab's ⌘Z never pops it, exactly as before.
function actorToSource(actor: string): ChangeSource {
  return actor === "human" || actor === "user" ? "user" : actor === "remote" ? "remote" : "agent";
}

/**
 * Commit one bus command server-side (a faithful inline of core's Editor.commit — the server needs no
 * gesture machinery, and core/src/editor.ts's parameter-property syntax isn't loadable under the app's
 * strip-only `node --test` runner): validate against core's defaultCommands, run the handler in ONE store
 * transaction (→ one diff on channel 2), mint the board's next authoritative seq, durably append ONE
 * IntentEvent carrying that diff, and advance the watermark. The transaction already folded the change
 * into the live store, so the mutation is visible to every server read the instant this returns. The
 * returned event carries the diff (to broadcast to tabs) and the seq (to echo to the caller + adopt).
 *
 * Ordering + failure: the store mutates (transact) BEFORE the durable append. So if the append throws, the
 * store is one commit ahead of the files — drop it, so the next read rehydrates from the (authoritative)
 * files that never got the event, and rethrow for the caller to 500. An unknown command type throws before
 * any mutation, so there is nothing to heal (the caller reports it as a validation reject).
 */
export function commitBoardCommand(boardId: string, repoPath: string, cmd: Command): IntentEvent {
  const entry = getBoardEngine(boardId, repoPath);
  const handler = (defaultCommands as Record<string, CommandHandler>)[cmd.type];
  if (!handler) throw new Error(`board-engine: no handler for command "${cmd.type}"`);
  const parent = entry.store.version;
  const diff = entry.store.transact(() => handler(entry.store, cmd.payload), actorToSource(cmd.actor));
  const seq = entry.watermark + 1;
  const event: IntentEvent = { id: `evt:${uid()}`, ts: Date.now(), parent, seq, type: cmd.type, payload: cmd.payload, actor: cmd.actor, diff };
  try {
    appendBoardEvent(repoPath, event as unknown as Record<string, unknown>); // durable at commit — THROWS on IO failure
  } catch (err) {
    dropBoardEngine(boardId); // store is one commit ahead of the files — rehydrate from the files on next read
    throw err;
  }
  entry.watermark = seq;
  entry.hasPersist = true;
  return event;
}

/**
 * Record a tab-originated (human gesture) event on the single append point (design §10 seq handover):
 * the tab minted a provisional seq locally, but the server is now the authority — REASSIGN the board's
 * next authoritative seq (entry.watermark + 1), durably append with it, fold the diff into the live
 * store, and return the seq for the tab to adopt. This closes the tripwire's dual-sequencer hazard: a
 * bus commit and a human gesture can no longer be handed the same seq. On a fold error, drop the store
 * (the durable append already landed — the next read rehydrates from the files).
 */
export function appendTabEvent(
  boardId: string,
  repoPath: string,
  ev: StoredEvent & Record<string, unknown>,
): number {
  const entry = getBoardEngine(boardId, repoPath);
  const seq = entry.watermark + 1;
  const stamped = { ...ev, seq };
  appendBoardEvent(repoPath, stamped); // durable first — THROWS on failure (caller 500s, nothing folded)
  entry.watermark = seq;
  entry.hasPersist = true;
  try {
    if (ev.diff) entry.store.applyDiffAsChange(ev.diff, "remote");
  } catch (err) {
    console.warn(`[board-engine] tab-event fold failed for ${boardId}; dropping store to rehydrate:`, err);
    dropBoardEngine(boardId);
  }
  return seq;
}
