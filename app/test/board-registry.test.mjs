// Hermetic tests for the board-registry SELECTOR changes (thread node:thread:8c60a713): the stable-order
// upsert in recordBoardOpened, forgetBoard (registry removal / unmount), and the DELETE /api/boards route.
// No live dev server — this imports the extracted server modules directly, the same no-server complement to
// http-contract.test.mjs that middleware-hermetic.test.mjs uses (and the same .js→.ts resolve hook, since
// `node --test` doesn't rewrite the TypeScript `.js` import specifiers Vite/tsc do).
//
// The registry file these functions read/write is the DEV repo's `.canvas/boards.json` — here, this
// worktree's (it has none). Every board this test adds it also forgets in cleanup, so the file returns to
// its starting state and no real registry is clobbered. Synthetic repoPaths sit OUTSIDE the OS tmpdir so
// recordBoardOpened actually persists them (a tmpdir path is treated as throwaway scratch and skipped).

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context); // a real hand-authored .js module — resolve as-is
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context); // only a .ts sibling exists (a split module)
      }
    }
    return nextResolve(specifier, context);
  },
});

const boards = await import("../server-boards.ts");
const boardRoutes = (await import("../routes/boards.ts")).boardRoutes;

const A = { id: "aa-11111111", name: "A", repo: "/nonexistent-boards-test/a" };
const B = { id: "bb-22222222", name: "B", repo: "/nonexistent-boards-test/b" };
const C = { id: "cc-33333333", name: "C", repo: "/nonexistent-boards-test/c" };
const MINE = new Set([A.id, B.id, C.id]);
const mineOrder = () => boards.readBoardRegistry().map((e) => e.boardId).filter((id) => MINE.has(id));

function cleanup() {
  for (const id of MINE) boards.forgetBoard(id);
}

// A minimal ServerResponse double matching server-http.sendJson's contract (statusCode + setHeader + end).
function fakeRes() {
  return {
    statusCode: 200,
    headersSent: false,
    _headers: {},
    _body: undefined,
    setHeader(k, v) {
      this._headers[k] = v;
    },
    end(body) {
      this.headersSent = true;
      this._body = body;
    },
  };
}
const delRoute = boardRoutes.find((r) => r.method === "DELETE");
const runDelete = (query) => {
  const res = fakeRes();
  delRoute.run({ method: "DELETE" }, res, new URL(`http://localhost/api/boards${query}`), []);
  return { status: res.statusCode, body: res._body ? JSON.parse(res._body) : undefined };
};

test("recordBoardOpened upserts IN PLACE — re-opening a board keeps its slot (stable order)", () => {
  cleanup();
  try {
    boards.recordBoardOpened(A.id, A.name, A.repo);
    boards.recordBoardOpened(B.id, B.name, B.repo);
    boards.recordBoardOpened(C.id, C.name, C.repo);
    assert.deepEqual(mineOrder(), [A.id, B.id, C.id], "insertion order is registry order");

    const beforeStamp = boards.readBoardRegistry().find((e) => e.boardId === A.id).lastOpened;
    boards.recordBoardOpened(A.id, A.name, A.repo); // re-open the FIRST board
    // Order is unchanged — the old behavior moved a re-opened board to the END, reshuffling the picker.
    assert.deepEqual(mineOrder(), [A.id, B.id, C.id], "a re-open does NOT move the board to the end");
    const afterStamp = boards.readBoardRegistry().find((e) => e.boardId === A.id).lastOpened;
    assert.ok(afterStamp >= beforeStamp, "lastOpened still refreshes on re-open");
  } finally {
    cleanup();
  }
});

test("forgetBoard removes an entry (registry + preserves the survivors' order) and refuses the default", () => {
  cleanup();
  try {
    boards.recordBoardOpened(A.id, A.name, A.repo);
    boards.recordBoardOpened(B.id, B.name, B.repo);
    boards.recordBoardOpened(C.id, C.name, C.repo);

    assert.equal(boards.forgetBoard(B.id), true, "forgetting a registered board reports removed");
    assert.deepEqual(mineOrder(), [A.id, C.id], "the survivors keep their relative order");
    assert.ok(!boards.readBoardRegistry().some((e) => e.boardId === B.id), "the entry is gone from the registry");

    assert.equal(boards.forgetBoard(B.id), false, "forgetting an already-gone board reports nothing removed");
    assert.equal(boards.forgetBoard(boards.DEFAULT_BOARD.boardId), false, "the default board can never be forgotten");
  } finally {
    cleanup();
  }
});

test("DELETE /api/boards — 400 (no id), 404 (unknown / default), 200 (removed)", () => {
  cleanup();
  try {
    assert.ok(delRoute, "a DELETE arm is registered on /api/boards");

    assert.equal(runDelete("").status, 400, "no board id → 400");
    assert.equal(runDelete("?board=does-not-exist").status, 404, "unknown board → 404");
    assert.equal(
      runDelete(`?board=${encodeURIComponent(boards.DEFAULT_BOARD.boardId)}`).status,
      404,
      "the default board is not removable → 404",
    );

    boards.recordBoardOpened(A.id, A.name, A.repo);
    const ok = runDelete(`?board=${encodeURIComponent(A.id)}`);
    assert.equal(ok.status, 200, "removing a registered board → 200");
    assert.deepEqual(ok.body, { boardId: A.id, removed: true });
    assert.ok(!boards.readBoardRegistry().some((e) => e.boardId === A.id), "the DELETE dropped it from the registry");
  } finally {
    cleanup();
  }
});
