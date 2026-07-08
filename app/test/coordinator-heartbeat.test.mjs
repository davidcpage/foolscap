// Coordinator heartbeat migrated onto the standing-job machinery (wakeable-substrate-plan.md — wake-live
// loop-migration). Two surfaces under test: the canonical JOB SPEC (coordinator-heartbeat.js — the single
// source of truth for role/interval/instruction) and the WAKE-LIVE-ELSE-RESPAWN decision (planRoleJobFire in
// standing-jobs.js). The last test is a MOCKED TICK: it drives the exact pure logic standingJobsTick composes
// for a Coordinator heartbeat job — due-detection, seat-keyed single-flight, and the nudge/skip/respawn plan
// across the three occupant states — without spawning a live session (the autonomy switch stays OFF).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COORDINATOR_ROLE,
  COORDINATOR_HEARTBEAT_INTERVAL_MS,
  COORDINATOR_HEARTBEAT_INSTRUCTION,
  HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS,
  coordinatorHeartbeatJobSpec,
  heartbeatEffectiveInterval,
} from "../coordinator-heartbeat.js";
import {
  MIN_INTERVAL_MS,
  normInterval,
  upsertJob,
  readJobs,
  stampFired,
  jobDue,
  dueJobs,
  jobClaimKey,
  planRoleJobFire,
} from "../standing-jobs.js";
import { seatSurfaceKey } from "../auto-wake.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coord-heartbeat-"));
}
const TID = "node:thread:coord";

// ── the canonical spec ──────────────────────────────────────────────────────────────────────────
test("coordinatorHeartbeatJobSpec — role, default interval, non-empty sweep instruction", () => {
  const spec = coordinatorHeartbeatJobSpec();
  assert.equal(spec.role, "Coordinator");
  assert.equal(spec.role, COORDINATOR_ROLE);
  assert.equal(spec.intervalMs, normInterval(COORDINATOR_HEARTBEAT_INTERVAL_MS));
  assert.equal(spec.instruction, COORDINATOR_HEARTBEAT_INSTRUCTION);
  // the sweep instruction must actually tell the worker to read the inbox + board and sweep for stalls
  for (const needle of ["inbox", "board", "sweep", "stalled"])
    assert.ok(spec.instruction.toLowerCase().includes(needle), `instruction mentions "${needle}"`);
});

test("coordinatorHeartbeatJobSpec — interval override, floor-clamped", () => {
  assert.equal(coordinatorHeartbeatJobSpec({ intervalMs: 600_000 }).intervalMs, 600_000, "honours an override");
  assert.equal(
    coordinatorHeartbeatJobSpec({ intervalMs: 100 }).intervalMs,
    MIN_INTERVAL_MS,
    "a sub-floor override clamps up to the standing-job floor",
  );
});

test("the default interval is at/above the standing-job floor", () => {
  assert.ok(COORDINATOR_HEARTBEAT_INTERVAL_MS >= MIN_INTERVAL_MS);
});

// ── intent-keyed backoff (part 4) ─────────────────────────────────────────────────────────────────
test("heartbeatEffectiveInterval: backs off ONLY while the seat is blocked:human; base cadence otherwise", () => {
  const base = COORDINATOR_HEARTBEAT_INTERVAL_MS; // 4 min
  // blocked:human → the slow pulse (parked on a human; the reply wakes it reactively)
  assert.equal(heartbeatEffectiveInterval(base, "blocked:human"), HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS);
  assert.ok(HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS > base, "the backoff pulse really is slower than the base");
  // every other stance keeps the base cadence — blocked:peer/working MUST stay fast to detect a peer finishing
  for (const intent of ["working", "blocked:peer", "done", null, undefined])
    assert.equal(heartbeatEffectiveInterval(base, intent), base, `intent=${intent} keeps the base cadence`);
});

test("heartbeatEffectiveInterval: never SHORTENS a base already longer than the backoff floor", () => {
  const longBase = HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS + 60_000; // a human-set --interval past the floor
  assert.equal(heartbeatEffectiveInterval(longBase, "blocked:human"), longBase);
});

// ── the wake-live-else-respawn decision ─────────────────────────────────────────────────────────
test("planRoleJobFire — idle nudges, running skips, dormant/absent respawns", () => {
  assert.equal(planRoleJobFire("idle"), "nudge", "a live+idle seat is nudged (cheap — context intact)");
  assert.equal(planRoleJobFire("running"), "skip", "a mid-turn seat is skipped (no interrupt, no stamp)");
  assert.equal(planRoleJobFire("exited"), "respawn", "an exited occupant is reconstituted fresh");
  assert.equal(planRoleJobFire(null), "respawn", "no live occupant → respawn");
  assert.equal(planRoleJobFire(undefined), "respawn", "absent status → respawn");
});

// ── the mocked tick ─────────────────────────────────────────────────────────────────────────────
test("a Coordinator heartbeat job on a thread: due-logic + seat-keyed single-flight", () => {
  const repo = tmpRepo();
  const t0 = 1_000_000;
  const { job } = upsertJob(repo, TID, { ...coordinatorHeartbeatJobSpec(), by: "human", ts: t0 });

  // A fresh job's first fire is one interval out (not on creation) — no wake-on-enable storm.
  assert.equal(jobDue(job, t0), false, "not due at creation");
  assert.equal(jobDue(job, t0 + job.intervalMs - 1), false, "not due just before the interval");
  assert.equal(jobDue(job, t0 + job.intervalMs), true, "due exactly one interval out");

  // The persisted job reads back and dueJobs picks it up once due.
  const persisted = readJobs(repo, TID);
  assert.equal(persisted.length, 1);
  assert.equal(dueJobs(persisted, t0 + job.intervalMs).length, 1);

  // A role job keys its single-flight claim by the role's SEAT, so a timer fire and a dormant-seat
  // reconstitution mutually exclude — one Coordinator per thread, never two racing onto the seat.
  assert.equal(jobClaimKey(TID, job), seatSurfaceKey(TID, "Coordinator"));

  fs.rmSync(repo, { recursive: true, force: true });
});

test("mocked tick: fire-next-due re-bases only on a real fire (nudge/respawn), never on a mid-turn skip", () => {
  const repo = tmpRepo();
  const t0 = 5_000_000;
  const { job } = upsertJob(repo, TID, { ...coordinatorHeartbeatJobSpec(), ts: t0 });
  const fireAt = t0 + job.intervalMs;

  // Drive one tick's decision for each occupant state — the exact branch standingJobsTick takes.
  // running → skip: NO stamp, so the job stays due and re-fires next tick.
  assert.equal(planRoleJobFire("running"), "skip");
  // (no stampFired call on a skip)
  assert.equal(jobDue(readJobs(repo, TID)[0], fireAt), true, "a skipped mid-turn fire stays due — retries next tick");

  // idle → nudge: stamp re-bases the schedule to now, so it is no longer due until the NEXT interval.
  assert.equal(planRoleJobFire("idle"), "nudge");
  stampFired(repo, TID, job.id, fireAt);
  const afterNudge = readJobs(repo, TID)[0];
  assert.equal(jobDue(afterNudge, fireAt), false, "just fired → not due");
  assert.equal(jobDue(afterNudge, fireAt + job.intervalMs), true, "due again one interval after the fire");

  fs.rmSync(repo, { recursive: true, force: true });
});
