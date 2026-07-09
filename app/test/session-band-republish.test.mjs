// Band-staleness reconciliation (thread mrcmofwf-10). The session CARD renders its status band from a value
// PUSHED onto its feed by publishSession (fires on the session's own process events only); the thread PILL
// renders the SAME band read LIVE off /api/sessions. When an input the band depends on changes OUT OF BAND
// (a standing job on the seat, a declared intent, a waitingOn set), the live band moves but the pushed one
// freezes and the two surfaces diverge. The loopTick safety net recomputes each live session's band and
// republishes on drift; `shouldRepublishBand` is that PURE decision, unit-tested here.
//
// The vite-fs-plugin handlers that wire this (publishSession / loopTick / the instant paths) are not yet
// hermetically importable (the handlers-on-a-context-object split is a documented follow-up — see
// http-contract.test.mjs), so the wiring is covered by the live contract net + hand verification; this file
// pins the change-detection logic, and standing-jobs.test.mjs pins the out-of-band trigger it reconciles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { idleBand, shouldRepublishBand } from "../session-band-republish.js";

test("never-published (undefined lastBand) never republishes — no stale band to correct", () => {
  // The card falls back to its own file-tail derivation until the first real publish; the safety net must
  // not manufacture a spurious first push (which would blank a file-tail feed with empty content).
  assert.equal(shouldRepublishBand(undefined, null), false);
  assert.equal(shouldRepublishBand(undefined, "working"), false);
  assert.equal(shouldRepublishBand(undefined, "scheduled"), false);
});

test("the canonical bug: pushed 'waiting-agent' but live is 'scheduled' ⇒ republish", () => {
  // Exactly the divergence in the brief: a standing job lands on an idle looping session's seat, so the live
  // band flips to teal 'scheduled' while the card's pushed band is frozen blue 'waiting-agent'.
  assert.equal(shouldRepublishBand("waiting-agent", "scheduled"), true);
});

test("no drift ⇒ no republish (not per-tick spam)", () => {
  assert.equal(shouldRepublishBand("scheduled", "scheduled"), false);
  assert.equal(shouldRepublishBand("working", "working"), false);
  assert.equal(shouldRepublishBand("waiting", "waiting"), false);
  assert.equal(shouldRepublishBand(null, null), false);
});

test("null is a real published value distinct from undefined — null→working republishes", () => {
  // A bandless never-run session publishes band:null; once it produces output and takes a turn its live band
  // becomes real, and that transition must reconcile.
  assert.equal(shouldRepublishBand(null, "working"), true);
  assert.equal(shouldRepublishBand("working", null), true);
});

test("every ordered pair of distinct bands (incl. null) republishes; identical pairs don't", () => {
  const bands = [null, "working", "waiting", "waiting-agent", "scheduled", "done", "crashed", "ended"];
  for (const a of bands) {
    for (const b of bands) {
      // `a` stands in for a PUBLISHED lastBand (never undefined here), so the rule is pure inequality.
      assert.equal(shouldRepublishBand(a, b), a !== b, `${String(a)} → ${String(b)}`);
    }
  }
});

// idle-band precedence (thread mrcmofwf-10 Done-when v3): the reorder this thread exists for. The v2 code
// checked `scheduled` FIRST, so a session with a live standing wake (a Coordinator ALWAYS has a heartbeat
// job) could never show a declared blocked:human/blocked:peer — the loud states were masked by teal. v3
// makes a DECLARED intent outrank the wake timer, while a mere server-INFERRED @-tag peer-wait still ranks
// BELOW the scheduled fact. Process facts (crashed/exited/running) are resolved before idleBand runs.

test("v3 fix: declared blocked:human outranks a scheduled wake → orange 'waiting', NOT 'scheduled'", () => {
  // The masking bug's headline case: a heartbeat Coordinator that declared blocked:human. scheduled=true,
  // but the explicit "I'm blocked on a human" must win — this is the whole point of the reorder.
  assert.equal(idleBand("blocked:human", true, false), "waiting");
  assert.equal(idleBand("blocked:human", true, true), "waiting", "…even with a waitingOn also set");
});

test("v3 fix: declared blocked:peer outranks a scheduled wake → blue 'waiting-agent', NOT 'scheduled'", () => {
  assert.equal(idleBand("blocked:peer", true, false), "waiting-agent");
  assert.equal(idleBand("blocked:peer", true, true), "waiting-agent");
});

test("no declared intent + scheduled wake → teal 'scheduled' (unchanged)", () => {
  assert.equal(idleBand(null, true, false), "scheduled");
});

test("scheduled still outranks the @-tag waitingOn inference (a free guess loses to the wake fact)", () => {
  // scheduled AND a waitingOn both set, nothing declared: scheduled wins — the reorder moved declared
  // intents above scheduled, it did NOT lift the @-tag inference above it.
  assert.equal(idleBand(null, true, true), "scheduled");
});

test("@-tag waitingOn inference wins only once nothing higher is set → blue 'waiting-agent'", () => {
  assert.equal(idleBand(null, false, true), "waiting-agent");
});

test("nothing set → the default orange 'waiting' (your turn)", () => {
  assert.equal(idleBand(null, false, false), "waiting");
  assert.equal(idleBand(undefined, false, false), "waiting", "undefined idleIntent behaves like null");
});

test("full idle-band precedence order is pinned (highest wins, top to bottom)", () => {
  // Enumerate the ladder so any future reorder of idleBand breaks this test loudly. Each row: the highest
  // input present, and the band it must produce.
  //   declared blocked:human > declared blocked:peer > scheduled > waitingOn inference > default
  assert.equal(idleBand("blocked:human", true, true), "waiting", "blocked:human is top");
  assert.equal(idleBand("blocked:peer", true, true), "waiting-agent", "blocked:peer beats scheduled+waitingOn");
  assert.equal(idleBand(null, true, true), "scheduled", "scheduled beats the waitingOn inference");
  assert.equal(idleBand(null, false, true), "waiting-agent", "waitingOn inference beats the default");
  assert.equal(idleBand(null, false, false), "waiting", "default is the floor");
});
