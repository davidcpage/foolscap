// server-kernel.ts — the Jupyter kernel BROKER engine. The server-side half of interactive `.ipynb`
// execution (Path B, docs/notebook-card.md §2): the dev-server plugin drives a headless per-repo Jupyter
// kernel and writes results back into the `.ipynb` as normal nbformat outputs, so the FILE is the durable,
// agent-legible, shadow-git-versioned record and the card is a live view over it.
//
// Shape (chosen over a browser↔gateway WS bridge): a SERVER-SIDE broker, mirroring the session model.
//   • The browser NEVER sees the gateway or its token. It drives execution over same-origin HTTP POSTs
//     (routes/kernel.ts) and watches live status over the `kernel:<nodeId>` feed (mirror `session:<id>`).
//   • The broker holds ONE upstream Jupyter WS per notebook (kernel-per-notebook, keyed by (board,node)),
//     folds IOPub replies (stream / execute_result / display_data / error + execution_count) into nbformat
//     outputs correlated by `parent_header.msg_id → cellId`, and merges them back into the file by nbformat
//     CELL ID under an optimistic-concurrency CAS (never index — a concurrent edit must not clobber).
//   • The gateway itself is a detached sidecar (jupyter-host.js) launched on demand; the token stays server-side.
//
// The registry (`liveKernels`) hangs off the re-eval-surviving `fsState` (server-context). A kernel need not
// survive a full dev-server RESTART for this cut (approved) — a dead kernel is simply re-started on next run.

import crypto from "node:crypto";
import WebSocket from "ws";
import { getServerContext } from "./server-context.js";
import {
  type Notebook,
  joinMaybe,
  resolveNotebookPath,
  readNotebook,
  casWriteNotebook,
  ensureCellIds,
} from "./server-notebook.js";
import { ensureGateway } from "./jupyter-host.js";

// One nbformat output, as the render codec / render.js already understand them.
interface NbOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  [k: string]: unknown;
}

interface PendingExec {
  cellId: string;
  outputs: NbOutput[];
  execCount: number | null;
  resolve: (r: { execCount: number | null; outputs: NbOutput[]; errored: boolean }) => void;
}

interface LiveKernel {
  boardId: string;
  nodeId: string;
  baseUrl: string;
  token: string;
  kernelId: string;
  ws: WebSocket;
  wsSession: string; // the jupyter session id stamped on every message header
  status: "starting" | "idle" | "busy" | "dead";
  pending: Map<string, PendingExec>; // msg_id → in-flight execution
  idleTimer?: ReturnType<typeof setTimeout>; // armed while idle; fires shutdownKernel (the idle-reap, below)
}

// Reap a kernel left idle this long. A dev notebook rarely needs a warm kernel longer than this, and a
// reaped kernel is transparently re-started on the next Run — so this bounds the "open a notebook, walk
// away" leak without surprising an active user (every Run re-arms the clock).
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const kernelKey = (boardId: string, nodeId: string) => `${boardId}\0${nodeId}`;

// The re-eval-surviving server state (globalThis-pinned via server-context). Both the kernel registry and
// the one-shot reconcile flag hang off it, so they survive a Vite plugin re-eval but reset on a real restart.
function kernelState(): { liveKernels?: Map<string, LiveKernel>; kernelsReconciled?: boolean } {
  return (getServerContext() as unknown as { fsState: { liveKernels?: Map<string, LiveKernel>; kernelsReconciled?: boolean } }).fsState;
}

function liveKernels(): Map<string, LiveKernel> {
  const s = kernelState();
  return (s.liveKernels ??= new Map());
}

// ── the live-status feed (mirror `session:<id>`) ────────────────────────────────────────────────────
// A coarse, last-value-cached status frame per notebook: kernel lifecycle + which cell is running + a
// running stdout/stderr tail for responsiveness. The DURABLE outputs land in the file (write-back → watch →
// re-render); this feed is the *live* channel so the card reacts before the file lands.
// Board-scoped feed name: a node id (`node:<root>:<path>`) is NOT unique across boards, so we suffix the
// board id — matching the client's `boardFeedSignal("kernel:" + nodeId)`, which appends `:<boardId>`.
function publishKernel(boardId: string, nodeId: string, frame: Record<string, unknown>): void {
  getServerContext().publishFeed(`kernel:${nodeId}:${boardId}`, { ts: Date.now(), ...frame });
}

// ── nbformat helpers ────────────────────────────────────────────────────────────────────────────────
// The notebook FILE read / normalize / full-fidelity CAS-write primitives live in server-notebook.ts and are
// SHARED with the structural-edit engine there — so a kernel output-merge and a card source-edit go through
// the SAME by-cell-id CAS-write path and can't clobber each other. This module owns only the IOPub→nbformat
// mapping and the output-merge that consume them.

// Map one IOPub message to an nbformat output (or null for non-output messages like status/execute_input).
function iopubToOutput(msgType: string, content: Record<string, unknown>): NbOutput | null {
  switch (msgType) {
    case "stream":
      return { output_type: "stream", name: content.name as string, text: content.text as string };
    case "execute_result":
      return {
        output_type: "execute_result",
        data: content.data,
        metadata: content.metadata ?? {},
        execution_count: content.execution_count,
      };
    case "display_data":
      return { output_type: "display_data", data: content.data, metadata: content.metadata ?? {} };
    case "error":
      return {
        output_type: "error",
        ename: content.ename,
        evalue: content.evalue,
        traceback: content.traceback,
      };
    default:
      return null;
  }
}

// Merge one cell's fresh outputs + execution_count into the file by CELL ID, under CAS. Retries on a stale
// conflict (re-read + re-merge). Returns "ok" | "stale-cell" (the target id vanished) | "error".
function mergeCellOutputs(abs: string, cellId: string, outputs: NbOutput[], execCount: number | null): "ok" | "stale-cell" | "error" {
  for (let attempt = 0; attempt < 6; attempt++) {
    const read = readNotebook(abs);
    if (!read) return "error";
    const { nb, version } = read;
    const cell = nb.cells.find((c) => c.id === cellId);
    if (!cell) return "stale-cell"; // the cell was deleted/renamed since we ran it — drop the outputs
    cell.outputs = outputs;
    cell.execution_count = execCount;
    const r = casWriteNotebook(abs, nb, version);
    if (r === "ok") return "ok";
    if (r === "error") return "error";
    // stale → concurrent write; loop and re-merge on the fresh bytes.
  }
  return "error";
}

// ── kernel lifecycle ────────────────────────────────────────────────────────────────────────────────

async function gatewayFetch(baseUrl: string, token: string, pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(pathname, baseUrl), {
    ...init,
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

// ── idle reap ───────────────────────────────────────────────────────────────────────────────────────
// A kernel with no in-flight work is a candidate for the idle timeout. Arm the clock when it falls idle,
// clear it the moment a cell runs. unref'd so it never keeps the dev server alive on its own.
function clearIdleReap(k: LiveKernel): void {
  if (k.idleTimer) {
    clearTimeout(k.idleTimer);
    k.idleTimer = undefined;
  }
}
function armIdleReap(k: LiveKernel): void {
  clearIdleReap(k);
  if (k.pending.size) return; // still working — not idle
  k.idleTimer = setTimeout(() => {
    void shutdownKernel(k.boardId, k.nodeId);
  }, IDLE_TIMEOUT_MS);
  k.idleTimer.unref?.();
}

// ── single-flight + reconcile (BUG-3) ───────────────────────────────────────────────────────────────

// Deduplicate concurrent async starts by key: the first caller runs `factory`, callers arriving while it is
// in flight await the SAME promise, and the slot clears when it settles. Mirrors jupyter-host.js's
// `launching` guard (jupyter-host.js:197-214). This is what stops two fast Runs on one notebook from racing
// two kernels into existence (the second silently orphaning the first). Exported for direct unit testing.
export function singleFlight<T>(inflight: Map<string, Promise<T>>, key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = factory().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Reconcile the gateway's kernels against the broker's registry. The detached gateway (jupyter-host.js)
// survives a dev-server RESTART but `liveKernels` does not — so every kernel created before the restart is
// orphaned INSIDE the surviving gateway, and ensureKernel would start a fresh one right next to it. Sweep
// once per server lifetime: GET the gateway's kernels and DELETE any the broker no longer tracks. Returns
// the reaped ids (for the caller's log line + the test). Best-effort — a gateway error just skips the sweep
// (a kernel we couldn't list stays put rather than risking a wrong delete). Exported for direct unit testing.
export async function reconcileGatewayKernels(
  gw: { baseUrl: string; token: string },
  knownKernelIds: Set<string>,
): Promise<string[]> {
  let list: Array<{ id?: string }>;
  try {
    const res = await gatewayFetch(gw.baseUrl, gw.token, "/api/kernels");
    if (!res.ok) return [];
    list = (await res.json()) as Array<{ id?: string }>;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const reaped: string[] = [];
  for (const { id } of list) {
    if (!id || knownKernelIds.has(id)) continue;
    const ok = await gatewayFetch(gw.baseUrl, gw.token, `/api/kernels/${id}`, { method: "DELETE" })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) reaped.push(id);
  }
  return reaped;
}

// Run the reconcile sweep at most once per server lifetime. The flag lives on fsState (survives a Vite
// re-eval, resets on a real restart), so a re-eval — after which `liveKernels` is still populated — does NOT
// re-sweep and reap live kernels; only a genuine restart (empty `liveKernels`) reaps the orphans. Set the
// flag BEFORE the await so concurrent first-run starters don't double-sweep.
async function reconcileGatewayOnce(gw: { baseUrl: string; token: string }): Promise<void> {
  const s = kernelState();
  if (s.kernelsReconciled) return;
  s.kernelsReconciled = true;
  const known = new Set([...liveKernels().values()].map((k) => k.kernelId));
  const reaped = await reconcileGatewayKernels(gw, known).catch(() => [] as string[]);
  if (reaped.length) {
    console.log(`[kernel] reconcile: reaped ${reaped.length} orphaned kernel(s) after restart: ${reaped.join(", ")}`);
  }
}

// In-flight guard for kernel starts (mirrors jupyter-host's `launching`), keyed by (board,node).
const kernelStarting = new Map<string, Promise<LiveKernel>>();

// Route an inbound WS frame to its in-flight execution (correlated by parent_header.msg_id) and update the
// live feed. Appends outputs; resolves the pending promise when the cell goes idle.
function onKernelMessage(k: LiveKernel, raw: WebSocket.RawData): void {
  let m: { header?: { msg_type?: string }; parent_header?: { msg_id?: string }; content?: Record<string, unknown>; channel?: string };
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const msgType = m.header?.msg_type;
  const parentId = m.parent_header?.msg_id;
  if (!parentId) {
    // Kernel-wide status with no parent (e.g. the initial idle) — reflect coarse kernel state.
    if (msgType === "status" && m.content) {
      const st = m.content.execution_state;
      if (st === "idle" || st === "busy") k.status = st as "idle" | "busy";
    }
    return;
  }
  const pending = k.pending.get(parentId);
  if (!pending) return;
  const content = m.content ?? {};

  if (msgType === "execute_input") {
    pending.execCount = (content.execution_count as number) ?? null;
    publishKernel(k.boardId, k.nodeId, { status: "busy", runningCellId: pending.cellId, execCount: pending.execCount });
    return;
  }
  const out = iopubToOutput(msgType ?? "", content);
  if (out) {
    pending.outputs.push(out);
    // Live streaming: push the running stdout/stderr tail + error flag so the card reacts before write-back.
    const streamTail = pending.outputs
      .filter((o) => o.output_type === "stream")
      .map((o) => joinMaybe((o as { text?: unknown }).text))
      .join("");
    publishKernel(k.boardId, k.nodeId, {
      status: "busy",
      runningCellId: pending.cellId,
      execCount: pending.execCount,
      stream: streamTail.slice(-4000),
      errored: pending.outputs.some((o) => o.output_type === "error"),
    });
  }
  if (msgType === "status" && content.execution_state === "idle") {
    k.pending.delete(parentId);
    k.status = k.pending.size ? "busy" : "idle";
    if (k.status === "idle") armIdleReap(k); // fully idle again — restart the reap clock
    pending.resolve({
      execCount: pending.execCount,
      outputs: pending.outputs,
      errored: pending.outputs.some((o) => o.output_type === "error"),
    });
  }
}

// Start (or reuse) the kernel for one notebook. A single-flight guard (BUG-3) collapses concurrent starts
// for the same notebook onto one kernel; a live kernel is returned directly without entering the guard.
async function ensureKernel(boardId: string, nodeId: string, appDir: string): Promise<LiveKernel> {
  const key = kernelKey(boardId, nodeId);
  const existing = liveKernels().get(key);
  if (existing && existing.status !== "dead" && existing.ws.readyState === WebSocket.OPEN) return existing;
  if (existing) liveKernels().delete(key); // dead/closed — replace
  return singleFlight(kernelStarting, key, () => startKernel(boardId, nodeId, appDir));
}

// Actually start a kernel: ensure the gateway is up, reconcile away restart-orphans (once per lifetime),
// create a kernel, open the upstream WS, and wire message routing. Throws on env/gateway failure (the route
// turns it into 5xx/blocker). Only ever called through ensureKernel's single-flight guard.
async function startKernel(boardId: string, nodeId: string, appDir: string): Promise<LiveKernel> {
  const key = kernelKey(boardId, nodeId);
  const gw = await ensureGateway(appDir); // { baseUrl, token }
  await reconcileGatewayOnce(gw); // reap kernels orphaned in the surviving gateway by a prior restart
  publishKernel(boardId, nodeId, { status: "starting", envLabel: gw.envLabel });

  const res = await gatewayFetch(gw.baseUrl, gw.token, "/api/kernels", {
    method: "POST",
    body: JSON.stringify({ name: "python3" }),
  });
  if (!res.ok) throw new Error(`gateway kernel create failed: ${res.status} ${await res.text().catch(() => "")}`);
  const kernelId = ((await res.json()) as { id: string }).id;

  const wsSession = crypto.randomUUID();
  const wsUrl = gw.baseUrl.replace(/^http/, "ws") + `/api/kernels/${kernelId}/channels?token=${gw.token}`;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `token ${gw.token}` } });
  const k: LiveKernel = {
    boardId, nodeId, baseUrl: gw.baseUrl, token: gw.token, kernelId, ws, wsSession,
    status: "starting", pending: new Map(),
  };
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });
  ws.on("message", (raw) => onKernelMessage(k, raw));
  ws.on("close", () => {
    k.status = "dead";
    clearIdleReap(k);
    for (const p of k.pending.values()) p.resolve({ execCount: p.execCount, outputs: p.outputs, errored: true });
    k.pending.clear();
    publishKernel(boardId, nodeId, { status: "dead" });
  });
  k.status = "idle";
  liveKernels().set(key, k);
  armIdleReap(k); // idle from birth — start the reap clock (every Run re-arms it)
  publishKernel(boardId, nodeId, { status: "idle", kernelId });
  return k;
}

// Send one cell's source for execution and resolve when it goes idle, collecting nbformat outputs.
function executeCell(k: LiveKernel, code: string, cellId: string): Promise<{ execCount: number | null; outputs: NbOutput[]; errored: boolean }> {
  const msgId = crypto.randomUUID();
  const header = {
    msg_id: msgId, session: k.wsSession, username: "canvas", msg_type: "execute_request",
    version: "5.3", date: new Date().toISOString(),
  };
  const msg = {
    header, parent_header: {}, metadata: {}, channel: "shell", buffers: [],
    content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
  };
  return new Promise((resolve) => {
    k.pending.set(msgId, { cellId, outputs: [], execCount: null, resolve });
    k.status = "busy";
    clearIdleReap(k); // active again — cancel any pending reap; onKernelMessage re-arms when it goes idle
    k.ws.send(JSON.stringify(msg));
  });
}

// ── the public engine surface (called by routes/kernel.ts) ──────────────────────────────────────────

export interface KernelRunResult {
  ok: boolean;
  ran: number;
  execCount?: number | null;
  errored?: boolean;
  cellId?: string;
  error?: string;
  writeback?: string; // "ok" | "stale-cell" | "error" for the last cell written
}

// Run ONE cell (by cellId if given & present, else by cellIndex among the document's cells). Normalizes cell
// ids first, executes, then merges outputs into the file by id under CAS.
export async function runOneCell(
  boardId: string, nodeId: string, appDir: string, rootDir: string, relPath: string,
  sel: { cellId?: string; cellIndex?: number },
): Promise<KernelRunResult> {
  const abs = resolveNotebookPath(rootDir, relPath);
  if (!abs) return { ok: false, ran: 0, error: "notebook not found" };
  const k = await ensureKernel(boardId, nodeId, appDir);
  const norm = ensureCellIds(abs);
  if (!norm) return { ok: false, ran: 0, error: "could not read notebook" };
  const cells = norm.nb.cells;
  let cell = sel.cellId ? cells.find((c) => c.id === sel.cellId) : undefined;
  if (!cell && sel.cellIndex != null) cell = cells[sel.cellIndex];
  if (!cell) return { ok: false, ran: 0, error: "cell not found" };
  if (cell.cell_type !== "code") return { ok: true, ran: 0, cellId: cell.id }; // nothing to run
  const code = joinMaybe(cell.source);
  const r = await executeCell(k, code, cell.id!);
  const wb = mergeCellOutputs(abs, cell.id!, r.outputs, r.execCount);
  publishKernel(boardId, nodeId, { status: k.status, lastCellId: cell.id, execCount: r.execCount, errored: r.errored, done: true });
  return { ok: true, ran: 1, cellId: cell.id, execCount: r.execCount, errored: r.errored, writeback: wb };
}

// Run ALL code cells in document order, merging each cell's outputs as it completes. Stops early on a cell
// error (Run-All semantics), leaving later cells' outputs untouched.
export async function runAllCells(
  boardId: string, nodeId: string, appDir: string, rootDir: string, relPath: string,
): Promise<KernelRunResult> {
  const abs = resolveNotebookPath(rootDir, relPath);
  if (!abs) return { ok: false, ran: 0, error: "notebook not found" };
  const k = await ensureKernel(boardId, nodeId, appDir);
  const norm = ensureCellIds(abs);
  if (!norm) return { ok: false, ran: 0, error: "could not read notebook" };
  const codeCells = norm.nb.cells.filter((c) => c.cell_type === "code" && c.id);
  let ran = 0;
  let errored = false;
  for (const cell of codeCells) {
    const code = joinMaybe(cell.source);
    const r = await executeCell(k, code, cell.id!);
    mergeCellOutputs(abs, cell.id!, r.outputs, r.execCount);
    ran++;
    if (r.errored) { errored = true; break; } // Run-All stops at the first error
  }
  publishKernel(boardId, nodeId, { status: k.status, done: true, ranAll: true, errored });
  return { ok: true, ran, errored };
}

// Interrupt the running cell (SIGINT-equivalent → KeyboardInterrupt in the kernel).
export async function interruptKernel(boardId: string, nodeId: string): Promise<KernelRunResult> {
  const k = liveKernels().get(kernelKey(boardId, nodeId));
  if (!k) return { ok: false, ran: 0, error: "no live kernel" };
  const res = await gatewayFetch(k.baseUrl, k.token, `/api/kernels/${k.kernelId}/interrupt`, { method: "POST" });
  publishKernel(boardId, nodeId, { status: k.status, interrupted: true });
  return { ok: res.ok, ran: 0, error: res.ok ? undefined : `interrupt failed: ${res.status}` };
}

// Restart the kernel (fresh namespace, same kernel id). Clears in-flight state.
export async function restartKernel(boardId: string, nodeId: string): Promise<KernelRunResult> {
  const k = liveKernels().get(kernelKey(boardId, nodeId));
  if (!k) return { ok: false, ran: 0, error: "no live kernel" };
  for (const p of k.pending.values()) p.resolve({ execCount: p.execCount, outputs: p.outputs, errored: true });
  k.pending.clear();
  const res = await gatewayFetch(k.baseUrl, k.token, `/api/kernels/${k.kernelId}/restart`, { method: "POST" });
  k.status = "idle";
  armIdleReap(k); // back to idle after a restart — restart the reap clock
  publishKernel(boardId, nodeId, { status: "idle", restarted: true });
  return { ok: res.ok, ran: 0, error: res.ok ? undefined : `restart failed: ${res.status}` };
}

// Shut down the kernel and forget it (DELETE on the gateway + close the WS). The gateway sidecar stays up.
export async function shutdownKernel(boardId: string, nodeId: string): Promise<KernelRunResult> {
  const key = kernelKey(boardId, nodeId);
  const k = liveKernels().get(key);
  if (!k) return { ok: true, ran: 0 };
  liveKernels().delete(key);
  clearIdleReap(k);
  try { k.ws.close(); } catch { /* already closed */ }
  const res = await gatewayFetch(k.baseUrl, k.token, `/api/kernels/${k.kernelId}`, { method: "DELETE" }).catch(() => null);
  publishKernel(boardId, nodeId, { status: "dead", shutdown: true });
  return { ok: !!res && res.ok, ran: 0 };
}
