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
  HEARTBEAT_STALE_BUCKET_MS,
  coordinatorHeartbeatJobSpec,
  heartbeatEffectiveInterval,
  heartbeatSweepSignature,
  sweepSessionActivity,
} from "../coordinator-heartbeat.js";
import {
  MIN_INTERVAL_MS,
  normInterval,
  upsertJob,
  readJobs,
  removeJob,
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

// ── the fire decision: TIMERS NUDGE, NEVER SPAWN ────────────────────────────────────────────────
test("planRoleJobFire — idle nudges, running skips; a dormant/absent seat is NEVER respawned", () => {
  assert.equal(planRoleJobFire("idle"), "nudge", "a live+idle seat is nudged (the only fire a timer may make)");
  assert.equal(planRoleJobFire("running"), "skip", "a mid-turn seat is skipped (no interrupt, no stamp)");
  // The invariant: a timer must not create a session. A dormant/absent/exited seat → "none", never a spawn.
  assert.equal(planRoleJobFire("exited"), "none", "an exited occupant is NOT respawned by the timer");
  assert.equal(planRoleJobFire(null), "none", "no live occupant → nothing to do (no spawn)");
  assert.equal(planRoleJobFire(undefined), "none", "absent status → nothing to do (no spawn)");
  // Holds regardless of the declared intent — no intent value ever yields a spawn outcome.
  for (const intent of ["working", "blocked:peer", "blocked:human", "done", null, undefined]) {
    assert.equal(planRoleJobFire("exited", intent), "none", `intent=${intent}: an exited seat is never respawned`);
    assert.ok(
      ["nudge", "skip", "none"].includes(planRoleJobFire("idle", intent)),
      `intent=${intent}: only nudge/skip/none are ever returned — never a spawn`,
    );
  }
});

// A stood-down seat (intent="done") is not nudged either — it declared its work finished, so the timer leaves
// it alone (and reap-only-on-done lets the reaper reclaim the idle session rather than the nudge keeping it
// alive). Checked BEFORE liveness, so it holds even for a done-but-not-yet-exited occupant.
test("planRoleJobFire — a stood-down seat (intent=done) yields 'none' in every liveness state", () => {
  for (const status of ["exited", null, "idle", "running", undefined]) {
    assert.equal(planRoleJobFire(status, "done"), "none", `done seat, occupant=${status}: nothing to do`);
  }
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

  // A role job keys its single-flight claim by the role's SEAT, so a timer fire and a reactive seat wake
  // mutually exclude — one Coordinator per thread, never two racing onto the seat.
  assert.equal(jobClaimKey(TID, job), seatSurfaceKey(TID, "Coordinator"));

  fs.rmSync(repo, { recursive: true, force: true });
});

// ── the server-side sweep gate (§6.1) ───────────────────────────────────────────────────────────
// heartbeatSweepSignature folds the board's sweep-relevant state to a stable string; standingJobsTick
// skips the nudge when it equals the signature stored at the last fire. Equal ⇒ a sweep finds nothing.

const NOW = 10_000_000;
const baseState = () => ({
  threads: [
    {
      threadId: "node:thread:a",
      lastTs: NOW - 60_000,
      intents: {
        Implementer: { intent: "working", ts: NOW - 120_000, sid: "s-imp" },
        Coordinator: { intent: "working", ts: NOW - 120_000, sid: "s-coord" },
      },
    },
    { threadId: "node:thread:b", lastTs: NOW - 500_000 },
  ],
  // sessions[].status is the whole-session BAND (sessionStatus), coarsened by sweepSessionActivity: the
  // Implementer is actively building (`working`), the Coordinator is parked on its heartbeat (`scheduled`).
  sessions: [
    { sid: "s-imp", status: "working" },
    { sid: "s-coord", status: "scheduled" },
  ],
});

// ── sweep-signature session coarsening (the fix: steady-state working ≠ change) ─────────────────────
test("sweepSessionActivity — folds the running↔idle working oscillation; keeps scheduled/terminal distinct", () => {
  // running (mid-turn) and idle-between-turns both mean "actively engaged" → ONE token, so a long build
  // no longer flips the signature every turn.
  assert.equal(sweepSessionActivity("working"), "working");
  assert.equal(sweepSessionActivity("waiting"), "working", "the default idle 'your turn' between turns is still working");
  assert.equal(sweepSessionActivity("waiting-agent"), "working", "blocked:peer rides the intent component, not the session token");
  assert.equal(sweepSessionActivity(null), "working", "a just-spawned live session with no band yet reads engaged");
  // the one calm parked state stays distinct → a scheduled→working transition (a parked session picking up
  // work — the 'idle→working' a sweep should notice) still fires
  assert.equal(sweepSessionActivity("scheduled"), "scheduled");
  // terminal bands stay distinct → a working→done/crashed transition fires even before the row leaves
  assert.equal(sweepSessionActivity("done"), "done");
  assert.equal(sweepSessionActivity("crashed"), "crashed");
  assert.equal(sweepSessionActivity("ended"), "ended");
});

test("heartbeatSweepSignature — a working session's running↔idle micro-flip does NOT move the signature", () => {
  // The bug: sessionStatus flips `working` (mid-turn) ↔ `waiting` (idle between turns) every turn, which
  // used to change the sig each tick and defeat the §6.1 gate — an active build woke the Coordinator each
  // cadence. Both coarsen to one token now, so the signature is stable across the oscillation.
  const running = baseState();
  running.sessions[0].status = "working";
  const between = baseState();
  between.sessions[0].status = "waiting";
  assert.equal(
    heartbeatSweepSignature(between, NOW),
    heartbeatSweepSignature(running, NOW),
    "running ⇄ idle-between-turns holds a stable signature — the gate engages during a steady build",
  );
});

test("heartbeatSweepSignature — deterministic and order-insensitive (threads, intent keys, sessions)", () => {
  const sig = heartbeatSweepSignature(baseState(), NOW);
  assert.equal(heartbeatSweepSignature(baseState(), NOW), sig, "same state → same signature");

  const shuffled = baseState();
  shuffled.threads.reverse();
  shuffled.sessions.reverse();
  // re-key an intents map in reverse insertion order
  const a = shuffled.threads.find((t) => t.threadId === "node:thread:a");
  a.intents = Object.fromEntries(Object.entries(a.intents).reverse());
  assert.equal(heartbeatSweepSignature(shuffled, NOW), sig, "ordering of inputs never changes the signature");

  // degenerate inputs render, never throw
  assert.equal(heartbeatSweepSignature(undefined, NOW), "");
  assert.equal(heartbeatSweepSignature({ threads: [null], sessions: [null] }, NOW), "");
});

test("heartbeatSweepSignature — every sweep-relevant change moves it", () => {
  const sig = heartbeatSweepSignature(baseState(), NOW);
  const mutations = [
    ["a new post (lastTs bump)", (s) => (s.threads[0].lastTs = NOW - 1_000)],
    ["a new thread appears", (s) => s.threads.push({ threadId: "node:thread:c", lastTs: NOW })],
    ["a peer intent changes value (working → done)", (s) => (s.threads[0].intents.Implementer.intent = "done")],
    ["a parked session picks up work (scheduled → working)", (s) => (s.sessions[1].status = "working")],
    ["a working session finishes (working → done)", (s) => (s.sessions[0].status = "done")],
    ["a working session crashes (working → crashed)", (s) => (s.sessions[0].status = "crashed")],
    ["a session appears", (s) => s.sessions.push({ sid: "s-new", status: "working" })],
    ["a session disappears", (s) => s.sessions.pop()],
  ];
  for (const [what, mutate] of mutations) {
    const state = baseState();
    mutate(state);
    assert.notEqual(heartbeatSweepSignature(state, NOW), sig, `${what} changes the signature`);
  }
});

test("heartbeatSweepSignature — an exited session is not sweep-relevant", () => {
  const state = baseState();
  state.sessions.push({ sid: "s-gone", status: "exited" });
  assert.equal(heartbeatSweepSignature(state, NOW), heartbeatSweepSignature(baseState(), NOW));
});

// Stall detection survives the gate: a stall IS a state — the AGE of a non-self working/blocked:peer
// intent, quantized to HEARTBEAT_STALE_BUCKET_MS buckets. Each bucket crossing reads as change, so a
// silently-stalled peer re-fires the sweep once per bucket (not never, and not every 4 minutes).
test("heartbeatSweepSignature — a stalled peer intent re-reads as change once per staleness bucket", () => {
  const sig0 = heartbeatSweepSignature(baseState(), NOW);
  const inBucket = heartbeatSweepSignature(baseState(), NOW + HEARTBEAT_STALE_BUCKET_MS - 130_000);
  assert.equal(inBucket, sig0, "time passing WITHIN a bucket is not a change");
  const crossed = heartbeatSweepSignature(baseState(), NOW + HEARTBEAT_STALE_BUCKET_MS);
  assert.notEqual(crossed, sig0, "a bucket crossing IS a change — the stalled peer gets re-swept");
  for (const intent of ["blocked:peer"]) {
    const state = baseState();
    state.threads[0].intents.Implementer.intent = intent;
    assert.notEqual(
      heartbeatSweepSignature(state, NOW + 10 * HEARTBEAT_STALE_BUCKET_MS),
      heartbeatSweepSignature(state, NOW),
      `${intent} ages into buckets too`,
    );
  }
});

test("heartbeatSweepSignature — the sweeper's own seat and human-parked/done intents never age", () => {
  // Only the Coordinator (self) intent + a blocked:human elsewhere: a quiet board must SETTLE — no
  // bucket may tick the watcher awake forever on its own stance, and a human block is woken by the
  // human's reply (a post), not by re-sweeping.
  const quiet = () => ({
    threads: [
      {
        threadId: "node:thread:a",
        lastTs: NOW - 60_000,
        intents: {
          Coordinator: { intent: "working", ts: NOW - 120_000, sid: "s-coord" },
          Reviewer: { intent: "blocked:human", ts: NOW - 120_000, sid: "s-rev" },
          Implementer: { intent: "done", ts: NOW - 120_000, sid: "s-imp" },
        },
      },
    ],
    sessions: [{ sid: "s-coord", status: "scheduled" }],
  });
  assert.equal(
    heartbeatSweepSignature(quiet(), NOW + 100 * HEARTBEAT_STALE_BUCKET_MS),
    heartbeatSweepSignature(quiet(), NOW),
    "self-working + blocked:human + done: signature is time-invariant — the gate holds indefinitely",
  );
  // a custom selfRole is honoured (the gate is reusable for a non-Coordinator sweeper role)
  const state = baseState();
  assert.notEqual(
    heartbeatSweepSignature(state, NOW + HEARTBEAT_STALE_BUCKET_MS, "Implementer"),
    heartbeatSweepSignature(state, NOW, "Implementer"),
    "with self=Implementer the Coordinator intent is the one that ages",
  );
});

// The gate must stay comfortably inside the measured 1h prompt-cache TTL (§6.2, comment at the interval
// consts): a cadence past the TTL turns every sweep into a ~2× cold rewrite of the parked context.
test("every heartbeat cadence stays well inside the 1h prompt-cache TTL", () => {
  const TTL = 60 * 60_000;
  assert.ok(COORDINATOR_HEARTBEAT_INTERVAL_MS <= TTL / 2, "base cadence ≤ half the TTL");
  assert.ok(HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS <= TTL / 2, "blocked:human backoff ≤ half the TTL");
  assert.ok(HEARTBEAT_STALE_BUCKET_MS <= TTL / 2, "staleness re-sweep bucket ≤ half the TTL");
});

// The mocked GATED tick — the exact composition standingJobsTick now runs for a due, live+idle
// Coordinator seat: plan says nudge → compare the board signature to the one stored at the last fire →
// equal = skip (NO stamp: stays due, re-checks next tick) / different = fire + stamp + store.
test("mocked tick: the §6.1 gate — unchanged state skips the nudge (no stamp), a change fires it", () => {
  const repo = tmpRepo();
  const t0 = 7_000_000;
  const { job } = upsertJob(repo, TID, { ...coordinatorHeartbeatJobSpec(), ts: t0 });
  const lastSwept = new Map(); // the tick's in-memory gate map
  const gateKey = `board|${jobClaimKey(TID, job)}#${job.id}`;

  const tick = (state, now) => {
    if (!jobDue(readJobs(repo, TID)[0], now)) return "not-due";
    if (planRoleJobFire("idle", "working") !== "nudge") return "no-nudge";
    const sig = heartbeatSweepSignature(state, now);
    if (lastSwept.get(gateKey) === sig) return "gated";
    lastSwept.set(gateKey, sig);
    stampFired(repo, TID, job.id, now);
    return "fired";
  };

  const t1 = t0 + job.intervalMs;
  assert.equal(tick(baseState(), t1), "fired", "first due fire is never gated (no stored signature)");
  assert.equal(tick(baseState(), t1 + 1_000), "not-due", "just fired → re-based to the next interval");

  const t2 = t1 + job.intervalMs;
  assert.equal(tick(baseState(), t2), "gated", "due again but NOTHING changed → the nudge is skipped");
  assert.equal(jobDue(readJobs(repo, TID)[0], t2), true, "a gated skip does NOT stamp — the job stays due");
  assert.equal(tick(baseState(), t2 + 15_000), "gated", "…and re-evaluates every scheduler tick");

  const changed = baseState();
  changed.threads[0].lastTs = t2 + 20_000; // a peer posts
  assert.equal(tick(changed, t2 + 30_000), "fired", "the tick a change lands, the sweep fires immediately");
  assert.equal(jobDue(readJobs(repo, TID)[0], t2 + 30_000), false, "a real fire stamps — re-based again");

  // RESTART SAFETY: the gate map is in-memory ON PURPOSE — losing it can only UN-gate, never mis-skip
  // (a skip requires an EQUAL stored signature; an absent one always fires). So the first due sweep
  // after a server restart fires unconditionally, even on a byte-identical board state.
  lastSwept.clear(); // ← the restart
  const t3 = t2 + 30_000 + job.intervalMs;
  assert.equal(tick(changed, t3), "fired", "first due sweep after a restart is never gated");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("mocked tick: fire-next-due re-bases only on a real fire (a nudge), never on a mid-turn skip", () => {
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

// ── job DEDUPE: one Coordinator heartbeat per seat per board (no-leak) ────────────────────────────
// A single Coordinator SESSION seated on N threads accumulates N identical heartbeat jobs (meta + each
// subthread). Keyed per-thread, each used to pass the board-wide §6.1 gate independently and nudge the
// same session N times per cadence. The production gate is keyed by the TARGET SESSION (board + sid), so
// the first job to fire stamps the board-wide signature and the siblings gate out — one nudge per
// Coordinator session per board per signature change. This mocked tick drives that exact composition.
test("mocked tick: DEDUPE — one Coordinator session on N threads nudges ONCE per board per signature change", () => {
  const repo = tmpRepo();
  const t0 = 3_000_000;
  const threads = ["node:thread:meta", "node:thread:stage1", "node:thread:stage2"];
  for (const tid of threads) upsertJob(repo, tid, { ...coordinatorHeartbeatJobSpec(), ts: t0 });
  const SID = "s-coord";
  const lastSwept = new Map(); // the tick's in-memory gate map
  let now = t0 + COORDINATOR_HEARTBEAT_INTERVAL_MS;
  // The board-wide signature — one live Coordinator, parked — is identical for every thread's job in a tick.
  const sig = () =>
    heartbeatSweepSignature(
      { threads: threads.map((tid) => ({ threadId: tid, lastTs: t0 })), sessions: [{ sid: SID, status: "scheduled" }] },
      now,
    );

  const runTick = () => {
    let nudges = 0;
    for (const tid of threads) {
      const job = readJobs(repo, tid)[0];
      if (!jobDue(job, now)) continue;
      if (planRoleJobFire("idle", "working") !== "nudge") continue;
      const gateKey = `board|coord:${SID}`; // ← fix 1a: keyed by the target session, NOT the per-thread job
      const s = sig();
      if (lastSwept.get(gateKey) === s) continue; // a sibling already swept this session this signature → no double nudge
      lastSwept.set(gateKey, s);
      stampFired(repo, tid, job.id, now);
      nudges++;
    }
    return nudges;
  };

  assert.equal(runTick(), 1, "three identical heartbeats on one Coordinator session → exactly ONE nudge");
  now += 15_000; // the siblings never stamped, so they are still due — but the board is unchanged
  assert.equal(runTick(), 0, "…and the still-due siblings gate out — no second nudge on an unchanged board");
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── job CLEANUP: a closed thread's heartbeat is removed (thread-close) ─────────────────────────────
// A Coordinator seat that stands down (declares `done`) closes its thread; reap-only-on-done reclaims the
// idle session. The tick REMOVES that thread's heartbeat (not just skips it) so it stops accumulating on
// the marker and can never fire again — the fix for a done subthread's job that kept firing (esp. when the
// Coordinator was still live on another thread). A later re-staffing re-creates it (ensureCoordinatorHeartbeat).
test("mocked tick: CLEANUP — a Coordinator seat that declared `done` removes its heartbeat job", () => {
  const repo = tmpRepo();
  const t0 = 4_000_000;
  const TID2 = "node:thread:closing";
  upsertJob(repo, TID2, { ...coordinatorHeartbeatJobSpec(), ts: t0 });
  assert.equal(readJobs(repo, TID2).length, 1, "heartbeat attached on staffing");

  // the production tick's close-cleanup branch: role === Coordinator && seatIntent === "done" → removeJob
  const closeTick = (seatIntent) => {
    for (const job of readJobs(repo, TID2)) {
      if (job.role === COORDINATOR_ROLE && seatIntent === "done") removeJob(repo, TID2, job.id);
    }
  };

  closeTick("working");
  assert.equal(readJobs(repo, TID2).length, 1, "an open (working) seat keeps its heartbeat");
  closeTick(null);
  assert.equal(readJobs(repo, TID2).length, 1, "an undeclared seat keeps its heartbeat");
  closeTick("done");
  assert.equal(readJobs(repo, TID2).length, 0, "a stood-down (done) seat's heartbeat is removed → stops firing");
  closeTick("done"); // idempotent — nothing left to remove
  assert.equal(readJobs(repo, TID2).length, 0, "removal is idempotent");
  fs.rmSync(repo, { recursive: true, force: true });
});
