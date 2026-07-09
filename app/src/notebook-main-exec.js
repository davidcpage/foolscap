// notebook-main-exec.js — the MAIN-THREAD execution realm for the notebook card (Phase-2 B2 DOM/SVG output).
//
// The single shared Web Worker (notebook-worker.js) has NO `document`, so a cell that builds a DOM/SVG node —
// an Observable Plot chart, a hand-rolled d3 selection — cannot run there: Plot throws before any node exists,
// and a node would not survive the structured-clone postMessage anyway. B2's answer is a SECOND, deliberate
// execution realm: DOM-producing cells run HERE, on the main thread, against the real document + the real
// browser layout engine (getBBox/getComputedTextLength — what Plot needs to size margins and place ticks
// correctly). The single-worker invariant (notebook-runtime.ts header) stands: the worker is still the DEFAULT
// realm for pure compute; this main-thread realm is the bounded exception, entered only for `domCandidate`
// cells (notebook-infer.js). See the Phase-2 design in thread node:mrc94xcb-17.
//
// This is a PLAIN-JS twin of the worker (not an import of it): the worker is a `/public` asset loaded by URL
// (it cannot import bundled src in production), and importing the worker module into the main thread would fire
// its `self.onmessage` binding. So the transport helpers (rehydrate) are duplicated here — a small, deliberate
// cost that keeps the worker a pristine asset and this module node-importable for tests (no `self`, no DOM at
// import time). STATELESSNESS is re-established identically to the worker: the cell body runs via a scoped
// `new Function(...names, body)` with inputs injected as named parameters ONLY — no shared mutable namespace,
// no leaked globals; a cell sees another cell's state solely through its declared inputs (invariant #1).

// Run one cell on the main thread and return its RAW value — which MAY be a live DOM node (unlike the worker's
// runJob, which clone-safes the value for postMessage). The runtime decides what to do with it: a Node is
// mounted + serialized (serializeView); any other value takes the existing clone-safe text/JSON path. Mirrors
// the worker's runJob exactly (same wrap, same input binding, same never-throw contract) so the two realms
// behave identically for non-DOM code.
export async function runMainThreadCell({ source, inputs, block, budgetMs }) {
  try {
    const names = inputs ? Object.keys(inputs) : [];
    const args = names.map((n) => rehydrate(inputs[n]));
    const body = block
      ? "return (async () => {\n" + source + "\n})()" // block: the body already carries its own `return`
      : "return (async () => { return (\n" + source + "\n); })()"; // expression: wrap as the returned value
    const fn = new Function(...names, body);
    // The cell body is wrapped in an async IIFE, so `fn(...args)` returns a promise — UNLESS the synchronous
    // prologue (before the first await) loops forever, in which case this call BLOCKS the thread here and no
    // watchdog can fire (JS has no preemption; a sync loop on the main thread is unstoppable in-realm). That is
    // the honest limit the consent gate, not this budget, guards. For everything that DOES yield, the budget
    // below abandons a run that never settles so the cell surfaces an error instead of hanging "running" forever.
    const value = await withBudget(Promise.resolve(fn(...args)), budgetMs);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Race a main-thread run against a wall-clock budget. If the run settles first, its value passes through and the
// timer is cleared. If the budget expires first, we REJECT with a "time budget exceeded" error — the run itself
// keeps going in the background (we cannot cancel an in-flight promise), but the cell is unstuck and reports the
// overrun. HONEST by construction: this only ever fires for ASYNC overruns (a never-resolving await, a loop that
// yields), because a synchronous infinite loop never returns control to the event loop for the timer to fire.
// A non-positive/absent budget disables the race (tests + any caller that wants the raw run).
function withBudget(promise, budgetMs) {
  if (!(budgetMs > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`time budget exceeded (${budgetMs} ms) — a still-awaiting cell was abandoned (a purely synchronous loop cannot be interrupted)`)),
      budgetMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Is this value a live DOM node (an Element / SVG element / Text / DocumentFragment)? nodeType is the portable
// duck-type (jsdom, happy-dom, and every browser set it); the instanceof is a belt-and-braces check where a
// real Node constructor is in scope. Guarded so it never throws in a DOM-less realm (returns false).
export function isNode(v) {
  if (!v || typeof v !== "object") return false;
  if (typeof v.nodeType === "number" && typeof v.nodeName === "string") return true;
  return typeof Node !== "undefined" && v instanceof Node;
}

// Serialize a live node into the SHAPE that rides to the relay + agent-legibility (notebook-runtime.ts §7):
// { kind, markup }. The live node itself is handed to the template unchanged (mounted via lit-html); ONLY this
// serialized markup is JSON-relayed, so an agent reading /api/notebook/<id>/outputs sees the chart's SVG/HTML.
//   • kind: 'svg' for an SVG element (namespace or <svg> tag), 'dom' for a DocumentFragment, else 'html'.
//   • markup: outerHTML for an element; the concatenated child markup for a fragment; the text for a text node.
const SVG_NS = "http://www.w3.org/2000/svg";
export function serializeView(node) {
  const kind = viewKind(node);
  return { kind, markup: nodeMarkup(node) };
}
function viewKind(node) {
  if (!node) return "html";
  // DocumentFragment (nodeType 11) has no single tag — a bag of nodes.
  if (node.nodeType === 11) return "dom";
  if (node.namespaceURI === SVG_NS || (typeof node.tagName === "string" && node.tagName.toLowerCase() === "svg"))
    return "svg";
  return "html";
}
function nodeMarkup(node) {
  if (!node) return "";
  if (typeof node.outerHTML === "string") return node.outerHTML; // an Element (HTML or SVG)
  // A DocumentFragment: concatenate each child's markup (outerHTML for elements, data/textContent for text).
  if (node.nodeType === 11 && node.childNodes) {
    let out = "";
    for (const c of node.childNodes) out += nodeMarkup(c);
    return out;
  }
  // A Text/comment node: its textual content.
  if (typeof node.data === "string") return node.data;
  return typeof node.textContent === "string" ? node.textContent : String(node);
}

// Make a NON-node value from a main-thread run safe to structured-clone into exportsVal (so a downstream
// WORKER cell can receive it across postMessage) — a duplicate of the worker's cloneSafe, applied only after
// the runtime has ruled out a DOM node (a node takes the view path instead). Primitives pass through; a
// function becomes a source descriptor (rehydratable in either realm); anything else non-clonable is
// stringified. This keeps the two realms' exportsVal contract identical.
export function cloneSafe(value) {
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

// A function value travels as SOURCE (see the worker's fnDescriptor) — a re-evaluable standalone function
// becomes a {__fn__, source} descriptor the runtime later closes over; a native/bound/method-shorthand
// function that can't re-parse degrades to its display string.
function fnDescriptor(fn) {
  const source = String(fn);
  try {
    new Function("return (" + source + ")");
  } catch {
    return source;
  }
  return { __fn__: true, source };
}

// Rehydrate a transported value on the way IN — a duplicate of the worker's rehydrate (see the module header
// for WHY it's duplicated, not imported). Turns every {__fn__} descriptor back into a real callable by
// re-evaluating its source with its captured closure bound as parameters; recurses into the closure and into
// plain arrays/objects so a whole-notebook object import has callable members. `seen` guards cyclic input.
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
