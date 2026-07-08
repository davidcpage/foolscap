import { test } from "node:test";
import assert from "node:assert/strict";

// Source-based FUNCTION TRANSPORT across notebook cells/notebooks (thread node:mrc94k6u-15). A function value
// can't be structured-cloned, so an exported function travels as SOURCE: cloneSafe (in the producing worker
// run) emits a {__fn__,source} descriptor, the runtime attaches its closure snapshot, and rehydrate (in the
// consumer worker run) rebuilds a real callable. These tests exercise that serialization seam directly —
// notebook-runtime.ts's scheduler needs a real Worker + DOM signals and isn't node-importable, so we model
// its one relevant step (snapshotClosure: closure = the producing cell's resolved inputs) in `store` below.
const { runJob, cloneSafe, rehydrate, fnDescriptor } = await import(
  new URL("../public/notebook-worker.js", import.meta.url)
);

// Model the runtime's export step: run the producer cell in the worker, then attach the closure snapshot the
// runtime would (its resolved inputs), yielding the descriptor as it lands in exportsVal. `inputs` here are
// the producer cell's resolved inputs — for a cross-cell reader they come from the same notebook's exportsVal,
// for a cross-notebook reader from the target notebook's exportsVal; the transport is identical either way.
async function exportFrom(source, inputs = {}, block = false) {
  const r = await runJob({ source, inputs, block });
  assert.equal(r.ok, true, `producer cell should run ok: ${r.error ?? ""}`);
  if (r.value && typeof r.value === "object" && r.value.__fn__) return { ...r.value, closure: { ...inputs } };
  return r.value;
}

// Model the runtime's consumer step: bind the imported value(s) as inputs and run the reader cell.
async function readWith(source, inputs, block = false) {
  const r = await runJob({ source, inputs, block });
  assert.equal(r.ok, true, `consumer cell should run ok: ${r.error ?? ""}`);
  return r.value;
}

test("cloneSafe turns a function into a source descriptor (not a bare string)", () => {
  const d = cloneSafe((x) => x + 1);
  assert.equal(d.__fn__, true);
  assert.match(d.source, /=>\s*x \+ 1/);
});

test("case A — no-free-var function is callable from ANOTHER CELL in the same notebook", async () => {
  // Producer cell: `f = x => x + 1` → the worker runs the RHS expression and returns the function.
  const f = await exportFrom("x => x + 1");
  assert.equal(f.__fn__, true, "the export lands in exportsVal as a descriptor");
  // Consumer cell in the SAME notebook reads `f` (an inferred local import) and calls it.
  const out = await readWith("f(41)", { f });
  assert.equal(out, 42);
});

test("case A — no-free-var function is callable from ANOTHER NOTEBOOK via relative import", async () => {
  // notebook A: `f = x => x * 10`.
  const f = await exportFrom("x => x * 10");
  // notebook B: `import {f} from "./a"` then `f(5)` — the runtime strips the import and injects f as an input;
  // the reader cell is a rewritten statement block whose last expression is returned.
  const out = await readWith("return (f(5))", { f }, true);
  assert.equal(out, 50);
});

test("case B — function closing over another EXPORT carries that export's value", async () => {
  // Producer cell `g = x => x + a`, where `a` is a sibling export currently 100. The worker returns the
  // function; the runtime attaches closure { a: 100 } (a's resolved value at publish time).
  const g = await exportFrom("x => x + a", { a: 100 });
  assert.deepEqual(g.closure, { a: 100 }, "the closure snapshot carries the read export");
  // A consumer (same notebook or another) rebuilds g with a bound and calls it.
  assert.equal(await readWith("g(1)", { g }), 101);
  assert.equal(await readWith("return (g(1))", { g }, true), 101);
});

test("case B — the snapshot is a VALUE, so a later change to the export doesn't retroactively alter it", async () => {
  // Matches the reactive model: if `a` changes the producer re-runs and re-publishes a fresh descriptor.
  const g100 = await exportFrom("x => x + a", { a: 100 });
  const g200 = await exportFrom("x => x + a", { a: 200 });
  assert.equal(await readWith("g(0)", { g: g100 }), 100);
  assert.equal(await readWith("g(0)", { g: g200 }), 200);
});

test("case D — function closing over an IMPORTED function rehydrates recursively", async () => {
  const f = await exportFrom("x => x + 1"); // f in notebook A
  // h closes over the imported f: `h = x => f(x) * 2`. The producer's resolved input f is the descriptor,
  // so the closure snapshot nests it; rehydrate rebuilds f first, then h.
  const h = await exportFrom("x => f(x) * 2", { f });
  assert.equal(h.closure.f.__fn__, true, "the nested import is carried as a descriptor");
  assert.equal(await readWith("h(10)", { h }), 22);
});

test("async functions transport and remain awaitable", async () => {
  const f = await exportFrom("async (x) => x + 1");
  assert.equal(await readWith("return (await f(41))", { f }, true), 42);
});

test("a whole-notebook object import has callable function members", async () => {
  // `import * as a from "./a"` binds the target notebook's exports as one object; its function members are
  // descriptors that rehydrate recurses into.
  const f = await exportFrom("x => x + 1");
  const g = await exportFrom("x => x * 3");
  const out = await readWith("return (a.f(1) + a.g(2))", { a: { f, g } }, true);
  assert.equal(out, 8); // (1+1) + (2*3)
});

test("fallback — a NATIVE function stays a display string (unchanged behaviour), not a descriptor", () => {
  const d = cloneSafe(Math.max);
  assert.equal(typeof d, "string");
  assert.match(d, /\[native code\]/);
});

test("fallback — a BOUND function is not reconstructable, stays a display string", () => {
  const d = cloneSafe(((x) => x).bind(null));
  assert.equal(typeof d, "string");
});

test("fallback — a method-shorthand callable (non-re-evaluable) stays a display string", () => {
  const obj = { m() {} };
  const d = fnDescriptor(obj.m);
  assert.equal(typeof d, "string", "`m() {}` doesn't parse standalone → display string");
});

test("fallback — a descriptor whose source can't be rebuilt returns the source string, never crashes", () => {
  const out = rehydrate({ __fn__: true, source: "this is not valid js (" });
  assert.equal(out, "this is not valid js (");
});

test("rehydrate leaves ordinary data untouched and tolerates cycles", () => {
  const cyclic = { n: 1 };
  cyclic.self = cyclic;
  const out = rehydrate(cyclic);
  assert.equal(out.n, 1);
  assert.equal(out.self, out);
});
