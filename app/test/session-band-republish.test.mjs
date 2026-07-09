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
import { shouldRepublishBand } from "../session-band-republish.js";

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
