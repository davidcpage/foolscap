// server-notebook.ts — the notebook FILE engine: read / normalize / full-fidelity CAS-write a `.ipynb`,
// plus the STRUCTURAL EDIT engine (P2: edit cell source, add/delete/move cells). This is the server-side
// half of editable `.ipynb` cells (docs/ipynb-card.md), the sibling of the kernel output-merge in
// server-kernel.ts — and the two SHARE this module's read/write primitives on purpose, so there is ONE
// full-fidelity CAS-write path and a kernel run and a card source-edit can never clobber each other.
//
// WHY server-side, by cell id (not a whole-file card write-back). The card reads the notebook through the
// codec's RENDER projection (`?notebook=render`), which DROPS whole outputs past a budget on a big notebook
// and injects `metadata.__foolscap`. Writing that projection back verbatim would silently erase real outputs
// (a BUG-2-class loss the elision-marker guard can't catch — a dropped output leaves no marker). So an edit
// is expressed by cell ID and applied HERE to the freshly-read, full-fidelity ON-DISK notebook under an
// optimistic-concurrency CAS with retry — exactly how mergeCellOutputs writes kernel results. The client
// never ships the notebook body; it names the cell and the change.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { transformNotebook } from "./ipynb-codec.js";
import { contentVersion, isStaleWrite } from "./cas-guard.js";
import { safeResolve, fileVersion } from "./server-fs.js";
import { MAX_NOTEBOOK_BYTES } from "./server-http.js";

// A notebook cell + notebook, as the codec / render.js already understand them. `[k: string]: unknown`
// keeps any unknown nbformat fields (they round-trip untouched through the full-fidelity write).
export interface NbCell {
  id?: string;
  cell_type?: string;
  source?: unknown;
  outputs?: unknown;
  execution_count?: unknown;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Notebook {
  cells: NbCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [k: string]: unknown;
}

// An nbformat `source`/`text` value is EITHER a string or an array of line-strings. Join arrays verbatim
// (the lines carry their own newlines); a non-string/array yields "".
export function joinMaybe(v: unknown): string {
  return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
}

// Split an edited cell's source into the nbformat-canonical array-of-lines shape: each line KEEPS its
// trailing "\n" except the last, and a source ending in "\n" does NOT leave a trailing "" element (matching
// Jupyter's own `nbformat` round-trip). "" → [] (an empty cell). This is the ONLY shape we ever stamp on an
// EDITED cell; untouched cells keep whatever shape they had on disk (array or string), so the file stays
// byte-faithful everywhere the edit didn't touch.
export function splitSourceLines(s: string): string[] {
  if (typeof s !== "string" || s === "") return [];
  const parts = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (last && parts[i] === "") break; // a trailing "\n" drops the empty final element
    out.push(last ? parts[i]! : parts[i]! + "\n");
  }
  return out;
}

// A short, collision-resistant nbformat cell id (nbformat 4.5+). Kept ≤ the spec's suggested length.
export function newCellId(): string {
  return crypto.randomBytes(6).toString("hex");
}

// Resolve a root-relative path to a confined absolute `.ipynb` (or null): inside the root, and a `.ipynb`.
export function resolveNotebookPath(rootDir: string, relPath: string): string | null {
  const abs = safeResolve(rootDir, relPath);
  if (!abs) return null;
  if (path.extname(abs).toLowerCase() !== ".ipynb") return null;
  return abs;
}

// Read + parse a notebook, returning it with its current content version (the CAS base), or null on a
// read/parse failure (or a non-notebook JSON).
export function readNotebook(abs: string): { nb: Notebook; version: string | null } | null {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  let nb: Notebook;
  try {
    nb = JSON.parse(text);
  } catch {
    return null;
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) return null;
  return { nb, version: contentVersion(text) };
}

// Serialize a notebook object through the FULL-FIDELITY codec projection — the ONLY sanctioned write path
// (strips the render-only `metadata.__foolscap`, validates shape, never elides). CAS-write with the given
// baseVersion; returns "ok" | "stale" | "error". The small check-then-write race is tolerated (callers
// serialize their own writes; the CAS defends against EXTERNAL concurrent writes — the kernel merge and a
// card edit landing at once).
export function casWriteNotebook(abs: string, nb: Notebook, baseVersion: string | null): "ok" | "stale" | "error" {
  const { content, parsed } = transformNotebook(JSON.stringify(nb), { mode: "full" });
  if (!parsed) return "error";
  if (Buffer.byteLength(content, "utf8") > MAX_NOTEBOOK_BYTES) return "error";
  if (isStaleWrite(baseVersion, fileVersion(abs))) return "stale";
  try {
    fs.writeFileSync(abs, content, "utf8");
    return "ok";
  } catch {
    return "error";
  }
}

// The content version a full-fidelity write of `nb` would produce (so a caller can chain without a re-read).
function fullVersion(nb: Notebook): string | null {
  return contentVersion(transformNotebook(JSON.stringify(nb), { mode: "full" }).content);
}

// Ensure every cell carries a UNIQUE nbformat id (4.5+). Older notebooks (incl. the demo) omit them, but
// both write-back paths key on cell id — so we normalize once and persist. Returns the (id-bearing) notebook
// + current version, or null on a read/parse failure. Persists via CAS; a lost race just means someone else
// beat us — loop and re-read.
export function ensureCellIds(abs: string): { nb: Notebook; version: string | null } | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = readNotebook(abs);
    if (!read) return null;
    const { nb, version } = read;
    let changed = false;
    const seen = new Set<string>();
    for (const cell of nb.cells) {
      if (!cell.id || seen.has(cell.id)) {
        cell.id = newCellId();
        changed = true;
      }
      seen.add(cell.id);
    }
    if (!changed) return read;
    const r = casWriteNotebook(abs, nb, version);
    if (r === "ok") return { nb, version: fullVersion(nb) };
    if (r === "error") return null;
    // stale → an external write landed; loop and re-read.
  }
  return readNotebook(abs); // give up normalizing under contention; serve what's there
}

// ── the STRUCTURAL EDIT engine (P2) ───────────────────────────────────────────────────────────────────

// One structural edit, keyed by cell id (never index — a concurrent write must not clobber a shifted cell).
export type NotebookEdit =
  | { type: "editSource"; cellId: string; source: string }
  | { type: "addCell"; cellType: "code" | "markdown"; afterCellId?: string; index?: number; source?: string }
  | { type: "deleteCell"; cellId: string }
  | { type: "moveCell"; cellId: string; dir: "up" | "down" };

export interface NotebookEditResult {
  ok: boolean;
  writeback?: "ok" | "stale" | "error" | "stale-cell";
  cellId?: string;
  version?: string | null;
  error?: string;
}

// A fresh nbformat-4.5 cell of the given type, opened empty (or with `source`). A code cell carries the
// empty `outputs`/`execution_count` a never-run cell has; a markdown cell carries neither (nbformat omits
// them for non-code cells).
function makeCell(cellType: "code" | "markdown", source: string): NbCell {
  const cell: NbCell = { id: newCellId(), cell_type: cellType, metadata: {}, source: splitSourceLines(source) };
  if (cellType === "code") {
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

// Apply ONE edit to a notebook object in place. Returns { status, cellId } — status is "ok" | "stale-cell"
// (the target id vanished since the card read it — a concurrent delete) | "error" (a malformed op); cellId is
// the AFFECTED cell (the edited/added/moved cell — for addCell, the freshly-minted id the card auto-opens).
// Pure w.r.t. the filesystem — the caller owns the read/CAS-write loop.
function applyEdit(nb: Notebook, op: NotebookEdit): { status: "ok" | "stale-cell" | "error"; cellId?: string } {
  const cells = nb.cells;
  switch (op.type) {
    case "editSource": {
      const cell = cells.find((c) => c.id === op.cellId);
      if (!cell) return { status: "stale-cell" };
      // Jupyter convention: editing SOURCE does not clear outputs / execution_count (running does). We touch
      // ONLY the source, normalized to the array-of-lines shape; every other field is left byte-faithful.
      cell.source = splitSourceLines(op.source);
      return { status: "ok", cellId: op.cellId };
    }
    case "addCell": {
      const cell = makeCell(op.cellType, op.source ?? "");
      let at: number;
      if (op.afterCellId != null) {
        const i = cells.findIndex((c) => c.id === op.afterCellId);
        if (i < 0) return { status: "stale-cell" };
        at = i + 1;
      } else if (typeof op.index === "number") {
        at = Math.max(0, Math.min(op.index, cells.length));
      } else {
        at = cells.length; // no anchor → append
      }
      cells.splice(at, 0, cell);
      return { status: "ok", cellId: cell.id };
    }
    case "deleteCell": {
      const i = cells.findIndex((c) => c.id === op.cellId);
      if (i < 0) return { status: "stale-cell" };
      cells.splice(i, 1);
      return { status: "ok", cellId: op.cellId };
    }
    case "moveCell": {
      const i = cells.findIndex((c) => c.id === op.cellId);
      if (i < 0) return { status: "stale-cell" };
      const j = op.dir === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < cells.length) {
        const [moved] = cells.splice(i, 1);
        cells.splice(j, 0, moved!);
      } // else already at the edge — a no-op, not an error
      return { status: "ok", cellId: op.cellId };
    }
    default:
      return { status: "error" };
  }
}

// Validate a raw op payload into a typed NotebookEdit, or null if malformed. Kept beside applyEdit so the
// route stays a thin transport shell.
export function parseEdit(raw: unknown): NotebookEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "editSource":
      if (typeof o.cellId === "string" && typeof o.source === "string")
        return { type: "editSource", cellId: o.cellId, source: o.source };
      return null;
    case "addCell": {
      if (o.cellType !== "code" && o.cellType !== "markdown") return null;
      const op: NotebookEdit = { type: "addCell", cellType: o.cellType };
      if (typeof o.afterCellId === "string") op.afterCellId = o.afterCellId;
      if (typeof o.index === "number") op.index = o.index;
      if (typeof o.source === "string") op.source = o.source;
      return op;
    }
    case "deleteCell":
      return typeof o.cellId === "string" ? { type: "deleteCell", cellId: o.cellId } : null;
    case "moveCell":
      if (typeof o.cellId === "string" && (o.dir === "up" || o.dir === "down"))
        return { type: "moveCell", cellId: o.cellId, dir: o.dir };
      return null;
    default:
      return null;
  }
}

// Apply a structural edit to the on-disk notebook under CAS, retrying on a stale conflict (re-read +
// re-apply on the fresh bytes — the op is by cell id, so re-applying is correct). Normalizes cell ids first
// so an older notebook is editable, and so `addCell`'s neighbours are addressable. Returns the outcome.
export function editNotebook(rootDir: string, relPath: string, op: NotebookEdit): NotebookEditResult {
  const abs = resolveNotebookPath(rootDir, relPath);
  if (!abs) return { ok: false, error: "notebook not found" };
  const norm = ensureCellIds(abs); // also confirms the file reads/parses
  if (!norm) return { ok: false, error: "could not read notebook" };
  for (let attempt = 0; attempt < 6; attempt++) {
    const read = readNotebook(abs);
    if (!read) return { ok: false, error: "could not read notebook" };
    const { nb, version } = read;
    const applied = applyEdit(nb, op);
    if (applied.status === "error") return { ok: false, error: "bad edit op" };
    if (applied.status === "stale-cell") return { ok: false, writeback: "stale-cell", error: "cell not found" };
    const r = casWriteNotebook(abs, nb, version);
    if (r === "ok") return { ok: true, writeback: "ok", cellId: applied.cellId, version: fullVersion(nb) };
    if (r === "error") return { ok: false, writeback: "error", error: "write failed" };
    // stale → a concurrent write (a kernel merge, an external edit) landed; loop and re-apply on fresh bytes.
  }
  return { ok: false, writeback: "stale", error: "write contended" };
}
