// The SessionProc seam (plain ESM, runs under node --test; imported by vite-fs-plugin.ts): the dev
// server's view of a live session's PROCESS, abstracted so who OWNS the process is swappable —
//
//   localProc  — today's model: the dev server spawns and owns the child; it dies with the server.
//   remoteProc — the session-host model: the sidecar owns the child; the dev server is a client, and the
//                child SURVIVES a dev-server restart (added with the session-host client).
//
// The seam is deliberately tiny — it is exactly the four things the plugin ever did with a raw child:
// write a stdin line, kill, observe stdout lines, observe exit. Everything else (event folding, feeds,
// markers, nudges) stays above the seam, identical in both modes.

import { spawn } from "node:child_process";
import { makeLineSplitter } from "./session-host-protocol.js";

/**
 * Spawn and own a child in-process. `hooks.onLine` gets each non-blank stdout line; `hooks.onExit` fires
 * once with the reason: "killed" when our own kill() asked for it, else "self" (the child died on its
 * own — a spawn error surfaces the same way, matching how the remote host reports a failed spawn).
 */
export function localProc({ cmd, args, cwd, env }, hooks) {
  // `env` EXTENDS our environment (never replaces it — the child still needs PATH/HOME); used for
  // per-spawn knobs like MCP_TOOL_TIMEOUT (the permission relay's hold margin).
  const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : undefined });
  let alive = true;
  let killedByUs = false;
  let exited = false; // exit + error can both fire — the hook is once
  const exit = (code) => {
    if (exited) return;
    exited = true;
    alive = false;
    hooks.onExit({ code, reason: killedByUs ? "killed" : "self" });
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", makeLineSplitter(hooks.onLine));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {}); // drained so the pipe never blocks; not shown on the canvas
  child.on("exit", (code) => exit(code));
  child.on("error", () => exit(null));
  return {
    kind: "local",
    get alive() {
      return alive;
    },
    write(jsonLine) {
      if (!alive) return false;
      child.stdin.write(jsonLine + "\n");
      return true;
    },
    kill() {
      if (!alive) return;
      killedByUs = true;
      child.kill();
    },
  };
}

/**
 * A proc whose child lives in the session-host sidecar — the shape localProc has, over the client's
 * wire. Pass `opts.spawn` to start a NEW child; omit it to ADOPT one already running in the host (the
 * dev-server-restart path). Exit (any reason, including a spawn failure) unregisters the hooks and flips
 * `alive`; the reason flows through untouched — "shutdown" only exists on this side of the seam.
 */
export function remoteProc(client, id, hooks, opts) {
  let alive = true;
  client.attach(id, {
    onLine: (line) => hooks.onLine(line),
    onExit: (info) => {
      alive = false;
      hooks.onExit(info);
    },
  });
  if (opts?.spawn) client.spawnSession(id, opts.spawn);
  return {
    kind: "remote",
    get alive() {
      return alive;
    },
    write(jsonLine) {
      if (!alive) return false;
      return client.writeSession(id, jsonLine);
    },
    kill() {
      if (!alive) return;
      client.killSession(id);
    },
  };
}
