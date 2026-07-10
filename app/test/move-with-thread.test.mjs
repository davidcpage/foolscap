// P2 move-with-thread — the PURE decision logic (planThreadMoves). Verifies the delta / primacy / double-move
// rules headlessly: no store, no DOM, no server. The .ts source is resolved via the same .js→.ts hook the
// other hermetic tests register.
import { test } from "node:test";
import assert from "node:assert/strict";

// planThreadMoves lives in its own import-free module (no ./lib / store / DOM), so it loads under node --test
// with no resolve hook — the whole reason the pure logic was split out from the reactor plumbing.
const mwt = await import("../src/move-with-thread-plan.ts");

const P = (x, y) => ({ x, y });
// A single-thread session S1 anchored to thread T1, both open. Positions chosen so deltas are obvious.
function base() {
  return {
    posById: new Map([
      ["node:thread:T1", P(1000, 500)],
      ["node:live:S1", P(1120, 556)], // +120,+56 relative to T1
    ]),
    prevPos: new Map([
      ["node:thread:T1", P(1000, 500)],
      ["node:live:S1", P(1120, 556)],
    ]),
    isThread: (id) => id.startsWith("node:thread:"),
    memberThreads: new Map([["node:live:S1", ["node:thread:T1"]]]),
    primaryOf: () => undefined, // unknown primacy → sole-membership fallback
  };
}

test("planThreadMoves: nothing moved → no moves (baseline unchanged)", () => {
  const { moves } = mwt.planThreadMoves(base());
  assert.deepEqual(moves, []);
});

test("planThreadMoves: a thread that shifted drags its sole-membership session by the SAME delta", () => {
  const inp = base();
  inp.posById.set("node:thread:T1", P(1040, 470)); // thread moved +40,-30 (session not yet moved)
  const { moves } = mwt.planThreadMoves(inp);
  assert.deepEqual(moves, [{ id: "node:live:S1", x: 1160, y: 526 }], "session +40,-30 → keeps its offset");
});

test("planThreadMoves: a first-sighting thread (no baseline) seeds only, never moves a session", () => {
  const inp = base();
  inp.prevPos = new Map([["node:live:S1", P(1120, 556)]]); // T1 not in the baseline yet
  inp.posById.set("node:thread:T1", P(9999, 9999));
  const { moves, nextPrev } = mwt.planThreadMoves(inp);
  assert.deepEqual(moves, [], "no delta computable for a never-seen thread");
  assert.deepEqual(nextPrev.get("node:thread:T1"), P(9999, 9999), "but it IS seeded for next time");
});

test("planThreadMoves: double-move guard — a session already shifted by the delta this tick is skipped", () => {
  const inp = base();
  // Both thread AND session moved +40,-30 (a multi-select drag carried them together already).
  inp.posById.set("node:thread:T1", P(1040, 470));
  inp.posById.set("node:live:S1", P(1160, 526));
  const { moves } = mwt.planThreadMoves(inp);
  assert.deepEqual(moves, [], "session already at the right relative spot → not moved again (no doubling)");
});

test("planThreadMoves: a resize (w/h only, x/y unchanged) fires no move", () => {
  const inp = base();
  // posById carries only x/y here; an unchanged x/y is a zero delta regardless of size.
  const { moves } = mwt.planThreadMoves(inp);
  assert.deepEqual(moves, []);
});

test("planThreadMoves: multi-thread session moves ONLY with its PRIMARY (known primacy)", () => {
  const posById = new Map([
    ["node:thread:PRIMARY", P(0, 0)],
    ["node:thread:SECONDARY", P(500, 0)],
    ["node:live:S1", P(50, 50)],
  ]);
  const prevPos = new Map(posById);
  const memberThreads = new Map([["node:live:S1", ["node:thread:PRIMARY", "node:thread:SECONDARY"]]]);
  const isThread = (id) => id.startsWith("node:thread:");
  const primaryOf = () => "node:thread:PRIMARY";

  // Drag the SECONDARY thread → the session must NOT move.
  let inp = { posById: new Map(posById), prevPos, isThread, memberThreads, primaryOf };
  inp.posById.set("node:thread:SECONDARY", P(600, 100));
  assert.deepEqual(mwt.planThreadMoves(inp).moves, [], "secondary drag never moves the session");

  // Drag the PRIMARY thread → the session follows by that delta.
  inp = { posById: new Map(posById), prevPos, isThread, memberThreads, primaryOf };
  inp.posById.set("node:thread:PRIMARY", P(30, -20));
  assert.deepEqual(mwt.planThreadMoves(inp).moves, [{ id: "node:live:S1", x: 80, y: 30 }]);
});

test("planThreadMoves: unknown primacy on a MULTI-thread session → not moved (never guess)", () => {
  const posById = new Map([
    ["node:thread:A", P(0, 0)],
    ["node:thread:B", P(500, 0)],
    ["node:live:S1", P(50, 50)],
  ]);
  const inp = {
    posById: new Map(posById),
    prevPos: new Map(posById),
    isThread: (id) => id.startsWith("node:thread:"),
    memberThreads: new Map([["node:live:S1", ["node:thread:A", "node:thread:B"]]]),
    primaryOf: () => undefined, // anchors map not loaded
  };
  inp.posById.set("node:thread:A", P(40, 0));
  assert.deepEqual(mwt.planThreadMoves(inp).moves, [], "ambiguous multi-membership with no primacy → skip");
});

test("planThreadMoves: a closed session card (no layout) is never moved", () => {
  const inp = base();
  inp.posById.delete("node:live:S1"); // card closed — only the thread is on the board
  inp.posById.set("node:thread:T1", P(1040, 470));
  assert.deepEqual(mwt.planThreadMoves(inp).moves, [], "no card on the board → nothing to move");
});
