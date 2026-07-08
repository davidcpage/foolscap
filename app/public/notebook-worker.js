// /notebook-worker.js — stateless JS cell execution for the notebook card (docs/notebook-card.md §3).
// Served as a public asset and loaded by notebook-runtime.ts (the ONLY place a Worker is made, §3).
// Receives { jobId, source, inputs }, evaluates the source as the body of an async function whose LAST
// EXPRESSION is the cell's value — with each declared input bound as an in-scope variable — and posts back
// { jobId, ok:true, value } or { jobId, ok:false, error }.
//
// STATELESS by design (§3): nothing persists between messages, so a cell physically cannot carry hidden
// state across runs — the reactive model relies on the DAG being the ONLY way a value reaches a cell
// (values flow through declared inputs, never a hidden namespace), enforced here for free.
//
// Two cell shapes (the runtime, not the worker, decides which via `block`, using acorn — notebook-infer.js):
//   • block=false — a single EXPRESSION (the step-0/4a shape): wrap as `return (source)`.
//   • block=true  — a statement BLOCK (step-4b): `source` is already a function body whose last expression
//                   was rewritten to a `return`, with any `import` declarations blanked out (the runtime
//                   injects their bindings as inputs instead — the worker is not a module, so it can't run
//                   `import`). Run it as the body directly.
// Either way it runs inside an async IIFE, so top-level `await` works. A SyntaxError (a half-typed cell like
// `oops(`) is caught and returned as an error string — never a crash. No fs; `fetch` is available.
//
// FUNCTION TRANSPORT (§ share functions across cells/notebooks): a function value can't be structured-cloned,
// so an exported function travels as SOURCE — cloneSafe emits a tagged {__fn__,source} descriptor (the
// runtime attaches its closure snapshot), and any {__fn__} INPUT is rehydrated back into a real callable
// before the cell runs. This is what lets `f = x => x+1` in one cell be called from another cell/notebook.

// runJob IS the worker's core (also imported by tests — the worker itself sets up `self.onmessage` below only
// in a real Worker, since node has no `self`). Rehydrates every function-descriptor input into a callable,
// runs the cell body, and returns the clone-safe result — never throwing (a SyntaxError becomes an error
// string, exactly as the message handler expects).
export async function runJob({ source, inputs, block }) {
  try {
    // Inputs (the cell's resolved imports — local exports, cross-notebook exports, file content) are injected
    // as NAMED PARAMETERS, so the source reads them as plain variables — this is how a value flows along a
    // dependency edge (§5). A function-typed input arrives as a {__fn__} descriptor; rehydrate makes it callable.
    const names = inputs ? Object.keys(inputs) : [];
    const args = names.map((n) => rehydrate(inputs[n]));
    const body = block
      ? "return (async () => {\n" + source + "\n})()" // block: the body already carries its own `return`
      : "return (async () => { return (\n" + source + "\n); })()"; // expression: wrap as the returned value
    const fn = new Function(...names, body);
    const value = await Promise.resolve(fn(...args));
    return { ok: true, value: cloneSafe(value) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = (e) => {
    const { jobId, source, inputs, block } = e.data || {};
    runJob({ source, inputs, block }).then((r) => self.postMessage({ jobId, ...r }));
  };
}

// Make a value safe to structured-clone across postMessage. Primitives and plain JSON-ish structures go
// as-is; a FUNCTION becomes a source descriptor (see fnDescriptor) so the consumer worker can rebuild it;
// anything else that won't clone (DOM-ish, cyclic) is stringified for display now — richer rendering
// (DOM/SVG) is step-4, deliberately out of scope here.
function cloneSafe(value) {
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (value === null || t === "number" || t === "boolean" || t === "string") return value;
  if (t === "function") return fnDescriptor(value);
  try {
    structuredClone(value);
    return value;
  } catch {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

// A function export travels as SOURCE. Only functions whose String() form re-parses standalone can be
// rebuilt in the consumer: native/bound functions (`{ [native code] }`) and non-re-evaluable callables
// (object/class method shorthand like `m() {}`) can't, so we keep today's behaviour and return the display
// string. The closure snapshot is attached later by the runtime (the only place that knows the producing
// cell's resolved input values); here we emit the source alone.
function fnDescriptor(fn) {
  const source = String(fn);
  try {
    new Function("return (" + source + ")"); // parse-only guard: re-evaluable standalone?
  } catch {
    return source; // native / bound / method-shorthand — not reconstructable, show the source string
  }
  return { __fn__: true, source };
}

// Rehydrate a transported value on the way IN: turn every {__fn__} descriptor back into a real callable by
// re-evaluating its source with its captured closure bound as parameters. Recurses into the closure (so a
// function that closes over ANOTHER transported function rebuilds too) and into plain arrays/objects (so a
// whole-notebook object import has callable function members). A source that no longer parses standalone in
// this worker falls back to its display string. `seen` guards the cyclic structures structuredClone permits.
function rehydrate(value, seen) {
  if (value === null || typeof value !== "object") return value;
  if (value.__fn__ === true && typeof value.source === "string") {
    const closure = value.closure && typeof value.closure === "object" ? value.closure : {};
    const names = Object.keys(closure);
    const vals = names.map((n) => rehydrate(closure[n], seen));
    try {
      return new Function(...names, "return (" + value.source + ")")(...vals);
    } catch {
      return value.source; // not re-evaluable here — hand back the source (display fallback)
    }
  }
  seen = seen || new Set();
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = rehydrate(value[i], seen);
    return value;
  }
  for (const k of Object.keys(value)) value[k] = rehydrate(value[k], seen);
  return value;
}

export { cloneSafe, rehydrate, fnDescriptor };
