// Conformance gate for the hand-written .d.ts contracts of the server-side .js modules.
//
// WHY this exact shape (export-NAME existence only, no signatures) — do not "upgrade" it to `checkJs`:
// TypeScript NEVER cross-checks a .js against a sibling hand-written .d.ts. When `foo.js` and `foo.d.ts`
// coexist, the .d.ts is the authoritative declaration for every consumer and the .js body is type-checked
// (under checkJs) in ISOLATION — the two are never compared. Verified with a minimal counterexample: a pair
// whose .d.ts declared a wrong signature AND a phantom export the .js does not export still compiled clean
// under `tsc --checkJs`. So enabling checkJs would NOT verify these contracts (and separately explodes into
// ~778 implicit-any errors). This runtime test is the narrowest mechanism that actually catches the drift
// that bites: an export renamed or removed from a .js without updating its hand-written .d.ts. Signature
// drift and js-exports-not-in-the-.d.ts are deliberately out of scope (the .d.ts is a curated public subset).
// (Full single-source-of-truth via allowJs + inference is deferred as a separate work item — see thread
// "Structural: codex extraction, finish plugin split, checkJs", seq 7.)
//
// Scope: the ~35 root-level app/*.js server modules that carry a hand-written .d.ts. Discovered dynamically,
// so a NEW server module's .d.ts is covered automatically. Excludes src/ (browser code) and vendor/ (third-
// party libs — e.g. vendor/lit-html.js references `document` at load and cannot import under node).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Root-level .js modules that ship a hand-written .d.ts sibling.
const pairs = readdirSync(appDir)
  .filter((f) => f.endsWith(".d.ts"))
  .map((dts) => ({ dts, js: dts.replace(/\.d\.ts$/, ".js") }))
  .filter((p) => existsSync(path.join(appDir, p.js)))
  .sort((a, b) => a.js.localeCompare(b.js));

// One program over every .d.ts so cross-file type re-exports resolve; enumerate per file below.
const dtsPaths = pairs.map((p) => path.join(appDir, p.dts));
const program = ts.createProgram(dtsPaths, {
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
});
const checker = program.getTypeChecker();

// The names a .d.ts declares that exist as RUNTIME VALUES (functions, const/let/var, classes, enums,
// value-modules) — i.e. everything a consumer can reference at runtime. Type-only exports (interface, type
// alias) have no runtime footprint and are intentionally skipped. Alias exports (`export { x } from …`) are
// resolved to their target so re-exported values still count.
function declaredValueExports(dtsPath) {
  const sf = program.getSourceFile(dtsPath);
  assert.ok(sf, `could not load ${dtsPath} into the TS program`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return []; // no top-level exports → nothing to assert
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((sym) => {
      let flags = sym.flags;
      if (flags & ts.SymbolFlags.Alias) {
        try { flags = checker.getAliasedSymbol(sym).flags; } catch { /* keep original flags */ }
      }
      return (flags & ts.SymbolFlags.Value) !== 0;
    })
    .map((sym) => sym.name);
}

test("every hand-written .d.ts pairs with a real .js implementation", () => {
  assert.ok(pairs.length >= 30, `expected ~35 .d.ts/.js pairs, found ${pairs.length}`);
});

for (const { dts, js } of pairs) {
  test(`${js} exports every value its ${dts} declares`, async () => {
    const declared = declaredValueExports(path.join(appDir, dts));
    const mod = await import(pathToFileURL(path.join(appDir, js)).href);
    const actual = new Set(Object.keys(mod));
    const missing = declared.filter((name) => !actual.has(name));
    assert.deepEqual(
      missing,
      [],
      `${dts} declares value export(s) not present on ${js}: ${missing.join(", ")} — ` +
        `the .d.ts drifted from the implementation (renamed/removed export?).`,
    );
  });
}
