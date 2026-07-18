// MANUAL verify (not part of `npm test` — it needs the worktree .venv + a real Jupyter kernel): demonstrate
// the genuinely concurrent scenario the brief asks for — a SOURCE EDIT landing WHILE a cell is EXECUTING —
// and prove neither clobbers the other. Drives the REAL kernel through the broker engine (runOneCell) and the
// REAL structural-edit engine (editNotebook), both writing the same on-disk notebook by cell id under CAS.
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { setServerContext } = await import("../server-context.ts");
const { runOneCell } = await import("../server-kernel.ts");
const { editNotebook, readNotebook } = await import("../server-notebook.ts");

// Minimal context: the kernel engine only reaches publishFeed (live status) + fsState (the kernel registry).
setServerContext({ publishFeed: () => {}, fsState: {} });

const appDir = process.cwd(); // app/ — its parent is the worktree root whose .venv holds jupyter
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nbrun-"));
const rel = "live.ipynb";
const abs = path.join(dir, rel);
const nb = {
  cells: [
    { id: "runner", cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "import time\ntime.sleep(2.5)\nprint('ran-old-source')" },
    { id: "target", cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "y = 0" },
  ],
  metadata: { language_info: { name: "python" }, kernelspec: { name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
};
fs.writeFileSync(abs, JSON.stringify(nb, null, 1), "utf8");

const boardId = "verify-board";
const nodeId = "node:test:live.ipynb";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WARM the kernel first (boot the gateway + kernel by running the cheap target cell), so the runner cell
// below starts EXECUTING immediately — otherwise a cold gateway boot could read the source AFTER our edit.
console.log("[verify] warming the kernel (booting gateway + running a trivial cell)…");
await runOneCell(boardId, nodeId, appDir, dir, rel, { cellId: "target" });

console.log("[verify] starting the runner cell (sleeps 2.5s, then prints)…");
const runP = runOneCell(boardId, nodeId, appDir, dir, rel, { cellId: "runner" }); // do NOT await — it's executing

// Kernel is warm, so the runner is genuinely mid-sleep by now — our edits land WHILE it executes.
await sleep(800);
const midRun = readNotebook(abs);
const runnerRunning = midRun.nb.cells.find((c) => c.id === "runner");
console.log(`[verify] mid-run: runner outputs so far = ${JSON.stringify(runnerRunning.outputs)} (expected empty — still sleeping)`);

console.log("[verify] EDITING the executing runner cell's source + the target cell's source, mid-run…");
const e1 = editNotebook(dir, rel, { type: "editSource", cellId: "runner", source: "import time\ntime.sleep(2.5)\nprint('ran-NEW-source')" });
const e2 = editNotebook(dir, rel, { type: "editSource", cellId: "target", source: "y = 999" });
console.log(`[verify] edit(runner) → ${JSON.stringify(e1)}`);
console.log(`[verify] edit(target) → ${JSON.stringify(e2)}`);

const runResult = await runP; // now the cell finishes and its outputs merge back
console.log(`[verify] run finished → ${JSON.stringify(runResult)}`);

const after = readNotebook(abs).nb;
const runner = after.cells.find((c) => c.id === "runner");
const target = after.cells.find((c) => c.id === "target");
const runnerSrc = Array.isArray(runner.source) ? runner.source.join("") : runner.source;
const targetSrc = Array.isArray(target.source) ? target.source.join("") : target.source;
const runnerStdout = (runner.outputs || []).filter((o) => o.output_type === "stream").map((o) => (Array.isArray(o.text) ? o.text.join("") : o.text)).join("");

console.log("\n===== RESULT =====");
console.log(`runner.source  = ${JSON.stringify(runnerSrc)}`);
console.log(`runner.outputs = ${JSON.stringify(runner.outputs)}`);
console.log(`runner.exec_ct = ${JSON.stringify(runner.execution_count)}`);
console.log(`target.source  = ${JSON.stringify(targetSrc)}`);

const checks = [
  ["edit landed on the EXECUTING cell (new source)", runnerSrc.includes("ran-NEW-source")],
  ["the run's outputs were NOT clobbered by the edit (stdout present)", runnerStdout.includes("ran-old-source")],
  ["the run wrote an execution_count", runner.execution_count != null],
  ["the concurrent edit on the OTHER cell also landed", targetSrc === "y = 999"],
  ["e1 ok", e1.ok === true],
  ["e2 ok", e2.ok === true],
  ["run ok", runResult.ok === true && runResult.writeback === "ok"],
];
let allPass = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) allPass = false;
}
console.log(allPass ? "\n✅ CONCURRENT edit-during-run: both landed, no clobber." : "\n❌ FAILED");
// Best-effort kernel shutdown so the script exits cleanly.
try {
  const { shutdownKernel } = await import("../server-kernel.ts");
  await shutdownKernel(boardId, nodeId);
} catch {}
process.exit(allPass ? 0 : 1);
