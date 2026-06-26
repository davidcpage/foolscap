import { test } from "node:test";
import assert from "node:assert/strict";
import { deserialize, serialize } from "../vendor/notebook-format.js";

// The vendored notebook-format parser (docs/notebook-card.md §4) — a thin, DOM-free subset of the
// Observable Notebooks 2.0 HTML format. It imports nothing and uses no browser globals (string-based, not
// DOMParser), so node imports it directly. These lock the format contract the card + runtime ride on.

test("deserialize: title + cells with type, pinned, and the reactive data-* attributes", () => {
  const html = [
    "<!doctype html>",
    "<notebook>",
    "  <title>Demo</title>",
    '  <script id="a1" type="text/markdown">',
    "    # Heading",
    "    second line",
    "  </script>",
    '  <script id="a2" type="module" data-out="x">',
    "    21",
    "  </script>",
    '  <script id="a3" type="module" pinned data-in="x" data-out="y" data-policy="debounced:300">',
    "    x * 2",
    "  </script>",
  ].join("\n") + "\n</notebook>\n";

  const nb = deserialize(html);
  assert.equal(nb.title, "Demo");
  assert.equal(nb.cells.length, 3);

  const [a1, a2, a3] = nb.cells;
  assert.equal(a1.type, "text/markdown");
  assert.equal(a1.source, "# Heading\nsecond line", "markdown source is de-indented, blank edges trimmed");

  assert.equal(a2.type, "module");
  assert.equal(a2.source, "21");
  assert.deepEqual(a2.outNames, ["x"], "data-out parsed to a name list");
  assert.deepEqual(a2.inNames, [], "no data-in → empty");

  assert.equal(a3.pinned, true, "pinned flag");
  assert.deepEqual(a3.inNames, ["x"]);
  assert.deepEqual(a3.outNames, ["y"]);
  assert.equal(a3.policy, "debounced:300", "data-policy carried raw for the runtime to parse");
});

test("deserialize: comma OR space separated name lists, default type module, missing id synthesised", () => {
  const html =
    '<notebook><title>T</title><script type="module" data-in="a, b  c">a+b+c</script></notebook>';
  const nb = deserialize(html);
  assert.equal(nb.cells[0].type, "module", "type defaults to module");
  assert.ok(nb.cells[0].id, "a missing id is synthesised, never undefined");
  assert.deepEqual(nb.cells[0].inNames, ["a", "b", "c"], "commas and spaces both split names");
});

test("serialize → deserialize round-trips source, wiring, policy, and escapes </script>", () => {
  const nb = {
    title: "Round trip",
    cells: [
      { id: "a1", type: "text/markdown", source: "# Hi", inNames: [], outNames: [], policy: "" },
      { id: "a2", type: "module", source: "1 + 2", inNames: [], outNames: ["x"], policy: "" },
      { id: "a3", type: "module", source: 'document.write("</script>")', inNames: ["x"], outNames: ["y"], policy: "manual" },
    ],
  };
  const html = serialize(nb);

  // The one hard format requirement: a literal </script> in source is escaped so it can't end the block.
  assert.ok(html.includes("<\\/script>"), "</script> in source is escaped on write");
  assert.ok(!/[^\\]<\/script>\s*\)/.test(html), "no UNescaped </script> from the source body leaks");
  assert.ok(html.includes('data-out="x"') && html.includes('data-in="x"') && html.includes('data-policy="manual"'), "data-* attrs written back");

  const back = deserialize(html);
  assert.equal(back.title, "Round trip");
  assert.equal(back.cells.length, 3);
  assert.equal(back.cells[2].source, 'document.write("</script>")', "escaped </script> round-trips back to a literal");
  assert.deepEqual(back.cells[1].outNames, ["x"]);
  assert.deepEqual(back.cells[2].inNames, ["x"]);
  assert.equal(back.cells[2].policy, "manual");
  assert.equal(back.cells[0].source, "# Hi");
});

test("deserialize: data-in import grammar — local, path-object, and path#export (step-2)", () => {
  const html =
    '<notebook><title>T</title>' +
    '<script id="c" type="module" data-in="df, prices=./prices, one=../shared/data#total, raw=data.csv">' +
    "df" +
    "</script></notebook>";
  const [c] = deserialize(html).cells;
  // inNames stays the list of LOCAL binding names, so step-1 callers + display are unaffected.
  assert.deepEqual(c.inNames, ["df", "prices", "one", "raw"]);
  assert.deepEqual(c.imports, [
    { name: "df", path: null, export: null }, // a local sibling-cell export
    { name: "prices", path: "./prices", export: null }, // another notebook as an object
    { name: "one", path: "../shared/data", export: "total" }, // a single export from a notebook
    { name: "raw", path: "data.csv", export: null }, // a data file's content
  ]);
});

test("serialize → deserialize round-trips the step-2 import grammar", () => {
  const cells = [
    {
      id: "c1",
      type: "module",
      source: "prices.df",
      imports: [
        { name: "df", path: null, export: null },
        { name: "prices", path: "./prices", export: null },
        { name: "t", path: "../shared/data", export: "total" },
      ],
      outNames: ["v"],
      policy: "",
    },
  ];
  const back = deserialize(serialize({ title: "X", cells }));
  assert.deepEqual(back.cells[0].imports, cells[0].imports, "path + export survive a round-trip");
  assert.deepEqual(back.cells[0].inNames, ["df", "prices", "t"]);
});

test("deserialize tolerates empty/garbage input without throwing", () => {
  assert.deepEqual(deserialize("").cells, []);
  assert.deepEqual(deserialize(undefined).cells, []);
  assert.equal(deserialize("<notebook></notebook>").title, "");
});
