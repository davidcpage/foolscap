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

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import { getServerContext } from "./server-context.js";
import { transformNotebook } from "./ipynb-codec.js";
import { contentVersion, isStaleWrite } from "./cas-guard.js";
import { safeResolve, fileVersion } from "./server-fs.js";
import { MAX_NOTEBOOK_BYTES } from "./server-http.js";
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
}

const kernelKey = (boardId: string, nodeId: string) => `${boardId}\0${nodeId}`;

function liveKernels(): Map<string, LiveKernel> {
  const { fsState } = getServerContext() as unknown as { fsState: { liveKernels?: Map<string, LiveKernel> } };
  return (fsState.liveKernels ??= new Map());
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

function joinMaybe(v: unknown): string {
  return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
}

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

// A short, collision-resistant nbformat cell id (nbformat 4.5+). Kept ≤ the spec's suggested length.
function newCellId(): string {
  return crypto.randomBytes(6).toString("hex");
}

// ── notebook file read / normalize / write-back ─────────────────────────────────────────────────────

interface Notebook {
  cells: Array<{ id?: string; cell_type?: string; source?: unknown; outputs?: unknown; execution_count?: unknown }>;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function resolveNotebookPath(rootDir: string, relPath: string): string | null {
  const abs = safeResolve(rootDir, relPath);
  if (!abs) return null;
  if (path.extname(abs).toLowerCase() !== ".ipynb") return null;
  return abs;
}

function readNotebook(abs: string): { nb: Notebook; version: string | null } | null {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  let nb: Notebook;
  try {
    nb = JSON.parse(text);
  } catch {
    return null;
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) return null;
  return { nb, version: contentVersion(text) };
}

// Serialize a notebook object through the FULL-FIDELITY codec projection — the ONLY sanctioned write path
// (strips the render-only `metadata.__foolscap`, validates shape, never elides). CAS-write with the given
// baseVersion; returns "ok" | "stale" | "error". Small check-then-write race window is tolerated (all writes
// for one kernel are serialized upstream; the CAS defends against EXTERNAL concurrent writes only).
function casWriteNotebook(abs: string, nb: Notebook, baseVersion: string | null): "ok" | "stale" | "error" {
  const { content, parsed } = transformNotebook(JSON.stringify(nb), { mode: "full" });
  if (!parsed) return "error";
  if (Buffer.byteLength(content, "utf8") > MAX_NOTEBOOK_BYTES) return "error";
  if (isStaleWrite(baseVersion, fileVersion(abs))) return "stale";
  try {
    fs.writeFileSync(abs, content, "utf8");
    return "ok";
  } catch {
    return "error";
  }
}

// Ensure every cell carries an nbformat id (4.5+). Older notebooks (incl. the demo) omit them, but write-back
// keys on cell id — so we normalize once and persist. Returns the (id-bearing) notebook + current version, or
// null on a read/parse failure. Persists via CAS; a lost race just means someone else beat us — re-read.
function ensureCellIds(abs: string): { nb: Notebook; version: string | null } | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = readNotebook(abs);
    if (!read) return null;
    const { nb, version } = read;
    let changed = false;
    const seen = new Set<string>();
    for (const cell of nb.cells) {
      if (!cell.id || seen.has(cell.id)) {
        cell.id = newCellId();
        changed = true;
      }
      seen.add(cell.id);
    }
    if (!changed) return read;
    const r = casWriteNotebook(abs, nb, version);
    if (r === "ok") return { nb, version: contentVersion(transformNotebook(JSON.stringify(nb), { mode: "full" }).content) };
    if (r === "error") return null;
    // stale → an external write landed; loop and re-read.
  }
  return readNotebook(abs); // give up normalizing under contention; serve what's there
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
    pending.resolve({
      execCount: pending.execCount,
      outputs: pending.outputs,
      errored: pending.outputs.some((o) => o.output_type === "error"),
    });
  }
}

// Start (or reuse) the kernel for one notebook. Ensures the gateway is up, creates a kernel, opens the
// upstream WS, and wires message routing. Throws on env/gateway failure (the route turns it into 5xx/blocker).
async function ensureKernel(boardId: string, nodeId: string, appDir: string): Promise<LiveKernel> {
  const key = kernelKey(boardId, nodeId);
  const existing = liveKernels().get(key);
  if (existing && existing.status !== "dead" && existing.ws.readyState === WebSocket.OPEN) return existing;
  if (existing) liveKernels().delete(key); // dead/closed — replace

  const gw = await ensureGateway(appDir); // { baseUrl, token }
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
    for (const p of k.pending.values()) p.resolve({ execCount: p.execCount, outputs: p.outputs, errored: true });
    k.pending.clear();
    publishKernel(boardId, nodeId, { status: "dead" });
  });
  k.status = "idle";
  liveKernels().set(key, k);
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
  publishKernel(boardId, nodeId, { status: "idle", restarted: true });
  return { ok: res.ok, ran: 0, error: res.ok ? undefined : `restart failed: ${res.status}` };
}

// Shut down the kernel and forget it (DELETE on the gateway + close the WS). The gateway sidecar stays up.
export async function shutdownKernel(boardId: string, nodeId: string): Promise<KernelRunResult> {
  const key = kernelKey(boardId, nodeId);
  const k = liveKernels().get(key);
  if (!k) return { ok: true, ran: 0 };
  liveKernels().delete(key);
  try { k.ws.close(); } catch { /* already closed */ }
  const res = await gatewayFetch(k.baseUrl, k.token, `/api/kernels/${k.kernelId}`, { method: "DELETE" }).catch(() => null);
  publishKernel(boardId, nodeId, { status: "dead", shutdown: true });
  return { ok: !!res && res.ok, ran: 0 };
}
