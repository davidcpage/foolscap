// Notebook structural-edit engine (P2, server-notebook.ts) — edit cell source + add/delete/move cells with
// fidelity-preserving, CAS-guarded write-back, exercised against a real temp `.ipynb` (no dev server, no
// kernel). The engine is the SHARED write path a kernel output-merge and a card source-edit both take, so
// these tests also cover the run-vs-edit coexistence: disjoint fields (outputs vs source) never clobber, and
// the CAS primitive that makes the retry loop recover is asserted directly.
//
// server-notebook.ts imports its neighbours by the Vite/tsc `.js`-specifier convention; node --test resolves
// raw, so the resolve hook rewrites a relative `.js` import to its `.ts` sibling when only the `.ts` exists
// (mirroring kernel-lifecycle.test.mjs). Registered before the dynamic import so the chain resolves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { editNotebook, parseEdit, splitSourceLines, readNotebook, casWriteNotebook } = await import("../server-notebook.ts");

// A tmp checkout root + a notebook file in it. Returns { dir, rel, abs, write(nb), read() }.
function scratch(nb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nbedit-"));
  const rel = "explore.ipynb";
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, JSON.stringify(nb, null, 1), "utf8");
  return {
    dir,
    rel,
    abs,
    read: () => JSON.parse(fs.readFileSync(abs, "utf8")),
  };
}

// A notebook with a deliberate MIX of shapes to prove fidelity: array-of-lines source, string source, an
// output on a code cell, unknown top-level + cell fields, nbformat_minor, and cell ids present.
function fixture() {
  return {
    cells: [
      { id: "aaa", cell_type: "markdown", metadata: {}, source: ["# Title\n", "intro"] },
      {
        id: "bbb",
        cell_type: "code",
        metadata: { tags: ["keepme"] },
        execution_count: 3,
        source: "print(1)",
        outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }],
        custom_field: 42, // an unknown cell field must round-trip
      },
      { id: "ccc", cell_type: "code", metadata: {}, execution_count: null, source: ["x = 2\n", "x"], outputs: [] },
    ],
    metadata: { language_info: { name: "python" }, kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
    custom_top: "preserve-me", // an unknown top-level field must round-trip
  };
}

// ── splitSourceLines: the array-of-lines shape stamped on an edited cell ─────────────────────────────

test("splitSourceLines matches nbformat's line shape (trailing newline drops the empty tail)", () => {
  assert.deepEqual(splitSourceLines(""), []);
  assert.deepEqual(splitSourceLines("a"), ["a"]);
  assert.deepEqual(splitSourceLines("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitSourceLines("a\nb\n"), ["a\n", "b\n"]);
  assert.deepEqual(splitSourceLines("\n"), ["\n"]);
});

// ── parseEdit: transport validation ─────────────────────────────────────────────────────────────────

test("parseEdit accepts well-formed ops and rejects malformed ones", () => {
  assert.deepEqual(parseEdit({ type: "editSource", cellId: "x", source: "s" }), { type: "editSource", cellId: "x", source: "s" });
  assert.deepEqual(parseEdit({ type: "moveCell", cellId: "x", dir: "up" }), { type: "moveCell", cellId: "x", dir: "up" });
  assert.equal(parseEdit({ type: "editSource", cellId: "x" }), null); // no source
  assert.equal(parseEdit({ type: "addCell", cellType: "raw" }), null); // bad cell type
  assert.equal(parseEdit({ type: "moveCell", cellId: "x", dir: "sideways" }), null);
  assert.equal(parseEdit({ type: "bogus" }), null);
  assert.equal(parseEdit(null), null);
});

// ── editSource: fidelity + Jupyter output-preservation ──────────────────────────────────────────────

test("editSource changes ONLY the target cell (array-of-lines), leaves every other cell byte-faithful, keeps its outputs", () => {
  const s = scratch(fixture());
  const before = s.read();
  const r = editNotebook(s.dir, s.rel, { type: "editSource", cellId: "bbb", source: "print(2)\nprint(3)" });
  assert.equal(r.ok, true);
  assert.equal(r.writeback, "ok");
  const after = s.read();

  // Edited cell: source is the array-of-lines shape; outputs + execution_count UNTOUCHED (Jupyter: editing
  // source does not clear outputs — running does).
  const bbb = after.cells.find((c) => c.id === "bbb");
  assert.deepEqual(bbb.source, ["print(2)\n", "print(3)"]);
  assert.deepEqual(bbb.outputs, before.cells[1].outputs, "outputs preserved on a source edit");
  assert.equal(bbb.execution_count, 3, "execution_count preserved on a source edit");
  assert.equal(bbb.custom_field, 42, "unknown cell field preserved");

  // Every UNTOUCHED cell is byte-identical to before (source shape, metadata, ids all intact).
  assert.deepEqual(after.cells[0], before.cells[0], "markdown cell untouched (array source shape kept)");
  assert.deepEqual(after.cells[2], before.cells[2], "other code cell untouched");

  // Top-level fidelity: nbformat/minor, metadata, unknown field; and NO __foolscap leak.
  assert.equal(after.nbformat, 4);
  assert.equal(after.nbformat_minor, 5);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.custom_top, "preserve-me");
  assert.ok(!("__foolscap" in (after.metadata || {})), "no render-only __foolscap leaks to disk");
});

test("editSource on a markdown cell works and does not add code-only fields", () => {
  const s = scratch(fixture());
  editNotebook(s.dir, s.rel, { type: "editSource", cellId: "aaa", source: "## Edited" });
  const aaa = s.read().cells.find((c) => c.id === "aaa");
  assert.deepEqual(aaa.source, ["## Edited"]);
  assert.ok(!("outputs" in aaa), "markdown cell gains no outputs field");
  assert.ok(!("execution_count" in aaa), "markdown cell gains no execution_count");
});

test("editSource on a vanished cell reports stale-cell (a concurrent delete)", () => {
  const s = scratch(fixture());
  const r = editNotebook(s.dir, s.rel, { type: "editSource", cellId: "nope", source: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.writeback, "stale-cell");
});

// ── addCell ─────────────────────────────────────────────────────────────────────────────────────────

test("addCell mints a fresh nbformat-4.5 id, positions correctly, and seeds code vs markdown shape", () => {
  const s = scratch(fixture());
  // after bbb (index 1) → new cell at index 2
  const r = editNotebook(s.dir, s.rel, { type: "addCell", cellType: "code", afterCellId: "bbb", source: "y = 1" });
  assert.equal(r.ok, true);
  const nb = s.read();
  assert.equal(nb.cells.length, 4);
  const added = nb.cells[2];
  assert.match(added.id, /^[0-9a-f]{12}$/, "fresh hex id");
  assert.notEqual(added.id, "bbb");
  assert.equal(added.cell_type, "code");
  assert.deepEqual(added.source, ["y = 1"]);
  assert.deepEqual(added.outputs, [], "a code cell is born with empty outputs");
  assert.equal(added.execution_count, null);
  assert.equal(r.cellId, added.id, "result carries the minted id (so the card auto-opens it)");

  // markdown add appends at end (no anchor) with no code-only fields
  const s2 = scratch(fixture());
  editNotebook(s2.dir, s2.rel, { type: "addCell", cellType: "markdown" });
  const nb2 = s2.read();
  const last = nb2.cells[nb2.cells.length - 1];
  assert.equal(last.cell_type, "markdown");
  assert.ok(!("outputs" in last) && !("execution_count" in last));

  // index-based insertion
  const s3 = scratch(fixture());
  editNotebook(s3.dir, s3.rel, { type: "addCell", cellType: "code", index: 0 });
  assert.equal(s3.read().cells[0].cell_type, "code");
});

// ── deleteCell + moveCell ───────────────────────────────────────────────────────────────────────────

test("deleteCell removes by id; moveCell reorders and is a safe no-op at the edges", () => {
  const s = scratch(fixture());
  editNotebook(s.dir, s.rel, { type: "deleteCell", cellId: "bbb" });
  let nb = s.read();
  assert.deepEqual(nb.cells.map((c) => c.id), ["aaa", "ccc"]);

  const s2 = scratch(fixture());
  editNotebook(s2.dir, s2.rel, { type: "moveCell", cellId: "ccc", dir: "up" });
  assert.deepEqual(s2.read().cells.map((c) => c.id), ["aaa", "ccc", "bbb"]);

  // up at the top edge is a no-op success, not an error
  const s3 = scratch(fixture());
  const r = editNotebook(s3.dir, s3.rel, { type: "moveCell", cellId: "aaa", dir: "up" });
  assert.equal(r.ok, true);
  assert.deepEqual(s3.read().cells.map((c) => c.id), ["aaa", "bbb", "ccc"]);
});

test("a pre-4.5 notebook (no cell ids) is normalized once, then editable by id", () => {
  const s = scratch({
    cells: [
      { cell_type: "code", source: "1", outputs: [], execution_count: null },
      { cell_type: "markdown", source: "hi" },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 2,
  });
  // The first edit normalizes ids; delete the SECOND cell by the id it was assigned.
  const norm = readNotebook(s.abs); // not yet normalized on disk
  const r = editNotebook(s.dir, s.rel, { type: "moveCell", cellId: "will-not-exist", dir: "up" });
  assert.equal(r.writeback, "stale-cell"); // ids now exist but this bogus one doesn't
  const nb = s.read();
  assert.ok(nb.cells.every((c) => typeof c.id === "string" && c.id.length), "every cell has an id after normalization");
  assert.equal(nb.cells.length, 2);
});

// ── run-vs-edit coexistence (the shared CAS write path) ──────────────────────────────────────────────
// A kernel output-merge and a card source-edit both go through readNotebook → mutate-by-id → casWriteNotebook.
// They touch DISJOINT fields, so in EITHER order both survive. We simulate the merge with the same primitives
// the kernel uses (readNotebook + casWriteNotebook, exported here) — proving the coexistence at the write layer.

function simulateMerge(abs, cellId, outputs, execCount) {
  const read = readNotebook(abs);
  const cell = read.nb.cells.find((c) => c.id === cellId);
  cell.outputs = outputs;
  cell.execution_count = execCount;
  return casWriteNotebook(abs, read.nb, read.version);
}

test("a source edit and a kernel output-merge on the SAME cell both land (either order, no clobber)", () => {
  const out = [{ output_type: "execute_result", data: { "text/plain": "42" }, metadata: {}, execution_count: 7 }];

  // edit → merge
  const s = scratch(fixture());
  assert.equal(editNotebook(s.dir, s.rel, { type: "editSource", cellId: "bbb", source: "answer()" }).ok, true);
  assert.equal(simulateMerge(s.abs, "bbb", out, 7), "ok");
  let bbb = s.read().cells.find((c) => c.id === "bbb");
  assert.deepEqual(bbb.source, ["answer()"], "source edit survives a later merge");
  assert.deepEqual(bbb.outputs, out, "merge outputs land");
  assert.equal(bbb.execution_count, 7);

  // merge → edit (the "edit lands while a cell is executing" case: kernel wrote outputs for the OLD source,
  // then the edit sets the new source — new source + those outputs, exactly Jupyter's staleness semantics).
  const s2 = scratch(fixture());
  assert.equal(simulateMerge(s2.abs, "bbb", out, 7), "ok");
  assert.equal(editNotebook(s2.dir, s2.rel, { type: "editSource", cellId: "bbb", source: "answer()" }).ok, true);
  bbb = s2.read().cells.find((c) => c.id === "bbb");
  assert.deepEqual(bbb.source, ["answer()"], "new source after the merge");
  assert.deepEqual(bbb.outputs, out, "the executing cell's outputs are NOT clobbered by the edit");
  assert.equal(bbb.execution_count, 7);
});

test("casWriteNotebook rejects a stale baseVersion (the CAS primitive the retry loop recovers on)", () => {
  const s = scratch(fixture());
  const read = readNotebook(s.abs); // version V0
  // An external write lands (bumps the file to V1).
  simulateMerge(s.abs, "bbb", [{ output_type: "stream", name: "stdout", text: "hi\n" }], 9);
  // A write based on the now-stale V0 is refused — this is exactly the conflict editNotebook's loop re-reads on.
  const r = casWriteNotebook(s.abs, read.nb, read.version);
  assert.equal(r, "stale", "an outdated baseVersion is rejected, not silently overwritten");
});

test("editing strips a render-only metadata.__foolscap that somehow reached disk", () => {
  const nb = fixture();
  nb.metadata.__foolscap = { trimmed: true, droppedOutputs: 2 };
  const s = scratch(nb);
  editNotebook(s.dir, s.rel, { type: "editSource", cellId: "aaa", source: "# x" });
  assert.ok(!("__foolscap" in s.read().metadata), "__foolscap is stripped on the full-fidelity write");
});
