import { test } from "node:test";
import assert from "node:assert/strict";

// Main-thread rehydrate must NOT mutate its input (thread node:mrdj957r-b, Fix B #3). The main-thread execution
// realm (src/notebook-main-exec.js) is handed the runtime's REAL shared reactive values (exportsVal atoms,
// resolved inputs) — unlike the worker, which gets a private structured-clone copy over postMessage. The old
// rehydrate mutated arrays/objects in place (`value[i] = …`, `value[k] = …`), rewriting that shared export
// graph and breaking later worker consumers and re-runs that read the same atom. rehydrate now COPIES: it
// returns a fresh structure (descriptors rebuilt into callables) and leaves the input untouched, while still
// preserving cycles in the copy. No DOM needed — rehydrate is pure (new Function only).
const { rehydrate, runMainThreadCell } = await import(new URL("../src/notebook-main-exec.js", import.meta.url));

test("rehydrate returns a COPY and never mutates its input (nested descriptors)", () => {
  const shared = { fns: [{ __fn__: true, source: "x => x + 1" }], meta: { keep: 1 } };
  const out = rehydrate(shared);

  // The shared input is byte-for-byte what it was: the descriptor is still a descriptor, not a rebuilt function.
  assert.equal(shared.fns[0].__fn__, true, "the shared descriptor object is untouched");
  assert.equal(typeof shared.fns[0], "object");
  assert.notEqual(out, shared, "a new top-level object");
  assert.notEqual(out.fns, shared.fns, "a new nested array");
  assert.notEqual(out.meta, shared.meta, "a new nested object");

  // The copy carries a real callable rebuilt from the descriptor.
  assert.equal(typeof out.fns[0], "function", "the copy's descriptor became a callable");
  assert.equal(out.fns[0](41), 42);
  assert.equal(out.meta.keep, 1, "plain data is carried through");
});

test("rehydrate preserves cycles IN THE COPY without mutating the original", () => {
  const c = { n: 1 };
  c.self = c;
  const out = rehydrate(c);
  assert.equal(out.self, out, "the cycle is rebuilt against the COPY (not the original)");
  assert.equal(out.n, 1);
  assert.notEqual(out, c, "a fresh object");
  assert.equal(c.self, c, "the original cycle is intact");
});

test("rehydrate leaves primitives and non-descriptor values as-is", () => {
  assert.equal(rehydrate(5), 5);
  assert.equal(rehydrate("hi"), "hi");
  assert.equal(rehydrate(null), null);
  assert.equal(rehydrate(undefined), undefined);
});

test("runMainThreadCell rehydrates inputs into callables WITHOUT mutating the shared input structure", async () => {
  // A downstream (main-thread / DOM) cell imports a function export that arrived as a descriptor. The producer's
  // exportsVal — the SHARED atom — must survive the run unchanged so a later worker consumer still sees a
  // descriptor it can structured-clone, not a live (un-clonable) function.
  const sharedExport = { __fn__: true, source: "x => x * 3" };
  const inputs = { triple: sharedExport, n: 7 };
  const r = await runMainThreadCell({ source: "triple(n)", inputs, block: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 21, "the cell received a real callable rehydrated from the descriptor");
  assert.equal(inputs.triple, sharedExport, "the input map still points at the same descriptor object");
  assert.equal(inputs.triple.__fn__, true, "the shared descriptor was NOT rehydrated into a function in place");
  assert.equal(typeof inputs.triple, "object");
});
