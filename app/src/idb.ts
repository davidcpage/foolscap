import type { EventStore, SnapshotStore, IntentEvent, PersistedSnapshot } from "./lib";

// The browser durable backends — the IndexedDB drop-ins behind core's persistence seam (EventStore /
// SnapshotStore). This is the SWAP POINT the design calls out: a different instantiation (e.g. a
// filesystem-of-markdown for the multi-agent framework) implements the same two interfaces instead.
// Nothing here knows about records, diffs, or the store — it just persists opaque, structured-cloneable
// events and one snapshot. IndexedDB (not localStorage) because the event log grows unboundedly and we
// want async, off-main-thread writes.

const DB_NAME = "canvas-notes";
const DB_VERSION = 1;
const EVENTS = "events"; // append-only intent log (autoIncrement key = commit order)
const SNAPSHOT = "snapshot"; // single-entry document cache, under the key "current"

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(EVENTS)) d.createObjectStore(EVENTS, { autoIncrement: true });
      if (!d.objectStoreNames.contains(SNAPSHOT)) d.createObjectStore(SNAPSHOT);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
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
  async append(e: IntentEvent): Promise<void> {
    const d = await db();
    const tx = d.transaction(EVENTS, "readwrite");
    tx.objectStore(EVENTS).add(e);
    await txDone(tx);
  }
  async loadAll(): Promise<IntentEvent[]> {
    const d = await db();
    return reqDone(d.transaction(EVENTS).objectStore(EVENTS).getAll() as IDBRequest<IntentEvent[]>);
  }
  async clear(): Promise<void> {
    const d = await db();
    const tx = d.transaction(EVENTS, "readwrite");
    tx.objectStore(EVENTS).clear();
    await txDone(tx);
  }
}

export class IdbSnapshotStore implements SnapshotStore {
  async load(): Promise<PersistedSnapshot | null> {
    const d = await db();
    const v = await reqDone(
      d.transaction(SNAPSHOT).objectStore(SNAPSHOT).get("current") as IDBRequest<
        PersistedSnapshot | undefined
      >,
    );
    return v ?? null;
  }
  async save(s: PersistedSnapshot): Promise<void> {
    const d = await db();
    const tx = d.transaction(SNAPSHOT, "readwrite");
    tx.objectStore(SNAPSHOT).put(s, "current");
    await txDone(tx);
  }
  async clear(): Promise<void> {
    const d = await db();
    const tx = d.transaction(SNAPSHOT, "readwrite");
    tx.objectStore(SNAPSHOT).clear();
    await txDone(tx);
  }
}
