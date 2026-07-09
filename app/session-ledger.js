// The canvas-session ledger (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// Claude Code stores a session's transcript in a projects dir keyed off the process CWD, not off the board
// root: ~/.claude/projects/<cwd-with-non-alnum→->/. A plain terminal `claude` in this repo drops its .jsonl
// in the board-root dir alongside the ones the canvas spawned; a WORKTREE session (a Coordinator worker runs
// in <board>/.canvas/worktrees/<key>) drops its .jsonl in a DIFFERENT dir. So there is no single "the
// transcripts dir" — each session's dir follows its cwd, which we record on its marker (below).
//
// Terminal externals have a lifecycle the canvas never owned — we didn't spawn them, the server's killAll
// never reaps them, "resume" is meaningless — so projecting them as canvas session cards is wrong.
//
// To tell ours apart, we keep a durable marker per session WE own, under the board's `.canvas/` home
// (git-ignored, shadow-versioned like images — the watcher only ignores `.canvas/roots/`). A session is
// "ours" if it has a marker, written either at spawn (ensureLiveSession, recording its `cwd`) or by adoption
// the first time a card on the board asks for its transcript (handleSession). The marker set — one file per
// owned session, always under the BOARD ROOT `.canvas/` even for worktree sessions — is therefore the
// authoritative index of what the board owns AND where each transcript lives; listSessions is driven off it.
// The marker also OUTLIVES the in-memory live registry across a restart, so it's the durable home for
// lifecycle state the registry can't keep — the `endReason` of Phase 2 (done / terminated / crashed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The ~/.claude/projects transcript dir for a process running in `cwd`. Claude Code slugs the absolute cwd
 * by replacing every "/" AND "." with "-" (so `/a/foolscap/.canvas` → `-a-foolscap--canvas`), which is why a
 * board root (no dots) and its worktrees (which contain `.canvas`) resolve to DIFFERENT dirs. Single source
 * of truth for both the list (per-marker) and the per-session transcript read on the server side.
 */
export function projectsDirForCwd(cwd) {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

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
 * List the board's canvas-owned sessions, newest first. Driven off the MARKER SET (canvasSessionsDir), not a
 * readdir of one projects dir: a worktree session's transcript lives in a different projects dir than the
 * board root's (see projectsDirForCwd), so enumerating a single dir silently dropped every Coordinator-worker
 * session. Each marker records the session's `cwd`, so we resolve its transcript dir per-session — the
 * worktree dir when it has a cwd, `dir` (the board-root projects dir) otherwise (board-root/adopted sessions,
 * whose markers carry no cwd). This also inverts the old external filter for free: a terminal `claude` run
 * nobody placed on the board has no marker, so it's simply never enumerated. A marker whose transcript is
 * missing (deleted, or not yet written) is skipped rather than listed with bogus stats.
 *
 * `dirForCwd` resolves a session's `cwd` to its transcripts dir; it defaults to projectsDirForCwd and is a
 * seam only the tests use (they can't seed the real ~/.claude/projects).
 */
export function listSessions(dir, repoPath, dirForCwd = projectsDirForCwd) {
  let markers;
  try {
    markers = fs.readdirSync(canvasSessionsDir(repoPath)).filter((n) => n.endsWith(".json"));
  } catch {
    return []; // no marker dir yet → nothing is canvas-owned
  }
  return markers
    .map((n) => {
      const id = n.slice(0, -".json".length);
      const marker = readCanvasSession(repoPath, id);
      const tdir = marker?.cwd ? dirForCwd(marker.cwd) : dir;
      try {
        const st = fs.statSync(path.join(tdir, id + ".jsonl"));
        return { id, mtime: st.mtimeMs, bytes: st.size };
      } catch {
        return null; // owned but no transcript on disk — skip rather than list bogus stats
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}
