import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody } from "../server-http.js";
import { getServerContext } from "../server-context.js";
import { prefix, type GlobalRoute } from "./router.js";
import {
  appendBoardEvent,
  clearBoardPersist,
  compactBoardEvents,
  importBoardPersist,
  readBoardPersist,
  readBoardSnapshot,
  writeBoardSnapshot,
} from "../board-persist.js";

// ── the durable board store (external-repo boards step 4: records live with the repo) — Phase 1 split ─
// The browser's EventStore/SnapshotStore (core's persistence seam) are HTTP clients over these endpoints
// (app/src/remote-store.ts); board-persist.js owns the files under `<repo>/.canvas/board/`. IndexedDB is
// retired as the durable tier — a board opened in any browser/profile/machine hydrates from the repo's own
// `.canvas/`, and `import` adopts a board's pre-existing IndexedDB state once. Writes THROW on failure and
// 500 here — the client store retries; a swallowed event is data loss. The second-writer tripwire + the
// membership-diff onboarding reach shared state (fsState.lastEventSeq, announceNewMemberships) through the
// ServerContext, so the handler moves out while its cross-request state stays in the god-file.
async function handleBoardPersistWrite(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  repoPath: string,
  kind: "event" | "snapshot" | "import",
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
      // Second-writer tripwire: tabs mint their own seq (core/src/log.ts), so the log is single-
      // sequencer only while ONE tab writes. A non-monotonic append means a second writer (another
      // tab, a leaked headless probe) is interleaving — the append still lands (refusing would lose
      // a real gesture), but the collision must be LOUD, not discovered at hydrate. Seeded from the
      // snapshot watermark on the first append after boot, so a stale writer trips even then.
      const lastEventSeq = (ctx.fsState.lastEventSeq ??= new Map<string, number>());
      if (typeof ev.seq === "number") {
        const stored = readBoardSnapshot(repoPath) as { seq?: unknown } | null;
        const last = lastEventSeq.get(boardId) ?? (stored && typeof stored.seq === "number" ? stored.seq : undefined);
        if (last !== undefined && ev.seq <= last)
          console.warn(
            `[boards] event seq collision on ${boardId}: got ${ev.seq} after ${last} — ` +
              `a second writer is appending (another tab or a leaked probe); the log now holds conflicting seqs`,
          );
        if (last === undefined || ev.seq > last) lastEventSeq.set(boardId, ev.seq);
      }
      appendBoardEvent(repoPath, ev);
      return sendJson(res, 200, { ok: true });
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
        console.warn(
          `[boards] STALE snapshot save refused for ${boardId}: seq ${snap.seq} < stored ${before.seq} — ` +
            `a second writer is behind the board (another tab or a leaked probe)`,
        );
        return sendJson(res, 409, { error: "stale snapshot", storedSeq: before.seq, gotSeq: snap.seq });
      }
      writeBoardSnapshot(repoPath, snap as Record<string, unknown>);
      sendJson(res, 200, { ok: true });
      try {
        ctx.announceNewMemberships(boardId, before ? (before.records ?? []) : null, snap.records ?? [], ctx.originOf(req));
      } catch (err) {
        console.warn("[threads] membership announce from snapshot diff failed:", err);
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
        // Compact on the boot read (once per page load): drop events the snapshot absorbed, beyond a
        // generous tail — see board-persist.js. Never silent when it bites.
        const { dropped } = compactBoardEvents(b.repoPath);
        if (dropped > 0) console.log(`[boards] compacted ${b.boardId}: dropped ${dropped} events below the snapshot watermark tail`);
        return sendJson(res, 200, readBoardPersist(b.repoPath));
      }
      if (url.pathname === "/api/board/persist" && req.method === "DELETE") {
        clearBoardPersist(b.repoPath);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const kind = url.pathname.slice("/api/board/persist/".length);
        if (kind === "event" || kind === "snapshot" || kind === "import")
          return void handleBoardPersistWrite(req, res, b.boardId, b.repoPath, kind);
      }
      return sendJson(res, 404, { error: "unknown board-persist endpoint" });
    },
  },
];
