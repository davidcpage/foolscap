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

self.onmessage = (e) => {
  const { jobId, source, inputs, block } = e.data || {};
  try {
    // Inputs (the cell's resolved imports — local exports, cross-notebook exports, file content) are injected
    // as NAMED PARAMETERS, so the source reads them as plain variables — this is how a value flows along a
    // dependency edge (§5).
    const names = inputs ? Object.keys(inputs) : [];
    const args = names.map((n) => inputs[n]);
    const body = block
      ? "return (async () => {\n" + source + "\n})()" // block: the body already carries its own `return`
      : "return (async () => { return (\n" + source + "\n); })()"; // expression: wrap as the returned value
    const fn = new Function(...names, body);
    Promise.resolve(fn(...args))
      .then((value) => self.postMessage({ jobId, ok: true, value: cloneSafe(value) }))
      .catch((err) => self.postMessage({ jobId, ok: false, error: String(err) }));
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String(err) });
  }
};

// Make a value safe to structured-clone across postMessage. Primitives and plain JSON-ish structures go
// as-is; anything that won't clone (functions, DOM-ish, cyclic) is stringified for display now — richer
// rendering (DOM/SVG) is step-4, deliberately out of scope here.
function cloneSafe(value) {
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (value === null || t === "number" || t === "boolean" || t === "string") return value;
  if (t === "function") return String(value);
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
