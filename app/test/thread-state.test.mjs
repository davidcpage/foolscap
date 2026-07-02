// The §8 step-3 derived thread-state projection (thread-state.js) — the session-thread-lifecycle §4/§6
// state machine as table tests. The asymmetry the machine exists for (§5): "no recent activity" must
// split into waiting (surface it — the human's turn) vs dormant (archive it — nobody needs anything),
// and only declared intent can tell them apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveThreadState, isThreadState, THREAD_STATES } from "../thread-state.js";

const p = (processState, intent = null) => ({ processState, intent });

test("no participants → dormant (unstaffed satisfies the archive predicate; waiting stays hard to enter, and the first join/message re-activates)", () => {
  assert.equal(deriveThreadState([]), "dormant");
  assert.equal(deriveThreadState(undefined), "dormant");
});

test("any running participant → active, whatever anyone declared", () => {
  assert.equal(deriveThreadState([p("running")]), "active");
  assert.equal(deriveThreadState([p("running", "blocked:human")]), "active");
  assert.equal(deriveThreadState([p("running"), p("idle", "blocked:human")]), "active");
});

test("idle + undeclared defaults to working → active (between turns, will continue when nudged)", () => {
  assert.equal(deriveThreadState([p("idle")]), "active");
});

test("idle + declared working → active", () => {
  assert.equal(deriveThreadState([p("idle", "working")]), "active");
});

test("quorum, not first-mover: one done while another works → active", () => {
  assert.equal(deriveThreadState([p("idle", "done"), p("idle", "working")]), "active");
});

test("blocked:human with no one active → waiting (the loud state)", () => {
  assert.equal(deriveThreadState([p("idle", "blocked:human")]), "waiting");
  assert.equal(deriveThreadState([p("idle", "blocked:human"), p("idle", "done")]), "waiting");
  assert.equal(deriveThreadState([p("idle", "blocked:human"), p("exited")]), "waiting");
});

test("a seat-keyed blocked:human survives its occupant's exit → still waiting (the question is still on the table)", () => {
  assert.equal(deriveThreadState([p("exited", "blocked:human")]), "waiting");
  assert.equal(deriveThreadState([p("exited", "blocked:human"), p("exited", "done")]), "waiting");
});

test("all done (live) → dormant (the cooperative yield: safe to park, reversible)", () => {
  assert.equal(deriveThreadState([p("idle", "done")]), "dormant");
  assert.equal(deriveThreadState([p("idle", "done"), p("idle", "done")]), "dormant");
});

test("all exited, nothing declared → dormant (their parts are over; re-activation is non-destructive)", () => {
  assert.equal(deriveThreadState([p("exited")]), "dormant");
  assert.equal(deriveThreadState([p("exited"), p("exited", "done")]), "dormant");
});

test("exited while declared working → dormant (exited counts toward the quorum; the crashed SESSION card is the loud surface)", () => {
  assert.equal(deriveThreadState([p("exited", "working")]), "dormant");
});

test("live blocked:peer chains fall through the §4 table → active (inter-agent work: not the human's turn, not archivable)", () => {
  assert.equal(deriveThreadState([p("idle", "blocked:peer")]), "active");
  assert.equal(deriveThreadState([p("idle", "blocked:peer"), p("idle", "done")]), "active");
});

test("blocked:peer + blocked:human with none active → waiting wins (blocked:human is checked before the fallback)", () => {
  assert.equal(deriveThreadState([p("idle", "blocked:peer"), p("idle", "blocked:human")]), "waiting");
});

test("isThreadState / THREAD_STATES", () => {
  for (const s of THREAD_STATES) assert.ok(isThreadState(s));
  assert.ok(!isThreadState("archived"));
  assert.ok(!isThreadState(null));
});
