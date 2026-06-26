import type { EventStore, SnapshotStore, IntentEvent, PersistedSnapshot } from "./lib";

// The browser durable backends — the IndexedDB drop-ins behind core's persistence seam (EventStore /
// SnapshotStore). This is the SWAP POINT the design calls out: a different instantiation (e.g. a
// filesystem-of-markdown for the multi-agent framework) implements the same two interfaces instead.
// Nothing here knows about records, diffs, or the store — it just persists opaque, structured-cloneable
// events and one snapshot. IndexedDB (not localStorage) because the event log grows unboundedly and we
// want async, off-main-thread writes.

// One IndexedDB per BOARD: `canvas-notes:<boardId>`. Before boards had identity everything lived in a
// single global `canvas-notes` DB (LEGACY_DB) — origin-scoped, so two repos opened against different dev
// ports stayed apart only by accident. Now the DB name carries the boardId, so a board is its own
// persistence universe regardless of which port served it. `migrateLegacyBoard` adopts the old global DB
// once, for the dev repo's board, so the existing canvas isn't orphaned by the rename.
const LEGACY_DB = "canvas-notes";
export function boardDbName(boardId: string): string {
  return `${LEGACY_DB}:${boardId}`;
}
const DB_VERSION = 1;
const EVENTS = "events"; // append-only intent log (autoIncrement key = commit order)
const SNAPSHOT = "snapshot"; // single-entry document cache, under the key "current"

// Cache the open handle per DB name (one process can hold several boards' DBs open at once).
const dbPromises = new Map<string, Promise<IDBDatabase>>();
function db(name: string): Promise<IDBDatabase> {
  let p = dbPromises.get(name);
  if (!p) {
    p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(EVENTS)) d.createObjectStore(EVENTS, { autoIncrement: true });
        if (!d.objectStoreNames.contains(SNAPSHOT)) d.createObjectStore(SNAPSHOT);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromises.set(name, p);
  }
  return p;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class IdbEventStore implements EventStore {
  constructor(private readonly dbName: string) {}
  async append(e: IntentEvent): Promise<void> {
    const d = await db(this.dbName);
    const tx = d.transaction(EVENTS, "readwrite");
    tx.objectStore(EVENTS).add(e);
    await txDone(tx);
  }
  async loadAll(): Promise<IntentEvent[]> {
    const d = await db(this.dbName);
    return reqDone(d.transaction(EVENTS).objectStore(EVENTS).getAll() as IDBRequest<IntentEvent[]>);
  }
  async clear(): Promise<void> {
    const d = await db(this.dbName);
    const tx = d.transaction(EVENTS, "readwrite");
    tx.objectStore(EVENTS).clear();
    await txDone(tx);
  }
}

export class IdbSnapshotStore implements SnapshotStore {
  constructor(private readonly dbName: string) {}
  async load(): Promise<PersistedSnapshot | null> {
    const d = await db(this.dbName);
    const v = await reqDone(
      d.transaction(SNAPSHOT).objectStore(SNAPSHOT).get("current") as IDBRequest<
        PersistedSnapshot | undefined
      >,
    );
    return v ?? null;
  }
  async save(s: PersistedSnapshot): Promise<void> {
    const d = await db(this.dbName);
    const tx = d.transaction(SNAPSHOT, "readwrite");
    tx.objectStore(SNAPSHOT).put(s, "current");
    await txDone(tx);
  }
  async clear(): Promise<void> {
    const d = await db(this.dbName);
    const tx = d.transaction(SNAPSHOT, "readwrite");
    tx.objectStore(SNAPSHOT).clear();
    await txDone(tx);
  }
}

// One-time adoption of the pre-multi-board global DB. The dev repo's board historically owned the bare
// `canvas-notes` DB; under the new naming it lives at `canvas-notes:<boardId>`. The first time that board
// boots under its new name, copy the legacy events + snapshot across so the existing canvas isn't lost to
// the rename. Idempotent and safe: a no-op once the target holds any data of its own, and the legacy DB is
// left intact as a fallback (never deleted here). Callers run this for the DEFAULT board only — copying
// the dev-repo log into an unrelated repo's board would be wrong.
export async function migrateLegacyBoard(targetDbName: string): Promise<void> {
  if (targetDbName === LEGACY_DB) return;
  const target = await db(targetDbName);
  // Already has its own data? then this isn't a first boot — leave it untouched.
  const snapKey = await reqDone(
    target.transaction(SNAPSHOT).objectStore(SNAPSHOT).getKey("current") as IDBRequest<IDBValidKey | undefined>,
  );
  const eventCount = await reqDone(target.transaction(EVENTS).objectStore(EVENTS).count() as IDBRequest<number>);
  if (snapKey != null || eventCount > 0) return;

  // Open the legacy DB WITHOUT an upgrade (no version arg). If it predates us it has our stores; if it
  // never existed we just created an empty shell with none — nothing to adopt either way.
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const hasEvents = legacy.objectStoreNames.contains(EVENTS);
    const hasSnapshot = legacy.objectStoreNames.contains(SNAPSHOT);
    if (!hasEvents && !hasSnapshot) return;
    const events = hasEvents
      ? await reqDone(legacy.transaction(EVENTS).objectStore(EVENTS).getAll() as IDBRequest<IntentEvent[]>)
      : [];
    const snapshot = hasSnapshot
      ? await reqDone(
          legacy.transaction(SNAPSHOT).objectStore(SNAPSHOT).get("current") as IDBRequest<
            PersistedSnapshot | undefined
          >,
        )
      : undefined;
    if (events.length === 0 && snapshot == null) return; // legacy empty too
    const tx = target.transaction([EVENTS, SNAPSHOT], "readwrite");
    for (const e of events) tx.objectStore(EVENTS).add(e);
    if (snapshot != null) tx.objectStore(SNAPSHOT).put(snapshot, "current");
    await txDone(tx);
  } finally {
    legacy.close();
  }
}
