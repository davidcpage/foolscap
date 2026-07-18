import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { prefix, type GlobalRoute } from "./router.js";
import {
  clearBoardPersist,
  importBoardPersist,
  readBoardBoot,
  readBoardPersist,
  readBoardSnapshot,
  writeBoardSnapshot,
} from "../board-persist.js";
import { dropBoardEngine, reconcileBoardEngineOnSnapshot } from "../board-engine.js";
import { commitTabEvent } from "../server-delivery.js";
import { isScratchBoard } from "../server-sessions.js";

// ── the durable board store (external-repo boards step 4: records live with the repo) — Phase 1 split ─
// The browser's EventStore/SnapshotStore (core's persistence seam) are HTTP clients over these endpoints
// (app/src/remote-store.ts); board-persist.js owns the files under `<repo>/.canvas/board/`. IndexedDB is
// retired as the durable tier — a board opened in any browser/profile/machine hydrates from the repo's own
// `.canvas/`, and `import` adopts a board's pre-existing IndexedDB state once. Writes THROW on failure and
// 500 here — the client store retries; a swallowed event is data loss. §9 stage 2: the /event echo mints
// the authoritative seq on the single server-side append point (board-engine.appendTabEvent) and the
// membership-diff onboarding (announceNewMemberships) reaches shared state through the ServerContext.
async function handleBoardPersistWrite(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  repoPath: string,
  kind: "event" | "snapshot" | "import",
  originTab: string | undefined,
): Promise<void> {
  const ctx = getServerContext();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  try {
    if (kind === "event") {
      if (typeof body.event !== "object" || body.event === null)
        return sendJson(res, 400, { error: "missing event" });
      const ev = body.event as Record<string, unknown>;
      // §9 stage 2 / §10 seq handover: the server is the single APPEND POINT. It assigns the board's
      // next authoritative seq (ignoring the tab's provisional one), durably appends the tab-originated
      // (human gesture) event with it, and folds the diff into the live server store (read authority).
      // §9 stage 3 (D2/D6): commitTabEvent then BROADCASTS the folded diff to every OTHER tab on the board
      // (excluding this origin `?tab=` id) so a human edit in one tab converges live in a second with no
      // reload — the headline stage-3 deliverable. RETURNS the authoritative seq for the tab's in-memory
      // mirror to adopt. (Bus commands never reach here — they commit via /api/command; only tab-local human
      // gestures still echo through this route until the tab-echo retires in stage 4.)
      const seq = commitTabEvent(boardId, repoPath, ev, originTab);
      return sendJson(res, 200, { ok: true, seq });
    }
    if (kind === "snapshot") {
      if (typeof body.snapshot !== "object" || body.snapshot === null)
        return sendJson(res, 400, { error: "missing snapshot" });
      const snap = body.snapshot as { seq?: unknown; records?: Array<Record<string, unknown>> };
      // Capture the snapshot being replaced FIRST: the before↔after membership diff below is how a
      // human-drawn thread join/leave (a local commit that never crosses the bus) reaches onboarding.
      const before = readBoardSnapshot(repoPath) as { seq?: unknown; records?: Array<Record<string, unknown>> } | null;
      // Watermark guard: never roll the snapshot BACKWARDS. A stale tab (behind because another tab
      // kept committing) would otherwise clobber the newer save — events replay heals the content,
      // but the membership diff below would then see phantom joins on the next good save. 409 is
      // deliberate (4xx): remote-store must NOT retry a save that will never become fresh; the error
      // surfaces via Persistence.onError in the stale tab, which is exactly where the news belongs.
      if (
        before && typeof before.seq === "number" && typeof snap.seq === "number" && snap.seq < before.seq
      ) {
        // The 409 is unconditional (the guard BEHAVIOR never changes — the stale write must not clobber),
        // but the warn is quieted on a scratch/test board: the http-contract suite provokes this 409 on
        // purpose every run, so on that board it is expected, not news. A real board keeps the loud line —
        // a stale second writer there is a genuine desync worth surfacing.
        if (!isScratchBoard(boardId))
          console.warn(
            `[boards] STALE snapshot save refused for ${boardId}: seq ${snap.seq} < stored ${before.seq} — ` +
              `a second writer is behind the board (another tab or a leaked probe)`,
          );
        return sendJson(res, 409, { error: "stale snapshot", storedSeq: before.seq, gotSeq: snap.seq });
      }
      writeBoardSnapshot(repoPath, snap as Record<string, unknown>);
      // Keep the live store (§9 stage 1 read authority) in step with a snapshot that carries state no
      // event fold has seen (directly-authored save / lost echo). No-op for an ordinary debounced save.
      reconcileBoardEngineOnSnapshot(boardId, repoPath, snap);
      sendJson(res, 200, { ok: true });
      try {
        ctx.announceNewMemberships(boardId, before ? (before.records ?? []) : null, snap.records ?? [], ctx.originOf(req));
      } catch (err) {
        console.warn("[threads] membership announce from snapshot diff failed:", err);
      }
      // D7 (stage 3): repaint member:open edges for a session card that just (re)appeared on the board —
      // the edge is a server-derived projection of the ledger, so a reopen/first-appearance rewires it
      // server-side (idempotent with the retiring client redraw; the only painter for a no-tab reopen).
      try {
        ctx.repaintReopenedMemberEdges(boardId, before ? (before.records ?? []) : null, snap.records ?? [], ctx.originOf(req));
      } catch (err) {
        console.warn("[threads] member-edge repaint from snapshot diff failed:", err);
      }
      // P2: capture each durable member's offset from its primary thread card off this debounced save (the
      // "persist on drag-end, not per-frame" point). Idempotent — a save that moved nothing writes nothing.
      try {
        ctx.captureMemberOffsets(boardId, snap.records ?? []);
      } catch (err) {
        console.warn("[threads] member-offset capture from snapshot save failed:", err);
      }
      // P4: capture each open thread card's reopen-set (member cards open right now) off the same save.
      // Frozen when the thread card closes, so reopen restores the set that was open at close. Idempotent.
      try {
        ctx.captureReopenSets(boardId, snap.records ?? []);
      } catch (err) {
        console.warn("[threads] reopen-set capture from snapshot save failed:", err);
      }
      return;
    }
    // import: the one-time IndexedDB adoption. Refused (imported:false) once any server state exists.
    const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : [];
    const snapshot =
      typeof body.snapshot === "object" && body.snapshot !== null
        ? (body.snapshot as Record<string, unknown>)
        : null;
    const imported = importBoardPersist(repoPath, events, snapshot);
    if (imported) dropBoardEngine(boardId); // adopted files replace board state out-of-band — rehydrate on next read
    // ALWAYS log adoptions: whichever tab wins this race seeds the board's durable state forever, and
    // the wrong winner is invisible after the fact. The user-agent is what tells a leaked HEADLESS
    // probe tab (this exact incident: a stale HeadlessChrome's near-empty IndexedDB beat the real
    // browser to the import and "reset" the board) apart from the browser the human is actually in.
    console.log(
      `[boards] persist import ${imported ? "ACCEPTED" : "refused (state exists)"} for ${boardId}: ` +
        `${events.length} events, snapshot=${snapshot ? "yes" : "no"} — ua: ${req.headers["user-agent"] ?? "?"}`,
    );
    return sendJson(res, 200, { imported });
  } catch (e) {
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

export const boardPersistRoutes: GlobalRoute[] = [
  {
    match: prefix("/api/board/persist"),
    run: (req, res, url) => {
      const b = getServerContext().reqBoard(url);
      if (!b) return sendJson(res, 400, { error: "unknown board" });
      if (url.pathname === "/api/board/persist" && req.method === "GET") {
        // The BOOT read (once per page load): snapshot + only the POST-watermark event TAIL — the exact
        // set hydrate replays. The full absorbed log contributes nothing to hydration and only bloats the
        // blank-screen boot fetch (it grows unbounded with board history), so it is NOT shipped here; the
        // provenance mirror fetches it lazily after first paint via /api/board/persist/log below. One parse
        // of events.jsonl feeds both this tail and compaction (which is skipped when the watermark is stale).
        const boot = readBoardBoot(b.repoPath);
        if (boot.dropped > 0)
          console.log(`[boards] compacted ${b.boardId}: dropped ${boot.dropped} events below the snapshot watermark tail`);
        return sendJson(res, 200, { events: boot.events, snapshot: boot.snapshot }, req);
      }
      if (url.pathname === "/api/board/persist/log" && req.method === "GET") {
        // The full intent log — the provenance mirror / who-touched-this actor badges. Fetched lazily
        // after first paint (not on the boot path), so a blank screen never waits on it. gzip'd (it is
        // large and highly compressible) when the client accepts it.
        return sendJson(res, 200, { events: readBoardPersist(b.repoPath).events }, req);
      }
      if (url.pathname === "/api/board/persist" && req.method === "DELETE") {
        clearBoardPersist(b.repoPath);
        dropBoardEngine(b.boardId); // files cleared out-of-band — drop the live store so the next read rehydrates empty
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const kind = url.pathname.slice("/api/board/persist/".length);
        if (kind === "event" || kind === "snapshot" || kind === "import")
          // The origin `?tab=` id (stage 3, D6) rides the /event POST so its own commit isn't echoed back
          // to the acting tab — the same stable per-tab id feeds.ts sends on the WS (tabCountFor dedupe).
          return void handleBoardPersistWrite(req, res, b.boardId, b.repoPath, kind, url.searchParams.get("tab") ?? undefined);
      }
      return sendJson(res, 404, { error: "unknown board-persist endpoint" });
    },
  },
];
