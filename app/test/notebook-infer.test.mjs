import { test } from "node:test";
import assert from "node:assert/strict";

// Same-notebook dependency inference (docs/notebook-card.md §11.4a). analyzeCell parses a `module` cell with
// the vendored acorn and reports its free variables (`reads`), the name(s) it defines via the `name = …`
// convention (`defines`), and the expression the worker should run (`valueSource`). It imports acorn through
// a relative ./acorn.js, which node resolves on disk — no data:-URL rewrite needed (unlike the templates).
const { analyzeCell, analyzeMarkdown, compileMarkdown, resolveSpecifierUrl, DEFAULT_CDN_BASE } = await import(
  new URL("../vendor/notebook-infer.js", import.meta.url)
);
// The worker's core — reused to prove a rewritten import-block actually RUNS (import → compute), exactly as the
// scheduler would post it. No network: a `data:text/javascript,…` URL is the stubbed CDN, loaded by real import().
const { runJob } = await import(new URL("../public/notebook-worker.js", import.meta.url));

const sorted = (a) => [...a].sort();

test("a bare expression reads its free variables and defines nothing", () => {
  const a = analyzeCell("x * 2");
  assert.equal(a.ok, true);
  assert.deepEqual(a.reads, ["x"], "x is a free variable");
  assert.deepEqual(a.defines, [], "a bare expression defines no export");
  assert.equal(a.valueSource, "x * 2", "the source is run verbatim");
});

test("a `name = expr` cell defines the name and runs only the RHS", () => {
  const a = analyzeCell("x = 21");
  assert.deepEqual(a.defines, ["x"], "the assigned name is the export");
  assert.deepEqual(a.reads, [], "the constant reads nothing");
  assert.equal(a.valueSource, "21", "the worker runs the RHS, not the bare assignment (no global leak)");
});

test("a `name = expr` cell reads the free variables of its RHS", () => {
  const a = analyzeCell("y = x * 2");
  assert.deepEqual(a.defines, ["y"]);
  assert.deepEqual(a.reads, ["x"], "x on the RHS is a read; y (the target) is not");
  assert.equal(a.valueSource, "x * 2");
});

test("globals are free variables too (the runtime drops the ones no cell produces)", () => {
  const a = analyzeCell("Math.sqrt(x) + y");
  assert.deepEqual(sorted(a.reads), ["Math", "x", "y"], "Math is reported; the runtime filters non-producers");
});

test("member access reads the object, not the property name", () => {
  assert.deepEqual(analyzeCell("obj.foo.bar").reads, ["obj"], "a.b.c reads only a");
  assert.deepEqual(sorted(analyzeCell("obj[key]").reads), ["key", "obj"], "computed access reads the key too");
});

test("object literal: values are reads, plain keys are not", () => {
  assert.deepEqual(analyzeCell("({ a: x, b: 2 })").reads, ["x"], "shorthand-free keys aren't reads");
  assert.deepEqual(sorted(analyzeCell("({ [k]: v })").reads), ["k", "v"], "computed keys ARE reads");
});

test("locally declared names are not free (coarse whole-cell binding)", () => {
  // Multi-statement (a step-4b worker concern to RUN) but inference still resolves the graph.
  const a = analyzeCell("const a = 1;\na + b");
  assert.deepEqual(a.reads, ["b"], "a is locally declared → only b is free");
  assert.deepEqual(a.defines, [], "a multi-statement cell is not a named-cell define");
});

test("function params and their bodies don't leak as reads; param defaults do", () => {
  assert.deepEqual(analyzeCell("z => z + w").reads, ["w"], "z is a param, w is free");
  assert.deepEqual(sorted(analyzeCell("(a = d) => a + 1").reads), ["d"], "a is a param; its default d is read");
  assert.deepEqual(sorted(analyzeCell("items.map(it => it.value)").reads), ["items"], "it is a param");
});

test("destructuring assignment defines several names off one value object", () => {
  // Object-pattern assignment needs parens at statement start (bare `{…}` parses as a block — a JS rule).
  const a = analyzeCell("({ lo, hi } = bounds)");
  assert.deepEqual(sorted(a.defines), ["hi", "lo"], "both names are exports");
  assert.deepEqual(a.reads, ["bounds"], "the source object is read");
  assert.equal(a.valueSource, "bounds", "the worker runs the object expression; the runtime picks the keys");
  // Array destructuring needs no parens.
  const arr = analyzeCell("[first, second] = pair");
  assert.deepEqual(arr.defines, ["first", "second"]);
  assert.deepEqual(arr.reads, ["pair"]);
});

test("a member assignment is a write, not a notebook define", () => {
  const a = analyzeCell("obj.x = 5");
  assert.deepEqual(a.defines, [], "obj.x = … defines no export");
  assert.deepEqual(a.reads, ["obj"], "it reads the object it mutates");
  assert.equal(a.valueSource, "obj.x = 5", "and runs verbatim (not a stripped RHS)");
});

test("a compound assignment reads its target; a plain one does not", () => {
  assert.deepEqual(analyzeCell("n += 1").reads, ["n"], "+= reads n");
  assert.deepEqual(analyzeCell("n = 1").reads, [], "= does not read the target");
});

test("a parse error infers nothing but never throws", () => {
  const a = analyzeCell("oops(");
  assert.equal(a.ok, false);
  assert.deepEqual(a.reads, []);
  assert.deepEqual(a.defines, []);
  assert.equal(a.valueSource, "oops(", "the cell still runs (and errors) verbatim");
});

test("await and template literals resolve their free variables", () => {
  assert.deepEqual(sorted(analyzeCell("await fetch(url)").reads), ["fetch", "url"], "top-level await parses");
  assert.deepEqual(sorted(analyzeCell("`y is ${y} at ${t}`").reads), ["t", "y"], "template interpolations are reads");
});

test("import bindings are not free variables (the names they introduce are local)", () => {
  // The acorn parse of a step-4b import statement: df is bound by the import, n is the only free read.
  const a = analyzeCell("import { df } from './nb';\ndf.length + n");
  assert.deepEqual(a.reads, ["n"], "df is import-bound, not free");
});

// ── step-4b: cross-notebook `import` statements + the statement-block worker ──────────────────────────

test("a named import becomes a cross-card edge and is stripped from the value source", () => {
  const a = analyzeCell('import { df } from "./prices"\ndf.length');
  assert.deepEqual(a.imports, [{ name: "df", path: "./prices", export: "df" }], "{df} → name=df, export=df");
  assert.equal(a.block, true, "an import makes the cell a statement block");
  assert.deepEqual(a.reads, [], "df is import-bound, not a free read");
  assert.ok(!/import/.test(a.valueSource), "the import declaration is stripped from the body");
  assert.ok(/return \(df\.length\)/.test(a.valueSource), "the last expression becomes a return");
});

test("an aliased import maps the export name to the local binding", () => {
  const a = analyzeCell('import { df as data } from "./prices"\ndata');
  assert.deepEqual(a.imports, [{ name: "data", path: "./prices", export: "df" }], "df as data → name=data, export=df");
});

test("a namespace / default import is a whole-notebook object import (export null)", () => {
  const star = analyzeCell('import * as nb1 from "./nb1"\nnb1.df');
  assert.deepEqual(star.imports, [{ name: "nb1", path: "./nb1", export: null }], "* as nb1 → object import");
  assert.deepEqual(star.reads, [], "nb1 is import-bound");
  const def = analyzeCell('import nb1 from "./nb1"\nnb1.df');
  assert.deepEqual(def.imports, [{ name: "nb1", path: "./nb1", export: null }], "default → object import");
});

test("a bare/npm specifier is not a cross-card edge but is REWRITTEN into a dynamic import (A2 lib loading)", () => {
  const a = analyzeCell('import _ from "lodash"\n_.range(n)');
  assert.deepEqual(a.imports, [], "a non-relative specifier is not a cross-card edge");
  assert.equal(a.block, true, "the import still forces block mode");
  assert.ok(
    /const \{ default: _ \} = await import\("https:\/\/esm\.sh\/lodash"\);/.test(a.valueSource),
    "the bare import is re-emitted as a dynamic import() prologue, not blanked away",
  );
  assert.deepEqual(a.reads, ["n"], "_ is import-bound; n is the free read");
});

test("a multi-statement cell with no import is a block; the last expression is returned", () => {
  const a = analyzeCell("const a = x + 1\na * 2");
  assert.equal(a.block, true, "two statements → block");
  assert.deepEqual(a.imports, []);
  assert.deepEqual(a.reads, ["x"], "a is locally declared; x is free");
  assert.deepEqual(a.defines, [], "a multi-statement cell defines no named export");
  assert.ok(/const a = x \+ 1/.test(a.valueSource), "earlier statements are kept");
  assert.ok(/return \(a \* 2\)/.test(a.valueSource), "the last expression is returned");
});

test("a block assignment defines the name without leaking a global (declared local, returned as an object)", () => {
  const a = analyzeCell('import { rate } from "./fx"\ntotal = base * rate');
  assert.deepEqual(a.defines, ["total"], "the assignment is the export");
  assert.deepEqual(a.imports, [{ name: "rate", path: "./fx", export: "rate" }]);
  assert.deepEqual(a.reads, ["base"], "base is free; rate is import-bound; total is the define");
  assert.equal(a.keyedExports, true, "a block define returns a { value, exports } pair the runtime keys by name");
  assert.ok(/let __nbValue, total/.test(a.valueSource), "the define is declared local (no global leak in the shared worker)");
  assert.ok(/total = base \* rate/.test(a.valueSource), "the assignment runs against the local");
  assert.ok(/return \(\{ value: __nbValue, exports: \{ total \} \}\)/.test(a.valueSource), "returns the display value + export map");
});

test("a block defines EVERY top-level assignment, not just the last", () => {
  const a = analyzeCell("total = sum(values)\naverage = total / values.length");
  assert.deepEqual(sorted(a.defines), ["average", "total"], "both names are exports");
  assert.deepEqual(a.reads, ["sum", "values"], "total is an internal define, not a read; values + sum are free");
  assert.equal(a.keyedExports, true);
  assert.ok(/let __nbValue, total, average/.test(a.valueSource), "both defines are declared local");
  assert.ok(/exports: \{ total, average \}/.test(a.valueSource), "both are returned in the export map");
  // The DISPLAY value is the last top-level expression — here the `average = …` assignment, value `total/len`.
  assert.ok(/__nbValue = \(average = total \/ values\.length\)/.test(a.valueSource), "the last statement's value is captured for display");
});

test("a define block displays its LAST expression, not an object of its bindings (Observable-style)", () => {
  // `a = 1` defines `a`; the bare `2` is the cell's final expression. Observable shows the last expression, so
  // the DISPLAY value is 2 — while `a` is still exported. Previously this whole block displayed `{ a: 1 }`.
  const a = analyzeCell("a = 1\n2");
  assert.equal(a.keyedExports, true);
  assert.deepEqual(a.defines, ["a"], "a is still exported");
  assert.ok(/__nbValue = \(2\)/.test(a.valueSource), "the trailing expression 2 is captured as the display value");
  assert.ok(/exports: \{ a \}/.test(a.valueSource), "a is the export");
  // Evaluate the rewritten body to confirm the runtime sees value:2 (display) and exports.a:1 (wiring).
  const out = new Function(a.valueSource)();
  assert.deepEqual(out, { value: 2, exports: { a: 1 } });
});

test("a block with no assignment-define returns its last expression (display-only)", () => {
  const a = analyzeCell("const a = x + 1\na * 2");
  assert.deepEqual(a.defines, [], "const declarations are locals, not exports");
  assert.equal(a.keyedExports, false);
  assert.ok(/return \(a \* 2\)/.test(a.valueSource), "the last expression is the value");
});

test("a single-statement, import-free cell stays an EXPRESSION (object literal not a block)", () => {
  const obj = analyzeCell("({ a: 1, b: 2 })");
  assert.equal(obj.block, false, "no regression: a lone object literal evaluates as an expression");
  assert.equal(obj.valueSource, "({ a: 1, b: 2 })", "run verbatim, paren-wrapped by the worker");
  const expr = analyzeCell("x * 2");
  assert.equal(expr.block, false, "a lone bare expression is still expression mode");
});

// ── markdown `${ }` interpolation (Observable Notebook Kit 2.0, docs/notebook-card.md §8) ───────────────
// analyzeMarkdown compiles a text/markdown cell to a template literal whose evaluated value is the
// interpolated prose string; its free variables are the reactive reads. Evaluate the compiled valueSource
// the way the worker does (expression mode → `return (source)` inside a function) to prove the round-trip.
const runMd = (source, inputs = {}) => {
  const a = analyzeMarkdown(source);
  const names = Object.keys(inputs);
  const fn = new Function(...names, "return (" + a.valueSource + ")");
  return fn(...names.map((n) => inputs[n]));
};

test("a markdown cell with no interpolation is not scheduled and reads nothing", () => {
  const a = analyzeMarkdown("# Hello\nplain **prose**, no expressions.");
  assert.equal(a.interpolated, false, "no ${} → a plain prose cell, not run by the scheduler");
  assert.deepEqual(a.reads, []);
  assert.deepEqual(a.defines, [], "markdown never defines an export");
  assert.deepEqual(a.imports, [], "markdown never imports");
});

test("a `${name}` interpolation reads the name and splices its value into the prose", () => {
  const a = analyzeMarkdown("# Sales: ${total}");
  assert.equal(a.interpolated, true);
  assert.deepEqual(a.reads, ["total"], "total is a reactive read");
  assert.deepEqual(a.defines, [], "the cell defines nothing — it only reads");
  assert.equal(a.block, false, "a compiled markdown cell is a single template-literal expression");
  assert.equal(runMd("# Sales: ${total}", { total: 42 }), "# Sales: 42", "the value is spliced in");
});

test("multiple interpolations and member/call expressions resolve their free variables", () => {
  const a = analyzeMarkdown("avg is ${avg.toFixed(2)} over ${rows.length} rows");
  assert.deepEqual(sorted(a.reads), ["avg", "rows"], "member access reads the object, not the property");
  assert.equal(
    runMd("avg is ${avg.toFixed(2)} over ${rows.length} rows", { avg: 3.14159, rows: [1, 2, 3] }),
    "avg is 3.14 over 3 rows",
  );
});

test("an interpolation expression may contain braces, strings, and nested templates (parser, not brace count)", () => {
  const a = analyzeMarkdown("pick ${ {a: x}.a } and ${ `n=${n}` }");
  assert.deepEqual(sorted(a.reads), ["n", "x"], "the object value x and the nested-template n are reads");
  assert.equal(runMd("pick ${ {a: x}.a } and ${ `n=${n}` }", { x: 7, n: 2 }), "pick 7 and n=2");
});

test("literal `$`, backticks, and backslashes in prose survive (escaped, not interpolated)", () => {
  // `$5` is not a `${`; a lone backtick and backslash are literal text. None is an interpolation.
  const src = "cost is $5 (a `code` span) \\ end";
  const a = analyzeMarkdown(src);
  assert.equal(a.interpolated, false, "no ${} present → not scheduled");
  assert.equal(runMd(src), src, "the prose round-trips byte-for-byte through the template literal");
});

test("a `${` with no valid expression is treated as literal text, not an interpolation", () => {
  const src = "this ${ is not closed and not valid";
  const a = analyzeMarkdown(src);
  assert.equal(a.interpolated, false, "an unparseable ${ is prose, not an edge");
  assert.equal(runMd(src), src, "and renders verbatim");
});

test("compileMarkdown counts only real interpolations", () => {
  assert.equal(compileMarkdown("a ${x} b ${y} c").count, 2, "two real interpolations");
  assert.equal(compileMarkdown("price $9.99, no expr").count, 0, "a bare $ is not an interpolation");
});

// ── output suppression: a trailing `;` runs the cell but shows no value (Jupyter/MATLAB/Observable `;`) ──
// analyzeCell reports `suppress` (AST-based: the last top-level statement is an ExpressionStatement ending in a
// real `;`). The runtime blanks only the DISPLAY value on suppress; exports still flow. Detection is on the
// tree, so a `;` inside a string/comment or a for-header never triggers it.

test("a single expression ending in `;` suppresses output AND runs as a valid expression (crash fix)", () => {
  const a = analyzeCell("1;");
  assert.equal(a.suppress, true, "the trailing ; asks for output suppression");
  assert.equal(a.block, false, "still a single-expression cell");
  assert.equal(a.valueSource, "1", "the ; is stripped — the worker wraps `return (1)`, not the SyntaxError `return (1;)`");
  // Confirm the worker's wrap actually evaluates now (previously `return (1;)` threw a SyntaxError).
  assert.equal(new Function("return (" + a.valueSource + ")")(), 1, "the stripped expression evaluates to 1");
});

test("a parenthesized single expression ending in `;` also runs without error and suppresses", () => {
  const a = analyzeCell("(1);");
  assert.equal(a.suppress, true);
  assert.equal(a.valueSource, "(1)", "only the trailing ; is dropped; the author's parens survive");
  assert.equal(new Function("return (" + a.valueSource + ")")(), 1);
});

test("a single expression WITHOUT a trailing `;` is unchanged (no suppression)", () => {
  const a = analyzeCell("x * 2");
  assert.equal(a.suppress, false, "no trailing ; → normal output");
  assert.equal(a.valueSource, "x * 2", "runs verbatim, exactly as before");
});

test("a `name = expr;` cell suppresses display but still defines its export (data-out still flows)", () => {
  const a = analyzeCell("x = 21;");
  assert.equal(a.suppress, true, "display suppressed by the trailing ;");
  assert.deepEqual(a.defines, ["x"], "x is still exported so downstream cells update");
  assert.equal(a.valueSource, "21", "the worker runs the RHS (the ; is not part of it)");
});

test("suppression is AST-based: a `;` inside a string is NOT a terminator", () => {
  const a = analyzeCell('"a;"');
  assert.equal(a.suppress, false, "the ; lives inside the string literal, not at statement end");
  const b = analyzeCell('"a;";');
  assert.equal(b.suppress, true, "a genuine terminator after the string DOES suppress");
});

test("suppression is AST-based: a `;` inside a trailing comment does NOT suppress", () => {
  const a = analyzeCell("1 // ok;");
  assert.equal(a.suppress, false, "the ; is in a comment, not part of the statement");
  // The source runs verbatim (the ; is only inside the comment, so there's no terminator to strip); the
  // worker's `return (…)` wrap still evaluates it to 1 — the comment can't leak out and break the wrap.
  assert.equal(new Function("return (\n" + a.valueSource + "\n)")(), 1, "still evaluates to 1");
});

test("a for-loop header's semicolons never trigger suppression (not an ExpressionStatement)", () => {
  const a = analyzeCell("for (let i = 0; i < 3; i++) console.log(i)");
  assert.equal(a.suppress, false, "the ; are loop-header separators; the last statement is a ForStatement");
});

test("a statement BLOCK ending in `;` suppresses its display value (last expression stripped of the ;)", () => {
  const a = analyzeCell("let a = 1;\na + 1;");
  assert.equal(a.block, true, "more than one statement → a block");
  assert.equal(a.suppress, true, "the final statement ends in ;");
  assert.ok(/return \(a \+ 1\)/.test(a.valueSource), "the block returns its last expression (the ; is dropped)");
});

test("a block whose final statement has NO trailing `;` does not suppress", () => {
  const a = analyzeCell("let a = 1;\na + 1");
  assert.equal(a.block, true);
  assert.equal(a.suppress, false, "earlier statements' ; don't matter — only the final statement's terminator");
});

test("a markdown cell never suppresses (its compiled template is not a `;`-terminated statement)", () => {
  const a = analyzeMarkdown("Total: ${total};");
  assert.equal(a.suppress, false, "a literal ; in prose is not a statement terminator");
});

// ── A2 external-library loading (Phase 1): a non-relative `import` → a dynamic import() in the block body ──
// A bare specifier (`d3`) or a full ESM URL is neither a cross-card edge nor runnable as a static `import` in
// the DOM-less worker. So analyzeCell REWRITES it into a top-of-cell `const … = await import(<url>)` prologue
// (the worker runs the block via `new Function` in a module realm, where import() works), mapping bare specs
// onto a configurable ESM CDN (resolveSpecifierUrl, default esm.sh) and passing URL specs through. Relative
// imports are untouched — they stay cross-card edges injected as inputs. import() self-caches per realm.

test("resolveSpecifierUrl: bare → CDN base, full URL passes through, base is configurable", () => {
  assert.equal(resolveSpecifierUrl("d3"), "https://esm.sh/d3", "a bare specifier maps onto the default CDN");
  assert.equal(resolveSpecifierUrl("d3-array"), "https://esm.sh/d3-array");
  assert.equal(resolveSpecifierUrl("@scope/pkg"), "https://esm.sh/@scope/pkg", "a scoped package is still bare");
  assert.equal(DEFAULT_CDN_BASE, "https://esm.sh/", "the default base is esm.sh");
  assert.equal(
    resolveSpecifierUrl("https://esm.sh/d3-array@3"),
    "https://esm.sh/d3-array@3",
    "a full URL passes through unchanged",
  );
  assert.equal(resolveSpecifierUrl("d3", "https://cdn.example/"), "https://cdn.example/d3", "the base is a knob");
});

test("a namespace import of a bare specifier becomes `const ns = await import(cdnUrl)`", () => {
  const a = analyzeCell('import * as d3 from "d3"\nd3.max([1, 9, 3])');
  assert.deepEqual(a.imports, [], "a bare specifier is not a cross-card edge");
  assert.equal(a.block, true);
  assert.deepEqual(a.reads, [], "d3 is import-bound, not a free read");
  assert.ok(
    /const d3 = await import\("https:\/\/esm\.sh\/d3"\);/.test(a.valueSource),
    "the namespace binding loads the whole module object",
  );
  assert.ok(/return \(d3\.max\(\[1, 9, 3\]\)\)/.test(a.valueSource), "the last expression is still returned");
});

test("a named import becomes an object destructure; `as` aliases the local", () => {
  const named = analyzeCell('import { mean } from "d3-array"\nmean([2, 4])');
  assert.ok(/const \{ mean \} = await import\("https:\/\/esm\.sh\/d3-array"\);/.test(named.valueSource));
  const aliased = analyzeCell('import { mean as m } from "d3-array"\nm([2, 4])');
  assert.ok(
    /const \{ mean: m \} = await import\("https:\/\/esm\.sh\/d3-array"\);/.test(aliased.valueSource),
    "the CDN export name maps to the local alias",
  );
});

test("a default import destructures `.default`; default + named fold into one destructure", () => {
  const def = analyzeCell('import d3 from "d3"\nd3.scaleLinear');
  assert.ok(/const \{ default: d3 \} = await import\("https:\/\/esm\.sh\/d3"\);/.test(def.valueSource));
  const both = analyzeCell('import d3, { mean } from "d3"\nmean');
  assert.ok(
    /const \{ default: d3, mean \} = await import\("https:\/\/esm\.sh\/d3"\);/.test(both.valueSource),
    "a default + named import is one destructure over the namespace",
  );
});

test("a default + namespace import binds the namespace, then the default off it", () => {
  const a = analyzeCell('import d3, * as ns from "d3"\nns');
  assert.ok(
    /const ns = await import\("https:\/\/esm\.sh\/d3"\), d3 = ns\.default;/.test(a.valueSource),
    "namespace first (a later declarator may reference an earlier one)",
  );
});

test("a full ESM URL specifier passes through import() unchanged (no CDN rewrite)", () => {
  const a = analyzeCell('import { mean } from "https://esm.sh/d3-array@3"\nmean([1, 2])');
  assert.ok(
    /const \{ mean \} = await import\("https:\/\/esm\.sh\/d3-array@3"\);/.test(a.valueSource),
    "a URL is loaded verbatim",
  );
});

test("a side-effect-only import loads the module for its effects with no bindings", () => {
  const a = analyzeCell('import "some-lib"\n42');
  assert.ok(/await import\("https:\/\/esm\.sh\/some-lib"\);/.test(a.valueSource), "no `const`, just the import");
  assert.ok(!/const .*await import/.test(a.valueSource), "no binding is introduced");
});

test("bare and RELATIVE imports coexist: the lib is rewritten, the sibling stays a cross-card edge", () => {
  const a = analyzeCell('import * as d3 from "d3"\nimport { df } from "./prices"\nd3.max(df) + n');
  assert.deepEqual(a.imports, [{ name: "df", path: "./prices", export: "df" }], "only the relative import is an edge");
  assert.ok(/const d3 = await import\("https:\/\/esm\.sh\/d3"\);/.test(a.valueSource), "d3 is rewritten to a dynamic import");
  assert.ok(!/import \{ df \}/.test(a.valueSource), "the relative import is blanked (df arrives as an injected input)");
  assert.deepEqual(a.reads, ["n"], "d3 and df are import-bound; only n is free");
});

test("the CDN base is configurable per call via opts.cdnBase (the A3 import-map seam)", () => {
  const a = analyzeCell('import * as d3 from "d3"\nd3', { cdnBase: "https://cdn.example/esm/" });
  assert.ok(
    /const d3 = await import\("https:\/\/cdn\.example\/esm\/d3"\);/.test(a.valueSource),
    "a bare specifier resolves against the supplied base",
  );
});

test("the dynamic-import prologue adds NO newline, so user line numbers are preserved", () => {
  // The import spans stay blanked in place; the prologue is prepended without a newline. So the number of
  // newlines BEFORE the returned expression matches the source — an important property for error line mapping.
  const src = 'import * as d3 from "d3"\nconst xs = [1, 2, 3]\nd3.max(xs)';
  const a = analyzeCell(src);
  const upToReturn = a.valueSource.slice(0, a.valueSource.indexOf("return ("));
  const srcUpToLast = src.slice(0, src.lastIndexOf("d3.max(xs)"));
  assert.equal(
    (upToReturn.match(/\n/g) || []).length,
    (srcUpToLast.match(/\n/g) || []).length,
    "same newline count before the final expression → line numbers unshifted",
  );
});

// ── A2 end-to-end: the rewritten block RUNS and computes (real import(), stubbed via a data: URL) ─────────
// Prove the whole chain: analyzeCell rewrites the import → the worker's runJob executes the block via
// new Function → the dynamic import() resolves. A `data:text/javascript,…` URL is the stubbed CDN (real
// import(), no network), reached either as a URL passthrough or by pointing cdnBase at a data: URL prefix.
const runBlock = async (source, opts) => {
  const a = analyzeCell(source, opts);
  assert.equal(a.block, true, "an import forces block mode");
  const r = await runJob({ source: a.valueSource, inputs: {}, block: a.block });
  assert.equal(r.ok, true, `the rewritten block should run: ${r.error ?? ""}`);
  return r.value;
};

test("E2E: a NAMED import (URL passthrough) loads and computes", async () => {
  const url = "data:text/javascript,export const max = (arr) => Math.max(...arr)";
  const out = await runBlock(`import { max } from "${url}"\nmax([3, 9, 4])`);
  assert.equal(out, 9, "d3.max-style compute over an imported function");
});

test("E2E: a NAMESPACE import (URL passthrough) exposes the whole module object", async () => {
  const url = "data:text/javascript,export const a = 2; export const b = 40";
  const out = await runBlock(`import * as lib from "${url}"\nlib.a + lib.b`);
  assert.equal(out, 42);
});

test("E2E: a BARE specifier resolves through the CDN base and computes", async () => {
  // Point cdnBase at a data: URL whose trailing `//` comments out the appended bare name — so a bare specifier
  // resolves to a real, loadable module. This exercises the bare → resolveSpecifierUrl → import() → compute path.
  const cdnBase = "data:text/javascript,export const scale = (x) => x * 10;//";
  const out = await runBlock('import { scale } from "d3-magic"\nscale(4)', { cdnBase });
  assert.equal(out, 40, "the bare specifier loaded and computed");
});

test("E2E: an import + a named-cell define exports the computed value and displays the last expression", async () => {
  const url = "data:text/javascript,export const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length";
  const src = `import { mean } from "${url}"\navg = mean([2, 4, 6])`;
  const a = analyzeCell(src);
  assert.deepEqual(a.defines, ["avg"], "the assignment is the export");
  assert.equal(a.keyedExports, true);
  const r = await runJob({ source: a.valueSource, inputs: {}, block: a.block });
  assert.equal(r.ok, true, `should run: ${r.error ?? ""}`);
  assert.deepEqual(r.value, { value: 4, exports: { avg: 4 } }, "avg is exported (=4) and displayed");
});
