import type { EventStore, SnapshotStore, IntentEvent, PersistedSnapshot } from "./lib";
import { tabId } from "./feeds";

// The server-backed durable stores (external-repo boards step 4) — the OTHER instantiation of core's
// persistence seam that idb.ts always advertised. The dev server owns the durable tier now
// (board-persist.js: `<repo>/.canvas/board/` events.jsonl + snapshot.json), so a board hydrates the
// same in ANY browser/profile/machine and its records travel with the repo. IndexedDB is retired as
// the durable tier: it was per-origin, per-profile, and evictable under storage pressure — the wrong
// home for the one copy of a board. (App.tsx still reads it once, to adopt a pre-step-4 board's data.)
//
// Availability isn't a new dependency — the dev server serves the app itself, so if these endpoints
// are down the canvas isn't running either. The one real window is a dev-server RESTART under an open
// tab: writes fail while it bounces. So writes RETRY until they land (the Persistence write chain is
// serialized, so order holds and later writes queue behind the outage); a request the server judges
// malformed (4xx) will never heal by retrying and throws instead, surfacing via Persistence.onError.
// Worst case a tab dies mid-outage: the tail of the event log is lost but the next debounced snapshot
// from any tab self-heals the CONTENT — a provenance gap, not data loss.

const RETRY_START_MS = 250;
const RETRY_MAX_MS = 5000;

/** A request the server judged wrong (4xx) — retrying re-sends the same mistake, so it throws
 *  instead and surfaces via Persistence.onError. Typed so requestRetry's own catch can tell it from
 *  a network error without string-matching its message. */
export class PersistClientError extends Error {
  constructor(
    url: string,
    readonly status: number,
  ) {
    super(`${url} → ${status}`);
    this.name = "PersistClientError";
  }
}

function persistUrl(boardId: string, sub = ""): string {
  return `/api/board/persist${sub}?board=${encodeURIComponent(boardId)}`;
}

async function requestRetry(url: string, init: RequestInit): Promise<Response> {
  let delay = RETRY_START_MS;
  for (;;) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // 4xx is OUR bug (bad board id / malformed body / a stale snapshot save) — retrying re-sends
      // the same mistake forever.
      if (res.status >= 400 && res.status < 500) throw new PersistClientError(url, res.status);
    } catch (e) {
      if (e instanceof PersistClientError) throw e;
      // network error / 5xx: the restart window — fall through and retry
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
}

/** Everything the server holds for a board — fetched once at boot, handed to both stores below. */
export interface BoardPersistState {
  events: IntentEvent[];
  snapshot: PersistedSnapshot | null;
}

export async function fetchBoardPersist(boardId: string): Promise<BoardPersistState> {
  const res = await requestRetry(persistUrl(boardId), { method: "GET" });
  return (await res.json()) as BoardPersistState;
}

/** The FULL intent log — every event, including the pre-watermark prefix the boot fetch omits. Fetched
 *  lazily AFTER first paint to seed the provenance mirror (App.tsx → seedProvenanceHistory); the boot
 *  fetch above ships only the post-watermark tail, so this is what makes the provenance card's history and
 *  the who-touched-this actor badges complete. Not on the render-blocking boot path — a slow/failed fetch
 *  never delays first paint. */
export async function fetchBoardLog(boardId: string): Promise<IntentEvent[]> {
  const res = await requestRetry(persistUrl(boardId, "/log"), { method: "GET" });
  return ((await res.json()) as { events: IntentEvent[] }).events;
}

/** The reconnect GAP-FILL (design §9 stage 3, D4): only the events with seq > `since` — the tail a tab
 *  missed while its socket was down. The caller applies each diff as a "remote" change in seq order and
 *  adopts each seq, so a dropped connection converges with no reload. Small by construction (a since-window,
 *  not the whole log). Uses requestRetry so a catch-up mid-outage simply waits for the server to return. */
export async function fetchBoardLogSince(boardId: string, since: number): Promise<IntentEvent[]> {
  const res = await requestRetry(`${persistUrl(boardId, "/log")}&since=${since}`, { method: "GET" });
  return ((await res.json()) as { events: IntentEvent[] }).events;
}

/** One-time adoption of a board's IndexedDB state. `imported:false` = the server already had state
 *  (another tab won the race, or this board predates nothing) — re-fetch and trust the server. */
export async function importBoardPersist(
  boardId: string,
  events: IntentEvent[],
  snapshot: PersistedSnapshot | null,
): Promise<boolean> {
  const res = await requestRetry(persistUrl(boardId, "/import"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events, snapshot }),
  });
  return ((await res.json()) as { imported: boolean }).imported;
}

export class RemoteEventStore implements EventStore {
  // Set after construction (once Persistence exists) to adopt the server's authoritative seq: since §9
  // stage 2 the server is the single append point and REASSIGNS the seq of every tab-echoed event (design
  // §10), so this tab bumps its mirror's watermark to what the server actually assigned — keeping its next
  // locally-minted seq above the server's and its snapshot watermark honest.
  onServerSeq?: (seq: number) => void;
  // loadAll serves the boot payload rather than re-fetching: hydrate() runs once, right after the
  // boot fetch, and every later event is one this tab itself appended (already in the mem mirror).
  constructor(
    private readonly boardId: string,
    private readonly boot: IntentEvent[],
  ) {}
  async loadAll(): Promise<IntentEvent[]> {
    return this.boot;
  }
  async append(e: IntentEvent): Promise<void> {
    // keepalive: an event is small (one gesture's diff) and this lets the LAST append of a closing
    // tab finish against the 64KB keepalive budget — the snapshot save is too big to get the same.
    // `&tab=` (stage 3, D6): the server excludes this originating tab from the diff rebroadcast it now
    // does on every human commit — this tab already applied the edit optimistically.
    const res = await requestRetry(`${persistUrl(this.boardId, "/event")}&tab=${encodeURIComponent(tabId())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: e }),
      keepalive: true,
    });
    // Adopt the server-assigned seq (§10). Best-effort: a body without a numeric seq (an older server, or
    // a keepalive response the tab is shutting down through) simply skips the adopt — never fatal.
    try {
      const { seq } = (await res.json()) as { seq?: number };
      if (typeof seq === "number") this.onServerSeq?.(seq);
    } catch {
      /* no parseable seq — leave the mirror watermark as-is */
    }
  }
  async clear(): Promise<void> {
    // The endpoint drops the WHOLE board store (events + snapshot) — a reset is all-or-nothing.
    await requestRetry(persistUrl(this.boardId), { method: "DELETE" });
  }
}

export class RemoteSnapshotStore implements SnapshotStore {
  constructor(
    private readonly boardId: string,
    private boot: PersistedSnapshot | null,
  ) {}
  async load(): Promise<PersistedSnapshot | null> {
    return this.boot;
  }
  async save(s: PersistedSnapshot): Promise<void> {
    this.boot = s;
    await requestRetry(persistUrl(this.boardId, "/snapshot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot: s }),
    });
  }
  async clear(): Promise<void> {
    await requestRetry(persistUrl(this.boardId), { method: "DELETE" });
  }
}
