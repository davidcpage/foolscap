// The doc-watch ledger (docs/anchored-async-ask.md §2/§4, docs/wakeable-substrate-plan.md W4 — P1). The
// annotation ledger's sibling: a DOC becomes a wakeable surface by carrying SEATS, exactly as a thread does
// (threads-as-cards §5), generalized off the thread onto the doc. A watcher is a role bound to a doc at a
// notification level — the durable "who to wake when a comment lands", a standing job owned by the DOC, not
// its creator. Two things fill a doc's seats (§2): a human-armed watcher (the "watch for comments"
// affordance) and — later, W5 — an ask-armed watcher an agent's `--blocking` question takes.
//
// Storage: a per-doc JSON MARKER `<enc>.watch.json` beside the annotation `<enc>.jsonl`, under the board's
// `.canvas/annotations/` home (git-ignored, shadow-versioned like the annotations it sits with). A marker,
// not an append-log: a watcher is small mutable state (level/paused), not a stream of events — the
// thread-ledger meta convention, not the annotation-log convention. `enc` is encodeURIComponent(filePath),
// the annotation-ledger naming, so listWatchedPaths can decode it back and the `.jsonl` sweep never collides.
//
// A watch record (§4): `{ role, level:"all"|"mentions"|"paused", state:"active"|"paused", by, createdAt }`.
// `level` is the standing preference; `state` is the transient pause/resume toggle (pausing must not lose the
// level, so resume restores it) — the EFFECTIVE wake level is `paused` while state is paused, else `level`
// (see watcherEffectiveLevel). Keyed by `role` (one watcher per role per doc — 1:1 until labelled
// multiplicity ships, the seat convention). Every write is best-effort: a watch is a convenience, never a
// gate, so a failed write must not throw.

import fs from "node:fs";
import path from "node:path";
import { normLevel } from "./notification-levels.js";

/** The directory holding the watch markers — the SAME dir as the annotation logs (they're siblings). */
export function canvasAnnotationsDir(repoPath) {
  return path.join(repoPath, ".canvas", "annotations");
}

function watchPath(repoPath, filePath) {
  return path.join(canvasAnnotationsDir(repoPath), encodeURIComponent(filePath) + ".watch.json");
}

/**
 * Read a doc's watch marker as an array of watcher records (newest binding order isn't tracked — the map is
 * keyed by role), or [] if there's none / it's unreadable. Best-effort, never throws.
 */
export function readWatchers(repoPath, filePath) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(watchPath(repoPath, filePath), "utf8"));
  } catch {
    return [];
  }
  const watchers = marker?.watchers;
  return watchers && typeof watchers === "object" ? Object.values(watchers) : [];
}

// Write the marker's `watchers` map back. Internal — callers use setWatcher/removeWatcher/setWatcherState.
function writeWatchers(repoPath, filePath, byRole) {
  try {
    fs.mkdirSync(canvasAnnotationsDir(repoPath), { recursive: true });
    fs.writeFileSync(watchPath(repoPath, filePath), JSON.stringify({ path: filePath, watchers: byRole }));
    return true;
  } catch {
    return false;
  }
}

function watchersMap(repoPath, filePath) {
  const out = {};
  for (const w of readWatchers(repoPath, filePath)) if (w && typeof w.role === "string") out[w.role] = w;
  return out;
}

/**
 * Bind or re-level a watcher on a doc (upsert by role). `createdAt`/`by` are written once (a re-level keeps
 * the original arming provenance); `level` is normalized. A fresh bind is `state:"active"`; re-binding an
 * existing watcher preserves its `state` unless `state` is passed. Returns the watcher record.
 */
export function setWatcher(repoPath, filePath, { role, level, state, by, ts }) {
  const byRole = watchersMap(repoPath, filePath);
  const existing = byRole[role];
  const watcher = {
    role,
    level: normLevel(level ?? existing?.level),
    state: state === "paused" || state === "active" ? state : (existing?.state ?? "active"),
    by: existing?.by ?? by ?? "human",
    createdAt: existing?.createdAt ?? ts ?? Date.now(),
  };
  byRole[role] = watcher;
  writeWatchers(repoPath, filePath, byRole);
  return watcher;
}

/**
 * Flip a watcher's `state` to "paused" or "active" (the pause/resume affordance) without touching its
 * `level`. No-op returning null if there's no such watcher. Returns the updated watcher.
 */
export function setWatcherState(repoPath, filePath, role, state) {
  const byRole = watchersMap(repoPath, filePath);
  const existing = byRole[role];
  if (!existing) return null;
  existing.state = state === "paused" ? "paused" : "active";
  byRole[role] = existing;
  writeWatchers(repoPath, filePath, byRole);
  return existing;
}

/**
 * Remove a watcher (unwatch). Returns whether one was removed. Deletes the marker file when the last
 * watcher goes, so listWatchedPaths reflects "no watchers" without a stale empty marker.
 */
export function removeWatcher(repoPath, filePath, role) {
  const byRole = watchersMap(repoPath, filePath);
  if (!byRole[role]) return false;
  delete byRole[role];
  if (Object.keys(byRole).length === 0) {
    try {
      fs.unlinkSync(watchPath(repoPath, filePath));
    } catch {
      /* already gone — fine */
    }
    return true;
  }
  writeWatchers(repoPath, filePath, byRole);
  return true;
}

/**
 * A watcher's EFFECTIVE notification level: `paused` while its `state` is paused (a temporary mute that
 * still yields to an @-mention via wakesSeat), else its standing `level`. This is what the wake trigger
 * (W5) feeds to wakesSeat — pausing disarms without discarding the preference.
 */
export function watcherEffectiveLevel(watcher) {
  return watcher?.state === "paused" ? "paused" : normLevel(watcher?.level);
}

/**
 * The doc paths this board has a watch marker for (decoded from the on-disk names) — the sweep's "what's
 * watched" source. Missing dir → [], never throws.
 */
export function listWatchedPaths(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(canvasAnnotationsDir(repoPath));
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".watch.json"))
    .map((n) => {
      try {
        return decodeURIComponent(n.slice(0, -".watch.json".length));
      } catch {
        return null;
      }
    })
    .filter((p) => typeof p === "string" && p.length > 0)
    .sort();
}
