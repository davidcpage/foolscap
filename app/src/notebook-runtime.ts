import type { Subscribable } from "./lib";
import { fileContentSignal } from "./content";
import { activeBoardId } from "./board";
import { analyzeCell, analyzeMarkdown, DEFAULT_IMPORT_MAP, unresolvableFreeVars } from "../vendor/notebook-infer.js";
import { runMainThreadCell, isNode, serializeView, cloneSafe } from "./notebook-main-exec.js";

// The notebook RUNTIME (docs/notebook-card.md §3/§5/§6) — an app subsystem, NOT the card template
// (templates stay pure render, §2/§6). This is the ONLY place a Worker is created. It is the reactive
// SCHEDULER: it owns the per-card dependency DAG (built from each cell's explicit `data-in`/`data-out`
// declarations — §5 "explicit first"), the off-log export atoms (a value per exported name), topological
// dirty-tracking, the per-cell `auto | manual | debounced` execution policy (§6), and supersede-based
// cancellation. The template FEEDS it the parsed cells (`syncCells`) and READS the per-cell outputs
// (`cellOutputs`); everything reactive happens here.
//
// Separation of tracking from triggering (§1/§6): the graph is always live and cheap to maintain;
// *running* a cell is the opt-in cost, governed per cell by its policy. Nothing here touches the durable
// intent log — outputs are derived/off-log, recomputed, exactly like content.ts's fileContentSignal.

export type Policy = { kind: "auto" | "manual" | "debounced"; ms: number };

// A function export can't be structured-cloned, so it travels as a SOURCE descriptor (built by cloneSafe in
// notebook-worker.js) that the consumer worker rebuilds into a callable. The runtime carries it through
// exportsVal like any other value; it attaches the `closure` snapshot (see snapshotClosure) and renders the
// descriptor as its source string wherever a cell value is displayed or relayed.
interface FnDescriptor {
  __fn__: true;
  source: string;
  closure?: Record<string, unknown>;
}
function isFnDescriptor(v: unknown): v is FnDescriptor {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { __fn__?: unknown }).__fn__ === true &&
    typeof (v as { source?: unknown }).source === "string"
  );
}

// One declared import (the `data-in` grammar, §11.2). `path` null = a LOCAL sibling-cell export named
// `name` (the step-1 form). `path` set = a cross-card import resolved against THIS notebook's directory:
// a notebook (object of its exports, or one export when `export` is set) or a data file (its text). The
// runtime decides notebook-vs-file at resolve time (it knows which cards are open); the parser only splits.
export interface CellImport {
  name: string; // the local variable the value binds to inside the cell
  path: string | null; // relative path to another notebook/file, or null for a local export
  export: string | null; // a single export name to pull (the `#export` form), else null
}

// What the template hands in per cell (already parsed from the `.html` by the vendored format parser).
export interface CellSpec {
  id: string;
  type: string; // only "module" cells execute; prose cells (text/markdown, …) are ignored by the scheduler
  source: string;
  inNames: string[]; // local binding names (= imports.map(name)); kept for display + the spec signature
  imports?: CellImport[]; // structured imports (step-2); absent → treat inNames as all-local (step-1)
  outNames: string[]; // declared exports (data-out)
  policy: string; // raw data-policy: "" | "auto" | "manual" | "debounced" | "debounced:300"
  // ── filled by the runtime from acorn inference (step-4a/4b), not the template ──
  runSource?: string; // the code the worker runs (RHS of a `name = …` define / a rewritten block / === source)
  block?: boolean; // runSource is a statement BLOCK (step-4b) — the worker runs it as a body, not an expression
  keyedExports?: boolean; // the block returns an object keyed by define names → map keys→exports even for one
  suppress?: boolean; // the cell's final statement ended in `;` — run normally but DISPLAY no value (Jupyter `;`)
  domCandidate?: boolean; // may build a DOM node → run on the MAIN-THREAD realm, not the worker (B2, step-4)
  reExports?: string[]; // local names this cell republishes from its cross-card imports (Observable's import-cell)
  inferredIn?: boolean; // imports were inferred from the code (no explicit data-in present)
  inferredOut?: boolean; // outNames were inferred from a `name = …` define (no explicit data-out present)
}

// Normalise a cell's imports: the structured form if present, else every inName as a local export (the
// step-1 shape, so a spec built the old way still works).
function importsOf(spec: CellSpec): CellImport[] {
  return spec.imports ?? spec.inNames.map((name) => ({ name, path: null, export: null }));
}

// Which cells the scheduler runs: every `module` cell, PLUS a prose cell (text/markdown / text/html) that
// carries a `${ }` interpolation (Observable Notebook Kit 2.0's reactive markdown — docs/notebook-card.md §8).
// The `${`-regex is a cheap gate so a plain prose cell never reaches acorn; analyzeMarkdown (in
// computeEffective) is the precise decision (a literal `${` in prose that isn't a real interpolation is
// dropped back to content there).
const PROSE_TYPES = new Set(["text/markdown", "text/html"]);
function isScheduled(c: CellSpec): boolean {
  return c.type === "module" || (PROSE_TYPES.has(c.type) && c.source.includes("${"));
}

// The per-cell view the card renders: the last run's RESULT plus the live scheduling flags.
export interface CellOutput {
  status?: "ok" | "error"; // the last completed run's kind (absent = never run)
  value?: unknown; // the value (already structured-clone-safe), for an "ok" run
  // A DOM/SVG output (Phase-2 B2): a cell that ran on the main-thread realm and returned a live DOM node (an
  // Observable Plot chart, a d3 selection). The `node` is LIVE and in-browser only — the template mounts it
  // directly (lit-html renders a raw Node child); it is NEVER serialized. `markup` is the node's outerHTML,
  // the SERIALIZABLE form that rides the outputs relay so an agent still sees the chart (§7 agent-legibility).
  view?: { kind: "svg" | "html" | "dom"; node?: unknown; markup: string };
  error?: string; // the error string, for an "error" run
  running?: boolean; // a run is queued or in flight
  stale?: boolean; // inputs changed since the last run; awaiting a trigger (manual click / debounce timer)
  needsConsent?: boolean; // a main-thread (domCandidate) cell parked UNRUN because the notebook lacks main-realm
  // consent (Fix A trust boundary) — the card shows a one-time "allow page access" affordance; granting re-runs it
  suppressed?: boolean; // the cell ran fine but its final statement ended in `;` → the pane shows no value
  // Inferred wiring (step-4a/4b) for the card to DISPLAY as a muted hint where no explicit declaration was
  // written — so a cell that auto-wired by its code shows what it reads/defines, not an empty box.
  inReads?: string[]; // LOCAL reads inferred from free variables (only when data-in was absent)
  inImports?: CellImport[]; // CROSS-card imports inferred from `import` statements (step-4b; data-in absent)
  inDefines?: string[]; // exports inferred from a `name = …` define (only when data-out was absent)
}

type RunState = "idle" | "queued" | "running" | "stale";

interface NB {
  sig: string; // signature of the last synced spec set — a no-op sync (re-render) is detected and ignored
  root: string; // the card's worktree root, parsed from its node id (node:<root>:<path>)
  dir: string; // the card's directory, the base for resolving a relative import path
  pathKey: string; // this notebook's canonical path key (root + normalised, .html-stripped) — its address
  specs: Map<string, CellSpec>; // module cells only, by id
  producers: Map<string, string>; // export name → the cell id that defines it
  importByName: Map<string, Set<string>>; // export name → cell ids that import it (LOCAL only)
  depsOf: Map<string, Set<string>>; // cell id → the producer cell ids it depends on (LOCAL only)
  cyclic: Set<string>; // cells in a dependency cycle — marked error, never scheduled
  exportsVal: Map<string, unknown>; // export name → current value (the off-log atom)
  state: Map<string, RunState>;
  job: Map<string, number>; // cell id → its current jobId, so a superseded run's reply is ignored
  timer: Map<string, ReturnType<typeof setTimeout>>; // debounce timers, by cell id
  mainRealmAllowed: boolean; // the notebook carries `data-main-realm="allow"` — its domCandidate cells may run
  // on the MAIN THREAD (full page authority; can hang the UI). False → those cells are gated unrun (Fix A).
}

const nbs = new Map<string, NB>();

// ── cross-card wiring (step-2, docs/notebook-card.md §11.2) ────────────────────────────────────────
// Imports address other cards by RELATIVE PATH (a notebook IS a file, §4 — the filesystem is the
// namespace), so resolution is board-wide, not per-NB. Three registries make a cell in card A re-run when
// the notebook/file it imports from changes:
//
//   • nbByPath   — every OPEN notebook card's address → its cardKey, so an import path resolves to a live NB.
//   • pathImporters — a target address → the importer cells waiting on it (with an optional export filter),
//                     so when a producer's export changes (applyExports) we re-dirty exactly its importers,
//                     and when a notebook first OPENS at an address we re-dirty the cells that were waiting.
//   • extState   — per importer cell, the external subscriptions currently held (file-content handles +
//                  the pathImporters entries), so a re-sync can reconcile them: subscribe new, drop gone.
const nbByPath = new Map<string, string>(); // pathKey → cardKey

interface Importer {
  cardKey: string;
  cellId: string;
  export: string | null; // null = an OBJECT import (re-dirty on ANY export change of the target)
}
const pathImporters = new Map<string, Map<string, Importer>>(); // pathKey → refKey → importer

interface CellExt {
  nb: Set<string>; // pathImporters refKeys this cell registered (so a re-sync can unregister gone ones)
  files: Map<string, () => void>; // fileKey → unsubscribe handle for a data-file import
}
const extState = new Map<string, Map<string, CellExt>>(); // cardKey → cellId → its external subscriptions

// ── path helpers ──────────────────────────────────────────────────────────────────────────────────
// A cardKey is the node id `node:<root>:<path>`; root is colon-free, so the first two colons bound it.
function parseCardKey(cardKey: string): { root: string; path: string } {
  const m = /^node:([^:]+):(.*)$/.exec(cardKey);
  return m ? { root: m[1]!, path: m[2]! } : { root: "repo", path: "" };
}
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}
// Resolve a relative import path against the importing notebook's directory, collapsing `.`/`..`. A
// leading "/" is root-absolute (within the same worktree root). The filesystem is the import namespace.
function resolvePath(dir: string, rel: string): string {
  const base = rel.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return base.join("/");
}
const stripHtml = (p: string): string => p.replace(/\.html$/i, "");
const pathKeyOf = (root: string, normPath: string): string => root + " " + normPath;
const refKeyOf = (cardKey: string, cellId: string, exp: string | null): string =>
  cardKey + " " + cellId + " " + (exp ?? "*");
const fileKeyOf = (root: string, path: string): string => root + " " + path;

// ── the off-log per-card output projection (cellOutputs) ──────────────────────────────────────────
const EMPTY: Record<string, CellOutput> = {};
const outputs = new Map<string, Record<string, CellOutput>>();
const subs = new Map<string, Set<() => void>>();
const signals = new Map<string, Subscribable<Record<string, CellOutput>>>();

function notify(cardKey: string): void {
  for (const fn of subs.get(cardKey) ?? []) fn();
  scheduleOutputsPush(cardKey); // §7 agent-legibility: relay the new outputs to the server (debounced)
}

// Merge a patch into one cell's output and publish a NEW map reference (the read-tracker bails out on
// Object.is, like the registry snapshot), so the card re-renders.
function patchOutput(cardKey: string, cellId: string, patch: Partial<CellOutput>): void {
  const cur = outputs.get(cardKey) ?? EMPTY;
  outputs.set(cardKey, { ...cur, [cellId]: { ...cur[cellId], ...patch } });
  notify(cardKey);
}

function dropOutput(cardKey: string, cellId: string): void {
  const cur = outputs.get(cardKey);
  if (!cur || !(cellId in cur)) return;
  const next = { ...cur };
  delete next[cellId];
  outputs.set(cardKey, next);
  notify(cardKey);
}

// Channel-1 handle for one notebook card's cell outputs, keyed by the card's node id — the SAME
// Subscribable<T> seam fileContentSignal exposes, so the card subscribes to its outputs as it would to any
// signal, and a finished run re-renders just this card.
export function cellOutputsSignal(cardKey: string): Subscribable<Record<string, CellOutput>> {
  let s = signals.get(cardKey);
  if (!s) {
    s = {
      get: () => outputs.get(cardKey) ?? EMPTY,
      subscribe(onChange) {
        let set = subs.get(cardKey);
        if (!set) subs.set(cardKey, (set = new Set()));
        set.add(onChange);
        return () => set!.delete(onChange);
      },
    };
    signals.set(cardKey, s);
  }
  return s;
}

// ── agent-legibility: relay outputs to the server (docs/notebook-card.md §7, step-3) ───────────────
// A notebook card's cell outputs are off-log atoms living HERE in the browser — absent from the file tree
// and the /api/canvas snapshot, so an agent that reads the source with `Read` still can't see what a cell
// PRODUCED. We mirror the agentBus snapshot push: on every output change (the notify above), debounce, then
// POST an agent-friendly blob to /api/notebook/<id>/outputs, where the server holds it as a dumb relay (it
// has data only WHILE A TAB IS LIVE — the deliberate step-3 scope; a durable/diffable artefact is the
// step-4 memo-cache/shadow store). Values are bounded HERE, at the one serialization point (CLAUDE.md): a
// pathological cell value is clamped to MAX_VALUE_CHARS with a per-value `truncated` flag, keeping the blob
// valid JSON (a snapshot, not an append-only log — so no tail-trimming).
const MAX_VALUE_CHARS = 64 * 1024;
const PUSH_DEBOUNCE_MS = 400;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Render one value for the blob: keep the native (JSON-ish, already clone-safe) value when small so an
// agent gets real structure; clamp to a string prefix + `truncated` when it would blow the cap.
function clampValue(v: unknown): { value: unknown; truncated?: boolean } {
  if (isFnDescriptor(v)) v = v.source; // a function export relays as its source string, not [object Object]
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s == null) s = String(v); // JSON.stringify(undefined) → undefined
  if (s.length > MAX_VALUE_CHARS) return { value: s.slice(0, MAX_VALUE_CHARS), truncated: true };
  return { value: v };
}

function buildOutputsBlob(cardKey: string): string {
  const nb = nbs.get(cardKey);
  const out = outputs.get(cardKey) ?? EMPTY;
  const cells = Object.entries(out).map(([id, o]) => {
    const cell: Record<string, unknown> = { id, status: o.status, running: !!o.running, stale: !!o.stale };
    if (o.status === "error") cell.error = o.error;
    else if (o.suppressed) cell.suppressed = true; // output suppressed by a trailing `;` — no value to relay
    else if (o.status === "ok" && o.view) {
      // A DOM/SVG output (B2): the live node is browser-only, but its markup IS serializable — relay it so an
      // agent reading the outputs sees the chart's SVG/HTML. Bounded by the same clampValue cap as any value.
      const c = clampValue(o.view.markup);
      cell.view = { kind: o.view.kind, html: c.value };
      if (c.truncated) cell.truncated = true;
    } else if (o.status === "ok") {
      const c = clampValue(o.value);
      cell.value = c.value;
      if (c.truncated) cell.truncated = true;
    }
    return cell;
  });
  // The headline "what did this notebook produce": each export name → its current value (same clamp).
  const exportsObj: Record<string, unknown> = {};
  if (nb) for (const [name, val] of nb.exportsVal) exportsObj[name] = clampValue(val).value;
  const { root, path } = parseCardKey(cardKey);
  return JSON.stringify({ ts: Date.now(), root, path, cells, exports: exportsObj });
}

function scheduleOutputsPush(cardKey: string): void {
  if (typeof fetch === "undefined") return; // headless harness (no DOM/network) — nothing to relay to
  if (pushTimers.has(cardKey)) return; // a push is already pending; it will capture the latest state
  pushTimers.set(
    cardKey,
    setTimeout(() => {
      pushTimers.delete(cardKey);
      try {
        const board = activeBoardId();
        void fetch(`/api/notebook/${encodeURIComponent(cardKey)}/outputs?board=${board}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: buildOutputsBlob(cardKey),
        }).catch(() => {}); // server gone (dev restart) — the next output change re-pushes
      } catch {
        /* board/fetch unavailable — outputs stay browser-local, the safe direction */
      }
    }, PUSH_DEBOUNCE_MS),
  );
}

// ── the worker (a single shared, stateless worker) ────────────────────────────────────────────────
// SINGLE-WORKER INVARIANT, with ONE deliberate exception (Phase-2 B2). Pure-compute cells run here, on the
// one shared, DOM-less worker. A DOM-PRODUCING cell (spec.domCandidate) instead runs on the MAIN-THREAD realm
// (notebook-main-exec.js), because Plot/d3 need a real document + the real layout engine that a worker lacks.
// The main-thread realm re-establishes statelessness identically (scoped new Function, inputs as params), so
// the exception is about WHERE a cell runs, not a relaxation of the stateless/DAG-only-dataflow model.
let worker: Worker | null = null;
let nextJob = 0;
const pending = new Map<number, { cardKey: string; cellId: string }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker("/notebook-worker.js", { type: "module" });
  w.onmessage = (e: MessageEvent) => {
    const { jobId, ok, value, error } = e.data ?? {};
    const job = pending.get(jobId);
    if (!job) return;
    pending.delete(jobId);
    onReply(job.cardKey, job.cellId, jobId, ok, value, error);
  };
  w.onerror = () => {
    // A worker-level crash fails every in-flight job (rather than leaving cells stuck "running") and drops
    // the worker so the next run respawns a clean one.
    for (const job of pending.values()) {
      setState(job.cardKey, job.cellId, "idle");
      patchOutput(job.cardKey, job.cellId, { running: false, status: "error", error: "worker crashed" });
    }
    pending.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

// ── policy + value helpers ────────────────────────────────────────────────────────────────────────
const DEFAULT_DEBOUNCE = 400;
// The MAIN-THREAD realm's async time budget (Fix A, thread node:mrdj7o3s-9). A domCandidate cell runs on the UI
// thread; a never-settling await or a cooperative-yield loop would otherwise leave the cell stuck "running"
// forever. After this budget the run is ABANDONED and the cell surfaces a "time budget exceeded" error. HONEST
// LIMIT: this catches only ASYNC overruns — a purely SYNCHRONOUS infinite loop cannot be preempted from the
// thread it runs on, which is exactly why the CONSENT GATE (not this budget) is the primary guard against a hang.
// Generous on purpose (the repo's err-large caps ethos): it exists to unstick a wedged cell, not to police speed.
const MAIN_THREAD_BUDGET_MS = 10_000;
function parsePolicy(raw: string): Policy {
  const [kind, ms] = (raw || "auto").trim().split(":");
  if (kind === "manual") return { kind: "manual", ms: 0 };
  if (kind === "debounced") return { kind: "debounced", ms: Number(ms) > 0 ? Number(ms) : DEFAULT_DEBOUNCE };
  return { kind: "auto", ms: 0 };
}

// Cheap structural equality so an upstream that recomputes the SAME value doesn't needlessly cascade
// (worker results are clone-safe — primitives or JSON-ish — so JSON compare is sound and bounded).
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function setState(cardKey: string, cellId: string, s: RunState): void {
  nbs.get(cardKey)?.state.set(cellId, s);
}
function stateOf(nb: NB, cellId: string): RunState {
  return nb.state.get(cellId) ?? "idle";
}

// ── graph build (DAG from declared in/out, with cycle detection) ──────────────────────────────────
function buildGraph(nb: NB): void {
  nb.producers = new Map();
  nb.importByName = new Map();
  nb.depsOf = new Map();
  nb.cyclic = new Set();
  // A cell produces its computed exports AND the names it re-exports from cross-card imports (step-4b), so a
  // sibling reading an imported name wires to the importing cell.
  for (const c of nb.specs.values()) {
    for (const name of c.outNames) nb.producers.set(name, c.id);
    for (const name of c.reExports ?? []) nb.producers.set(name, c.id);
  }
  for (const c of nb.specs.values()) {
    const deps = new Set<string>();
    // Only LOCAL imports (no path) form intra-card DAG edges + the topological order; cross-card imports
    // (path set) are wired separately (wireExternal) and re-dirty eventually, like a file change.
    for (const imp of importsOf(c)) {
      if (imp.path) continue;
      const name = imp.name;
      let set = nb.importByName.get(name);
      if (!set) nb.importByName.set(name, (set = new Set()));
      set.add(c.id);
      const p = nb.producers.get(name);
      if (p && p !== c.id) deps.add(p);
    }
    nb.depsOf.set(c.id, deps);
  }
  // Kahn's algorithm: peel cells whose deps are all resolved; whatever never peels is in a cycle.
  const indeg = new Map<string, number>();
  for (const [id, deps] of nb.depsOf) indeg.set(id, deps.size);
  const queue = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  const dependentsOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const c = nb.specs.get(id);
    if (c)
      for (const name of [...c.outNames, ...(c.reExports ?? [])])
        for (const dep of nb.importByName.get(name) ?? []) out.add(dep);
    return out;
  };
  let peeled = 0;
  while (queue.length) {
    const id = queue.shift()!;
    peeled++;
    for (const d of dependentsOf(id)) {
      indeg.set(d, (indeg.get(d) ?? 0) - 1);
      if (indeg.get(d) === 0) queue.push(d);
    }
  }
  if (peeled < nb.specs.size) {
    for (const [id, n] of indeg) if (n > 0) nb.cyclic.add(id);
  }
}

// ── inference: derive the intra-notebook DAG from the CODE (step-4a, docs/notebook-card.md §11.4a) ──
// The template hands in the RAW parsed cells (their explicit data-in/data-out, if any). Here we fold in
// acorn free-variable inference so a cell wires itself: `y = x * 2` defines `y` and reads `x` with no
// declarations. Explicit declarations are an OVERRIDE — when a cell carries data-in / data-out we keep it
// verbatim; only an ABSENT declaration is filled from inference. Cross-card imports (a `path` set) are
// always explicit (the step-2 attribute), so a cell with only cross-card imports still gets its LOCAL reads
// inferred. The result is the EFFECTIVE spec set the rest of the runtime (graph, exports, worker) uses.
function computeEffective(modules: CellSpec[], importMap: Record<string, string>): CellSpec[] {
  // Pass 1: per-cell analysis + everything the notebook PRODUCES, which a sibling's reads can match: the
  // effective EXPORT names (explicit data-out or inferred defines) AND the RE-EXPORTS — the local names a
  // cross-card `import {y} from "./nb"` republishes as notebook-local exports (Observable's import-cell, so
  // other cells can read `y`). A cross-card import is one with a `path` (from an `import` statement or the
  // explicit data-in grammar); its binding name becomes a producer of this notebook.
  const analysis = new Map<string, ReturnType<typeof analyzeCell>>();
  const effOut = new Map<string, string[]>();
  const reExp = new Map<string, string[]>();
  const scheduled: CellSpec[] = []; // the cells that actually run (module cells + interpolated markdown)
  for (const c of modules) {
    // A markdown/html cell is COMPILED to a template literal (analyzeMarkdown) and runs like a single-
    // expression cell; a `module` cell is analyzed as code. A prose cell with no live `${ }` interpolation is
    // pure content — drop it from the graph entirely (no worker run, no output); the card renders its source.
    // Thread the import map into analyzeCell so an EXPLICIT bare import (`import * as d3 from "d3"`) pins to
    // the notebook's URL for that lib (A3, Phase 1). Ambient auto-import (Phase 2) is decided below, once the
    // notebook's full set of produced names is known (precedence: a sibling export wins over an ambient lib).
    const a = c.type === "module" ? analyzeCell(c.source, { importMap }) : analyzeMarkdown(c.source);
    if (c.type !== "module" && !("interpolated" in a && (a as { interpolated?: boolean }).interpolated)) continue;
    analysis.set(c.id, a);
    effOut.set(c.id, c.outNames.length ? c.outNames : a.defines);
    const explicitIn = importsOf(c);
    const crossImports = explicitIn.length ? explicitIn.filter((i) => i.path) : a.imports;
    reExp.set(c.id, crossImports.map((i) => i.name));
    scheduled.push(c);
  }
  const produced = new Set<string>();
  for (const names of effOut.values()) for (const n of names) produced.add(n);
  for (const names of reExp.values()) for (const n of names) produced.add(n);
  // Pass 2: effective imports. With no explicit data-in, the imports come from the CODE: inferred LOCAL reads
  // (a free var some sibling produces or re-exports — free globals like Math/Array match nothing and are
  // dropped) PLUS the cross-notebook `import` statements acorn found (step-4b, already in {name,path,export}
  // shape). An explicit data-in wins outright (the override). Either way `runSource`/`block` come from
  // inference — the worker always runs the import-stripped body, since it can't execute `import`.
  return scheduled.map((c) => {
    let a = analysis.get(c.id)!;
    // PARSE-TIME REFERENCE RESOLUTION (A3, Phase 2, module cells only): a free read that is NOT produced by a
    // sibling and IS a known lib (in the import map) is AUTO-IMPORTED — re-analyze the cell so analyzeCell
    // synthesizes the `const name = await import(url)` prologue (and routes it to the main-thread realm). This
    // enforces the precedence local > sibling > ambient: `reads` already excludes local bindings, and filtering
    // out `produced` lets a sibling cell exporting `d3` shadow the ambient lib (never shadowing user data).
    if (c.type === "module") {
      const ambient = a.reads.filter((n) => !produced.has(n) && typeof importMap[n] === "string");
      if (ambient.length) a = analyzeCell(c.source, { importMap, ambient });
    }
    const hasExplicitIn = importsOf(c).length > 0;
    const inferredIn = !hasExplicitIn;
    const inferredLocal: CellImport[] = a.reads.filter((n) => produced.has(n)).map((name) => ({ name, path: null, export: null }));
    const imports = hasExplicitIn ? importsOf(c) : [...inferredLocal, ...a.imports];
    return {
      ...c,
      imports,
      inNames: imports.map((i) => i.name),
      outNames: effOut.get(c.id)!,
      reExports: reExp.get(c.id)!,
      runSource: a.valueSource,
      block: a.block,
      keyedExports: a.keyedExports,
      suppress: a.suppress,
      domCandidate: a.domCandidate, // route DOM-producing cells to the main-thread realm (startRun)
      inferredIn,
      inferredOut: c.outNames.length === 0,
    };
  });
}

// The notebook's effective import map (A3): the small built-in defaults (d3/Plot, version-pinned) overlaid
// with any `type="importmap"` cell's JSON — a flat `{ name: url }` table (a `{ imports: {…} }` wrapper is also
// accepted). Later cells win; malformed JSON / non-string values are ignored (best-effort — never throw,
// matching the format parser's posture). Keys are REFERENCE NAMES (the identifier a cell writes: `d3`, `Plot`)
// → the ESM URL to import, used for BOTH explicit-import pinning and ambient auto-import.
function extractImportMap(rawCells: CellSpec[]): Record<string, string> {
  const map: Record<string, string> = { ...DEFAULT_IMPORT_MAP };
  for (const c of rawCells) {
    if (c.type !== "importmap") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(c.source);
    } catch {
      continue; // a half-typed / invalid map — keep the last-good map, never throw
    }
    if (!obj || typeof obj !== "object") continue;
    const wrapped = (obj as { imports?: unknown }).imports;
    const table = wrapped && typeof wrapped === "object" ? (wrapped as Record<string, unknown>) : (obj as Record<string, unknown>);
    for (const [k, v] of Object.entries(table)) if (typeof v === "string") map[k] = v;
  }
  return map;
}

// ── sync: the template feeds the parsed cells in; we diff and (re)schedule ────────────────────────
export function syncCells(cardKey: string, rawCells: CellSpec[], opts?: { mainRealmAllowed?: boolean }): void {
  // MAIN-REALM CONSENT (Fix A): whether this notebook carries `data-main-realm="allow"`. It's in the signature
  // below so TOGGLING consent re-syncs and re-dirties the gated domCandidate cells (granting makes them run,
  // revoking parks them again) — otherwise a consent change alone (source unchanged) would be gated out as a
  // no-op re-render.
  const mainRealmAllowed = !!(opts && opts.mainRealmAllowed);
  const importMap = extractImportMap(rawCells); // A3: defaults + any type="importmap" cell (before scheduling)
  const rawScheduled = rawCells.filter(isScheduled); // module cells + interpolated markdown cells
  // The signature is over the RAW cells the template parsed — what the user actually wrote (type + source +
  // explicit data-in/data-out/policy) — PLUS the import map (an importmap-cell edit changes resolution but not
  // any scheduled cell, so it must be in the signature or the change would be gated out). Inference is a pure
  // function of these, so an unchanged signature means an unchanged EFFECTIVE graph: gate on it FIRST, so a
  // mere re-render (an output change) never re-parses every cell with acorn — only a real source/wiring/map
  // edit pays for computeEffective. `type` is in the signature so a markdown↔module conversion still re-syncs.
  const sig = JSON.stringify([importMap, mainRealmAllowed, rawScheduled.map((c) => [c.id, c.type, c.source, importsOf(c), c.outNames, c.policy])]);
  let nb = nbs.get(cardKey);
  if (nb && nb.sig === sig) return; // a pure re-render (outputs changed) — same graph, nothing to do

  // The graph actually changed → fold in acorn inference to get the EFFECTIVE specs (inferred reads/defines
  // where no explicit declaration was written) that the rest of the runtime schedules and runs.
  const modules = computeEffective(rawScheduled, importMap);

  const prev = nb;
  const prevSpecs = prev?.specs ?? new Map<string, CellSpec>();
  const prevDeps = prev?.depsOf ?? new Map<string, Set<string>>();
  const { root, path } = parseCardKey(cardKey);
  const pathKey = pathKeyOf(root, stripHtml(path));
  nb = {
    sig,
    root,
    dir: dirOf(path),
    pathKey,
    specs: new Map(modules.map((c) => [c.id, c])),
    producers: new Map(),
    importByName: new Map(),
    depsOf: new Map(),
    cyclic: new Set(),
    exportsVal: prev?.exportsVal ?? new Map(),
    state: prev?.state ?? new Map(),
    job: prev?.job ?? new Map(),
    timer: prev?.timer ?? new Map(),
    mainRealmAllowed,
  };
  nbs.set(cardKey, nb);
  // Publish this notebook's address so other cards' imports resolve to it. New address (first sync / a
  // moved card) → re-dirty the cells that were waiting on this path, so they pick up its exports.
  const firstAtPath = nbByPath.get(pathKey) !== cardKey;
  nbByPath.set(pathKey, cardKey);
  buildGraph(nb);

  // Removed cells: drop their view + scheduling state, and the exports they alone produced (their importers
  // then see `undefined` and re-run — never a silently-stale value, the project's "where did it go?" rule).
  for (const id of prevSpecs.keys()) {
    if (nb.specs.has(id)) continue;
    const t = nb.timer.get(id);
    if (t) clearTimeout(t);
    nb.timer.delete(id);
    nb.state.delete(id);
    nb.job.delete(id);
    tearDownExt(cardKey, id); // drop the removed cell's cross-card subscriptions
    dropOutput(cardKey, id);
  }
  for (const name of [...nb.exportsVal.keys()]) {
    if (!nb.producers.has(name)) {
      nb.exportsVal.delete(name);
      for (const importer of nb.importByName.get(name) ?? []) markDirty(cardKey, importer);
      // A vanished export must also wake cross-card importers (they'd otherwise hold a stale value) —
      // both those naming it and object-importers of this notebook.
      for (const imp of pathImporters.get(nb.pathKey)?.values() ?? [])
        if (imp.export === name || imp.export === null) markDirty(imp.cardKey, imp.cellId);
    }
  }

  // Cyclic cells: mark error, never schedule.
  for (const id of nb.cyclic) {
    setState(cardKey, id, "idle");
    patchOutput(cardKey, id, { running: false, stale: false, status: "error", error: "circular dependency" });
  }

  // Publish each module cell's INFERRED wiring (step-4a/4b) so the card can show it as a muted hint where the
  // user wrote no explicit declaration — an auto-wired cell otherwise renders an empty reads/defines box. The
  // inferred imports split into LOCAL reads (free vars matching a sibling → bare names) and CROSS-card imports
  // (`import` statements → name←path labels). We set all keys every sync (clearing to undefined when a
  // declaration is now explicit, or no longer inferred), so a stale hint never lingers.
  for (const c of nb.specs.values()) {
    const inf = c.inferredIn ? importsOf(c) : [];
    const localReads = inf.filter((i) => !i.path).map((i) => i.name);
    const crossImports = inf.filter((i) => i.path);
    patchOutput(cardKey, c.id, {
      inReads: localReads.length ? localReads : undefined,
      inImports: crossImports.length ? crossImports : undefined,
      inDefines: c.inferredOut && c.outNames.length ? c.outNames : undefined,
    });
  }

  // Dirty = a cell that is new, whose spec changed, or whose set of producer cells changed (a rewiring).
  for (const c of nb.specs.values()) {
    if (nb.cyclic.has(c.id)) continue;
    const old = prevSpecs.get(c.id);
    const depsChanged = !setsEqual(prevDeps.get(c.id), nb.depsOf.get(c.id));
    const specChanged =
      !old ||
      old.source !== c.source ||
      old.policy !== c.policy ||
      old.inNames.join(",") !== c.inNames.join(",") ||
      old.outNames.join(",") !== c.outNames.join(",");
    if (specChanged || depsChanged) markDirty(cardKey, c.id);
  }

  // CONSENT TOGGLED (Fix A): flipping `data-main-realm` changes no cell's SOURCE, so the spec-diff above
  // re-dirties nothing — but the gate outcome for every domCandidate cell just changed. Re-dirty them so a
  // GRANT runs the previously-parked cells (per their own policy) and a REVOKE re-parks any that had run.
  // Only on an actual flip (prev exists and differs); the first sync already dirties them as new cells.
  if (prev && prev.mainRealmAllowed !== mainRealmAllowed) {
    for (const c of nb.specs.values()) if (c.domCandidate && !nb.cyclic.has(c.id)) markDirty(cardKey, c.id);
  }

  // Reconcile this card's CROSS-CARD subscriptions (notebook-object/export imports + data-file imports)
  // against the new spec set: register new waiters, drop gone ones, (un)subscribe file handles.
  wireExternal(cardKey);

  // This notebook just became the live card at its address → wake the cells elsewhere that import it, so
  // they re-run against its (now resolvable) exports rather than sitting on undefined.
  if (firstAtPath) {
    for (const imp of pathImporters.get(pathKey)?.values() ?? []) markDirty(imp.cardKey, imp.cellId);
  }

  tick(cardKey);
}

// Reconcile one card's external (cross-card) wiring after a sync. For every cell, work out the imports
// that point OUTSIDE this notebook, resolve each to a notebook address or a data file, and diff the
// resulting subscriptions against what the cell held before: add the new, drop the gone. This is the only
// place pathImporters entries and file-content subscriptions are created/destroyed, so they can't leak
// across edits. A re-dirty fires when a subscribed file's content changes.
function wireExternal(cardKey: string): void {
  const nb = nbs.get(cardKey);
  if (!nb) return;
  let cells = extState.get(cardKey);
  if (!cells) extState.set(cardKey, (cells = new Map()));

  for (const spec of nb.specs.values()) {
    const wantNb = new Set<string>(); // pathImporters refKeys this cell should hold
    const wantFiles = new Map<string, { root: string; path: string }>(); // fileKey → (root, path)
    if (!nb.cyclic.has(spec.id)) {
      for (const imp of importsOf(spec)) {
        if (!imp.path) continue; // a local export — handled by the intra-card DAG, not here
        const r = resolveImport(nb, imp);
        if (r.kind === "nb") wantNb.add(refKeyOf(cardKey, spec.id, imp.export));
        else wantFiles.set(fileKeyOf(r.root, r.path), { root: r.root, path: r.path });
      }
    }

    let ext = cells.get(spec.id);
    if (!ext) cells.set(spec.id, (ext = { nb: new Set(), files: new Map() }));

    // Notebook waiters: register what's wanted (keyed under the TARGET's pathKey, with the export filter),
    // drop what's no longer wanted. We re-derive the target pathKey from the refKey-bearing import again.
    for (const imp of importsOf(spec)) {
      if (!imp.path) continue;
      const r = resolveImport(nb, imp);
      if (r.kind !== "nb") continue;
      const refKey = refKeyOf(cardKey, spec.id, imp.export);
      let m = pathImporters.get(r.pathKey);
      if (!m) pathImporters.set(r.pathKey, (m = new Map()));
      m.set(refKey, { cardKey, cellId: spec.id, export: imp.export });
    }
    for (const refKey of ext.nb) {
      if (!wantNb.has(refKey)) removeImporter(refKey);
    }
    ext.nb = wantNb;

    // Data-file subscriptions: subscribe the new files, unsubscribe the gone. A file's content change
    // re-dirties this cell (per its policy), exactly as an upstream export change does.
    for (const [fileKey, off] of ext.files) {
      if (!wantFiles.has(fileKey)) {
        off();
        ext.files.delete(fileKey);
      }
    }
    for (const [fileKey, { root, path }] of wantFiles) {
      if (ext.files.has(fileKey)) continue;
      const off = fileContentSignal(root, path).subscribe(() => markDirty(cardKey, spec.id));
      ext.files.set(fileKey, off);
    }
  }
}

// Resolve one cross-card import against the importing notebook. NOTEBOOK when an open card already lives
// at the address, or the `#export` form is used, or the path names a `.html`; otherwise a DATA FILE read
// from disk by relative path (the "normal fileload mechanism", §11.2) — which needn't be an open card.
type ResolvedImport =
  | { kind: "nb"; pathKey: string }
  | { kind: "file"; root: string; path: string };
function resolveImport(nb: NB, imp: CellImport): ResolvedImport {
  const resolved = resolvePath(nb.dir, imp.path!);
  const pathKey = pathKeyOf(nb.root, stripHtml(resolved));
  // A NOTEBOOK when: the `#export` form is used, a notebook is already open at the address, the path names
  // a `.html`, OR the path has NO extension (the "drop the .html" convention, §11.2 — a bare `./prices`
  // is a sibling notebook). A path with any OTHER extension (`.csv`, `.json`, …) is a DATA FILE read from
  // disk. The extensionless rule is what lets an importer resolve to a notebook that isn't open YET (so it
  // wakes when that notebook opens) rather than mis-resolving to a non-existent file.
  const base = resolved.slice(resolved.lastIndexOf("/") + 1);
  const hasExt = base.includes(".");
  const looksNotebook = imp.export != null || nbByPath.has(pathKey) || /\.html$/i.test(resolved) || !hasExt;
  if (looksNotebook) return { kind: "nb", pathKey };
  return { kind: "file", root: nb.root, path: resolved };
}

// Drop one notebook-import registration (a re-sync no longer wants it, or the cell was removed).
function removeImporter(refKey: string): void {
  for (const [pk, m] of pathImporters) {
    if (m.delete(refKey) && m.size === 0) pathImporters.delete(pk);
  }
}

// Tear down all of one cell's external subscriptions (cell removed, or whole card torn down).
function tearDownExt(cardKey: string, cellId: string): void {
  const ext = extState.get(cardKey)?.get(cellId);
  if (!ext) return;
  for (const refKey of ext.nb) removeImporter(refKey);
  for (const off of ext.files.values()) off();
  extState.get(cardKey)!.delete(cellId);
}

function setsEqual(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  const x = a ?? new Set<string>();
  const y = b ?? new Set<string>();
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

// ── dirtying, triggering, the scheduler tick ──────────────────────────────────────────────────────
// Mark a cell dirty per its POLICY (§6): auto runs asap; manual/debounced go STALE (a badge + a wait),
// debounced additionally arming a timer. This is the master cost lever — nothing expensive auto-runs.
function markDirty(cardKey: string, cellId: string): void {
  const nb = nbs.get(cardKey);
  if (!nb || nb.cyclic.has(cellId)) return;
  const spec = nb.specs.get(cellId);
  if (!spec) return;
  const policy = parsePolicy(spec.policy);
  if (policy.kind === "auto") return trigger(cardKey, cellId);
  // manual / debounced: show it's stale (keep the last value visible), don't run yet.
  if (stateOf(nb, cellId) !== "running") setState(cardKey, cellId, "stale");
  patchOutput(cardKey, cellId, { stale: true });
  if (policy.kind === "debounced") {
    const existing = nb.timer.get(cellId);
    if (existing) clearTimeout(existing);
    nb.timer.set(
      cellId,
      setTimeout(() => {
        nb.timer.delete(cellId);
        trigger(cardKey, cellId);
      }, policy.ms),
    );
  }
}

// Make a cell run as soon as it's READY — used by auto-dirty, a fired debounce timer, and the manual Run
// button (which overrides policy). If it's mid-run, remember to re-run on completion (supersede).
function trigger(cardKey: string, cellId: string): void {
  const nb = nbs.get(cardKey);
  if (!nb || nb.cyclic.has(cellId) || !nb.specs.has(cellId)) return;
  const t = nb.timer.get(cellId);
  if (t) (clearTimeout(t), nb.timer.delete(cellId));
  if (stateOf(nb, cellId) === "running") {
    redoSet(cardKey).add(cellId); // re-run once the in-flight job returns (inputs changed mid-run)
    return;
  }
  setState(cardKey, cellId, "queued");
  patchOutput(cardKey, cellId, { running: true, stale: false });
  tick(cardKey);
}

// Cells re-dirtied while running, to be re-run once their in-flight job returns (per card, by id).
const redo = new Map<string, Set<string>>();
function redoSet(cardKey: string): Set<string> {
  let s = redo.get(cardKey);
  if (!s) redo.set(cardKey, (s = new Set()));
  return s;
}

// Start every queued cell whose upstream producers have all SETTLED (not queued/running) — readiness IS
// the topological order: a downstream cell simply waits, and a producer's completion re-ticks. A stale
// (manual/debounced-waiting) or cyclic upstream counts as settled, so a downstream runs with that
// producer's last/undefined value rather than deadlocking.
function tick(cardKey: string): void {
  const nb = nbs.get(cardKey);
  if (!nb) return;
  for (const [id, st] of nb.state) {
    if (st !== "queued") continue;
    const deps = nb.depsOf.get(id) ?? new Set();
    let ready = true;
    for (const p of deps) {
      const ps = stateOf(nb, p);
      if (ps === "queued" || ps === "running") (ready = false);
    }
    if (ready) startRun(cardKey, id);
  }
}

// The current value to bind for one import (§11.2): a LOCAL export from this card, a cross-card notebook
// export (one, or the whole notebook as an object of its exports), or a data file's text content. Anything
// not yet available (a notebook not open, a file still fetching) resolves to undefined — the cell runs
// now and re-runs when it arrives (the subscriptions wired in wireExternal), never a deadlock.
function resolveInput(nb: NB, imp: CellImport): unknown {
  if (!imp.path) return nb.exportsVal.get(imp.name);
  const r = resolveImport(nb, imp);
  if (r.kind === "file") return fileContentSignal(r.root, r.path).get();
  const target = nbs.get(nbByPath.get(r.pathKey) ?? "");
  if (!target) return undefined; // the imported notebook isn't open on the board
  if (imp.export) return target.exportsVal.get(imp.export);
  return Object.fromEntries(target.exportsVal); // whole notebook as an object of its exports
}

function startRun(cardKey: string, cellId: string): void {
  const nb = nbs.get(cardKey);
  const spec = nb?.specs.get(cellId);
  if (!nb || !spec) return;
  // An empty (or whitespace-only) cell has nothing to evaluate — a fresh `+ code` cell, or one mid-authoring.
  // Don't hand it to the worker: an empty expression wraps to `return ()`, a SyntaxError. Present a clean
  // empty pane (no error, no value), clear any exports it used to define, and unblock its dependents.
  const runSrc = spec.runSource ?? spec.source ?? "";
  if (!runSrc.trim()) {
    setState(cardKey, cellId, "idle");
    patchOutput(cardKey, cellId, { running: false, stale: false, status: undefined, value: undefined, view: undefined, error: undefined });
    applyExports(cardKey, cellId, undefined);
    afterRun(cardKey, cellId);
    return;
  }
  // MAIN-THREAD REALM CONSENT GATE (Fix A, the trust boundary — thread node:mrdj7o3s-9). A domCandidate cell runs
  // on the MAIN THREAD with FULL PAGE AUTHORITY (DOM, IndexedDB, localStorage, credentialed same-origin fetch)
  // and, being synchronous UI-thread code, CAN hang the whole app with no in-realm interrupt. So it must NOT run
  // — not on card open, not on a manual Run (this gate is a security boundary, not a policy the Run button
  // overrides) — until the notebook carries explicit consent (`data-main-realm="allow"` → nb.mainRealmAllowed).
  // Until then the cell is parked idle with `needsConsent` (the card renders a one-time "allow page access"
  // affordance) and publishes undefined for its exports, so downstream cells settle exactly as for an empty cell
  // (never a deadlock). This closes BOTH review HIGHs at one chokepoint: no auto-run-on-open hang, no silent
  // privilege escalation on lib import.
  if (spec.domCandidate && !nb.mainRealmAllowed) {
    setState(cardKey, cellId, "idle");
    patchOutput(cardKey, cellId, { running: false, stale: false, status: undefined, value: undefined, view: undefined, error: undefined, needsConsent: true });
    applyExports(cardKey, cellId, undefined);
    afterRun(cardKey, cellId);
    return;
  }
  const inputs: Record<string, unknown> = {};
  for (const imp of importsOf(spec)) inputs[imp.name] = resolveInput(nb, imp);
  setState(cardKey, cellId, "running");
  patchOutput(cardKey, cellId, { running: true, stale: false, needsConsent: undefined });
  const jobId = ++nextJob;
  nb.job.set(cellId, jobId);
  const src = spec.runSource ?? spec.source;
  // TWO EXECUTION REALMS (B2, invariant #3). A DOM-producing cell (spec.domCandidate — imports an external lib
  // or reads document/window) runs on the MAIN THREAD, where a real document + the real layout engine let Plot
  // measure text and size margins correctly; a live node comes back and is mounted. Every other cell runs on
  // the shared, DOM-less worker as before. Statelessness holds in both: each runs via a scoped new Function with
  // inputs injected as named params only (notebook-main-exec.js / notebook-worker.js) — no shared namespace.
  if (spec.domCandidate) {
    // runMainThreadCell never rejects (it catches internally); the onRejected arm is belt-and-braces.
    runMainThreadCell({ source: src, inputs, block: spec.block, budgetMs: MAIN_THREAD_BUDGET_MS }).then(
      (r) => onMainReply(cardKey, cellId, jobId, r),
      (err) => onMainReply(cardKey, cellId, jobId, { ok: false, error: String(err) }),
    );
    return;
  }
  pending.set(jobId, { cardKey, cellId });
  try {
    // `runSource` is what the worker evaluates: the RHS for a `name = …` named-cell define, a rewritten
    // statement block (imports stripped, last expression returned — step-4b), or the source verbatim; `block`
    // tells the worker which (§11.4a/4b). The bare define assignment never leaks a global into the worker.
    ensureWorker().postMessage({ jobId, source: src, inputs, block: spec.block });
  } catch (err) {
    pending.delete(jobId);
    setState(cardKey, cellId, "idle");
    patchOutput(cardKey, cellId, { running: false, status: "error", error: String(err) });
  }
}

// Completion for a MAIN-THREAD run (the DOM realm, B2) — the twin of onReply. Same supersede + state handling,
// but the value is RAW (not worker clone-safed): a live DOM node becomes a `view` output (the template mounts
// the live node; its markup rides the relay), while any OTHER value takes the identical clone-safe text/JSON
// path a worker reply would, so exports and downstream cells behave the same across realms.
function onMainReply(cardKey: string, cellId: string, jobId: number, r: { ok: boolean; value?: unknown; error?: string }): void {
  const nb = nbs.get(cardKey);
  if (!nb) return;
  if (nb.job.get(cellId) !== jobId) {
    afterRun(cardKey, cellId); // superseded — inputs changed mid-run; drop this stale (possibly node) result
    return;
  }
  setState(cardKey, cellId, "idle");
  if (r.ok) {
    const spec = nb.specs.get(cellId);
    const suppressed = !!spec?.suppress;
    if (!suppressed && isNode(r.value)) {
      // A DOM/SVG node: mount the LIVE node + relay its markup (agent-legibility, §7). A view cell's export
      // (rare) degrades to the markup string — a node can't structured-clone to a downstream worker cell,
      // matching the existing non-clone-safe→string rule. Clear any prior text `value` (a value→node switch).
      const view = serializeView(r.value as Node);
      patchOutput(cardKey, cellId, { running: false, stale: false, status: "ok", value: undefined, view: { ...view, node: r.value }, error: undefined, suppressed: undefined });
      applyExports(cardKey, cellId, view.markup);
    } else {
      // A plain value (or a suppressed node): the existing text/JSON path. Clone-safe it exactly as the worker
      // would so exportsVal stays transportable; clear any prior `view` (a node→value switch, or a fresh run).
      const value = cloneSafe(r.value);
      patchOutput(cardKey, cellId, { running: false, stale: false, status: "ok", value: suppressed ? undefined : displayValue(spec, value), view: undefined, error: undefined, suppressed: suppressed || undefined });
      applyExports(cardKey, cellId, value);
    }
  } else {
    patchOutput(cardKey, cellId, { running: false, stale: false, status: "error", value: undefined, view: undefined, error: String(r.error) });
  }
  afterRun(cardKey, cellId);
}

function onReply(cardKey: string, cellId: string, jobId: number, ok: boolean, value: unknown, error: unknown): void {
  const nb = nbs.get(cardKey);
  if (!nb) return;
  // Supersede: ignore a reply that isn't this cell's current job (the inputs changed mid-run).
  if (nb.job.get(cellId) !== jobId) {
    afterRun(cardKey, cellId);
    return;
  }
  setState(cardKey, cellId, "idle");
  if (ok) {
    // A multi-define block returns an object keyed by EVERY defined name (keyedExports). That object is the
    // EXPORT map (applyExports picks the per-name atoms off it), but it is NOT what the cell should DISPLAY:
    // Observable-style, a cell shows its FINAL value — here the last defined name's value — not an object of
    // all its bindings. Split the two: exports get the whole object, the pane gets the final value only.
    //
    // OUTPUT SUPPRESSION (Jupyter `;`): when the cell's final statement ended in `;`, blank the DISPLAY value
    // only — exports (applyExports) and side effects derive from the RAW worker `value`, so a named `x = 1;`
    // still publishes x and downstream cells still update; just the pane shows nothing.
    const spec = nb.specs.get(cellId);
    const suppressed = !!spec?.suppress;
    // Clear any prior `view`: a cell edited from DOM-producing → plain reroutes here (worker), and its old
    // chart node must not linger under the new text value.
    patchOutput(cardKey, cellId, { running: false, stale: false, status: "ok", value: suppressed ? undefined : displayValue(spec, value), view: undefined, error: undefined, suppressed: suppressed || undefined });
    applyExports(cardKey, cellId, value);
  } else {
    // A failed cell keeps its downstream's last-good values (no cascade) — only its own pane shows the error.
    patchOutput(cardKey, cellId, { running: false, stale: false, status: "error", view: undefined, error: String(error) });
  }
  afterRun(cardKey, cellId);
}

// Re-run a cell that was re-dirtied while it was in flight, then advance the scheduler.
function afterRun(cardKey: string, cellId: string): void {
  const rs = redo.get(cardKey);
  if (rs?.has(cellId)) {
    rs.delete(cellId);
    setState(cardKey, cellId, "idle");
    trigger(cardKey, cellId);
  }
  tick(cardKey);
}

// Write a finished cell's exports to the off-log atoms; any CHANGED name marks its importers dirty (per
// their own policy), which is the reactive cascade. This is the one place a value flows along an edge. A cell
// publishes both its COMPUTED exports (mapped from the worker value) and its RE-EXPORTS — the values it pulls
// from cross-card imports, republished under the local name so sibling cells can read them (step-4b).
function applyExports(cardKey: string, producerId: string, value: unknown): void {
  const nb = nbs.get(cardKey);
  const spec = nb?.specs.get(producerId);
  if (!nb || !spec) return;
  for (const [name, val] of computeExports(spec, value)) publishExport(cardKey, nb, producerId, name, snapshotClosure(nb, spec, val));
  // Re-exports (Observable's import-cell): an imported binding becomes a notebook-local export whose value is
  // the resolved import. It tracks the upstream because a change there re-dirties this cell (wireExternal).
  for (const imp of importsOf(spec)) if (imp.path) publishExport(cardKey, nb, producerId, imp.name, resolveInput(nb, imp));
}

// A function export travels as a source descriptor built in the worker. Attach the closure snapshot HERE —
// the runtime is the only place that holds the producing cell's resolved input VALUES — so a function that
// reads a sibling/imported export (`g = x => x + a`) carries `a`'s current value and stays callable in the
// consumer worker (case B). The closure is the cell's resolved inputs; inputs that are themselves function
// descriptors ride along and rehydrate recursively (case D). A no-free-var function (case A) gets an empty
// closure. Non-descriptor values pass through untouched.
function snapshotClosure(nb: NB, spec: CellSpec, val: unknown): unknown {
  if (!isFnDescriptor(val)) return val;
  const closure: Record<string, unknown> = {};
  for (const imp of importsOf(spec)) closure[imp.name] = resolveInput(nb, imp);
  // A transported function stays callable in the consumer ONLY if every free identifier in its source resolves
  // there — a snapshotted closure binding (above) or a realm global. A function closing over a cell-LOCAL const
  // (`const k = 5; f = x => x + k`) or referencing its OWN name (anonymous recursion, `f = n => n * f(n - 1)`)
  // has a free var that is neither, so it would rehydrate but throw ReferenceError at call time — contradicting
  // the documented "degrade to display string" contract. Detect that (acorn, in notebook-infer) and hand back
  // the source STRING instead of a landmine descriptor. A NAMED recursive function (`function f(n){…f…}`) binds
  // its own name, so it is not flagged and transports normally.
  if (unresolvableFreeVars(val.source, Object.keys(closure)).length) return val.source;
  return { ...val, closure };
}

// Publish one export value; on a real change, re-dirty its importers — local (this card) and cross-card
// (other cards pulling this exact export, plus object-importers depending on any export of this notebook).
function publishExport(cardKey: string, nb: NB, producerId: string, name: string, val: unknown): void {
  if (valuesEqual(nb.exportsVal.get(name), val)) return;
  nb.exportsVal.set(name, val);
  for (const importer of nb.importByName.get(name) ?? []) if (importer !== producerId) markDirty(cardKey, importer);
  for (const imp of pathImporters.get(nb.pathKey)?.values() ?? [])
    if (imp.export === name || imp.export === null) markDirty(imp.cardKey, imp.cellId);
}

// What a cell's pane should DISPLAY (vs. what it exports). For an ordinary cell the displayed value IS the
// worker value. A multi-define block (keyedExports) instead returns a { value, exports } pair — `value` is the
// cell's FINAL expression (Observable's "a cell shows its last expression"), `exports` is the named-binding
// map for wiring. Show the `value` half. Falls back to the whole value if the shape is unexpected, so display
// never throws.
function displayValue(spec: CellSpec | undefined, value: unknown): unknown {
  const v = spec?.keyedExports && value && typeof value === "object" ? (value as { value: unknown }).value : value;
  return isFnDescriptor(v) ? v.source : v; // a function export shows its source, not [object Object]
}

// Map a cell's value to its declared exports: 0 outputs → none (a display-only cell); a keyedExports block →
// pick the named keys off its `exports` map (the worker returned a { value, exports } pair); >1 names on a
// non-keyed cell → pick the keys off the value object directly; a single non-keyed name → the value IS that export.
function computeExports(spec: CellSpec, value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const names = spec.outNames;
  if (spec.keyedExports) {
    const exp = value && typeof value === "object" ? (value as { exports?: unknown }).exports : undefined;
    for (const name of names) out.set(name, exp && typeof exp === "object" ? (exp as Record<string, unknown>)[name] : undefined);
  } else if (names.length > 1) {
    for (const name of names) out.set(name, value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined);
  } else if (names.length === 1) out.set(names[0]!, value);
  return out;
}

// The manual Run button (and the keyboard-free twin a template might add): force this cell to run now,
// overriding its policy.
export function runCell(cardKey: string, cellId: string): void {
  trigger(cardKey, cellId);
}

// ── card teardown (thread node:mrdj957r-b, Fix B #2) ──────────────────────────────────────────────
// Release EVERYTHING a notebook card holds when it unmounts (closed / removed from the board), so a card
// opened-then-closed leaves behind no live chart DOM, no file-content or cross-card subscriptions, and no
// scheduler state. Without this the per-card maps (nbs/outputs/signals/subs/extState) and the cross-card
// registries (pathImporters, nbByPath) accumulate for every notebook ever opened, and each open notebook's
// debounce/relay timers keep firing. Idempotent and safe on a NON-notebook card key — every map simply has no
// entry. The single shared worker is board-wide, not per-card, so it is deliberately NOT torn down here.
export function teardownNotebook(cardKey: string): void {
  const nb = nbs.get(cardKey);
  if (nb) {
    for (const t of nb.timer.values()) clearTimeout(t); // pending debounce timers
    nb.timer.clear();
    // Drop this notebook's published address so a stale import can't resolve to a dead card (it instead waits
    // for a re-open, per the extensionless-import rule). Guarded: another card may have taken the address.
    if (nbByPath.get(nb.pathKey) === cardKey) nbByPath.delete(nb.pathKey);
    nbs.delete(cardKey);
  }
  // This card's cross-card + data-file subscriptions (pathImporters entries + file-content unsubscribes). Spread
  // the keys first — tearDownExt mutates the per-card extState map as it removes each cell.
  for (const cellId of [...(extState.get(cardKey)?.keys() ?? [])]) tearDownExt(cardKey, cellId);
  extState.delete(cardKey);
  // In-flight worker jobs for this card: drop their pending entries (a late reply already no-ops once the nb is
  // gone, but the map would otherwise retain the cardKey/cellId reference).
  for (const [jobId, job] of [...pending]) if (job.cardKey === cardKey) pending.delete(jobId);
  const pt = pushTimers.get(cardKey); // the debounced outputs-relay timer
  if (pt) (clearTimeout(pt), pushTimers.delete(cardKey));
  redo.delete(cardKey);
  // The off-log output projection + its signal/subscribers — dropping outputs releases the live chart DOM nodes
  // (B2 views) it referenced, so they can be garbage-collected with the unmounted card.
  outputs.delete(cardKey);
  signals.delete(cardKey);
  subs.delete(cardKey);
}
