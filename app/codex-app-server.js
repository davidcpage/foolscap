// Codex app-server's newline-delimited JSON-RPC peer. This is deliberately below Foolscap session
// semantics: it owns connection initialization, request correlation, notifications, and server-initiated
// requests, while codex-session-router.js owns canvas-sid <-> Codex-thread multiplexing.
//
// App-server omits the JSON-RPC "jsonrpc":"2.0" field on the wire. Requests and server requests both
// carry ids; responses are distinguished by result/error, notifications by method without id.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLineSplitter } from "./session-host-protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_INFO = { name: "foolscap_canvas", title: "Foolscap Canvas", version: "0.1.0" };

export function resolveCodexCommand() {
  const candidates = [
    process.env.CANVAS_CODEX_COMMAND,
    ...String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "codex")),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking; app launches commonly have a much smaller PATH than an interactive shell.
    }
  }
  throw new CodexAppServerError(
    "Codex executable not found; install it, add it to PATH, or set CANVAS_CODEX_COMMAND",
  );
}

export class CodexAppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexAppServerError";
    Object.assign(this, details);
  }
}

/**
 * Build the protocol peer over an arbitrary line transport. Tests use this directly; the real child
 * wrapper below supplies writeLine from stdin and feeds receiveLine from stdout.
 */
export function createCodexAppServerPeer({
  writeLine,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  clientInfo = DEFAULT_CLIENT_INFO,
  capabilities = {},
}) {
  let nextId = 0;
  let closed = false;
  let requestHandler = null;
  const pending = new Map();
  const notificationListeners = new Set();
  const closeListeners = new Set();

  const send = (message) => {
    if (closed) throw new CodexAppServerError("Codex app-server connection is closed");
    writeLine(JSON.stringify(message));
  };

  const request = (method, params = {}) => {
    if (closed) return Promise.reject(new CodexAppServerError("Codex app-server connection is closed", { method }));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodexAppServerError(`Codex app-server request timed out: ${method}`, { method, id }));
      }, requestTimeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        send({ method, id, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  };

  const notify = (method, params = {}) => send({ method, params });

  const respondToServerRequest = async (message) => {
    try {
      if (!requestHandler)
        throw new CodexAppServerError(`No handler for app-server request ${message.method}`, {
          method: message.method,
          id: message.id,
        });
      const result = await requestHandler(message);
      if (!closed) send({ id: message.id, result: result ?? {} });
    } catch (err) {
      if (closed) return;
      send({
        id: message.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  const receive = (message) => {
    if (!message || typeof message !== "object") return;
    // A response to one of our requests. Check the pending map first: server-request ids live in the
    // opposite direction and are allowed to use the same primitive JSON types.
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const p = pending.get(message.id);
      if (!p) return; // a late response after timeout/close, or an unrelated frame
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) {
        p.reject(new CodexAppServerError(message.error.message || `Codex app-server request failed: ${p.method}`, {
          method: p.method,
          id: message.id,
          code: message.error.code,
          data: message.error.data,
        }));
      } else {
        p.resolve(message.result);
      }
      return;
    }
    // Bidirectional request: approval, tool user input, MCP elicitation, token refresh, etc.
    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      void respondToServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of notificationListeners) listener(message);
    }
  };

  const receiveLine = (line) => {
    try {
      receive(JSON.parse(line));
    } catch {
      // stdout is a protocol stream; a malformed/non-JSON line is ignored rather than taking down every
      // loaded thread. stderr is drained separately by the child wrapper.
    }
  };

  const close = (reason = new CodexAppServerError("Codex app-server connection closed")) => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    pending.clear();
    for (const listener of closeListeners) listener(reason);
  };

  const ready = (async () => {
    const result = await request("initialize", { clientInfo, capabilities });
    notify("initialized", {});
    return result;
  })();
  // The owner may attach after the child has already failed. Preserve the rejecting promise for callers,
  // but mark it observed here so a startup race cannot become an unhandled rejection.
  void ready.catch(() => {});

  return {
    ready,
    request,
    notify,
    receiveLine,
    close,
    get closed() { return closed; },
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    setRequestHandler(handler) {
      requestHandler = handler;
    },
  };
}

/** Spawn one shared app-server process. The returned peer is ready after the mandatory handshake. */
export function spawnCodexAppServer({
  command,
  args = ["app-server", "--stdio"],
  cwd = process.cwd(),
  env,
  requestTimeoutMs,
  clientInfo,
  capabilities,
  spawnProcess = spawn,
} = {}) {
  command ??= resolveCodexCommand();
  const child = spawnProcess(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : undefined,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {}); // never let diagnostics block the protocol child

  const peer = createCodexAppServerPeer({
    writeLine: (line) => child.stdin.write(line + "\n"),
    requestTimeoutMs,
    clientInfo,
    capabilities,
  });
  child.stdout.on("data", makeLineSplitter(peer.receiveLine));
  let alive = true;
  let killedByUs = false;
  let exited = false;
  const finish = (code, signal, error) => {
    if (exited) return;
    exited = true;
    alive = false;
    peer.close(new CodexAppServerError(error ? `Failed to run Codex app-server: ${error}` : "Codex app-server exited", {
      code,
      signal,
      reason: killedByUs ? "killed" : "self",
    }));
  };
  child.on("exit", (code, signal) => finish(code, signal, null));
  child.on("error", (err) => finish(null, null, String(err)));

  return {
    ready: peer.ready,
    request: peer.request,
    notify: peer.notify,
    receiveLine: peer.receiveLine,
    close: peer.close,
    onNotification: peer.onNotification,
    onClose: peer.onClose,
    setRequestHandler: peer.setRequestHandler,
    pid: child.pid,
    get closed() { return peer.closed; },
    get alive() { return alive; },
    kill() {
      if (!alive) return;
      killedByUs = true;
      child.kill();
    },
  };
}
