// The §8 step-3 derived thread-state projection (thread-state.js) — the session-thread-lifecycle §4/§6
// state machine as table tests. The asymmetry the machine exists for (§5): "no recent activity" must
// split into waiting (surface it — the human's turn) vs dormant (archive it — nobody needs anything),
// and only declared intent can tell them apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deriveThreadState,
  isThreadState,
  intentPillState,
  memberPillState,
  PILL_STATES,
  THREAD_STATES,
} from "../thread-state.js";

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

test("an exited seat's blocked:human no longer lights waiting → dormant (orange requires a LIVE asker; a dead asker's stale block can't stay loud forever with no one to clear it)", () => {
  assert.equal(deriveThreadState([p("exited", "blocked:human")]), "dormant");
  assert.equal(deriveThreadState([p("exited", "blocked:human"), p("exited", "done")]), "dormant");
  // but a LIVE (idle) blocked:human alongside an exited one still counts — the live asker holds the turn.
  assert.equal(deriveThreadState([p("exited", "blocked:human"), p("idle", "blocked:human")]), "waiting");
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

// memberPillState — the unified per-pill fusion that superseded memberDisplayIntent. The pill wears the SAME
// slot as the session card's band; the full server band (not a working-only bit) drives it, with this
// thread's declared intent folded on top for the two states the server can't observe per-thread.

// Every server band, with nothing declared, maps to the card's slot for that band — the "card and pill never
// disagree" contract. (These are the Done-when divergence cases.)
test("memberPillState: each process-observed band drives the pill exactly as it drives the card", () => {
  assert.equal(memberPillState("working", null), "working");
  assert.equal(memberPillState("waiting", null), "blocked-human"); // idle "your turn" / permission-held → orange
  assert.equal(memberPillState("waiting-agent", null), "blocked-peer"); // server-inferred blue, free
  assert.equal(memberPillState("scheduled", null), "scheduled"); // teal
  assert.equal(memberPillState("crashed", null), "crashed"); // red
  assert.equal(memberPillState("done", null), "done"); // grey
  assert.equal(memberPillState("ended", null), "done"); // grey (shares the done slot)
});

test("memberPillState: a RUNNING turn stays green regardless of a stale declaration (the contradiction it kills)", () => {
  assert.equal(memberPillState("working", "blocked:human"), "working");
  assert.equal(memberPillState("working", "blocked:peer"), "working");
  assert.equal(memberPillState("working", "done"), "working");
});

test("memberPillState: done-on-a-still-live idle session → grey (the one thing only the declaration carries)", () => {
  assert.equal(memberPillState("waiting", "done"), "done"); // idle-live, wound up its part here
  assert.equal(memberPillState("waiting-agent", "done"), "done");
  assert.equal(memberPillState("scheduled", "done"), "done");
  // ...but never over a real exit band — a crash is not "done".
  assert.equal(memberPillState("crashed", "done"), "crashed");
});

test("memberPillState: an untagged blocked:peer promotes the idle orange band to blue (the server can't see it)", () => {
  assert.equal(memberPillState("waiting", "blocked:peer"), "blocked-peer");
  // server already blue (an @-tagged peer) — declaration just agrees.
  assert.equal(memberPillState("waiting-agent", "blocked:peer"), "blocked-peer");
});

test("memberPillState: no live row → fall back to the durable declared intent (a seat outlives its occupant)", () => {
  assert.equal(memberPillState(null, "blocked:human"), "blocked-human"); // exited seat still holds the question
  assert.equal(memberPillState(null, "done"), "done");
  assert.equal(memberPillState(undefined, "blocked:peer"), "blocked-peer");
});

test("memberPillState: no row and nothing declared → null (never fabricate a status on a pill)", () => {
  assert.equal(memberPillState(null, null), null);
  assert.equal(memberPillState(undefined, undefined), null);
  assert.equal(memberPillState(null, "working"), "working"); // a declared working still shows
});

test("intentPillState: the four declarable intents map, anything else → null", () => {
  assert.equal(intentPillState("working"), "working");
  assert.equal(intentPillState("blocked:human"), "blocked-human");
  assert.equal(intentPillState("blocked:peer"), "blocked-peer");
  assert.equal(intentPillState("done"), "done");
  assert.equal(intentPillState(null), null);
  assert.equal(intentPillState("nonsense"), null);
});

// Drift lock: the whole point of the shared map is that the card band and the pill can never drift out of
// step. Two guards — (1) every server band a session can carry maps to a pill slot (no band silently falls
// through to a neutral pill); (2) every pill slot has a `.chan-member.i-<slot>` rule in style.css (the two
// added here — scheduled/crashed — plus the four that predate this).
test("drift lock: every SessionStatus band maps to a pill slot", () => {
  // The SessionStatus union (session-status.ts) — kept here as the contract since node --test can't import
  // the .ts. If a band is added there, add it to BAND_TO_PILL and to this list together.
  const BANDS = ["working", "waiting", "waiting-agent", "scheduled", "done", "crashed", "ended"];
  for (const b of BANDS) {
    assert.ok(PILL_STATES.includes(memberPillState(b, null)), `band ${b} has no pill slot`);
  }
});

test("drift lock: every pill slot has a .chan-member.i-<slot> rule in style.css", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
  for (const slot of PILL_STATES) {
    assert.match(css, new RegExp(`\\.chan-member\\.i-${slot}\\b`), `no pill CSS for i-${slot}`);
  }
});
