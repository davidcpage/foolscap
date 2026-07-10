// Bug A (summon card/edge loss) + Bug C (headless-created node invisible to GET /api/canvas) — the pure
// persist-gap buffer algebra (bus-replay-buffer.js). The HTTP wiring (buffer on delivered===0 in
// dispatchBusCommand, drain on ws-attach) rides a live server and is the http-contract net's job; here we
// pin the decision hermetically: what gets held, prune-on-remove, the cap, and drain-and-clear.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferBusReplay, takeBusReplay, MAX_PENDING_BUS_REPLAY } from "../bus-replay-buffer.js";

const B = "board-x";
const addNode = (id) => ({ type: "addNode", actor: "system", payload: { id, type: "session", title: id } });
const addEdge = (id) => ({ type: "addEdge", actor: "system", payload: { id, from: "a", to: "b", type: "member:open" } });

test("buffers additive creation commands (addNode/addEdge) per board", () => {
  const pending = new Map();
  assert.deepEqual(bufferBusReplay(pending, B, addNode("node:live:s1")), { buffered: true, dropped: 0 });
  assert.deepEqual(bufferBusReplay(pending, B, addEdge("edge:member:s1:t1")), { buffered: true, dropped: 0 });
  assert.equal(pending.get(B).length, 2);
  assert.deepEqual(
    pending.get(B).map((c) => c.payload.id),
    ["node:live:s1", "edge:member:s1:t1"],
  );
});

test("ignores non-additive commands (a move/setText with no tab is stale by replay time)", () => {
  const pending = new Map();
  for (const type of ["moveNodes", "raiseNodes", "setText", "unknown"]) {
    assert.deepEqual(bufferBusReplay(pending, B, { type, payload: { id: "node:x" } }), { buffered: false, dropped: 0 });
  }
  assert.equal(pending.has(B), false);
});

test("a removeNode/removeEdge prunes the buffered create for the SAME id (create+delete nets to nothing)", () => {
  const pending = new Map();
  bufferBusReplay(pending, B, addNode("node:live:s1"));
  bufferBusReplay(pending, B, addEdge("edge:member:s1:t1"));
  bufferBusReplay(pending, B, addNode("node:live:s2"));
  // Remove s1's node → only its addNode is pruned; the edge and s2's node stay.
  bufferBusReplay(pending, B, { type: "removeNode", payload: { id: "node:live:s1" } });
  assert.deepEqual(
    pending.get(B).map((c) => c.payload.id),
    ["edge:member:s1:t1", "node:live:s2"],
  );
  // Removing the last entry for a board drops the board key entirely.
  bufferBusReplay(pending, B, { type: "removeEdge", payload: { id: "edge:member:s1:t1" } });
  bufferBusReplay(pending, B, { type: "removeNode", payload: { id: "node:live:s2" } });
  assert.equal(pending.has(B), false);
});

test("a remove for an id NOT buffered is a harmless no-op", () => {
  const pending = new Map();
  bufferBusReplay(pending, B, addNode("node:live:s1"));
  bufferBusReplay(pending, B, { type: "removeNode", payload: { id: "node:live:absent" } });
  assert.deepEqual(
    pending.get(B).map((c) => c.payload.id),
    ["node:live:s1"],
  );
});

test("boards are independent", () => {
  const pending = new Map();
  bufferBusReplay(pending, "board-a", addNode("node:live:a"));
  bufferBusReplay(pending, "board-b", addNode("node:live:b"));
  assert.equal(pending.get("board-a").length, 1);
  assert.equal(pending.get("board-b").length, 1);
});

test("the cap drops the OLDEST (recent creations are the ones a fresh tab still needs)", () => {
  const pending = new Map();
  for (let i = 0; i < MAX_PENDING_BUS_REPLAY; i++) bufferBusReplay(pending, B, addNode(`node:live:${i}`));
  assert.equal(pending.get(B).length, MAX_PENDING_BUS_REPLAY);
  // One past the cap evicts exactly one — the oldest (index 0).
  const { dropped } = bufferBusReplay(pending, B, addNode("node:live:newest"));
  assert.equal(dropped, 1);
  assert.equal(pending.get(B).length, MAX_PENDING_BUS_REPLAY);
  assert.equal(pending.get(B)[0].payload.id, "node:live:1"); // node:live:0 evicted
  assert.equal(pending.get(B).at(-1).payload.id, "node:live:newest");
});

test("takeBusReplay drains AND clears (first ws-attach wins; a second tab sees nothing to re-apply)", () => {
  const pending = new Map();
  bufferBusReplay(pending, B, addNode("node:live:s1"));
  bufferBusReplay(pending, B, addEdge("edge:member:s1:t1"));
  const drained = takeBusReplay(pending, B);
  assert.equal(drained.length, 2);
  assert.equal(pending.has(B), false); // cleared
  assert.deepEqual(takeBusReplay(pending, B), []); // a second attach drains nothing
});

test("takeBusReplay tolerates a null/absent buffer → []", () => {
  assert.deepEqual(takeBusReplay(null, B), []);
  assert.deepEqual(takeBusReplay(undefined, B), []);
  assert.deepEqual(takeBusReplay(new Map(), "never-seen"), []);
});
