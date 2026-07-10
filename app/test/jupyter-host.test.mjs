import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectPythonEnv, probeGateway } from "../jupyter-host.js";
import { jupyterRendezvousPath, jupyterHostLogPath, appDirKey } from "../jupyter-host-protocol.js";

// The Jupyter kernel-gateway sidecar (jupyter-host.js) — the thin per-app-checkout manager that launches a
// detached `jupyter kernelgateway` on demand and records it in a tmpdir rendezvous. These cover the pure /
// fs-only surface (env detection priority, rendezvous keying, a dead-gateway probe); the live launch + kernel
// round-trip is covered by the end-to-end proof in the thread (a real notebook run, outputs persisted).

// A throwaway dir with a fake `.venv/bin/jupyter` executable file.
function tmpRepo(withVenv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jup-host-test-"));
  if (withVenv) {
    fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", "bin", "jupyter"), "#!/bin/sh\n");
  }
  return dir;
}

test("detectPythonEnv prefers the repo .venv when present", () => {
  const repo = tmpRepo(true);
  const env = detectPythonEnv(path.join(repo, "app"), repo);
  assert.equal(env.jupyter, path.join(repo, ".venv", "bin", "jupyter"));
  assert.equal(env.cwd, repo);
  assert.match(env.label, /\.venv/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("detectPythonEnv defaults repoRoot to the app checkout's parent", () => {
  const repo = tmpRepo(true);
  // No explicit repoRoot → derived as dirname(appDir); appDir = <repo>/app so repoRoot = <repo>.
  const env = detectPythonEnv(path.join(repo, "app"));
  assert.equal(env.jupyter, path.join(repo, ".venv", "bin", "jupyter"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("detectPythonEnv throws an actionable error when no env is found", () => {
  const repo = tmpRepo(false);
  // Point PATH at an empty dir so the system-jupyter fallback also misses (no `jupyter` anywhere).
  const savedPath = process.env.PATH;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));
  process.env.PATH = empty;
  try {
    assert.throws(() => detectPythonEnv(path.join(repo, "app"), repo), /no Jupyter env found|uv venv/);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("jupyterRendezvousPath is app-dir-keyed, stable, and lives in tmpdir (not the checkout)", () => {
  const a = jupyterRendezvousPath("/some/app");
  const b = jupyterRendezvousPath("/some/app");
  const c = jupyterRendezvousPath("/other/app");
  assert.equal(a, b); // stable for one app dir
  assert.notEqual(a, c); // distinct per checkout
  assert.ok(a.startsWith(os.tmpdir())); // never inside the watched tree
  assert.ok(a.includes(appDirKey("/some/app")));
});

test("jupyterHostLogPath sits next to the app dir and is a .log (gitignored)", () => {
  assert.equal(jupyterHostLogPath("/some/app"), path.join("/some/app", ".jupyter-host.log"));
});

test("probeGateway resolves false for a gateway that isn't listening", async () => {
  // Port 1 is privileged/unused — nothing answers, so the probe must resolve false (never hang/throw).
  assert.equal(await probeGateway("http://127.0.0.1:1", "any-token", 500), false);
});
