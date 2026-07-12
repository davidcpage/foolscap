import { test } from "node:test";
import assert from "node:assert/strict";
import { transformNotebook, notebookHasElisionMarkers } from "../ipynb-codec.js";

// The notebook-aware /api/file codec (docs/ipynb-card.md; brief: "make .ipynb handling notebook-aware for
// size"). Two shapes of the same notebook: the RENDER path (the card — keep images, drop only whole outputs
// past a budget) and the default AGENT path (elide base64 to markers, clamp huge text — legible JSON). Both
// must ALWAYS stay valid, parseable JSON, with cell SOURCE intact and trimming honestly flagged.

// A minimal nbformat-v4 notebook with one code cell carrying a big base64 image + a text/plain repr.
function nbWithImage(b64) {
  return {
    cells: [
      {
        cell_type: "code",
        execution_count: 1,
        source: ["import matplotlib.pyplot as plt\n", "plt.plot([1,2,3])\n"],
        outputs: [
          {
            output_type: "display_data",
            data: { "image/png": b64, "text/plain": ["<Figure size 640x480>"] },
            metadata: {},
          },
        ],
      },
      { cell_type: "markdown", source: ["# Title\n", "prose\n"] },
    ],
    metadata: { language_info: { name: "python" }, kernelspec: { language: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

const bigB64 = "A".repeat(500_000); // ~500 KB fake base64 payload

test("agent: base64 raster image elided to a byte-count marker; source intact; valid JSON; flagged", () => {
  const src = JSON.stringify(nbWithImage(bigB64));
  const { content, trimmed, parsed } = transformNotebook(src, { mode: "agent" });
  assert.equal(parsed, true);
  assert.equal(trimmed, true);
  const nb = JSON.parse(content); // must be valid JSON
  const img = nb.cells[0].outputs[0].data["image/png"];
  assert.match(img, /^<image\/png output elided: \d+ bytes>$/);
  assert.ok(img.includes("500000"), `marker reports the elided byte count: ${img}`);
  // cell SOURCE is never touched — that's what the agent is reading for
  assert.deepEqual(nb.cells[0].source, ["import matplotlib.pyplot as plt\n", "plt.plot([1,2,3])\n"]);
  // small text/plain repr is kept as-is
  assert.deepEqual(nb.cells[0].outputs[0].data["text/plain"], ["<Figure size 640x480>"]);
  // the elided content is dramatically smaller than the original
  assert.ok(content.length < src.length / 10, "elided notebook is far smaller than the original");
});

test("agent: oversized stream text is clamped to head + marker; short stream untouched", () => {
  const nb = {
    cells: [
      {
        cell_type: "code",
        source: [],
        outputs: [
          { output_type: "stream", name: "stdout", text: "x".repeat(50_000) },
          { output_type: "stream", name: "stdout", text: "small output\n" },
        ],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
  const { content, trimmed } = transformNotebook(JSON.stringify(nb), { mode: "agent", maxTextChars: 4000 });
  assert.equal(trimmed, true);
  const out = JSON.parse(content).cells[0].outputs;
  assert.match(out[0].text, /truncated: 50000 chars total, 4000 shown/);
  assert.ok(out[0].text.length < 5000, "clamped to roughly the head budget");
  assert.equal(out[1].text, "small output\n"); // untouched
});

test("agent: error traceback clamped when oversized", () => {
  const nb = {
    cells: [
      {
        cell_type: "code",
        source: [],
        outputs: [{ output_type: "error", ename: "ValueError", evalue: "boom", traceback: ["y".repeat(20_000)] }],
      },
    ],
    metadata: {},
    nbformat: 4,
  };
  const { content, trimmed } = transformNotebook(JSON.stringify(nb), { mode: "agent" });
  assert.equal(trimmed, true);
  const tb = JSON.parse(content).cells[0].outputs[0].traceback;
  assert.equal(tb.length, 1);
  assert.match(tb[0], /traceback truncated/);
});

test("agent: a small notebook with no images is unchanged (trimmed=false), still valid JSON", () => {
  const nb = {
    cells: [{ cell_type: "code", source: ["print(1)\n"], outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }] }],
    metadata: {},
    nbformat: 4,
  };
  const src = JSON.stringify(nb);
  const { content, trimmed, parsed } = transformNotebook(src, { mode: "agent" });
  assert.equal(parsed, true);
  assert.equal(trimmed, false);
  assert.deepEqual(JSON.parse(content), nb);
});

test("render: images are KEPT when under budget (trimmed=false)", () => {
  const src = JSON.stringify(nbWithImage(bigB64));
  const { content, trimmed } = transformNotebook(src, { mode: "render" });
  assert.equal(trimmed, false);
  const nb = JSON.parse(content);
  assert.equal(nb.cells[0].outputs[0].data["image/png"], bigB64); // full image survives
});

test("render: over budget → whole outputs dropped (valid JSON), source intact, banner flag set", () => {
  // three cells each with a ~500 KB image; a 700 KB budget forces dropping the largest until it fits
  const nb = {
    cells: [0, 1, 2].map((n) => ({
      cell_type: "code",
      source: [`cell ${n}\n`],
      outputs: [{ output_type: "display_data", data: { "image/png": "B".repeat(500_000) }, metadata: {} }],
    })),
    metadata: {},
    nbformat: 4,
  };
  const { content, trimmed } = transformNotebook(JSON.stringify(nb), { mode: "render", renderBudget: 700_000 });
  assert.equal(trimmed, true);
  const out = JSON.parse(content); // valid JSON
  assert.ok(out.metadata.__foolscap && out.metadata.__foolscap.trimmed, "banner flag injected");
  assert.ok(out.metadata.__foolscap.droppedOutputs >= 1);
  assert.ok(content.length <= 800_000, "trimmed under budget (plus small banner)");
  // every cell's SOURCE survives even where its output was dropped
  assert.deepEqual(out.cells.map((c) => c.source[0]), ["cell 0\n", "cell 1\n", "cell 2\n"]);
});

test("malformed / non-notebook JSON is served verbatim (parsed=false) — never guess truncation", () => {
  const clipped = '{"cells": [{"cell_type": "code", "sour'; // byte-clipped upstream → invalid JSON
  const a = transformNotebook(clipped, { mode: "agent" });
  assert.equal(a.parsed, false);
  assert.equal(a.content, clipped); // unchanged
  assert.equal(a.trimmed, false);

  const notNb = JSON.stringify({ foo: "bar" }); // valid JSON but no cells array
  const b = transformNotebook(notNb, { mode: "render" });
  assert.equal(b.parsed, false);
  assert.equal(b.content, notNb);
});

test("agent: image payload given as an array of base64 lines is elided too", () => {
  const nb = {
    cells: [
      {
        cell_type: "code",
        source: [],
        outputs: [{ output_type: "execute_result", execution_count: 1, data: { "image/jpeg": ["AAAA\n", "BBBB\n"] }, metadata: {} }],
      },
    ],
    metadata: {},
    nbformat: 4,
  };
  const { content, trimmed } = transformNotebook(JSON.stringify(nb), { mode: "agent" });
  assert.equal(trimmed, true);
  assert.match(JSON.parse(content).cells[0].outputs[0].data["image/jpeg"], /^<image\/jpeg output elided: 8 bytes>$/);
});

// ── the "full" mode: the WRITE-BACK projection (Path B kernel broker) ─────────────────────────────────
// Full-fidelity identity — nothing elided or dropped, so the on-disk record is complete — but it strips the
// render-only `metadata.__foolscap` banner flag (which must never be persisted) and validates notebook shape.

test("full: keeps every output at full fidelity (no elision, no drop)", () => {
  const bigImg = "A".repeat(50000);
  const nb = nbWithImage(bigImg);
  const { content, trimmed, parsed } = transformNotebook(JSON.stringify(nb), { mode: "full" });
  assert.equal(parsed, true);
  assert.equal(trimmed, false);
  const out = JSON.parse(content);
  assert.equal(out.cells[0].outputs[0].data["image/png"], bigImg); // kept whole — never a marker
});

test("full: strips the render-only metadata.__foolscap banner flag", () => {
  const nb = { cells: [{ cell_type: "code", source: [], outputs: [] }], metadata: { __foolscap: { trimmed: true, droppedOutputs: 3 }, kernelspec: { name: "python3" } }, nbformat: 4 };
  const { content } = transformNotebook(JSON.stringify(nb), { mode: "full" });
  const out = JSON.parse(content);
  assert.equal("__foolscap" in out.metadata, false); // never persisted
  assert.deepEqual(out.metadata.kernelspec, { name: "python3" }); // other metadata untouched
});

test("full: a merged output survives a round-trip by cell id", () => {
  const nb = { cells: [{ id: "abc123", cell_type: "code", source: ["1/0"], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  const parsed = JSON.parse(transformNotebook(JSON.stringify(nb), { mode: "full" }).content);
  parsed.cells[0].outputs = [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["..."] }];
  parsed.cells[0].execution_count = 7;
  const round = JSON.parse(transformNotebook(JSON.stringify(parsed), { mode: "full" }).content);
  assert.equal(round.cells[0].id, "abc123");
  assert.equal(round.cells[0].execution_count, 7);
  assert.equal(round.cells[0].outputs[0].ename, "ZeroDivisionError");
});

test("full: malformed / non-notebook JSON passes through unchanged (parsed=false)", () => {
  const clipped = '{"cells":[{"outputs":[{"data":{"image/png":"AAAABBBB'; // byte-clipped
  const a = transformNotebook(clipped, { mode: "full" });
  assert.equal(a.parsed, false);
  assert.equal(a.content, clipped);
});

// ── notebookHasElisionMarkers: the BUG-2 write guard's detector ────────────────────────────────────────
// The lossy AGENT projection must never round-trip back to disk (writing markers erases real outputs). The
// detector recognises EXACTLY what the agent path stamps — and nothing else, so a clean notebook (or a
// marker string sitting in cell SOURCE) is never falsely refused.

test("markers: the AGENT projection of an image-bearing notebook is detected", () => {
  const agent = transformNotebook(JSON.stringify(nbWithImage(bigB64)), { mode: "agent" }).content;
  assert.equal(notebookHasElisionMarkers(agent), true, "the image-elision marker is caught");
});

test("markers: a clamped-text agent projection is detected", () => {
  const nb = {
    cells: [{ cell_type: "code", source: ["print('x')\n"], outputs: [{ output_type: "stream", name: "stdout", text: ["y".repeat(10000)] }] }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  };
  const agent = transformNotebook(JSON.stringify(nb), { mode: "agent" });
  assert.equal(agent.trimmed, true, "the long stream output was clamped");
  assert.equal(notebookHasElisionMarkers(agent.content), true, "the text-clamp marker is caught");
});

test("markers: a clean full-fidelity notebook is NOT flagged (a legitimate edit round-trips)", () => {
  // The FULL projection keeps the real base64 image — no markers — so it must pass the write guard.
  const full = transformNotebook(JSON.stringify(nbWithImage(bigB64)), { mode: "full" }).content;
  assert.equal(notebookHasElisionMarkers(full), false);
  // A small, output-free notebook is likewise clean.
  const small = JSON.stringify({ cells: [{ cell_type: "code", source: ["1+1\n"], outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  assert.equal(notebookHasElisionMarkers(small), false);
});

test("markers: a marker STRING in cell SOURCE (not an output) does not false-trip", () => {
  const nb = {
    cells: [{ cell_type: "code", source: ["print('<image/png output elided: 123 bytes>')\n"], outputs: [] }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  };
  assert.equal(notebookHasElisionMarkers(JSON.stringify(nb)), false, "only OUTPUT fields are inspected");
});

test("markers: malformed / non-notebook JSON is not flagged (nothing to protect)", () => {
  assert.equal(notebookHasElisionMarkers('{"cells":[{"outputs":[{"data":{"image/png":"AAA'), false);
  assert.equal(notebookHasElisionMarkers("not json at all"), false);
  assert.equal(notebookHasElisionMarkers(JSON.stringify({ not: "a notebook" })), false);
});
