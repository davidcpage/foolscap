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

test("deserialize guarantees UNIQUE cell ids — the cell-delete data-loss root fix", () => {
  // A file can carry colliding ids two ways. Both broke delete-by-id (filter removes EVERY match →
  // deleting one cell also removed its collision twin, the "deletes the cell below" bug). The parser now
  // mints a fresh `c<n>` on any clash so no downstream op (delete/move/edit/convert, all id-keyed) can
  // touch the wrong cell.

  // (a) an explicit id that collides with the NEXT cell's positional fallback `c${n}`.
  const collideWithFallback = [
    "<notebook><title>T</title>",
    '<script id="c2" type="module">first</script>', // explicit "c2"
    "<script type=\"module\">second</script>", // no id → fallback would be c2 → COLLISION
    "</notebook>",
  ].join("");
  const a = deserialize(collideWithFallback);
  assert.equal(a.cells.length, 2);
  assert.equal(new Set(a.cells.map((c) => c.id)).size, 2, "colliding fallback id is re-minted unique");
  assert.equal(a.cells[0].source, "first");
  assert.equal(a.cells[1].source, "second");

  // (b) two LITERAL duplicate explicit ids.
  const dupExplicit = [
    "<notebook><title>T</title>",
    '<script id="dup" type="module">one</script>',
    '<script id="dup" type="module">two</script>',
    '<script id="dup" type="module">three</script>',
    "</notebook>",
  ].join("");
  const b = deserialize(dupExplicit);
  assert.equal(b.cells.length, 3);
  assert.equal(new Set(b.cells.map((c) => c.id)).size, 3, "all three duplicate ids become distinct");
  assert.deepEqual(b.cells.map((c) => c.source), ["one", "two", "three"], "no cell dropped or merged");

  // The delete op reduces to filter-by-id. With unique ids it removes EXACTLY the target — never a neighbour.
  const target = b.cells[1].id;
  const afterDelete = b.cells.filter((c) => c.id !== target);
  assert.equal(afterDelete.length, 2, "delete-by-id removes exactly one cell");
  assert.deepEqual(afterDelete.map((c) => c.source), ["one", "three"], "the adjacent cells survive");
});

test("deserialize tolerates empty/garbage input without throwing", () => {
  assert.deepEqual(deserialize("").cells, []);
  assert.deepEqual(deserialize(undefined).cells, []);
  assert.equal(deserialize("<notebook></notebook>").title, "");
});

// ── main-realm consent (Fix A trust boundary, thread node:mrdj7o3s-9) ────────────────────────────────
// `data-main-realm="allow"` on the <notebook> element is the durable, doc-declarable consent that lets this
// notebook's DOM-producing cells run on the main thread (notebook-runtime's gate reads it via syncCells). The
// format parser must round-trip it so a grant survives every cell/title edit (render.js threads it through
// every serialize), and treat its ABSENCE as no consent (the gate holds).
test("deserialize: reads data-main-realm off the <notebook> element", () => {
  assert.equal(deserialize('<notebook data-main-realm="allow"><title>T</title></notebook>').mainRealm, "allow");
  assert.equal(deserialize("<notebook><title>T</title></notebook>").mainRealm, "", "absent → empty (no consent)");
  assert.equal(deserialize("").mainRealm, "", "garbage input → empty, never throws");
});

test("serialize: emits data-main-realm only when granted, and round-trips", () => {
  const granted = serialize({ title: "T", cells: [], mainRealm: "allow" });
  assert.match(granted, /<notebook data-main-realm="allow">/, "a grant is written onto the <notebook> tag");
  assert.equal(deserialize(granted).mainRealm, "allow", "grant survives a round-trip");

  const ungranted = serialize({ title: "T", cells: [] });
  assert.doesNotMatch(ungranted, /data-main-realm/, "no consent → the attribute is absent (no file noise)");
  assert.match(ungranted, /<notebook>/, "the bare <notebook> tag is still well-formed");
});

test("serialize: a cell edit that carries mainRealm through preserves consent (the render.js contract)", () => {
  // render.js includes `mainRealm: nb.mainRealm` in EVERY serialize; simulate an edit that keeps it.
  const src = serialize({ title: "T", cells: [{ id: "c1", type: "module", source: "1" }], mainRealm: "allow" });
  const nb = deserialize(src);
  const edited = serialize({ title: nb.title, cells: nb.cells.map((c) => ({ ...c, source: "2" })), mainRealm: nb.mainRealm });
  assert.equal(deserialize(edited).mainRealm, "allow", "editing a cell does not silently revoke consent");
});
