// Standing jobs (R6, docs/wakeable-substrate-plan.md W6): periodic server-fired workers declared on a
// thread's durable marker. This covers the LEDGER (marker CRUD on `.canvas/threads/`) and the PURE due-logic
// (fire-next-due, the interval floor, single-flight keys). The actual spawning (standingJobsTick →
// serverSpawnWorker) is server wiring, exercised by the live smoke test, not here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_INTERVAL_MS,
  normInterval,
  readJobs,
  upsertJob,
  removeJob,
  stampFired,
  jobDue,
  jobDueWithInterval,
  dueJobs,
  jobClaimKey,
  sessionHasScheduledWake,
} from "../standing-jobs.js";
import { readThreadMeta, fillSeat, listThreads } from "../thread-ledger.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "standing-jobs-"));
}
const TID = "node:thread:jobs";

test("normInterval clamps to the floor and rejects junk", () => {
  assert.equal(normInterval(100), MIN_INTERVAL_MS, "sub-floor clamps up");
  assert.equal(normInterval(MIN_INTERVAL_MS), MIN_INTERVAL_MS, "at the floor stays");
  assert.equal(normInterval(5 * 60_000), 5 * 60_000, "above the floor is kept");
  assert.equal(normInterval("nonsense"), MIN_INTERVAL_MS, "non-numeric ⇒ the floor");
  assert.equal(normInterval(undefined), MIN_INTERVAL_MS, "missing ⇒ the floor");
});

test("upsertJob mints a job and readJobs round-trips it off the marker", () => {
  const repo = tmpRepo();
  assert.deepEqual(readJobs(repo, TID), [], "no marker → no jobs, not a throw");
  const { job, jobs } = upsertJob(repo, TID, { instruction: "sweep for stalls", intervalMs: 120_000, by: "human", ts: 1000 });
  assert.equal(jobs.length, 1);
  assert.ok(job.id, "a fresh job gets an id");
  assert.equal(job.role, null, "no role ⇒ bare worker");
  assert.equal(job.intervalMs, 120_000);
  assert.equal(job.instruction, "sweep for stalls");
  assert.equal(job.createdAt, 1000);
  assert.equal(job.lastFiredAt, null, "never fired yet");
  // It's durable on the thread marker (survives a cold restart — the point of 'jobs survive their creator').
  assert.deepEqual(readThreadMeta(repo, TID).jobs, jobs);
});

test("upsertJob with a jobId updates in place, keeping id/createdAt/lastFiredAt", () => {
  const repo = tmpRepo();
  const { job } = upsertJob(repo, TID, { instruction: "v1", intervalMs: 60_000, ts: 1000 });
  const fired = stampFired(repo, TID, job.id, 5000);
  assert.equal(fired[0].lastFiredAt, 5000);
  const { job: updated, jobs } = upsertJob(repo, TID, { id: job.id, instruction: "v2", intervalMs: 300_000 });
  assert.equal(jobs.length, 1, "updated in place, not appended");
  assert.equal(updated.id, job.id, "same id");
  assert.equal(updated.createdAt, 1000, "createdAt preserved");
  assert.equal(updated.lastFiredAt, 5000, "lastFiredAt preserved across an edit");
  assert.equal(updated.instruction, "v2");
  assert.equal(updated.intervalMs, 300_000);
});

test("a sub-floor interval is clamped on create", () => {
  const repo = tmpRepo();
  const { job } = upsertJob(repo, TID, { instruction: "x", intervalMs: 100 });
  assert.equal(job.intervalMs, MIN_INTERVAL_MS, "100ms clamps to the 60s floor — no per-tick wake storm");
});

test("removeJob removes by id; a missing id is a no-op", () => {
  const repo = tmpRepo();
  const { job: a } = upsertJob(repo, TID, { instruction: "a" });
  const { job: b } = upsertJob(repo, TID, { instruction: "b" });
  assert.equal(readJobs(repo, TID).length, 2);
  assert.deepEqual(removeJob(repo, TID, "no-such-id"), { removed: false, jobs: readJobs(repo, TID) });
  const { removed, jobs } = removeJob(repo, TID, a.id);
  assert.equal(removed, true);
  assert.deepEqual(jobs.map((j) => j.id), [b.id], "only a removed, b stays");
});

test("jobDue: first fire is one interval after creation, not on creation", () => {
  const job = { id: "j", intervalMs: 60_000, createdAt: 1000, lastFiredAt: null };
  assert.equal(jobDue(job, 1000), false, "not due at creation");
  assert.equal(jobDue(job, 1000 + 59_999), false, "not due before one interval");
  assert.equal(jobDue(job, 1000 + 60_000), true, "due exactly one interval out");
});

test("jobDue after a fire counts from lastFiredAt (periodic)", () => {
  const job = { id: "j", intervalMs: 60_000, createdAt: 1000, lastFiredAt: 100_000 };
  assert.equal(jobDue(job, 100_000 + 30_000), false, "not due mid-interval");
  assert.equal(jobDue(job, 100_000 + 60_000), true, "due one interval after the last fire");
});

test("jobDueWithInterval: applies an EXPLICIT interval (the intent-keyed backoff), and jobDue delegates to it", () => {
  const job = { id: "j", intervalMs: 60_000, createdAt: 1000, lastFiredAt: 100_000 };
  // With a backed-off 5x interval, a fire that WOULD be due at the base interval is NOT yet due.
  assert.equal(jobDueWithInterval(job, 100_000 + 60_000, 300_000), false, "not due — the effective interval is longer");
  assert.equal(jobDueWithInterval(job, 100_000 + 300_000, 300_000), true, "due once the longer interval elapses");
  // jobDue is exactly jobDueWithInterval against the job's own interval.
  assert.equal(jobDueWithInterval(job, 100_000 + 60_000, job.intervalMs), jobDue(job, 100_000 + 60_000));
  // a falsy interval is never due (guards a role job with an unresolved interval)
  assert.equal(jobDueWithInterval(job, 1e12, 0), false);
  assert.equal(jobDueWithInterval(null, 1e12, 60_000), false);
});

test("fire-next-due, NOT catch-up: a long-overdue job is due exactly once, then stampFired re-bases it", () => {
  const repo = tmpRepo();
  // A job created long ago, last fired long ago (simulating the server having been down for hours).
  const { job } = upsertJob(repo, TID, { instruction: "daily", intervalMs: 60_000, ts: 0 });
  stampFired(repo, TID, job.id, 1000); // fired once at t=1000
  const bootNow = 10 * 60 * 60_000; // 10 hours later — HUNDREDS of intervals missed
  const overdue = readJobs(repo, TID)[0];
  assert.equal(jobDue(overdue, bootNow), true, "overdue ⇒ due");
  // The tick fires it ONCE and re-bases to now — it does NOT replay the hundreds of missed fires.
  stampFired(repo, TID, job.id, bootNow);
  const after = readJobs(repo, TID)[0];
  assert.equal(after.lastFiredAt, bootNow, "schedule re-based to now");
  assert.equal(jobDue(after, bootNow), false, "not immediately due again — no catch-up storm");
  assert.equal(jobDue(after, bootNow + 60_000), true, "next fire is one interval out, as normal");
});

test("stampFired only stamps the matching id and only if present", () => {
  const repo = tmpRepo();
  const { job: a } = upsertJob(repo, TID, { instruction: "a", ts: 1 });
  const { job: b } = upsertJob(repo, TID, { instruction: "b", ts: 2 });
  stampFired(repo, TID, a.id, 9999);
  const jobs = readJobs(repo, TID);
  assert.equal(jobs.find((j) => j.id === a.id).lastFiredAt, 9999);
  assert.equal(jobs.find((j) => j.id === b.id).lastFiredAt, null, "b untouched");
  // A no-such-id stamp doesn't rewrite the marker (returns the prior jobs unchanged).
  assert.deepEqual(stampFired(repo, TID, "nope", 1), jobs);
});

test("dueJobs filters the due ones at a given now", () => {
  const jobs = [
    { id: "a", intervalMs: 60_000, createdAt: 0, lastFiredAt: null }, // due at 60_000
    { id: "b", intervalMs: 300_000, createdAt: 0, lastFiredAt: null }, // due at 300_000
    { id: "c", intervalMs: 0, createdAt: 0, lastFiredAt: null }, // guard: intervalMs 0 never due
  ];
  assert.deepEqual(dueJobs(jobs, 60_000).map((j) => j.id), ["a"]);
  assert.deepEqual(dueJobs(jobs, 300_000).map((j) => j.id), ["a", "b"]);
  assert.deepEqual(dueJobs([], 1), []);
  assert.deepEqual(dueJobs(null, 1), []);
});

test("jobClaimKey: a role-named job keys by SEAT; a bare job keys by its own id", () => {
  // Role job → the seat surface key, so it mutually excludes a dormant-seat respawn onto the same seat.
  assert.equal(jobClaimKey(TID, { id: "j1", role: "Coordinator" }), `thread:${TID}#Coordinator`);
  // Bare job → its own id, so two bare jobs on one thread run independently.
  assert.equal(jobClaimKey(TID, { id: "j2", role: null }), `job:${TID}#j2`);
});

test("sessionHasScheduledWake: an idle looping session reads 'scheduled' ONLY with a live job on its seat", () => {
  const repo = tmpRepo();
  const SID = "sid-coord-1";
  // The Coordinator holds a seat but there is NO standing job yet — jobs are human-gated and often absent.
  // A looping role with no job will never wake on a timer, so no wake is scheduled (the bug: it showed
  // "scheduled" anyway off the static `loops` flag).
  fillSeat(repo, TID, "Coordinator", SID, 1000);
  assert.equal(sessionHasScheduledWake(listThreads(repo), SID), false, "seat but no job ⇒ NOT scheduled → 'waiting'");
  // Add a live standing job targeting the Coordinator seat → a wake IS scheduled for its occupant.
  upsertJob(repo, TID, { instruction: "sweep", role: "Coordinator", intervalMs: 60_000 });
  assert.equal(sessionHasScheduledWake(listThreads(repo), SID), true, "job on the occupied seat ⇒ scheduled");
  // A different session, not in the seat, gets no wake from this job.
  assert.equal(sessionHasScheduledWake(listThreads(repo), "other-sid"), false, "job fires into the SEAT, not any sid");
});

test("sessionHasScheduledWake: a BARE (roleless) job never schedules a wake for an existing session", () => {
  const repo = tmpRepo();
  const SID = "sid-x";
  fillSeat(repo, TID, "Coordinator", SID, 1000);
  // A bare job always spawns a FRESH worker (jobClaimKey keys by its own id, standingJobsTick respawns) — it
  // targets no existing session, so it must NOT flip an idle session to "scheduled".
  upsertJob(repo, TID, { instruction: "bare sweep", role: null, intervalMs: 60_000 });
  assert.equal(sessionHasScheduledWake(listThreads(repo), SID), false, "bare job targets no seat ⇒ NOT scheduled");
});

test("sessionHasScheduledWake: defensive on empty/absent input", () => {
  assert.equal(sessionHasScheduledWake([], "sid"), false, "no markers ⇒ false");
  assert.equal(sessionHasScheduledWake(null, "sid"), false, "null markers ⇒ false, not a throw");
  assert.equal(sessionHasScheduledWake([{ jobs: [{ role: "R" }], seats: {} }], ""), false, "no sid ⇒ false");
  assert.equal(sessionHasScheduledWake([{}], "sid"), false, "marker with no jobs/seats ⇒ false");
});

test("jobs coexist with seats/intents/pins on the same marker (no clobber)", () => {
  const repo = tmpRepo();
  fillSeat(repo, TID, "Coordinator", "sid-1", 1000); // writes seats
  upsertJob(repo, TID, { instruction: "sweep", role: "Coordinator", intervalMs: 60_000 });
  const meta = readThreadMeta(repo, TID);
  assert.ok(meta.seats?.Coordinator, "seat survived the job write");
  assert.equal(meta.jobs.length, 1, "job landed alongside the seat");
  assert.equal(meta.jobs[0].role, "Coordinator");
});
