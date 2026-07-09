import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCell } from "../vendor/notebook-infer.js";
import { deserialize } from "../vendor/notebook-format.js";

// The MAIN-REALM CONSENT GATE (Fix A, thread node:mrdj7o3s-9) end-to-end over the REAL decision code. The
// runtime's startRun parks a cell UNRUN when `spec.domCandidate && !nb.mainRealmAllowed` — the two inputs to
// that predicate are produced by the two pure, node-importable modules exercised here:
//   • analyzeCell (notebook-infer.js) decides domCandidate — does the cell route to the MAIN THREAD?
//   • deserialize (notebook-format.js) decides mainRealmAllowed — did the notebook opt in?
// The full scheduler is browser-coupled (Worker + DOM signals) and not node-importable, so this drives the
// exact ROUTING + CONSENT decision and composes the gate predicate verbatim (kept in sync with startRun). The
// async-hang half of the fix is driven separately in notebook-main-budget.test.mjs.

// The runtime's gate predicate, verbatim from startRun — the one line the scheduler branches on.
const wouldRunOnMainThread = (spec, nb) => spec.domCandidate && nb.mainRealmAllowed;
const isGatedUnrun = (spec, nb) => !!spec.domCandidate && !nb.mainRealmAllowed;

test("a runaway lib-importing cell is classified domCandidate → it WOULD route to the main thread", () => {
  // The exact shape the review flagged: a cell that imports an external lib and then loops forever. It's the
  // import (a non-relative specifier) that routes it main-thread, independent of the loop.
  const a = analyzeCell('import * as Plot from "@observablehq/plot";\nwhile (true) {}');
  assert.equal(a.domCandidate, true, "importing an external lib routes the cell to the main-thread realm");
});

test("a document-touching runaway cell is also domCandidate", () => {
  const a = analyzeCell("document.body.appendChild(x);\nwhile (true) {}");
  assert.equal(a.domCandidate, true, "a free read of `document` routes the cell to the main-thread realm");
});

test("GATE: a domCandidate runaway in an UNGRANTED notebook is parked unrun (no auto-run on open, no escalation)", () => {
  const spec = analyzeCell('import * as Plot from "@observablehq/plot";\nwhile (true) {}');
  const nb = { mainRealmAllowed: deserialize("<notebook><title>T</title></notebook>").mainRealm === "allow" };
  assert.equal(nb.mainRealmAllowed, false, "an ungranted notebook confers no consent");
  assert.equal(wouldRunOnMainThread(spec, nb), false, "the runaway does NOT run on open — the hang can't happen");
  assert.equal(isGatedUnrun(spec, nb), true, "it is parked with needsConsent instead");
});

test("GATE: the SAME cell runs once the notebook opts in via data-main-realm=allow", () => {
  const spec = analyzeCell('import * as Plot from "@observablehq/plot";\nPlot.plot({})');
  const nb = {
    mainRealmAllowed: deserialize('<notebook data-main-realm="allow"><title>T</title></notebook>').mainRealm === "allow",
  };
  assert.equal(nb.mainRealmAllowed, true, "the granted notebook confers consent");
  assert.equal(wouldRunOnMainThread(spec, nb), true, "a consented domCandidate cell runs (legit charts work)");
  assert.equal(isGatedUnrun(spec, nb), false, "and is no longer gated");
});

test("a pure worker cell is unaffected by consent — it never touches the gate", () => {
  const spec = analyzeCell("x = 21 * 2"); // no lib import, no DOM read → worker realm
  assert.equal(spec.domCandidate, false, "a pure-compute cell stays in the off-thread worker");
  for (const allowed of [true, false]) {
    assert.equal(isGatedUnrun(spec, { mainRealmAllowed: allowed }), false, "a worker cell is never gated");
  }
});
