// cardReference (src/node-id.ts) — the pure per-card-type rule for a card's stable, copyable reference
// (the "Card id links" affordance). Node strips the type-only imports in node-id.ts on load, so this
// hermetic test reaches the source directly. The HOST wiring (the copy chip in NodeView) rides on this
// value being non-null; the rules below are the contract that decides which cards show a chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardReference } from "../src/node-id.ts";

const node = (type, title, id) => ({ type, title, id: id ?? `node:repo:${title}` });

test("file family → root-qualified path (repo root elided to the plain filepath)", () => {
  for (const type of ["file", "directory", "image", "ipynb", "notebook"]) {
    assert.equal(cardReference(node(type, "app/src/foo.ts"), "repo"), "app/src/foo.ts");
  }
});

test("file family under a non-repo root is qualified with the root", () => {
  const n = { type: "file", title: "app/src/foo.ts", id: "node:wt-x:app/src/foo.ts" };
  assert.equal(cardReference(n, "wt-x"), "wt-x:app/src/foo.ts");
});

test("an untitled file card has no reference", () => {
  assert.equal(cardReference(node("file", ""), "repo"), null);
});

test("thread → its own node id (node:thread:<id>)", () => {
  const n = { type: "thread", title: "Card id links", id: "node:thread:4a43b291" };
  assert.equal(cardReference(n, "repo"), "node:thread:4a43b291");
});

test("usage card → the tracked session id when titled, null when not", () => {
  assert.equal(cardReference(node("usage", "sess-abc", "node:usage:1"), "repo"), "sess-abc");
  assert.equal(cardReference(node("usage", "", "node:usage:1"), "repo"), null);
});

test("weather / git-log → the title (the query / feed key)", () => {
  assert.equal(cardReference(node("weather", "Berlin", "node:weather:1"), "repo"), "Berlin");
  assert.equal(cardReference(node("git-log", "data:git-log", "node:git-log:1"), "repo"), "data:git-log");
});

test("session and the no-reference cards → null (no chip)", () => {
  // session keeps its own in-head copy button; the rest have no stable external reference.
  for (const type of ["session", "note", "sticky", "clock", "sessions", "roles", "channels", "githead", "hn"]) {
    assert.equal(cardReference(node(type, "whatever", `node:${type}:x`), "repo"), null);
  }
});
