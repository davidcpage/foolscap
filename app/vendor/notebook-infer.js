// /vendor/notebook-infer.js — same-notebook dependency inference for the notebook card (step-4a,
// docs/notebook-card.md §5 "inferred later" + §11.4a). Parse a `module` cell's JS with the vendored acorn
// and work out, from the CODE alone, two things:
//
//   • `defines`  — the export name(s) the cell produces, via the named-cell convention: a top-level
//                  assignment `name = <expr>` (or a destructuring `{a, b} = <expr>` / `[a, b] = <expr>`)
//                  DEFINES those names. A single-statement cell defines its one name; a statement BLOCK
//                  (step-4b) defines EVERY top-level assignment (`a = 1` / `b = 2` → both a and b). Any other
//                  shape (a bare expression like `x * 2`, a call, a literal) defines nothing — display-only.
//   • `reads`    — the cell's FREE VARIABLES: identifiers referenced but not bound anywhere inside the cell
//                  (so not a param, not a local var/const/let/function/class/import, not a catch binding).
//                  The runtime intersects these with the names OTHER cells define → that's the dependency
//                  edge. Globals like `Math`/`console`/`Array` are free here too, but match no producer, so
//                  the runtime drops them.
//
// And `valueSource` + `block` — the code the WORKER should actually evaluate, and how. For a single
// EXPRESSION (the step-0/4a shape) `block` is false and `valueSource` is that expression: the worker
// paren-wraps it (`return (expr)`), and for an assignment-define cell it is the RHS only (`x = 21` → `21`)
// so the named-cell form needs NO global assignment in the shared worker. When the cell is a STATEMENT
// BLOCK — it has an `import` (step-4b) or more than one top-level statement — `block` is true and
// `valueSource` is the whole body rewritten so the worker runs it as a function body: every `import`
// declaration span blanked out in place, a NON-relative import (bare `"d3"` / a full ESM URL) additionally
// re-emitted as a dynamic-import prologue (`const d3 = await import(<url>)`, A2 lib loading — the worker IS a
// module realm, so import() runs there), and the LAST top-level expression
// turned into a `return` (a trailing `name = expr` becomes `return (expr)`, so a block define still maps to
// its export without leaking a global). This is step-4b's "richer worker" (docs/notebook-card.md §11.4b).
//
// And `imports` — the cross-notebook edges read from the cell's `import … from "./rel"` STATEMENTS (step-4b),
// in the SAME {name, path, export} shape the step-2 `data-in="q=./nb#export"` grammar produced, so the
// runtime's path→card resolution + cross-card export bus are reused unchanged; only the authoring syntax
// moved from an attribute into the code (§11.4b). Only relative specifiers (./ ../ /) are edges.
//
// This retires `data-in`/`data-out` as the PRIMARY surface (both intra- and now cross-notebook): they become
// an optional override (the runtime prefers an explicit declaration when present).
//
// Pure + DOM-free (depends only on acorn), so it runs in the browser at /vendor/, bundles into the runtime
// via Vite, and unit-tests under node alike — the notebook-format.js posture.

import { parse, parseExpressionAt } from "./acorn.js";

// Module + latest syntax: a cell is module-scoped (Observable 2.0 cells use standard `import`), which also
// makes top-level await legal. We never EXECUTE via acorn — only inspect the tree — so strict-mode parse
// quirks (e.g. assignment to an undeclared name) don't matter; acorn accepts them syntactically.
const PARSE_OPTS = { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true };

const isNode = (x) => x && typeof x === "object" && typeof x.type === "string";
// Keys on an acorn node that are positions/metadata, never child AST — skipped by the generic recursion.
const META = new Set(["type", "start", "end", "loc", "range", "sourceType", "directive", "raw", "regex", "bigint", "value", "name", "operator", "kind", "computed", "static", "prefix", "delegate", "optional", "generator", "async", "method", "shorthand", "tail", "flags", "pattern"]);

export function analyzeCell(source, opts) {
  const src = String(source ?? "");
  // A2 lib loading: the ESM CDN base a BARE import specifier resolves to (a full URL passes through). One knob,
  // resolved once here; the import-map (A3) slots in at resolveSpecifierUrl. Default esm.sh.
  const cdnBase = (opts && typeof opts.cdnBase === "string" && opts.cdnBase) || DEFAULT_CDN_BASE;
  // A3 import map (`{ name → url }`): pins the URL an EXPLICIT bare import resolves to (via resolveSpecifierUrl)
  // AND supplies the URL for an AMBIENT auto-import (opts.ambient — see below). Null = no map (A2 behaviour).
  const importMap = opts && opts.importMap && typeof opts.importMap === "object" ? opts.importMap : null;
  // A3 parse-time reference resolution (Phase 2): the caller (computeEffective) has decided that these free-read
  // names are neither a local binding nor a sibling export, but ARE in the import map — so they should be
  // auto-imported. We synthesize a dynamic-import prologue (`const d3 = await import(<url>)`), exactly as an
  // explicit `import * as d3 from "d3"` would, so NO value crosses postMessage — the realm imports it itself.
  // Guard each name against the map so a stale request can't emit `undefined`.
  const ambient =
    opts && Array.isArray(opts.ambient) && importMap
      ? opts.ambient.filter((n) => typeof importMap[n] === "string")
      : [];
  let ast;
  try {
    ast = parse(src, PARSE_OPTS);
  } catch {
    // A half-typed / not-yet-valid cell: infer nothing (the explicit declarations, if any, still apply in
    // the runtime; the cell errors at run exactly as today). Never throw — inference is best-effort.
    return { ok: false, reads: [], defines: [], imports: [], valueSource: src, block: false, keyedExports: false, suppress: false, domCandidate: false };
  }
  // Pass 1: every name BOUND anywhere in the cell (params, declarations, imports, …). A free variable is one
  // referenced but absent from this set — a deliberately COARSE (whole-cell, not scope-precise) rule: a name
  // declared anywhere locally is never treated as a sibling import, which is the safe direction (no spurious
  // edges), and matches that Observable forbids redefining an imported name in the same cell anyway. Import
  // bindings land here too (collectBindings handles ImportDeclaration), so an imported name is never a read.
  const bound = new Set();
  collectBindings(ast, bound);
  // Pass 2: identifiers in REFERENCE position (not property keys, not member `.prop`, not binding ids, not a
  // pure `=` write target).
  const referenced = new Set();
  collectReferences(ast, referenced);

  // Partition the top level into `import` declarations (step-4b cross-card edges, which the worker can't run
  // and so must be stripped) and everything else.
  const importDecls = ast.body.filter((s) => s.type === "ImportDeclaration");
  const rest = ast.body.filter((s) => s.type !== "ImportDeclaration");
  const imports = importsFromDecls(importDecls, src);

  // A3 ambient prologue: the auto-import statements for the caller-approved ambient names (never a locally
  // bound name — a `const d3 = …` in the cell wins, so we'd never shadow it with an import). Empty unless
  // this cell references a mapped lib with no import line. An ambient import injects STATEMENTS, so it forces
  // block mode (a bare expression can't carry a preceding `const … = await import()`).
  const ambientNames = ambient.filter((n) => !bound.has(n));
  const ambientPrologue = buildAmbientPrologue(ambientNames, importMap);
  // A cell is a STATEMENT BLOCK when it has any import (must be stripped), more than one top-level statement,
  // or an ambient prologue to prepend — the worker runs it as a function body whose value is its LAST top-level
  // expression. A single statement with NO imports/ambient keeps the single-EXPRESSION path verbatim, so an
  // object literal `{a:1}` (which parses as a block statement) still evaluates as an expression via the
  // worker's paren-wrap (no regression).
  const block = importDecls.length > 0 || rest.length > 1 || ambientPrologue !== "";
  // OUTPUT SUPPRESSION (Jupyter/MATLAB/Observable `;`): the cell runs normally but DISPLAYS no value when its
  // final statement ends in a statement-terminating semicolon. AST-based, not string-trim: acorn extends an
  // ExpressionStatement past its inner expression ONLY for a real `;` terminator, so a `;` inside a string or
  // comment (never part of the statement node) or a for-loop header (a ForStatement, not an ExpressionStatement)
  // is immune. Keys off the LAST top-level statement, uniform across the single-expression and block paths.
  const suppress = endsWithStatementSemicolon(src, ast);
  let defines, valueSource, keyedExports;
  if (block) {
    const b = buildBlockSource(src, importDecls, rest, cdnBase, importMap);
    defines = b.defines;
    // Prepend the ambient auto-import prologue (A3, Phase 2). It carries NO newline, so the block body's line
    // numbers are untouched (a runtime error still points at the user's code); buildBlockSource already emitted
    // its own return/exports epilogue, so the ambient const declarations simply sit ahead of the body.
    valueSource = ambientPrologue + b.body;
    keyedExports = b.keyedExports;
  } else {
    const d = detectDefine(ast, src); // ast.body carries no imports here, so the step-4a logic applies as-is
    defines = d.defines;
    valueSource = d.valueSource;
    keyedExports = false; // a single value (or a destructure-define, which the runtime keys by name count)
  }
  const dset = new Set(defines);
  const reads = [...referenced].filter((n) => !bound.has(n) && !dset.has(n));
  // domCandidate (Phase-2 B2 DOM/SVG output): does this cell MAYBE build a DOM node, so it must run on the
  // MAIN THREAD (real document + real layout) rather than the DOM-less worker? Two static signals, both free
  // here: (1) it imports an EXTERNAL lib (a non-relative specifier — Plot/d3, the viz path; relative imports
  // stay local edges), or (2) it free-reads a DOM global (`document`/`window` — the hand-rolled node path).
  // A worker-first-then-detect approach is impossible: Plot throws in the DOM-less worker BEFORE any Node
  // could be observed, so routing must be decided ahead of the run. Over-routing a pure-compute cell that
  // imports a lib (e.g. `d3.max`) is harmless — it returns a plain value and takes the existing text path.
  const externalImports = importDecls.some(
    (d) => d.source && typeof d.source.value === "string" && !isRelativeSpecifier(d.source.value),
  );
  // An AMBIENT import loads an external lib exactly as an explicit one does, so it routes the cell to the
  // main-thread realm the same way (a bare `Plot.plot(...)` needs real layout; a pure `d3.max` over-routes
  // harmlessly, as today). ambientNames is the effective set actually injected into the prologue.
  const domCandidate = externalImports || ambientNames.length > 0 || reads.some((n) => DOM_GLOBALS.has(n));
  return { ok: true, reads, defines, imports, valueSource, block, keyedExports, suppress, domCandidate };
}

// DOM globals whose presence as a free read routes a cell to the main-thread realm (see domCandidate). Kept
// deliberately small — `document`/`window` are the roots every hand-rolled DOM/SVG build goes through.
const DOM_GLOBALS = new Set(["document", "window"]);

// True when the cell's LAST top-level statement is an ExpressionStatement terminated by an explicit `;` — the
// output-suppression signal. Acorn sets an ExpressionStatement's `end` to just past its inner expression when
// there's NO semicolon (ASI), and just past the `;` when there is one; so the span between them contains the
// terminator iff the user wrote a trailing `;`. Any other last-statement shape (a loop, a declaration, a bare
// expression with no `;`) suppresses nothing. Whitespace/comments between the expression and `;` don't matter —
// a `;` there is still a genuine terminator; a `;` living inside a string/comment is never in this span at all.
function endsWithStatementSemicolon(src, ast) {
  const body = ast.body;
  if (!body || !body.length) return false;
  const last = body[body.length - 1];
  if (last.type !== "ExpressionStatement") return false;
  return src.slice(last.expression.end, last.end).includes(";");
}

// ── pass 1: bound names ─────────────────────────────────────────────────────────────────────────────
function collectBindings(node, out) {
  if (Array.isArray(node)) return void node.forEach((n) => collectBindings(n, out));
  if (!isNode(node)) return;
  switch (node.type) {
    case "VariableDeclarator":
      bindPattern(node.id, out);
      collectBindings(node.init, out);
      return;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      if (node.id) out.add(node.id.name);
      for (const p of node.params) bindPattern(p, out);
      collectBindings(node.body, out);
      return;
    case "ClassDeclaration":
    case "ClassExpression":
      if (node.id) out.add(node.id.name);
      collectBindings(node.body, out);
      return;
    case "CatchClause":
      if (node.param) bindPattern(node.param, out);
      collectBindings(node.body, out);
      return;
    case "ImportDeclaration":
      for (const s of node.specifiers) out.add(s.local.name);
      return;
  }
  for (const k in node) {
    if (META.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v) || isNode(v)) collectBindings(v, out);
  }
}

// Collect the binding NAMES introduced by a pattern (a param or a declarator id): plain, destructured,
// defaulted, rest. Default-value expressions are NOT bindings — references inside them are gathered by the
// reference pass (collectReferencesInDefaults), so they aren't lost.
function bindPattern(node, out) {
  if (!isNode(node)) return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      return;
    case "ObjectPattern":
      for (const p of node.properties) bindPattern(p.type === "RestElement" ? p.argument : p.value, out);
      return;
    case "ArrayPattern":
      for (const el of node.elements) el && bindPattern(el, out);
      return;
    case "AssignmentPattern":
      bindPattern(node.left, out);
      return;
    case "RestElement":
      bindPattern(node.argument, out);
      return;
  }
}

// ── pass 2: referenced names ────────────────────────────────────────────────────────────────────────
// Walk the tree adding Identifiers used as VALUES. The structural cases (member access, property keys,
// declarations, function params, assignment targets) are handled explicitly so a binding/key identifier is
// never miscounted as a read; everything else recurses generically, where a bare Identifier IS a reference.
function collectReferences(node, out) {
  if (Array.isArray(node)) return void node.forEach((n) => collectReferences(n, out));
  if (!isNode(node)) return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      return;
    case "MemberExpression":
      collectReferences(node.object, out);
      if (node.computed) collectReferences(node.property, out); // a.b → only `a`; a[b] → `a` and `b`
      return;
    case "Property":
      if (node.computed) collectReferences(node.key, out); // {[k]: v} → `k`; {a: v} → key `a` is not a read
      collectReferences(node.value, out);
      return;
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) collectReferences(node.key, out);
      collectReferences(node.value, out);
      return;
    case "AssignmentExpression":
      collectReferences(node.right, out);
      // The LHS of a plain `=` is a WRITE, not a read — skip a bare Identifier/pattern target, but a member
      // target still reads its object (`obj.x = 1` reads `obj`). Compound ops (`+=`) read the target too.
      if (node.operator !== "=") collectReferences(node.left, out);
      else if (node.left.type === "MemberExpression") collectReferences(node.left, out);
      return;
    case "VariableDeclarator":
      collectReferences(node.init, out);
      collectReferencesInDefaults(node.id, out); // the id is a binding; only its default exprs are reads
      return;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      for (const p of node.params) collectReferencesInDefaults(p, out); // param defaults can reference
      collectReferences(node.body, out);
      return;
    case "CatchClause":
      collectReferencesInDefaults(node.param, out);
      collectReferences(node.body, out);
      return;
    case "ImportDeclaration":
      return; // import bindings are not references
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return; // a label is not a variable reference
  }
  for (const k in node) {
    if (META.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v) || isNode(v)) collectReferences(v, out);
  }
}

// Inside a binding pattern, the only READS are default-value expressions and computed property keys; the
// bound names themselves are not reads. (e.g. `function f(a = b, {[k]: c} = d)` reads b, k, d — not a/c.)
function collectReferencesInDefaults(node, out) {
  if (!isNode(node)) return;
  switch (node.type) {
    case "Identifier":
      return;
    case "AssignmentPattern":
      collectReferences(node.right, out);
      collectReferencesInDefaults(node.left, out);
      return;
    case "ObjectPattern":
      for (const p of node.properties) {
        if (p.type === "RestElement") {
          collectReferencesInDefaults(p.argument, out);
          continue;
        }
        if (p.computed) collectReferences(p.key, out);
        collectReferencesInDefaults(p.value, out);
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements) el && collectReferencesInDefaults(el, out);
      return;
    case "RestElement":
      collectReferencesInDefaults(node.argument, out);
      return;
  }
}

// ── named-cell define + the worker's value expression ─────────────────────────────────────────────────
// A cell DEFINES names only when its whole body is exactly one top-level assignment `target = <expr>` with
// the plain `=` operator and a binding target (an Identifier, or a destructuring pattern → several names).
// Then the worker evaluates just the RHS and the value maps to the export(s), reusing the explicit-data-out
// path (1 name → the value IS the export; many → keys picked off the value object). `obj.x = …` is a member
// write, not a notebook define. Anything else → no define, evaluate the source verbatim (minus a trailing `;`).
function detectDefine(ast, src) {
  if (!ast.body || ast.body.length !== 1) return { defines: [], valueSource: src };
  const stmt = ast.body[0];
  if (stmt.type !== "ExpressionStatement") return { defines: [], valueSource: src };
  const ex = stmt.expression;
  // A non-define expression runs VERBATIM but with any statement-terminating `;` dropped — so `1;` wraps to the
  // valid `return (1)` instead of the SyntaxError `return (1;)`. We strip only the terminator character (not the
  // expression's own span) so surrounding parens/comments survive: `({a:1});` → `({a:1})`, not `{a:1}`.
  if (ex.type !== "AssignmentExpression" || ex.operator !== "=" || ex.left.type === "MemberExpression") {
    return { defines: [], valueSource: stripTrailingSemicolon(src, stmt) };
  }
  const names = new Set();
  bindPattern(ex.left, names);
  if (!names.size) return { defines: [], valueSource: stripTrailingSemicolon(src, stmt) };
  return { defines: [...names], valueSource: src.slice(ex.right.start, ex.right.end) };
}

// Drop the explicit statement terminator `;` from a single ExpressionStatement, if present. Acorn ends an
// ExpressionStatement just past its `;` (or at the expression when ASI applied), so the terminator — when
// written — is the last character of the statement's span; remove exactly that one char, keeping everything
// else (leading comments, wrapping parens) intact.
function stripTrailingSemicolon(src, stmt) {
  if (src[stmt.end - 1] === ";") return src.slice(0, stmt.end - 1) + src.slice(stmt.end);
  return src;
}

// ── step-4b: cross-notebook imports from `import` statements ────────────────────────────────────────
// Turn the RELATIVE-path `import` declarations into the runtime's CellImport shape ({name, path, export}) —
// the SAME descriptor the step-2 `data-in="q=./nb#export"` grammar produced, so the runtime's path→card
// resolution + cross-card export bus are reused unchanged (docs/notebook-card.md §11.4b). Mappings:
//   import { df } from "./nb"       → { name:"df", path:"./nb", export:"df" }   (a single export)
//   import { df as d } from "./nb"  → { name:"d",  path:"./nb", export:"df" }   (aliased)
//   import * as nb from "./nb"      → { name:"nb", path:"./nb", export:null }   (the whole notebook object)
//   import nb from "./nb"           → { name:"nb", path:"./nb", export:null }   (default → notebook object)
// A bare/npm or URL specifier (`from "d3"`) yields no cross-card EDGE here (it is not another notebook/file),
// but its statement is NOT dropped: buildBlockSource re-emits it as a dynamic-import prologue (A2 lib loading),
// so `import * as d3 from "d3"` becomes a runnable `const d3 = await import(<cdn>/d3)` in the same cell.
function importsFromDecls(decls, src) {
  const out = [];
  for (const d of decls) {
    const path = d.source && typeof d.source.value === "string" ? d.source.value : "";
    if (!isRelativeSpecifier(path)) continue;
    for (const s of d.specifiers) {
      if (s.type === "ImportSpecifier") out.push({ name: s.local.name, path, export: importedName(s.imported) });
      else out.push({ name: s.local.name, path, export: null }); // namespace `* as x` / default → object import
    }
  }
  return out;
}
function isRelativeSpecifier(p) {
  return p.startsWith("./") || p.startsWith("../") || p.startsWith("/");
}

// ── A2 external-library loading + A3 import-map: a non-relative specifier → the URL a dynamic import() loads ─
// The SINGLE place a bare/URL import specifier becomes a URL. Resolution order:
//   1. the notebook IMPORT MAP (A3) — a `{ name → url }` override keyed by the bare specifier: pins a lib's
//      URL (and version) consistently across the whole notebook. A user-written `d3@6` (its own version) is a
//      DIFFERENT specifier, so it is never overridden — the map only pins the plain `d3` form.
//   2. a full URL (any scheme, or a protocol-relative `//cdn`) passes through UNCHANGED.
//   3. a bare specifier (`d3`, `d3-array`, `@scope/pkg`) maps onto a configurable ESM CDN base (default esm.sh).
// Relative specifiers never reach this — isRelativeSpecifier routes them to the cross-card edge/input path.
export const DEFAULT_CDN_BASE = "https://esm.sh/";

// The small, DELIBERATE default import map (A3): the two libs a notebook can reference with NO import line,
// version-pinned so every cell resolves the same URL. Kept tiny on purpose — auto-importing a bare reference
// means a typo matching an entry silently imports, so the blast radius stays minimal (a notebook extends it
// via a `type="importmap"` cell). Keyed by the REFERENCE NAME the cell writes (`d3`, `Plot`); Plot's npm
// specifier is `@observablehq/plot`, but the identifier you use is `Plot` — the map keys on the identifier.
export const DEFAULT_IMPORT_MAP = Object.freeze({
  d3: "https://esm.sh/d3@7",
  Plot: "https://esm.sh/@observablehq/plot@0.6",
});

export function resolveSpecifierUrl(spec, base = DEFAULT_CDN_BASE, map = null) {
  const s = String(spec ?? "");
  if (map && typeof map[s] === "string") return map[s]; // A3: the import map pins this specifier's URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return s; // has a URI scheme, or protocol-relative
  return base + s; // a bare specifier → the CDN base
}
// The exported name of a named import: an Identifier (`{df}`) or a string literal (`{"odd name" as x}`).
function importedName(node) {
  return node ? (node.type === "Identifier" ? node.name : node.value) : null;
}

// ── step-4b: the statement-block source the worker runs ─────────────────────────────────────────────
// Rewrite the cell into a function body the worker runs (wrapped in an async IIFE, so top-level await still
// works). Every `import` declaration is blanked (spaces, newlines kept, so a runtime error's line numbers
// still point at the user's code — the worker is not a module and can't run `import`). Then, two shapes:
//
//   • Named-cell defines — EVERY top-level `name = expr` (and destructuring `{a,b} = …` / `[a,b] = …`) is a
//     notebook export, generalising Observable's single named cell to SEVERAL per block. We declare them all
//     as block-LOCALS up front (`let a, b;`) so the bare assignments populate locals and never leak a global
//     into the shared worker (the §4a no-leak rule, extended to blocks). The block still has a DISPLAY value —
//     Observable shows a cell's LAST expression — so we capture the last top-level statement's value into a
//     hidden local and `return ({ value, exports: { a, b } })`: the runtime shows `value` and keys the export
//     atoms off `exports` (keyedExports). This is why `a = 1 \n 2` displays `2` (the last expression) while
//     still exporting `a` — display and exports are distinct, not "an object of all the bindings".
//   • No defines — the block's value is its LAST top-level expression, wrapped `return (expr)`. A block whose
//     last statement isn't an expression (a loop, a bare declaration) yields undefined, as a REPL block would.
//
// Returns the rewritten body, the define names, and keyedExports (true for the { value, exports } define form).
function buildBlockSource(src, importDecls, rest, cdnBase, importMap) {
  const body0 = maskSpans(src, importDecls); // ALL import spans blanked; every other offset preserved (same length)
  // A2 LIB LOADING: a NON-relative import (bare `"d3"` / a full ESM URL) is neither a cross-card edge nor
  // runnable as a static `import` in the worker — but the worker runs the body via `new Function` in a module
  // realm, where dynamic import() works. Re-emit each as a single-line `const … = await import(<url>);` and
  // PREPEND it as a prologue. The import spans stay blanked in body0 above, so every downstream AST offset is
  // intact; the prologue carries NO newline, so the user's line 1 is still line 1 (as the define prologue relies
  // on). Empty string when the block has no non-relative import — the common case adds nothing.
  const libPrologue = buildLibPrologue(importDecls, cdnBase, importMap);
  // Collect the names of every TOP-LEVEL `name = expr` assignment, in source order (no duplicates).
  const defines = [];
  for (const s of rest) {
    if (s.type !== "ExpressionStatement") continue;
    const ex = s.expression;
    if (ex.type !== "AssignmentExpression" || ex.operator !== "=" || ex.left.type === "MemberExpression") continue;
    const names = new Set();
    bindPattern(ex.left, names);
    for (const n of names) if (!defines.includes(n)) defines.push(n);
  }
  const last = rest[rest.length - 1];
  if (defines.length) {
    // Capture the last top-level expression's value into a hidden local for DISPLAY; a trailing non-expression
    // statement leaves it undefined. The last statement may itself be a define assignment (`b = 2`) — rewriting
    // it to `__nbValue = (b = 2)` keeps the define running AND records its value. Prologue adds NO newline (every
    // original line number is preserved); the epilogue returns the { value, exports } pair.
    let captured = body0;
    if (last && last.type === "ExpressionStatement") {
      const ex = last.expression;
      captured = body0.slice(0, last.start) + "__nbValue = (" + body0.slice(last.start, ex.end) + ");" + body0.slice(last.end);
    }
    const prologue = "let __nbValue, " + defines.join(", ") + "; ";
    const epilogue = ";\nreturn ({ value: __nbValue, exports: { " + defines.join(", ") + " } });";
    return { body: libPrologue + prologue + captured + epilogue, defines, keyedExports: true };
  }
  if (last && last.type === "ExpressionStatement") {
    const ex = last.expression; // `EXPR [;]` → `return (EXPR)` (drops a trailing semicolon)
    const body = body0.slice(0, last.start) + "return (" + body0.slice(last.start, ex.end) + ")" + body0.slice(last.end);
    return { body: libPrologue + body, defines: [], keyedExports: false };
  }
  return { body: libPrologue + body0, defines: [], keyedExports: false };
}

// The dynamic-import PROLOGUE for a block's non-relative imports (A2). Each becomes one runnable
// `const … = await import(<url>);` statement, joined on a SINGLE line (no newlines → line numbers preserved)
// with a trailing space so it sits cleanly before the (blanked) body. Relative imports are skipped — they are
// cross-card edges (injected as inputs, blanked from the body). Returns "" when there are none.
function buildLibPrologue(importDecls, cdnBase, importMap) {
  const stmts = [];
  for (const d of importDecls) {
    const spec = d.source && typeof d.source.value === "string" ? d.source.value : "";
    if (!spec || isRelativeSpecifier(spec)) continue;
    stmts.push(dynamicImportStatement(d, resolveSpecifierUrl(spec, cdnBase, importMap)));
  }
  return stmts.length ? stmts.join(" ") + " " : "";
}

// The dynamic-import PROLOGUE for the A3 AMBIENT auto-imports (Phase 2): each caller-approved reference name
// becomes `const <name> = await import(<url>);`, joined on a SINGLE line (no newlines → the block body's line
// numbers are preserved) with a trailing space so it sits cleanly before the body. This is a NAMESPACE bind
// (the whole module object, like `import * as d3 from "d3"`) — the shape d3/Plot expect, where `.max`/`.plot`
// are named exports on the namespace. `url` comes from the import map (already a full, JSON-safe URL). Returns
// "" when there are no ambient names, so a cell that references no mapped lib adds nothing.
function buildAmbientPrologue(names, importMap) {
  if (!importMap) return "";
  const stmts = [];
  for (const name of names) {
    const url = importMap[name];
    if (typeof url !== "string") continue;
    stmts.push("const " + name + " = await import(" + JSON.stringify(url) + ");");
  }
  return stmts.length ? stmts.join(" ") + " " : "";
}

// Build the runnable `const … = await import(url)` for ONE non-relative import declaration, mapping its
// specifiers to the module-namespace object a dynamic import() resolves to:
//   import * as ns from "x"      → const ns = await import(url)
//   import def from "x"          → const { default: def } = await import(url)
//   import { a, b as c } from x  → const { a, b: c } = await import(url)
//   import def, { a } from "x"   → const { default: def, a } = await import(url)
//   import def, * as ns from x   → const ns = await import(url), def = ns.default   (default + namespace)
//   import "x"                   → await import(url)                                (side-effect only)
// A string-named specifier (`{ "odd name" as x }`) becomes a quoted destructuring key. `url` is already
// resolved (bare→CDN / URL passthrough) and JSON-encoded so it is a safe string literal.
function dynamicImportStatement(decl, url) {
  const lit = JSON.stringify(url);
  const specs = decl.specifiers || [];
  if (!specs.length) return "await import(" + lit + ");"; // side-effect-only import — no bindings
  const ns = specs.find((s) => s.type === "ImportNamespaceSpecifier");
  const def = specs.find((s) => s.type === "ImportDefaultSpecifier");
  const named = specs.filter((s) => s.type === "ImportSpecifier");
  if (ns) {
    // `* as ns` (optionally with a default): bind the namespace, then the default off it — a single `const
    // a = …, b = a.default` works because a later declarator may reference an earlier one. (JS syntax forbids
    // a namespace specifier ALONGSIDE named ones, so there is nothing else to fold in here.)
    let out = "const " + ns.local.name + " = await import(" + lit + ")";
    if (def) out += ", " + def.local.name + " = " + ns.local.name + ".default";
    return out + ";";
  }
  const parts = [];
  if (def) parts.push("default: " + def.local.name);
  for (const s of named) {
    const imported = s.imported.type === "Identifier" ? s.imported.name : JSON.stringify(s.imported.value);
    parts.push(imported === s.local.name ? imported : imported + ": " + s.local.name);
  }
  return "const { " + parts.join(", ") + " } = await import(" + lit + ");";
}
// Replace each node's [start,end) span of src with spaces, preserving newlines (so blanking imports keeps
// every other character at its original offset, and line numbers in a runtime error stay accurate).
function maskSpans(src, nodes) {
  if (!nodes.length) return src;
  const chars = [...src];
  for (const d of nodes) for (let i = d.start; i < d.end; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}

// ── markdown interpolation: `${ expr }` in a text/markdown cell (docs/notebook-card.md §8) ──────────────
// Observable Notebook Kit 2.0 treats a text/markdown cell as REACTIVE: `${expr}` splices a value from the
// dataflow graph into the prose, re-rendering when the value changes. We fit that onto the existing scheduler
// by COMPILING the markdown into a JS template literal — the cell then runs like a code cell (the worker
// evaluates the template, its value is the fully-interpolated markdown STRING, which the card renders as
// prose) and its free variables are the reactive edges. No new execution path: a markdown cell becomes a
// single-expression `module`-shaped run whose source is the template literal.
//
// EXPR_OPTS is for parsing ONE interpolation expression in isolation (parseExpressionAt). allowAwaitOutside
// function so `${await x}` parses — the worker runs the template inside an async IIFE, so await is legal there.
const EXPR_OPTS = { ecmaVersion: "latest", allowAwaitOutsideFunction: true };

// Escape a run of LITERAL prose so it is safe inside a template literal: backslash first (so we don't double-
// escape the escapes we add), then backtick, then `$` — escaping every `$` to `\$` means a stray `$` in prose
// can never start an interpolation, and we only ever re-introduce a real `${` for spans we deliberately parse.
function escapeTemplateText(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

// Compile a markdown cell's source into a template-literal source string. Each `${` is located, and the
// expression after it is parsed with acorn (parseExpressionAt) so the matching close brace is found CORRECTLY
// even with nested braces / strings / template literals inside the expression — a brace counter can't do this.
// A `${` that isn't followed by a valid `expr }` is treated as literal text (so prose can mention `${...}`
// without breaking). Returns the template literal and the number of real interpolations (0 ⇒ a plain prose
// cell, which the runtime won't schedule).
export function compileMarkdown(source) {
  const src = String(source ?? "");
  let out = "`";
  let i = 0;
  let count = 0;
  while (i < src.length) {
    const d = src.indexOf("${", i);
    if (d < 0) {
      out += escapeTemplateText(src.slice(i));
      break;
    }
    out += escapeTemplateText(src.slice(i, d));
    let node = null;
    try {
      node = parseExpressionAt(src, d + 2, EXPR_OPTS);
    } catch {
      node = null;
    }
    // A real interpolation needs a parseable expression followed (after optional whitespace) by `}`.
    let close = -1;
    if (node) {
      let j = node.end;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}") close = j;
    }
    if (close < 0) {
      out += escapeTemplateText("${"); // not an interpolation — emit `${` literally and scan past it
      i = d + 2;
      continue;
    }
    out += "${" + src.slice(d + 2, close) + "}"; // splice the expression through verbatim (its own JS, unescaped)
    i = close + 1;
    count++;
  }
  out += "`";
  return { templateSource: out, count };
}

// Analyze a text/markdown (or text/html) cell the same way analyzeCell does a `module` cell, so the runtime
// schedules it uniformly. The compiled template literal is one expression: its free variables are the cell's
// reactive `reads`; it defines and imports nothing (markdown only READS the graph — cross-notebook imports are
// a code-cell concern). `interpolated` tells the runtime whether to schedule it at all (false ⇒ pure prose,
// rendered directly by the card). valueSource is the template literal the worker evaluates to the prose string.
export function analyzeMarkdown(source) {
  const { templateSource, count } = compileMarkdown(source);
  const a = analyzeCell(templateSource); // reuse free-var inference over the template literal
  // A markdown cell's value is always the interpolated prose STRING, never a DOM node — force domCandidate
  // false so an interpolation that happens to read `window`/`document` never routes prose to the main thread.
  return { ...a, interpolated: count > 0 && a.ok, defines: [], imports: [], valueSource: templateSource, suppress: false, domCandidate: false };
}
