// jupyter-host-protocol.js — the tiny shared vocabulary for the Jupyter kernel-gateway sidecar (plain
// ESM, runs under bare `node` + node --test; shared by jupyter-host.js and the vite fs-plugin broker).
//
// UNLIKE the session host (a unix-socket ndjson protocol the dev server attaches to), the jupyter sidecar
// is a plain long-lived process — a `jupyter kernelgateway` — that the broker reaches over HTTP/WS. So the
// "protocol" here is just the RENDEZVOUS: a small JSON file in os.tmpdir() recording where the gateway is
// (host/port/token/pid) so a re-eval'd or restarted dev server finds the already-running gateway instead of
// orphaning it. Keyed by the resolved app dir, exactly like sessionHostSocketPath — one gateway per app
// checkout, matching one dev server per checkout — and living in tmpdir, NOT the watched tree (a JSON file
// churned inside the repo would fire the file-watch and, if under a shadow-git dir, corrupt the ledger).

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

// A short, stable key for this app checkout — the same hashing sessionHostSocketPath uses, so parallel
// checkouts (worktrees on alt ports) stay isolated and never collide on one gateway.
export function appDirKey(appDir) {
  return crypto.createHash("sha256").update(path.resolve(appDir)).digest("hex").slice(0, 12);
}

// The gateway rendezvous file: `{ baseUrl, token, pid, startedAt }`. In tmpdir (not the checkout — a file
// churned in the watched tree fires chokidar/Vite and, under a shadow-git dir, corrupts the ledger).
export function jupyterRendezvousPath(appDir) {
  return path.join(os.tmpdir(), `canvas-jupyter-host-${appDirKey(appDir)}.json`);
}

// The gateway's log file, next to the session-host log. `*.log` is already gitignored.
export function jupyterHostLogPath(appDir) {
  return path.join(appDir, ".jupyter-host.log");
}
