// Doc standing jobs (docs/wakeable-substrate-plan.md doc-jobs; the W6 drop-in). A STANDING JOB — a periodic,
// server-fired worker declared on a durable RECORD, not owned by the session that created it — generalized
// off the thread onto a DOC, exactly as doc-watch.js generalized seats/watchers off the thread. Same record
// shape and same lifecycle as a thread job (standing-jobs.js): the CRUD is the shared storage-agnostic core
// (readJobsIn/upsertJobIn/removeJobIn/stampFiredIn) fed a DOC store here; only the marker file differs. The
// firing (dueJobs → serverSpawnWorker) stays in vite-fs-plugin.ts's standingJobsTick, which already iterates
// docs beside threads — this module is just the ledger + the doc single-flight claim key.
//
// Storage: a per-doc JSON marker `<enc>.jobs.json` beside the annotation `<enc>.jsonl` and the watch marker
// `<enc>.watch.json`, under the board's `.canvas/annotations/` home (git-ignored, shadow-versioned like its
// siblings). A separate marker from `.watch.json` on purpose — watchers and jobs are independent doc concerns,
// and keeping them apart means removeWatcher's "delete the marker when the last watcher goes" can't nuke a
// doc's jobs (and vice-versa). `enc` is encodeURIComponent(filePath), the annotation-ledger naming, so
// listDocsWithJobs can decode it back and neither the `.jsonl` sweep nor the watch sweep collides.

import fs from "node:fs";
import path from "node:path";
import { canvasAnnotationsDir } from "./doc-watch.js";
import { docSurfaceKey } from "./auto-wake.js";
import { readJobsIn, upsertJobIn, removeJobIn, stampFiredIn } from "./standing-jobs.js";

function jobsPath(repoPath, filePath) {
  return path.join(canvasAnnotationsDir(repoPath), encodeURIComponent(filePath) + ".jobs.json");
}

/**
 * The job store backed by a doc's `.jobs.json` marker. `read` best-effort-parses the marker's `jobs` array;
 * `write` persists it, and DELETES the marker when the list goes empty (a removeJob to zero) so listDocsWithJobs
 * reflects "no jobs" without a stale empty marker — the removeWatcher convention. Every op is best-effort: a
 * standing job is a convenience, never a gate, so a failed read/write must not throw.
 */
function docJobStore(repoPath, filePath) {
  return {
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(jobsPath(repoPath, filePath), "utf8"))?.jobs;
      } catch {
        return [];
      }
    },
    write: (jobs) => {
      try {
        if (!Array.isArray(jobs) || jobs.length === 0) {
          try {
            fs.unlinkSync(jobsPath(repoPath, filePath));
          } catch {
            /* already gone — fine */
          }
          return;
        }
        fs.mkdirSync(canvasAnnotationsDir(repoPath), { recursive: true });
        fs.writeFileSync(jobsPath(repoPath, filePath), JSON.stringify({ path: filePath, jobs }));
      } catch {
        /* not fatal — the marker is a convenience, not the doc */
      }
    },
  };
}

/** A doc's standing jobs (array), or [] if none / no marker. Best-effort, never throws. */
export function readDocJobs(repoPath, filePath) {
  return readJobsIn(docJobStore(repoPath, filePath));
}

/** Create or update a standing job on a doc (upsert by `id`). See standing-jobs.js upsertJobIn. */
export function upsertDocJob(repoPath, filePath, opts) {
  return upsertJobIn(docJobStore(repoPath, filePath), opts);
}

/** Remove a doc job by id. Returns { removed, jobs }. See standing-jobs.js removeJobIn. */
export function removeDocJob(repoPath, filePath, id) {
  return removeJobIn(docJobStore(repoPath, filePath), id);
}

/** Stamp a doc job's `lastFiredAt` (on a REAL fire only — fire-next-due). See standing-jobs.js stampFiredIn. */
export function stampDocFired(repoPath, filePath, id, ts) {
  return stampFiredIn(docJobStore(repoPath, filePath), id, ts);
}

/**
 * The single-flight claim key for a doc job's fire: the doc's SURFACE key (docSurfaceKey). All of a doc's
 * jobs plus a doc-wake worker share ONE surface, so at most one worker services a doc at a time — a
 * timer-fired job and an annotation-driven doc-wake mutually exclude, matching the "one worker per doc's
 * open queue" model (auto-wake.js). (A thread bare job keys by its own id, letting two run independently;
 * a doc deliberately serializes, since the doc worker's job IS to drain the whole doc.)
 */
export function docJobClaimKey(filePath) {
  return docSurfaceKey(filePath);
}

/**
 * The doc paths this board has a `.jobs.json` marker for (decoded from the on-disk names) — the tick's "which
 * docs carry a standing job" source, mirroring doc-watch.js listWatchedPaths. Missing dir → [], never throws.
 */
export function listDocsWithJobs(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(canvasAnnotationsDir(repoPath));
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".jobs.json"))
    .map((n) => {
      try {
        return decodeURIComponent(n.slice(0, -".jobs.json".length));
      } catch {
        return null;
      }
    })
    .filter((p) => typeof p === "string" && p.length > 0)
    .sort();
}
