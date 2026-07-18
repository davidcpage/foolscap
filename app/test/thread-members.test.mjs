// threadMembers (src/threads.ts) — the OPEN member session cards that travel with a thread as its
// cluster. This is the shared seam behind the RIGHT-click group-select (App.onContextMenu sets the
// selection to `[thread, ...threadMembers(thread)]`) and the resize-target expansion wired into the
// interaction manager (m.expandSelection → resizeTargetId). Both must agree on "the cluster", so the
// membership scan lives in one place and is unit-tested here.
//
// threads.ts pulls in only a TYPE from ./lib (stripped at load) plus ./board (a side-effect-free module),
// so it imports directly under the app's tsx-less `node --test` runner — no resolve hook needed. We don't
// import core's Editor: its parameter-property syntax can't load in strip-only mode (see board-engine.ts).
// threadMembers reads only editor.store.get(id) + editor.store.getSnapshot().records, so a record-shaped
// stub store (node/edge records exactly as core emits them) exercises the scan faithfully.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Under Vite/tsc the src browser modules import each other Vite-style (extensionless, and core/interaction
// deps with a `.js` suffix); the app's tsx-less `node --test` runner resolves raw, so map both spellings to
// the real `.ts` file (the board-engine / middleware-hermetic hook, plus an extensionless branch for src/).
// Must be registered before the dynamic import so threads.ts's `./board` resolves.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const rel = specifier.startsWith("./") || specifier.startsWith("../");
    if (rel && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    if (rel && !specifier.split("/").pop().includes(".")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { threadMembers, MEMBER_OPEN } = await import("../src/threads.ts");

// A minimal editor: just the store surface threadMembers touches. Records carry the same fields core's
// Store emits — nodes with a `type`, edges with `typeName:"edge"` + `type`/`from`/`to`.
function editorWith(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  return { store: { get: (id) => byId.get(id), getSnapshot: () => ({ records }) } };
}

const node = (id, type) => ({ typeName: "node", id, type });
const memberEdge = (id, from, to) => ({ typeName: "edge", id, type: MEMBER_OPEN, from, to });

// A thread T with two OPEN member session cards A, B; a session U that never joined; an unrelated note X.
// member:open edges run session→thread (the member is the edge SOURCE, the thread its target).
function boardWithCluster() {
  return editorWith([
    node("node:thread:T", "thread"),
    node("node:session:A", "session"),
    node("node:session:B", "session"),
    node("node:session:U", "session"),
    node("node:note:X", "note"),
    memberEdge("edge:A", "node:session:A", "node:thread:T"),
    memberEdge("edge:B", "node:session:B", "node:thread:T"),
  ]);
}

test("threadMembers returns exactly a thread's open member session cards", () => {
  assert.deepEqual(
    threadMembers(boardWithCluster(), "node:thread:T").sort(),
    ["node:session:A", "node:session:B"],
    "the two member:open sources, and neither the non-joined session U nor the note X",
  );
});

test("threadMembers is one-way: a session never pulls in its thread", () => {
  assert.deepEqual(threadMembers(boardWithCluster(), "node:session:A"), [], "a member returns nothing");
});

test("threadMembers ignores a member:open edge in the OTHER direction", () => {
  // A stray edge whose TARGET is a session, not the thread — must not count as a member of anything.
  const editor = editorWith([
    node("node:thread:T", "thread"),
    node("node:session:A", "session"),
    node("node:session:U", "session"),
    memberEdge("edge:A", "node:session:A", "node:thread:T"),
    memberEdge("edge:rev", "node:thread:T", "node:session:U"),
  ]);
  assert.deepEqual(
    threadMembers(editor, "node:thread:T"),
    ["node:session:A"],
    "only edges POINTING AT the thread count; the reversed edge is ignored",
  );
});

test("threadMembers of a non-thread node is empty (no throw)", () => {
  const editor = boardWithCluster();
  assert.deepEqual(threadMembers(editor, "node:note:X"), []);
  assert.deepEqual(threadMembers(editor, "node:missing"), []);
});

test("threadMembers accepts the legacy 'channel' node type as a thread", () => {
  const editor = editorWith([
    node("node:channel:L", "channel"), // carried-over boards store threads as {type:"channel"}
    node("node:session:A", "session"),
    memberEdge("edge:A", "node:session:A", "node:channel:L"),
  ]);
  assert.deepEqual(threadMembers(editor, "node:channel:L"), ["node:session:A"]);
});
