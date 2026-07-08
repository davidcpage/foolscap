import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// DOM/SVG chart output (Phase-2 B2, thread node:mrc94xcb-17). A DOM-producing notebook cell — an Observable
// Plot chart, a d3 selection — cannot run in the DOM-less worker, so it runs on the MAIN-THREAD realm
// (src/notebook-main-exec.js) against a real document + the real layout engine. These tests exercise that
// realm directly: a Node return is detected and serialized; a plain value takes the text path; statelessness
// holds across runs. The full runtime scheduler (routing + mount + lifecycle) is TS + needs real DOM signals
// and isn't node-importable (same limit as notebook-fn-transport), so it is covered by these plain-JS unit
// tests + the human visual check in the running app. No network: a data:-URL module is the stubbed Plot CDN.
//
// jsdom is installed on globalThis BEFORE importing the module and before any cell runs, because a cell body
// runs via `new Function(...)` and reads `document`/`window` as GLOBALS (not injected inputs).
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.DocumentFragment = dom.window.DocumentFragment;

const { runMainThreadCell, isNode, serializeView, cloneSafe } = await import(
  new URL("../src/notebook-main-exec.js", import.meta.url)
);

// A block cell's body ALREADY carries its own `return` (the runtime rewrites the last expression via
// notebook-infer's buildBlockSource before it reaches either realm); these test bodies mirror that contract.

test("a cell that builds an SVG node returns a LIVE node → view kind 'svg' with real markup", async () => {
  const r = await runMainThreadCell({
    source: "const s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('width','200'); s.appendChild(document.createElementNS('http://www.w3.org/2000/svg','rect')); return s;",
    inputs: {},
    block: true,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(isNode(r.value), true, "the raw value is a live DOM node (not clone-safed away)");
  const view = serializeView(r.value);
  assert.equal(view.kind, "svg", "an SVG element is classified svg");
  assert.match(view.markup, /^<svg[\s>]/, "markup is the node's outerHTML");
  assert.match(view.markup, /<rect/, "markup carries the chart's children (agent-legible)");
});

test("a cell that reads `document` and builds HTML → view kind 'html'", async () => {
  const r = await runMainThreadCell({
    source: "const d = document.createElement('div'); d.textContent = 'chart'; return d;",
    inputs: {},
    block: true,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(isNode(r.value), true);
  const view = serializeView(r.value);
  assert.equal(view.kind, "html");
  assert.match(view.markup, /<div[^>]*>chart<\/div>/);
});

test("the Plot-import path: a data:-URL module (stubbed CDN, real import, no network) yields a mounted SVG", async () => {
  // Models the runtime's rewritten source for `import * as Plot from "@observablehq/plot"; Plot.plot(...)`:
  // the A2 prologue is a dynamic import() the main-thread realm runs. The stub module reads the real document.
  const stub =
    "data:text/javascript," +
    encodeURIComponent(
      "export function plot(){ const s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('class','plot'); const t = document.createElementNS('http://www.w3.org/2000/svg','text'); t.textContent='label'; s.appendChild(t); return s; }",
    );
  const r = await runMainThreadCell({
    source: `const Plot = await import(${JSON.stringify(stub)}); return Plot.plot({ marks: [] });`,
    inputs: {},
    block: true,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(isNode(r.value), true, "Plot.plot() returned a live SVG node via the main-thread realm");
  const view = serializeView(r.value);
  assert.equal(view.kind, "svg");
  assert.match(view.markup, /class="plot"/);
  assert.match(view.markup, /label/, "text label serialized (what a layout-less worker shim would misplace)");
});

test("a plain-value cell returns the value (not a node) → the existing text/JSON path", async () => {
  const r = await runMainThreadCell({ source: "1 + 2", inputs: {}, block: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 3);
  assert.equal(isNode(r.value), false, "a number is not a node → the runtime clone-safes it as before");
  assert.equal(cloneSafe(r.value), 3, "clone-safe passes a primitive through unchanged");
});

test("inputs are injected as named params (a value flows along a declared edge)", async () => {
  const r = await runMainThreadCell({ source: "data.length", inputs: { data: [1, 2, 3, 4] }, block: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 4);
});

test("statelessness: a var defined in one run does NOT leak into the next", async () => {
  const first = await runMainThreadCell({ source: "const leak = 42; return leak;", inputs: {}, block: true });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value, 42);
  // A second run must not see `leak` — the scoped new Function realm carries no shared mutable namespace.
  const second = await runMainThreadCell({ source: "typeof leak", inputs: {}, block: false });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.value, "undefined", "the previous cell's binding is invisible — statelessness held");
});

test("a run error is returned, never thrown (SyntaxError / ReferenceError)", async () => {
  const bad = await runMainThreadCell({ source: "oops(", inputs: {}, block: false });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /SyntaxError|Unexpected/);
  const ref = await runMainThreadCell({ source: "notDefinedAnywhere", inputs: {}, block: false });
  assert.equal(ref.ok, false);
  assert.match(ref.error, /not defined|ReferenceError/);
});

test("serializeView: a DocumentFragment concatenates its children's markup → kind 'dom'", () => {
  const frag = document.createDocumentFragment();
  const a = document.createElement("span");
  a.textContent = "one";
  const b = document.createElement("b");
  b.textContent = "two";
  frag.appendChild(a);
  frag.appendChild(b);
  const view = serializeView(frag);
  assert.equal(view.kind, "dom");
  assert.equal(view.markup, "<span>one</span><b>two</b>");
});

test("isNode: false for non-nodes (the runtime routes these to the text path)", () => {
  assert.equal(isNode(null), false);
  assert.equal(isNode(42), false);
  assert.equal(isNode("<svg>"), false, "a markup STRING is not a node");
  assert.equal(isNode({ nodeType: "not-a-number" }), false);
  assert.equal(isNode([1, 2, 3]), false);
});

test("cloneSafe: a returned function degrades to a source descriptor (twin of the worker)", () => {
  const d = cloneSafe((x) => x + 1);
  assert.equal(d.__fn__, true);
  assert.match(d.source, /=>\s*x \+ 1/);
});
