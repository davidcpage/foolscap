// The server-side board store (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// Step 4 of the external-repo boards work: the durable home for a board's RECORDS — the intent-event
// log + snapshot cache pair behind core's persistence seam (core/src/persist.ts EventStore /
// SnapshotStore). Until now that pair lived only in the browser's IndexedDB, which is per-ORIGIN and
// per-PROFILE (and evictable under storage pressure): a board opened in another browser, machine, or
// after a profile wipe came up empty. Now the dev server owns the durable tier, in the board repo's
// own `.canvas/` home — so the board travels WITH the repo — and the browser stores are thin HTTP
// clients over these files (app/src/remote-store.ts).
//
// Layout (under `<repo>/.canvas/board/`):
//   events.jsonl   — the authoritative append-only intent log, one JSON event per line.
//   snapshot.json  — the materialized document snapshot + `seq` watermark (a fast-load CACHE; boot
//                    replays the events with seq > watermark on top — see persist.ts hydrate).
//
// Unlike the session/role markers (best-effort indexes), these files ARE the board: writes throw on
// failure so the endpoint 500s and the browser store retries — never swallow a lost event.
//
// The log is append-only and unbounded, exactly as it was in IndexedDB; compaction (dropping events
// ≤ the snapshot watermark) is a deliberate follow-up, not something to do silently here.

import fs from "node:fs";
import path from "node:path";

/** The directory holding a board's durable record state, under the board repo's `.canvas/` home. */
export function boardPersistDir(repoPath) {
  return path.join(repoPath, ".canvas", "board");
}

function eventsFile(repoPath) {
  return path.join(boardPersistDir(repoPath), "events.jsonl");
}
function snapshotFile(repoPath) {
  return path.join(boardPersistDir(repoPath), "snapshot.json");
}

/**
 * Everything persisted for a board: `{ events, snapshot }` (empty array / null when nothing yet).
 * One unparseable jsonl line is skipped rather than fatal — a crash mid-append leaves a torn LAST
 * line, and the standard jsonl tolerance (skip it) loses at most the event that never fully landed.
 */
export function readBoardPersist(repoPath) {
  let events = [];
  try {
    const raw = fs.readFileSync(eventsFile(repoPath), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* torn/corrupt line — skip (see above) */
      }
    }
  } catch {
    events = []; // no file yet — a fresh board
  }
  return { events, snapshot: readBoardSnapshot(repoPath) }; // shares the memoized parse
}

/** Does this board have ANY persisted state? (Gates the one-time IndexedDB import.) */
export function hasBoardPersist(repoPath) {
  const { events, snapshot } = readBoardPersist(repoPath);
  return events.length > 0 || snapshot !== null;
}

// readBoardSnapshot memo: every server-side board lookup (thread membership, sid↔card resolution,
// spawn placement, the loop heartbeat's world signature) funnels through this read, and paying a
// stat is fine where paying a full parse per call is O(callers × snapshot bytes) of sync work on the
// event loop. Keyed by (mtimeMs, size); writeBoardSnapshot refreshes it in place. Pure
// recompute-on-miss — a hot re-eval only costs one re-parse. CALLERS MUST TREAT THE RESULT AS
// READ-ONLY: the same parsed object is handed to everyone.
const snapshotCache = new Map(); // repoPath → { mtimeMs, size, value }

/** Just the snapshot (null when absent/torn) — for callers on a hot path (the per-save membership
 *  diff, the agents' board read) that must not pay the whole event log — or even a re-parse — per
 *  call. Returns a shared parsed object: read-only by contract (see snapshotCache above). */
export function readBoardSnapshot(repoPath) {
  const file = snapshotFile(repoPath);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    snapshotCache.delete(repoPath);
    return null;
  }
  const hit = snapshotCache.get(repoPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    snapshotCache.set(repoPath, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return null;
  }
}

/** When the board state last changed (snapshot.json mtime, falling back to the log's), ms epoch;
 *  0 when nothing is persisted. The `ts` of the agents' GET /api/canvas read. */
export function boardPersistMtime(repoPath) {
  for (const f of [snapshotFile(repoPath), eventsFile(repoPath)]) {
    try {
      return Math.round(fs.statSync(f).mtimeMs);
    } catch {
      /* try the next */
    }
  }
  return 0;
}

/**
 * The last-n events as the human-readable intent trail — same line format as core's
 * MemoryIntentLog.describe / summarizeDiff (`<ts> <actor> <type> [+a ~u -r]`), reproduced here so the
 * agents' GET /api/canvas `recentIntent` survives the retirement of the browser push that used to
 * carry it.
 */
export function describeBoardEvents(events, n = 20) {
  const recent = events.slice(-n);
  if (recent.length === 0) return "(no intent yet)";
  const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
  return recent
    .map((e) => {
      const d = e.diff ?? {};
      const parts = [];
      if (count(d.added)) parts.push(`+${count(d.added)}`);
      if (count(d.updated)) parts.push(`~${count(d.updated)}`);
      if (count(d.removed)) parts.push(`-${count(d.removed)}`);
      return `${e.ts} ${e.actor} ${e.type} [${parts.length ? parts.join(" ") : "no-op"}]`;
    })
    .join("\n");
}

/**
 * Append one intent event to the authoritative log. Throws on failure — the caller must surface it.
 * If a crash left a torn tail (no trailing newline), open a fresh line first: otherwise the next
 * append would GLUE onto the partial line and both events would parse as garbage — the torn event is
 * already lost, but nothing after it may be.
 */
export function appendBoardEvent(repoPath, event) {
  fs.mkdirSync(boardPersistDir(repoPath), { recursive: true });
  let prefix = "";
  try {
    const fd = fs.openSync(eventsFile(repoPath), "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* no file yet — first event */
  }
  fs.appendFileSync(eventsFile(repoPath), prefix + JSON.stringify(event) + "\n");
}

/** Replace the snapshot cache. Atomic (tmp + rename) so a crash never leaves a torn snapshot.json. */
export function writeBoardSnapshot(repoPath, snapshot) {
  fs.mkdirSync(boardPersistDir(repoPath), { recursive: true });
  const tmp = snapshotFile(repoPath) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, snapshotFile(repoPath));
  try {
    const st = fs.statSync(snapshotFile(repoPath));
    snapshotCache.set(repoPath, { mtimeMs: st.mtimeMs, size: st.size, value: snapshot });
  } catch {
    snapshotCache.delete(repoPath); // can't stamp the memo — the next read re-parses, never serves stale
  }
}

/**
 * One-time adoption of a board's browser-side (IndexedDB) state, so nothing already on a canvas is
 * lost to the backend swap. Refuses (returns false) when the board already has server-side state —
 * the import must never clobber the now-authoritative files; the browser's copy stays intact as a
 * fallback either way.
 */
export function importBoardPersist(repoPath, events, snapshot) {
  if (hasBoardPersist(repoPath)) return false;
  fs.mkdirSync(boardPersistDir(repoPath), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e) + "\n").join("");
  if (lines) fs.writeFileSync(eventsFile(repoPath), lines);
  if (snapshot != null) writeBoardSnapshot(repoPath, snapshot);
  return true;
}

/** Drop everything (the EventStore/SnapshotStore `clear()` contract — tests / a reset affordance). */
export function clearBoardPersist(repoPath) {
  fs.rmSync(eventsFile(repoPath), { force: true });
  fs.rmSync(snapshotFile(repoPath), { force: true });
  snapshotCache.delete(repoPath);
}

// ── compaction ────────────────────────────────────────────────────────────────────────────────────
// The log is append-only and would grow forever (as it did in IndexedDB). Everything with
// seq ≤ the snapshot's watermark is already baked into snapshot.json, so it's not needed for
// CORRECTNESS — but the recent past below the watermark still feeds the history/provenance surfaces
// (the in-memory log mirror hydrate seeds) and the undo-scrubbing future, so a generous TAIL of it is
// kept. (⌘Z undo is NOT at stake: the undo stack is in-memory per tab and never reads the log.)
/** How many events below the watermark survive compaction — the readable recent past. Generous on
 *  purpose (this app's stingy caps have all cost more than they saved). */
export const COMPACT_KEEP_TAIL = 2000;
/** Don't bother rewriting the file for fewer droppable events than this — compaction runs on every
 *  board GET (once per page load), and a rewrite per reload for a handful of lines is churn. */
export const COMPACT_MIN_DROP = 500;

/**
 * Drop events the snapshot has fully absorbed, beyond a generous tail: an event goes only when its
 * seq ≤ watermark − keepTail (events with no numeric seq predate the watermark scheme — never
 * droppable safely, always kept). Atomic (tmp + rename), and safe against a concurrent append: every
 * fs op here is sync, so the whole read→rewrite runs in one event-loop turn — no POST can interleave.
 * Returns `{ dropped }` (0 = nothing done, including the no-snapshot and below-minDrop cases).
 */
export function compactBoardEvents(repoPath, { keepTail = COMPACT_KEEP_TAIL, minDrop = COMPACT_MIN_DROP } = {}) {
  const { events, snapshot } = readBoardPersist(repoPath);
  const watermark = snapshot && typeof snapshot.seq === "number" ? snapshot.seq : undefined;
  if (watermark === undefined) return { dropped: 0 };
  const cut = watermark - keepTail;
  const keep = events.filter((e) => !(typeof e.seq === "number" && e.seq <= cut));
  const dropped = events.length - keep.length;
  if (dropped < minDrop) return { dropped: 0 };
  const tmp = eventsFile(repoPath) + ".tmp";
  fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e) + "\n").join(""));
  fs.renameSync(tmp, eventsFile(repoPath));
  return { dropped };
}
