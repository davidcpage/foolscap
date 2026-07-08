// T3c — the pure "which edges touch this node" decision the /api/command removeNode cascade delegates to
// (node-cascade.js). The HTTP behaviour (each removeEdge dispatched, then the removeNode; the emitted-
// membership bridge cleared) is exercised end-to-end in http-contract.test.mjs against a live server; here
// we pin the edge-selection logic hermetically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectedEdgeIds } from "../node-cascade.js";

const records = [
  { typeName: "node", id: "node:live:sess-a", type: "session", title: "sess-a" },
  { typeName: "node", id: "node:thread:t1", type: "thread", title: "T1" },
  { typeName: "node", id: "node:thread:t2", type: "thread", title: "T2" },
  { typeName: "edge", id: "edge:member:a:t1", from: "node:live:sess-a", to: "node:thread:t1", type: "member:open" },
  { typeName: "edge", id: "edge:member:a:t2", from: "node:live:sess-a", to: "node:thread:t2", type: "member:open" },
  { typeName: "edge", id: "edge:link:t1:t2", from: "node:thread:t1", to: "node:thread:t2", type: "links" },
];

test("collects every edge with the node as `from` OR `to`", () => {
  // The session card owns both its outgoing member edges.
  assert.deepEqual(connectedEdgeIds(records, "node:live:sess-a").sort(), ["edge:member:a:t1", "edge:member:a:t2"]);
  // A thread node is hit by an incoming member edge AND a link where it is `from`.
  assert.deepEqual(connectedEdgeIds(records, "node:thread:t1").sort(), ["edge:link:t1:t2", "edge:member:a:t1"]);
  // As `to` on the link, plus its own member edge.
  assert.deepEqual(connectedEdgeIds(records, "node:thread:t2").sort(), ["edge:link:t1:t2", "edge:member:a:t2"]);
});

test("a node with no edges cascades nothing", () => {
  const lone = [{ typeName: "node", id: "node:live:sess-z", type: "session", title: "sess-z" }];
  assert.deepEqual(connectedEdgeIds(lone, "node:live:sess-z"), []);
});

test("tolerates a null/empty record set and malformed rows (no throw)", () => {
  assert.deepEqual(connectedEdgeIds(null, "node:x"), []);
  assert.deepEqual(connectedEdgeIds([], "node:x"), []);
  const junk = [
    null,
    { typeName: "edge" }, // no id / endpoints
    { typeName: "edge", id: 42, from: "node:x", to: "node:y" }, // non-string id
    { typeName: "node", id: "node:x" }, // a node, never an edge match
    { typeName: "edge", id: "edge:good", from: "node:x", to: "node:y" },
  ];
  assert.deepEqual(connectedEdgeIds(junk, "node:x"), ["edge:good"]);
});
