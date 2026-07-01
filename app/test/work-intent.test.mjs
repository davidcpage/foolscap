// The work-intent typed act (threads-as-cards §6, migration §8 step 1): the closed intent set the server
// 400-gates on, the legible line an act stores, and the card's glyph — one shared module so they can't drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WORK_INTENTS, isWorkIntent, intentLine, intentGlyph } from "../work-intent.js";

test("the intent set is closed and typed — the four stances, nothing else", () => {
  assert.deepEqual(WORK_INTENTS, ["working", "blocked:human", "blocked:peer", "done"]);
  for (const i of WORK_INTENTS) assert.ok(isWorkIntent(i), `${i} is declarable`);
  // A typed act, never free text: prose, casing drift, and non-strings are all rejected at the gate.
  for (const bad of ["blocked", "Working", "blocked: human", "", null, undefined, 3, ["done"]])
    assert.equal(isWorkIntent(bad), false, `${JSON.stringify(bad)} is not an intent`);
});

test("intentLine is the legible face: intent alone, or intent — note", () => {
  assert.equal(intentLine("done"), "done");
  assert.equal(intentLine("blocked:human", "need a nod on the schema"), "blocked:human — need a nod on the schema");
});

test("every intent has a glyph; an unknown value still renders (never throws)", () => {
  for (const i of WORK_INTENTS) assert.notEqual(intentGlyph(i), "•", `${i} has its own glyph`);
  assert.equal(intentGlyph("no-such-intent"), "•");
  assert.equal(intentGlyph(undefined), "•");
});
