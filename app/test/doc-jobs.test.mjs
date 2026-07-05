// Doc standing jobs (docs/wakeable-substrate-plan.md doc-jobs): the W6 thread-job drop-in generalized onto a
// DOC's marker. This covers the doc LEDGER (marker CRUD on `.canvas/annotations/<enc>.jobs.json`) + the doc
// claim key + the marker sweep; the shared record shape / due-logic is exercised by standing-jobs.test.mjs,
// and the actual firing (standingJobsTick) is server wiring the live smoke test drives, not here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readDocJobs,
  upsertDocJob,
  removeDocJob,
  stampDocFired,
  docJobClaimKey,
  listDocsWithJobs,
} from "../doc-jobs.js";
import { MIN_INTERVAL_MS } from "../standing-jobs.js";
import { setWatcher, readWatchers, removeWatcher } from "../doc-watch.js";
import { docSurfaceKey } from "../auto-wake.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doc-jobs-"));
}
const DOC = "docs/plan.md";
function jobsMarker(repo, doc) {
  return path.join(repo, ".canvas", "annotations", encodeURIComponent(doc) + ".jobs.json");
}

test("upsertDocJob mints a job and readDocJobs round-trips it off the doc marker", () => {
  const repo = tmpRepo();
  assert.deepEqual(readDocJobs(repo, DOC), [], "no marker → no jobs, not a throw");
  const { job, jobs } = upsertDocJob(repo, DOC, { instruction: "sweep the doc", intervalMs: 120_000, by: "human", ts: 1000 });
  assert.equal(jobs.length, 1);
  assert.ok(job.id, "a fresh job gets an id");
  assert.equal(job.role, null, "no role ⇒ bare doc worker");
  assert.equal(job.intervalMs, 120_000);
  assert.equal(job.instruction, "sweep the doc");
  assert.equal(job.createdAt, 1000);
  assert.equal(job.lastFiredAt, null, "never fired yet");
  // Durable on a `.jobs.json` marker in the annotations home (survives a cold restart).
  assert.ok(fs.existsSync(jobsMarker(repo, DOC)), "marker written to .canvas/annotations/<enc>.jobs.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(jobsMarker(repo, DOC), "utf8")).jobs, jobs);
});

test("upsertDocJob with a jobId updates in place, keeping id/createdAt/lastFiredAt", () => {
  const repo = tmpRepo();
  const { job } = upsertDocJob(repo, DOC, { instruction: "v1", intervalMs: 60_000, ts: 1000 });
  stampDocFired(repo, DOC, job.id, 5000);
  const { job: updated, jobs } = upsertDocJob(repo, DOC, { id: job.id, instruction: "v2", intervalMs: 300_000 });
  assert.equal(jobs.length, 1, "updated in place, not appended");
  assert.equal(updated.id, job.id, "same id");
  assert.equal(updated.createdAt, 1000, "createdAt preserved");
  assert.equal(updated.lastFiredAt, 5000, "lastFiredAt preserved across an edit");
  assert.equal(updated.instruction, "v2");
  assert.equal(updated.intervalMs, 300_000);
});

test("a sub-floor interval is clamped on create", () => {
  const repo = tmpRepo();
  const { job } = upsertDocJob(repo, DOC, { instruction: "x", intervalMs: 100 });
  assert.equal(job.intervalMs, MIN_INTERVAL_MS, "100ms clamps to the 60s floor — no per-tick wake storm");
});

test("removeDocJob removes by id; a missing id is a no-op; removing the LAST job deletes the marker", () => {
  const repo = tmpRepo();
  const { job: a } = upsertDocJob(repo, DOC, { instruction: "a", ts: 1 });
  const { job: b } = upsertDocJob(repo, DOC, { instruction: "b", ts: 2 });
  assert.equal(readDocJobs(repo, DOC).length, 2);
  assert.deepEqual(removeDocJob(repo, DOC, "no-such-id"), { removed: false, jobs: readDocJobs(repo, DOC) });
  const { removed, jobs } = removeDocJob(repo, DOC, a.id);
  assert.equal(removed, true);
  assert.deepEqual(jobs.map((j) => j.id), [b.id], "only a removed, b stays");
  assert.ok(fs.existsSync(jobsMarker(repo, DOC)), "marker stays while b remains");
  removeDocJob(repo, DOC, b.id);
  assert.equal(readDocJobs(repo, DOC).length, 0);
  assert.ok(!fs.existsSync(jobsMarker(repo, DOC)), "marker deleted when the last job goes (no stale empty marker)");
});

test("stampDocFired only stamps the matching id and only if present", () => {
  const repo = tmpRepo();
  const { job: a } = upsertDocJob(repo, DOC, { instruction: "a", ts: 1 });
  const { job: b } = upsertDocJob(repo, DOC, { instruction: "b", ts: 2 });
  stampDocFired(repo, DOC, a.id, 9999);
  const jobs = readDocJobs(repo, DOC);
  assert.equal(jobs.find((j) => j.id === a.id).lastFiredAt, 9999);
  assert.equal(jobs.find((j) => j.id === b.id).lastFiredAt, null, "b untouched");
  assert.deepEqual(stampDocFired(repo, DOC, "nope", 1), jobs, "a no-such-id stamp rewrites nothing");
});

test("docJobClaimKey keys every doc job by the doc SURFACE (roled or bare) — one worker per doc", () => {
  // Unlike a thread bare job (keyed by its own id so two run independently), a doc serializes: all its jobs
  // + a doc-wake worker share the one surface, so a timer-fired job and an annotation-driven wake exclude.
  assert.equal(docJobClaimKey(DOC), docSurfaceKey(DOC));
  assert.equal(docJobClaimKey(DOC), `doc:${DOC}`);
});

test("listDocsWithJobs returns the decoded, sorted doc paths, and drops a doc once its jobs are gone", () => {
  const repo = tmpRepo();
  assert.deepEqual(listDocsWithJobs(repo), [], "no annotations dir → [], not a throw");
  upsertDocJob(repo, "docs/z.md", { instruction: "z" });
  const { job: aJob } = upsertDocJob(repo, "docs/a.md", { instruction: "a" });
  assert.deepEqual(listDocsWithJobs(repo), ["docs/a.md", "docs/z.md"], "sorted, both listed");
  removeDocJob(repo, "docs/a.md", aJob.id);
  assert.deepEqual(listDocsWithJobs(repo), ["docs/z.md"], "docs/a.md drops once its last job is removed");
});

test("a doc's jobs and its watchers are independent markers — neither op clobbers the other", () => {
  const repo = tmpRepo();
  setWatcher(repo, DOC, { role: "Coordinator", level: "all", by: "human", ts: 1000 });
  upsertDocJob(repo, DOC, { instruction: "sweep", role: "Coordinator", intervalMs: 60_000 });
  // Removing the last WATCHER (which deletes the .watch.json marker) must not touch the .jobs.json marker.
  removeWatcher(repo, DOC, "Coordinator");
  assert.deepEqual(readWatchers(repo, DOC), [], "watcher gone");
  assert.equal(readDocJobs(repo, DOC).length, 1, "job survived the watcher removal");
  // And re-arming a watcher doesn't disturb the jobs.
  setWatcher(repo, DOC, { role: "Reviewer", level: "mentions", by: "human" });
  assert.equal(readDocJobs(repo, DOC).length, 1, "job still there after a fresh watcher");
  assert.equal(readWatchers(repo, DOC).length, 1);
});
