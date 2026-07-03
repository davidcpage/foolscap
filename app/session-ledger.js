// The canvas-session ledger (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// Session transcripts live in the SHARED Claude projects dir (~/.claude/projects/<repo>/), so a `claude`
// you run yourself in this repo's terminal drops its .jsonl right alongside the ones the canvas spawned.
// Those externals have a lifecycle the canvas never owned — we didn't spawn them, the server's killAll
// never reaps them, "resume" is meaningless — so projecting them as canvas session cards is wrong.
//
// To tell ours apart, we keep a durable marker per session WE own, under the board's `.canvas/` home
// (git-ignored, shadow-versioned like images — the watcher only ignores `.canvas/roots/`). A session is
// "ours" if it has a marker, written either at spawn (ensureLiveSession) or by adoption the first time a
// card on the board asks for its transcript (handleSession). The marker also OUTLIVES the in-memory live
// registry across a restart, so it's the durable home for lifecycle state the registry can't keep — the
// `endReason` of Phase 2 (done / terminated / crashed) lands in this same file next.

import fs from "node:fs";
import path from "node:path";

/** The directory holding one marker file per canvas-owned session, under the board repo's `.canvas/` home. */
export function canvasSessionsDir(repoPath) {
  return path.join(repoPath, ".canvas", "sessions");
}

/**
 * Record (or update) a session's ownership marker. Best-effort: a ledger write must NEVER take down a
 * spawn or a transcript read — worst case the session simply isn't listed until the next adoption.
 */
export function markCanvasSession(repoPath, id, data) {
  try {
    fs.mkdirSync(canvasSessionsDir(repoPath), { recursive: true });
    fs.writeFileSync(path.join(canvasSessionsDir(repoPath), id + ".json"), JSON.stringify(data));
  } catch {
    /* not fatal — the marker is an index, not the data */
  }
}

/** Is this session canvas-owned (has a marker)? */
export function isCanvasSession(repoPath, id) {
  return fs.existsSync(path.join(canvasSessionsDir(repoPath), id + ".json"));
}

/** Read a session's marker, or null if there is none / it's unreadable. Best-effort, never throws. */
export function readCanvasSession(repoPath, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(canvasSessionsDir(repoPath), id + ".json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Record how a session ENDED into its marker (Phase 2). This is the durable home for lifecycle state the
 * in-memory registry can't keep: a `done`/`terminated`/`crashed` reason survives a server restart, so a
 * post-restart file-tail card still paints the right "✓ done" vs "✕ crashed" band, not a status-less grey.
 * Merges onto the existing marker (preserving spawnedAt/origin/adoptedAt) rather than clobbering it; writes
 * even if there was no marker yet (an end implies ownership). Best-effort — a failed write never blocks a
 * terminate/exit, it just means the reason isn't durable past the live process.
 */
export function recordSessionEnd(repoPath, id, endReason, endedAt = Date.now()) {
  const prior = readCanvasSession(repoPath, id) ?? {};
  markCanvasSession(repoPath, id, { ...prior, endReason, endedAt });
}

/**
 * Merge a partial patch onto a session's marker (read-merge-write, like recordSessionEnd — markCanvasSession
 * clobbers). The durable home for the bits of live-registry state that must survive a restart — thread read
 * cursors, waitingOn — without erasing spawn identity (roleId/origin/endReason). Best-effort like every
 * ledger write.
 */
export function updateCanvasSession(repoPath, id, patch) {
  const prior = readCanvasSession(repoPath, id) ?? {};
  markCanvasSession(repoPath, id, { ...prior, ...patch });
}

/**
 * List the canvas-owned transcripts in `dir` (the shared projects dir), newest first. Externals — terminal
 * `claude` runs nobody has placed on the board — are filtered out by the marker check.
 */
export function listSessions(dir, repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".usage.jsonl"))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { id: n.slice(0, -".jsonl".length), mtime: st.mtimeMs, bytes: st.size };
    })
    .filter((s) => isCanvasSession(repoPath, s.id)) // canvas-owned only — externals are skipped
    .sort((a, b) => b.mtime - a.mtime);
}
