// jupyter-host.js — the Jupyter kernel-gateway sidecar manager (plain ESM; runs under bare `node` +
// node --test). The COUSIN of session-host.js: same "a long-lived process outlives the dev server"
// intent, but a MUCH thinner shape. session-host owns `claude -p` children over a unix-socket protocol;
// this owns exactly ONE process — a `jupyter kernelgateway` — that the broker reaches over plain HTTP/WS.
// So there is no attach protocol here: the sidecar IS the gateway, kernels are created/killed through the
// gateway's own REST API, and the only durable state is a RENDEZVOUS file (jupyter-host-protocol.js)
// recording where the gateway lives so a re-eval'd/restarted dev server re-finds it instead of orphaning it.
//
// Lifecycle mirrors the session host's spirit: START-ON-DEMAND (the broker calls ensureGateway() the first
// time a notebook runs a cell), PROBE + RECLAIM-STALE (a rendezvous whose gateway is dead is reclaimed),
// spawn DETACHED + unref (survives a dev-server re-eval — Vite re-evaluates the plugin module on config
// change without killing detached grandchildren), and a `--stop` verb (`npm run jupyter-host:stop`). The
// kernel need NOT survive a dev-server *restart* for this cut (approved) — a dead gateway is simply
// re-launched on the next run.

import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { jupyterRendezvousPath, jupyterHostLogPath } from "./jupyter-host-protocol.js";

// How long to wait for a freshly-spawned gateway to answer `GET /api` before giving up (ms). A cold
// kernelgateway import is a second or two; be generous — a slow first import must not read as "failed".
const GATEWAY_START_TIMEOUT_MS = 30000;
const GATEWAY_POLL_INTERVAL_MS = 200;

// ── env detection ───────────────────────────────────────────────────────────────────────────────────
// Resolve the Python env the gateway runs in, in the planned priority order: repo `.venv` → poetry →
// conda → system `jupyter` on PATH. Returns { jupyter, cwd, label } — `jupyter` is the executable to spawn,
// `cwd` is where kernels run (repo root, so a notebook's relative imports/paths resolve). Throws with an
// actionable message if nothing usable is found (the broker turns that into a human/env blocker surface).
// repoRoot defaults to the app checkout's parent (`<repo>/app` → `<repo>`), which is where `uv venv` put it.
export function detectPythonEnv(appDir, repoRoot = path.dirname(path.resolve(appDir))) {
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  // 1) repo .venv (the human's choice; what `uv venv && uv pip install …` produces)
  const venvJup = path.join(repoRoot, ".venv", "bin", "jupyter");
  if (isFile(venvJup)) return { jupyter: venvJup, cwd: repoRoot, label: `repo .venv (${venvJup})` };

  // 2) conda — an activated env exposes CONDA_PREFIX; trust its bin/jupyter if present.
  if (process.env.CONDA_PREFIX) {
    const condaJup = path.join(process.env.CONDA_PREFIX, "bin", "jupyter");
    if (isFile(condaJup)) return { jupyter: condaJup, cwd: repoRoot, label: `conda (${condaJup})` };
  }

  // 3) poetry — only if the repo declares it (pyproject.toml) AND `poetry` resolves an env path.
  if (isFile(path.join(repoRoot, "pyproject.toml"))) {
    try {
      const out = execFileSync("poetry", ["env", "info", "-p"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const poJup = path.join(out.trim(), "bin", "jupyter");
      if (isFile(poJup)) return { jupyter: poJup, cwd: repoRoot, label: `poetry (${poJup})` };
    } catch {
      /* no poetry / no env — fall through */
    }
  }

  // 4) system jupyter on PATH (the `GET /api/kernelspecs` fallback the design allows).
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of pathDirs) {
    const sysJup = path.join(d, "jupyter");
    if (isFile(sysJup)) return { jupyter: sysJup, cwd: repoRoot, label: `system (${sysJup})` };
  }

  throw new Error(
    `no Jupyter env found for ${repoRoot}: expected ${venvJup} (create it with \`uv venv && uv pip install jupyter_kernel_gateway ipykernel\`), a conda env, a poetry env, or \`jupyter\` on PATH`,
  );
}

// ── rendezvous + probe ──────────────────────────────────────────────────────────────────────────────

function readRendezvous(appDir) {
  const p = jupyterRendezvousPath(appDir);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeRendezvous(appDir, rec) {
  fs.writeFileSync(jupyterRendezvousPath(appDir), JSON.stringify(rec));
}

function clearRendezvous(appDir) {
  try {
    fs.unlinkSync(jupyterRendezvousPath(appDir));
  } catch {
    /* already gone */
  }
}

// Probe a gateway: resolve true iff `GET {baseUrl}/api` answers 200 with the right token. A gateway whose
// pid is gone (unclean death) fails the fetch → treated as dead → reclaimed.
export function probeGateway(baseUrl, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const u = new URL("/api", baseUrl);
    const req = http.get(
      u,
      { headers: { Authorization: `token ${token}` }, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Ask the OS for a free TCP port by binding :0 and reading it back, then release it. A tiny TOCTOU race
// (someone grabs the port before the gateway binds) is acceptable for a local dev sidecar — the caller
// retries on a failed start.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── launch ──────────────────────────────────────────────────────────────────────────────────────────

async function launchGateway(appDir, logPath) {
  const env = detectPythonEnv(appDir);
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("hex");
  const logFd = fs.openSync(logPath, "a");

  const args = [
    "kernelgateway",
    "--KernelGatewayApp.ip=127.0.0.1",
    `--KernelGatewayApp.port=${port}`,
    `--KernelGatewayApp.auth_token=${token}`,
    // Same-origin only in practice (the broker connects server-side), but the browser never sees this port
    // and the token gates every call — allow_origin is moot for the server-side client.
    "--KernelGatewayApp.allow_origin=*",
  ];

  // Detached + unref: the gateway becomes its own process-group leader and the dev server does NOT wait on
  // it, so a Vite plugin re-eval (which re-imports this module) leaves the running gateway untouched — the
  // next ensureGateway() re-discovers it through the rendezvous instead of spawning a second one.
  const child = spawn(env.jupyter, args, {
    cwd: env.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  const baseUrl = `http://127.0.0.1:${port}`;
  // Poll until the gateway answers (or the deadline / child death). A gateway that dies during startup
  // (bad env, port stolen) trips the exit flag and we fail fast rather than block the whole timeout.
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + GATEWAY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`jupyter kernelgateway exited during startup — see ${logPath}`);
    if (await probeGateway(baseUrl, token)) {
      const rec = { baseUrl, token, pid: child.pid, envLabel: env.label, startedAt: Date.now() };
      writeRendezvous(appDir, rec);
      return rec;
    }
    await new Promise((r) => setTimeout(r, GATEWAY_POLL_INTERVAL_MS));
  }
  try {
    process.kill(child.pid);
  } catch {
    /* already gone */
  }
  throw new Error(`jupyter kernelgateway did not come up within ${GATEWAY_START_TIMEOUT_MS}ms — see ${logPath}`);
}

// In-flight guard: concurrent ensureGateway() calls (two notebooks running a cell at once on first use)
// must not race two gateways into existence. Keyed by app dir so parallel checkouts stay independent.
const launching = new Map();

/**
 * Ensure a gateway is live for this app checkout and return { baseUrl, token, pid, envLabel }. Probes the
 * rendezvous first (re-uses a survivor), reclaims a stale one, else launches. The broker's single entry point.
 */
export async function ensureGateway(appDir) {
  const existing = readRendezvous(appDir);
  if (existing && (await probeGateway(existing.baseUrl, existing.token))) return existing;
  if (existing) clearRendezvous(appDir); // stale — reclaim before relaunch

  if (launching.has(appDir)) return launching.get(appDir);
  const p = launchGateway(appDir, jupyterHostLogPath(appDir)).finally(() => launching.delete(appDir));
  launching.set(appDir, p);
  return p;
}

/**
 * Stop the gateway for this app checkout: kill the pid recorded in the rendezvous and clear it. The
 * explicit stop-everything verb (`--stop`); idempotent — a no-op if nothing is running.
 */
export async function stopGateway(appDir) {
  const rec = readRendezvous(appDir);
  clearRendezvous(appDir);
  if (!rec || !rec.pid) return false;
  try {
    process.kill(rec.pid);
    return true;
  } catch {
    return false; // already dead
  }
}

// CLI: `node jupyter-host.js --stop` stops the gateway for THIS app checkout (keyed off this file's dir,
// like session-host). No bare-run mode — the gateway is launched on demand by the broker, not hand-started.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const appDir = new URL(".", import.meta.url).pathname;
  if (process.argv.includes("--stop")) {
    const stopped = await stopGateway(appDir);
    console.log(stopped ? "jupyter gateway stopped" : "no jupyter gateway running");
  } else {
    console.log("jupyter-host is launched on demand by the dev-server broker; use --stop to stop it");
  }
}
