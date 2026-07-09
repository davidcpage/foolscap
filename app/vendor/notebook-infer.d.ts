// Types for the vendored same-notebook inference (notebook-infer.js), so notebook-runtime.ts can import it.
/** One cross-notebook import parsed from an `import … from "./rel"` statement (step-4b) — the same shape
 *  as the step-2 `data-in` grammar, so the runtime resolves it identically. `export: null` = whole-notebook
 *  object import (`* as x` / default); otherwise the single export name (with `as` aliasing into `name`). */
export interface InferredImport {
  name: string;
  path: string;
  export: string | null;
}

export interface CellAnalysis {
  /** Parse succeeded — false for a half-typed/invalid cell, where reads/defines/imports are empty. */
  ok: boolean;
  /** Free variables (referenced, not locally bound); the runtime intersects these with sibling defines. */
  reads: string[];
  /** Names this cell defines: one for a `name = …` cell, EVERY top-level assignment for a statement block. */
  defines: string[];
  /** Cross-notebook edges from the cell's relative `import` statements (step-4b). */
  imports: InferredImport[];
  /** The code the worker should evaluate — a single expression (block=false) or a function body (block=true). */
  valueSource: string;
  /** True when valueSource is a statement BLOCK (imports stripped, last expression returned), not one expression. */
  block: boolean;
  /** True when the block returns an OBJECT keyed by its define names — the runtime maps keys→exports even for one. */
  keyedExports: boolean;
  /** True when the cell's final statement ends in an explicit `;` — it runs normally but its value is not displayed. */
  suppress: boolean;
  /** True when the cell MAY build a DOM node (imports an external lib, or free-reads `document`/`window`) and
   *  so must run on the MAIN THREAD realm (Phase-2 B2 DOM/SVG output), not the DOM-less worker. */
  domCandidate: boolean;
}

/** Options for {@link analyzeCell}.
 *  - `cdnBase` overrides the ESM CDN base a BARE import specifier resolves to (A2 lib loading); default
 *    {@link DEFAULT_CDN_BASE}.
 *  - `importMap` (A3) pins the URL a bare specifier resolves to (`{ name → url }`, keyed by the reference
 *    name) — applied to explicit imports via {@link resolveSpecifierUrl} and to ambient auto-imports below.
 *  - `ambient` (A3, Phase 2) is the caller-approved set of free-read names to AUTO-IMPORT (each must be a key
 *    in `importMap`): analyzeCell synthesizes a `const name = await import(url)` prologue for them, forcing
 *    block mode and marking the cell a DOM candidate. The caller (computeEffective) supplies only names that
 *    are neither a local binding nor a sibling export (precedence: local > sibling > ambient). */
export interface AnalyzeOptions {
  cdnBase?: string;
  importMap?: Record<string, string> | null;
  ambient?: string[];
}

export function analyzeCell(source: string, opts?: AnalyzeOptions): CellAnalysis;

/** The default ESM CDN base a bare import specifier maps onto (A2 lib loading), e.g. `https://esm.sh/`. */
export const DEFAULT_CDN_BASE: string;

/** The small, deliberate default import map (A3): the libs a notebook can reference with NO import line,
 *  version-pinned. Keyed by the REFERENCE NAME a cell writes (`d3`, `Plot`) → the ESM URL. A notebook extends
 *  or overrides it via a `type="importmap"` cell. */
export const DEFAULT_IMPORT_MAP: Readonly<Record<string, string>>;

/** Map a NON-relative import specifier to the URL a dynamic `import()` loads. Resolution order: the A3 import
 *  `map` (a `{ specifier → url }` override) first; then a full URL (any scheme, or a protocol-relative `//cdn`)
 *  passes through unchanged; then a bare specifier (`d3`) maps onto `base` (default {@link DEFAULT_CDN_BASE}). */
export function resolveSpecifierUrl(spec: string, base?: string, map?: Record<string, string> | null): string;

/** A markdown cell's analysis: a CellAnalysis (defines/imports always empty) plus whether it carries a live
 *  `${ }` interpolation. False ⇒ pure prose, not scheduled; the card renders the source directly. */
export interface MarkdownAnalysis extends CellAnalysis {
  interpolated: boolean;
}

/** Compile a text/markdown cell into a JS template literal whose evaluated value is the interpolated prose
 *  string (Observable Notebook Kit 2.0 `${expr}`). `count` is the number of real interpolations found. */
export function compileMarkdown(source: string): { templateSource: string; count: number };

/** Analyze a text/markdown cell as a single-expression run (the compiled template literal), reporting its
 *  free-variable `reads` and whether it is interpolated (and so should be scheduled). */
export function analyzeMarkdown(source: string): MarkdownAnalysis;
