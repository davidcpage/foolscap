import { test } from "node:test";
import assert from "node:assert/strict";

// The MAIN-THREAD realm's async TIME BUDGET (Fix A, thread node:mrdj7o3s-9). A domCandidate cell runs on the UI
// thread; a never-settling await would otherwise leave the cell stuck "running" forever and — combined with
// silent auto-run on card open — was one of the two HIGH-severity gaps the pre-push review flagged. The budget
// abandons an async run that overruns and surfaces an error instead. These are plain-JS unit tests over
// runMainThreadCell (no DOM needed — the bodies never touch document/window), the twin of the runtime path that
// passes MAIN_THREAD_BUDGET_MS. HONEST LIMIT under test: the budget catches ASYNC overruns only; a synchronous
// infinite loop cannot be interrupted in-realm (there is no test for "interrupting" one because it is impossible
// — the consent gate, covered in notebook-format's round-trip + the driven app repro, is that case's guard).
const { runMainThreadCell } = await import(new URL("../src/notebook-main-exec.js", import.meta.url));

test("a never-settling async cell is abandoned at the budget with a 'time budget exceeded' error", async () => {
  const started = process.hrtime.bigint();
  const r = await runMainThreadCell({ source: "new Promise(() => {})", inputs: {}, block: false, budgetMs: 60 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.ok, false, "a run that never settles must fail, not hang");
  assert.match(r.error, /time budget exceeded \(60 ms\)/, "the error names the budget");
  assert.match(r.error, /synchronous loop cannot be interrupted/, "the error is HONEST about the sync-loop limit");
  assert.ok(ms < 1000, `the budget fires promptly (took ${ms.toFixed(0)}ms), not after some longer hang`);
});

test("a fast async cell completes normally — the budget never false-positives", async () => {
  const r = await runMainThreadCell({
    source: "await new Promise((res) => setTimeout(res, 5)); return 21 * 2;",
    inputs: {},
    block: true,
    budgetMs: 5000,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 42, "the real value survives the race");
});

test("a synchronous-value cell is unaffected by the budget", async () => {
  const r = await runMainThreadCell({ source: "1 + 2", inputs: {}, block: false, budgetMs: 1000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 3);
});

test("no budget (absent / non-positive) disables the race — the raw run passes through", async () => {
  const a = await runMainThreadCell({ source: "7", inputs: {}, block: false });
  assert.deepEqual([a.ok, a.value], [true, 7], "absent budgetMs runs unbudgeted");
  const b = await runMainThreadCell({ source: "8", inputs: {}, block: false, budgetMs: 0 });
  assert.deepEqual([b.ok, b.value], [true, 8], "budgetMs=0 runs unbudgeted");
});
