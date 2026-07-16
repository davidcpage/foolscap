// The session host: a small long-lived sidecar that OWNS the `claude -p` children, so the dev server can
// restart without killing the agent sessions that are implementing/testing the very change being tested.
// (Plain ESM, runs under bare `node` and node --test; the tmux model — a background server owns the
// processes, clients attach.)
//
// The dev server attaches as a client over a unix socket (ndjson, session-host-protocol.js) and speaks:
//
//   client → host   {op:"hello", req, ver, pid}       → reply {ok,pid,ver} | {ok:false,error:"busy",clientPid}
//                   {op:"spawn", req, id, cmd, args, cwd, env?} → reply {ok,pid} | {ok:false,error}
//                   {op:"write", req?, id, data}      → reply {ok:false,error:"not-alive"} only on a dead id
//                   {op:"answer-request", id, requestId, answer} → settle a Codex human gate
//                   {op:"usage", req}                → ChatGPT account + app-server rate-limit snapshot
//                   {op:"kill",  req, id}             → SIGTERM; the exit records reason:"killed"
//                   {op:"list",  req}                 → reply {ok, sessions:[{id,cwd,busy,spawnedAt,pid}],
//                                                              exits:[{id,cwd,code,signal,ts,reason}]}
//                   {op:"ack-exits", req, ids}        → prune delivered exit-backlog entries
//   host → client   {op:"line", id, line}             (one child-stdout line, pre-split)
//                   {op:"exit", id, cwd, code, signal, ts, reason:"self"|"killed"|"shutdown"}
//
// Semantics the client relies on:
// - ONE attached client. A second `hello` is rejected `busy` — two dev servers double-driving the same
//   stdin (heartbeats, nudges) is the 5173/5174 footgun; first wins, no takeover.
// - The BUSY BIT: busy=true on a user-message write, busy=false on a stdout `result` line (protocol
//   helpers). Reported in `list` so an adopting dev server never guesses "idle" for a mid-turn session
//   (a wrong idle would let the nudge machinery inject stdin mid-turn, interrupting it).
// - Exit REASON is the remote-mode `shuttingDown` guard: only "self" means the child died on its own
//   (→ crashed); "killed" was a client kill; "shutdown" was this host stopping (SIGINT/SIGTERM kills all
//   children — stopping the sidecar IS the explicit "stop everything" verb, like tmux kill-server).
// - NO stdout buffering while detached: completed turns are already durable in the session's transcript
//   .jsonl (the adoption seed); only exits are backlogged (capped) so crashes-while-detached still stamp.

import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createCodexHostRuntime } from "./codex-host-runtime.js";
import {
  PROTOCOL_VERSION,
  makeLineSplitter,
  isResultLine,
  isUserWrite,
  sessionHostSocketPath,
  sessionHostLogPath,
} from "./session-host-protocol.js";

const MAX_EXIT_BACKLOG = 200;

/** Probe a socket path: resolves "live" (a host answered), "dead" (stale file), or "absent". */
function probeSocket(socketPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve("absent");
    const c = net.connect(socketPath);
    c.once("connect", () => {
      c.destroy();
      resolve("live");
    });
    c.once("error", () => resolve("dead"));
  });
}

/**
 * Start the host. Resolves once listening; rejects if another host already owns the socket. The returned
 * handle is for tests and the CLI — the protocol is the real interface.
 */
export async function createHost({ socketPath, logPath, codexRuntimeFactory = createCodexHostRuntime }) {
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      /* logging is never fatal */
    }
    if (process.stdout.isTTY) process.stdout.write(line);
  };

  const probe = await probeSocket(socketPath);
  if (probe === "live") throw new Error(`another session host is live on ${socketPath}`);
  if (probe === "dead") fs.unlinkSync(socketPath); // stale socket from an unclean death — reclaim

  /** id → { child, cwd, busy, spawnedAt, killedByClient } */
  const children = new Map();
  /** id → one logical Codex thread multiplexed through the shared app-server runtime */
  const codexSessions = new Map();
  /** host request id -> provider-neutral human gate retained even while Vite is detached */
  const codexRequests = new Map();
  let codexRequestSeq = 0;
  /** deaths not yet delivered/acked: {id, cwd, code, signal, ts, reason} */
  const exits = [];
  const conns = new Set(); // every open conn — server.close() waits for them, so shutdown must destroy them
  let attached = null; // the one client conn
  let attachedPid = null;
  let shuttingDown = false;
  let codexRuntimePromise = null;

  const sendTo = (conn, msg) => {
    if (!conn || conn.destroyed) return;
    conn.write(JSON.stringify(msg) + "\n");
  };
  const event = (msg) => sendTo(attached, msg);

  const recordExit = (id, entry, code, signal) => {
    children.delete(id);
    const reason = shuttingDown ? "shutdown" : entry.killedByClient ? "killed" : "self";
    const rec = { id, cwd: entry.cwd, code, signal, ts: Date.now(), reason };
    if (attached && !attached.destroyed) {
      event({ op: "exit", ...rec });
    } else {
      exits.push(rec);
      if (exits.length > MAX_EXIT_BACKLOG) exits.splice(0, exits.length - MAX_EXIT_BACKLOG);
    }
    log(`exit ${id} code=${code} signal=${signal ?? "-"} reason=${reason}`);
  };

  const recordCodexExit = (id, entry, reasonOverride = null) => {
    if (!codexSessions.delete(id)) return;
    const reason = reasonOverride ?? (shuttingDown ? "shutdown" : entry.killedByClient ? "killed" : "self");
    const rec = { id, cwd: entry.cwd, code: null, signal: null, ts: Date.now(), reason, provider: "codex" };
    if (attached && !attached.destroyed) event({ op: "exit", ...rec });
    else {
      exits.push(rec);
      if (exits.length > MAX_EXIT_BACKLOG) exits.splice(0, exits.length - MAX_EXIT_BACKLOG);
    }
    log(`exit ${id} provider=codex reason=${reason}`);
  };

  const codexLine = (id, method, params = {}) =>
    event({ op: "line", id, line: JSON.stringify({ type: "codex_event", method, params }) });

  const requestsOf = (sid) => [...codexRequests.values()]
    .filter((r) => r.sid === sid)
    .map((r) => ({ requestId: r.requestId, ...r.request }));

  const settleCodexRequest = (requestId, answer, error = null) => {
    const pending = codexRequests.get(requestId);
    if (!pending) return false;
    codexRequests.delete(requestId);
    if (error) pending.reject(error);
    else pending.resolve(answer);
    codexLine(pending.sid, "canvas/request-resolved", { requestId });
    return true;
  };

  const onCodexEvent = (id, message) => {
    if (!id) return; // account/config scoped notifications do not belong to one session card
    const entry = codexSessions.get(id);
    if (!entry) return;
    if (message.method === "turn/started") entry.busy = true;
    else if (message.method === "turn/completed") entry.busy = false;
    else if (message.method === "thread/status/changed") {
      const type = message.params?.status?.type;
      if (type === "active") entry.busy = true;
      else if (type === "idle" || type === "notLoaded" || type === "systemError") entry.busy = false;
    }
    codexLine(id, message.method, message.params);
  };

  const getCodexRuntime = () => {
    if (codexRuntimePromise) return codexRuntimePromise;
    const starting = codexRuntimeFactory({
      cwd: new URL(".", import.meta.url).pathname,
      onEvent: onCodexEvent,
      onRequest: (sid, request) => new Promise((resolve, reject) => {
        const requestId = `codex-request-${++codexRequestSeq}`;
        codexRequests.set(requestId, { requestId, sid, request, resolve, reject });
        codexLine(sid, "canvas/request", { requestId, ...request });
      }),
      onClose: () => {
        codexRuntimePromise = null;
        for (const r of [...codexRequests.values()])
          settleCodexRequest(r.requestId, null, new Error("Codex app-server exited while awaiting a decision"));
        for (const [id, entry] of [...codexSessions]) recordCodexExit(id, entry);
      },
    });
    codexRuntimePromise = starting;
    void starting.catch(() => {
      if (codexRuntimePromise === starting) codexRuntimePromise = null;
    });
    return starting;
  };

  const doCodexSpawn = async (msg) => {
    const { id, cwd } = msg;
    if (children.has(id) || codexSessions.has(id)) return { ok: false, error: "id already live" };
    const entry = {
      cwd,
      busy: false,
      spawnedAt: Date.now(),
      killedByClient: false,
      providerSessionId: null,
    };
    codexSessions.set(id, entry);
    // The bind is async (getCodexRuntime + thread/start round-trip), but the client sends the first prompt
    // RIGHT AFTER the spawn reply (handleSessionSpawn), and writes have no queue of their own. Seed the
    // entry's per-sid serialization chain (`tail`) with the spawn promise so the first write waits for the
    // bind instead of racing it into router.prompt's "unknown canvas session" (findings 1, 7). Set it
    // SYNCHRONOUSLY (before the first await) so a write that arrives mid-spawn finds a tail to chain onto.
    const spawning = (async () => {
      const runtime = await getCodexRuntime();
      entry.pid = runtime.pid;
      const spec = {
        cwd,
        model: msg.model,
        reasoningEffort: msg.reasoningEffort,
        developerInstructions: msg.developerInstructions,
      };
      const bound = msg.resumeProviderId
        ? await runtime.resume(id, msg.resumeProviderId, spec)
        : await runtime.start(id, spec);
      entry.providerSessionId = bound.threadId;
      codexLine(id, "canvas/provider-bound", {
        provider: "codex",
        providerSessionId: bound.threadId,
        // The ACTUAL serving model the app-server resolved for this thread (from the thread/start response),
        // so a Codex spawn with no explicit model still reports what it ran and the card pill isn't blank.
        ...(bound.model ? { model: bound.model } : {}),
        account: runtime.account,
      });
      if (msg.resumeProviderId) {
        const history = await runtime.read(id);
        codexLine(id, "canvas/history", history);
      }
      return bound;
    })();
    entry.tail = spawning;
    try {
      const bound = await spawning;
      log(`spawn ${id} provider=codex thread=${bound.threadId} cwd=${cwd}`);
      return { ok: true, pid: entry.pid, provider: "codex", providerSessionId: bound.threadId };
    } catch (err) {
      codexSessions.delete(id);
      log(`spawn ${id} provider=codex failed: ${String(err)}`);
      return { ok: false, error: String(err) };
    }
  };

  const doSpawn = (id, cmd, args, cwd, env) => {
    if (children.has(id) || codexSessions.has(id)) return { ok: false, error: "id already live" };
    let child;
    try {
      // `env` EXTENDS the host's environment (per-spawn knobs like MCP_TOOL_TIMEOUT), never replaces it.
      child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : undefined });
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    const entry = { child, cwd, busy: false, spawnedAt: Date.now(), killedByClient: false };
    children.set(id, entry);
    child.stdout.setEncoding("utf8");
    // Lines are split HERE (not just relayed) so the busy fold stays correct while no client is attached.
    child.stdout.on(
      "data",
      makeLineSplitter((line) => {
        if (isResultLine(line)) entry.busy = false;
        event({ op: "line", id, line });
      }),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {}); // drained so the pipe never blocks; the child logs its own way
    child.on("exit", (code, signal) => recordExit(id, entry, code, signal));
    child.on("error", () => recordExit(id, entry, null, null));
    log(`spawn ${id} pid=${child.pid} cwd=${cwd}`);
    return { ok: true, pid: child.pid };
  };

  const userText = (data) => {
    try {
      const content = JSON.parse(data)?.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("");
    } catch {
      // malformed writes are ignored by both provider paths
    }
    return "";
  };

  const applyCodexWrite = async (id, entry, data) => {
    // Resolve the runtime here (not eagerly) so a startup failure lands in THIS try — an unhandled
    // rejection off `getCodexRuntime()` would otherwise crash the shared sidecar, taking every CLAUDE
    // child with it (finding 2). Every provider path — usage/read-history/kill — already guards this; the
    // write path was the one that didn't.
    let runtime;
    try {
      runtime = await getCodexRuntime();
    } catch (err) {
      entry.busy = false;
      codexLine(id, "canvas/error", { message: String(err) });
      return;
    }
    try {
      if (isUserWrite(data)) {
        const text = userText(data);
        if (!text) throw new Error("Codex prompt contained no text");
        const inputRequest = [...codexRequests.values()].find((r) => r.sid === id && r.request.kind === "input");
        if (inputRequest) {
          settleCodexRequest(inputRequest.requestId, { text });
          return;
        }
        // wasBusy is read AFTER the prior write on this sid has settled (writes are serialized on
        // entry.tail below), so activeTurnId has settled too: steer-vs-prompt no longer races the turn
        // lifecycle (finding 7). A first prompt whose bind is still in flight has already been awaited by
        // the tail seeding, so `prompt` finds the session bound (finding 1).
        const wasBusy = entry.busy;
        entry.busy = true;
        if (wasBusy) await runtime.steer(id, text);
        else await runtime.prompt(id, text);
        return;
      }
      const parsed = JSON.parse(data);
      if (parsed?.type === "control_request" && parsed?.request?.subtype === "interrupt")
        await runtime.interrupt(id);
    } catch (err) {
      entry.busy = false;
      codexLine(id, "canvas/error", { message: String(err) });
    }
  };

  const writeCodex = (id, entry, data) => {
    // Serialize per-sid: chain each write onto the entry's tail (seeded with the spawn/bind promise) so a
    // write waits for the bind and for prior writes to settle. applyCodexWrite never rejects (it converts
    // every failure to a canvas/error line), so the chain stays a resolved promise — no unhandled
    // rejection can escape it. `.then(run, run)` runs this write even if the prior link rejected (a failed
    // spawn deletes the session separately; the write then errors cleanly as "unknown canvas session").
    const run = () => applyCodexWrite(id, entry, data);
    entry.tail = (entry.tail ?? Promise.resolve()).then(run, run);
  };

  const handle = (conn, msg) => {
    const reply = (body) => sendTo(conn, { op: "reply", req: msg.req, ...body });
    switch (msg.op) {
      case "hello": {
        if (msg.ver !== PROTOCOL_VERSION)
          return reply({ ok: false, error: "version-mismatch", ver: PROTOCOL_VERSION });
        if (attached && !attached.destroyed && attached !== conn)
          return reply({ ok: false, error: "busy", clientPid: attachedPid });
        attached = conn;
        attachedPid = msg.pid ?? null;
        log(`client attached pid=${attachedPid ?? "?"}`);
        return reply({ ok: true, pid: process.pid, ver: PROTOCOL_VERSION });
      }
      case "spawn":
        if (msg.provider === "codex") {
          void doCodexSpawn(msg).then(reply);
          return;
        }
        return reply(doSpawn(msg.id, msg.cmd, msg.args ?? [], msg.cwd, msg.env));
      case "write": {
        const codex = codexSessions.get(msg.id);
        if (codex) {
          writeCodex(msg.id, codex, msg.data);
          return msg.req != null ? reply({ ok: true }) : undefined;
        }
        const entry = children.get(msg.id);
        if (!entry) return msg.req != null ? reply({ ok: false, error: "not-alive" }) : undefined;
        if (isUserWrite(msg.data)) entry.busy = true;
        entry.child.stdin.write(msg.data + "\n");
        return msg.req != null ? reply({ ok: true }) : undefined;
      }
      case "answer-request": {
        const pending = codexRequests.get(msg.requestId);
        if (!pending || pending.sid !== msg.id)
          return msg.req != null ? reply({ ok: false, error: "no-such-request" }) : undefined;
        settleCodexRequest(msg.requestId, msg.answer);
        return msg.req != null ? reply({ ok: true }) : undefined;
      }
      case "usage": {
        // PROBE mode (the server's usage poller): report usage only if a Codex runtime is ALREADY up — do
        // NOT instantiate one. Booting app-server + refreshing the OpenAI token every 60s for a user who
        // never touches Codex is the spawn→fail→respawn churn finding 5 flags; probing leaves a codex-less
        // box quiet. A real request (a spawned session) still boots the runtime; a non-probe usage call
        // (none today) keeps the old instantiate-on-demand behaviour.
        if (msg.probe && !codexRuntimePromise) return reply({ ok: true, usage: null });
        void getCodexRuntime().then(
          (runtime) => reply({ ok: true, usage: runtime.usage() }),
          (err) => reply({ ok: false, error: String(err) }),
        );
        return;
      }
      case "read-history": {
        if (typeof msg.providerSessionId !== "string" || !msg.providerSessionId)
          return reply({ ok: false, error: "missing provider session id" });
        void getCodexRuntime().then(
          (runtime) => runtime.readThread(msg.providerSessionId),
        ).then(
          (history) => reply({ ok: true, history }),
          (err) => reply({ ok: false, error: String(err) }),
        );
        return;
      }
      case "kill": {
        const codex = codexSessions.get(msg.id);
        if (codex) {
          codex.killedByClient = true;
          for (const r of [...codexRequests.values()])
            if (r.sid === msg.id) settleCodexRequest(r.requestId, { behavior: "deny" });
          void getCodexRuntime()
            .then(async (runtime) => {
              if (codex.busy) {
                try { await runtime.interrupt(msg.id); } catch { /* release still proceeds */ }
              }
              return runtime.release(msg.id);
            })
            .catch(() => false)
            .finally(() => recordCodexExit(msg.id, codex));
          return reply({ ok: true });
        }
        const entry = children.get(msg.id);
        if (!entry) return reply({ ok: false, error: "not-alive" });
        entry.killedByClient = true;
        entry.child.kill();
        return reply({ ok: true });
      }
      case "list":
        return reply({
          ok: true,
          sessions: [
            ...[...children.entries()].map(([id, e]) => ({
              id, cwd: e.cwd, busy: e.busy, spawnedAt: e.spawnedAt, pid: e.child.pid, provider: "claude",
            })),
            ...[...codexSessions.entries()].map(([id, e]) => ({
              id, cwd: e.cwd, busy: e.busy, spawnedAt: e.spawnedAt,
              pid: e.pid, provider: "codex", providerSessionId: e.providerSessionId,
              requests: requestsOf(id),
            })),
          ],
          exits: [...exits],
        });
      case "ack-exits": {
        const ids = new Set(msg.ids ?? []);
        for (let i = exits.length - 1; i >= 0; i--) if (ids.has(exits[i].id)) exits.splice(i, 1);
        return reply({ ok: true });
      }
      case "shutdown": {
        // The remote stop-everything verb (`session-host.js --stop`): any conn may ask — it's the same
        // authority as SIGTERM on a local dev box, and it must work while a dev server holds the hello slot.
        // No process.exit: once the server closes and the children are gone the event loop drains and a
        // CLI host exits on its own (and an in-process test host must NOT take the test runner with it).
        log(`shutdown requested over the socket`);
        reply({ ok: true });
        void shutdown();
        return;
      }
      default:
        return reply({ ok: false, error: `unknown op ${JSON.stringify(msg.op)}` });
    }
  };

  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.setEncoding("utf8");
    conn.on(
      "data",
      makeLineSplitter((line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // a malformed frame is dropped, not fatal
        }
        handle(conn, msg);
      }),
    );
    conn.on("close", () => {
      conns.delete(conn);
      if (attached === conn) {
        attached = null;
        attachedPid = null;
        log("client detached — children keep running");
      }
    });
    conn.on("error", () => {}); // close bookkeeping handles it
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  log(`listening on ${socketPath} pid=${process.pid}`);

  /** Kill every child as reason:"shutdown" and stop listening. The explicit stop-everything verb.
   *  Idempotent — the socket `shutdown` op and a signal/test teardown may both arrive. */
  let shutdownRun = null;
  const shutdown = () => (shutdownRun ??= doShutdown());
  const doShutdown = async () => {
    shuttingDown = true;
    const waits = [...children.values()].map(
      (e) =>
        new Promise((resolve) => {
          e.child.once("exit", resolve);
          e.child.kill();
        }),
    );
    // Bounded wait: let exit events reach the attached client, but never hang the host's own exit.
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 2000))]);
    for (const [id, entry] of [...codexSessions]) recordCodexExit(id, entry, "shutdown");
    if (codexRuntimePromise) {
      try {
        (await codexRuntimePromise).close();
      } catch {
        /* a failed/lost app-server is already reflected in the logical-session exits */
      }
      codexRuntimePromise = null;
    }
    for (const conn of conns) conn.destroy(); // server.close waits on open conns — drop them explicitly
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    log("shut down");
  };

  return { shutdown, socketPath, pid: process.pid };
}

// CLI: `node session-host.js` runs a host (or `npm run session-host`); `--stop` tells the running host to
// kill every session and exit (`npm run session-host:stop`) — the stop-everything verb now that the
// sidecar, not the dev server, owns the children. Socket path is keyed off this file's dir — one host per
// app checkout, matching one dev server per checkout.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const appDir = new URL(".", import.meta.url).pathname;
  const socketPath = sessionHostSocketPath(appDir);
  if (process.argv.includes("--stop")) {
    const conn = net.connect(socketPath);
    conn.once("connect", () => conn.write(JSON.stringify({ op: "shutdown", req: 1 }) + "\n"));
    conn.once("error", () => {
      console.log("no session host running");
      process.exit(0);
    });
    conn.setEncoding("utf8");
    conn.once("data", (data) => {
      // Check the reply — a host still running PRE-shutdown-op code answers "unknown op", and claiming
      // "stopping" on any bytes at all is how that bug slipped past a live test once already.
      let ok = false;
      let error = "";
      try {
        const m = JSON.parse(String(data));
        ok = !!m.ok;
        error = typeof m.error === "string" ? m.error : "";
      } catch {
        /* not a frame — fall through to the refusal path */
      }
      if (ok) {
        console.log("session host stopping (all sessions ending)");
      } else {
        console.log(`session host refused --stop (${error || "bad reply"}) — an old-code host? kill its pid instead`);
        process.exitCode = 1;
      }
      conn.destroy();
    });
  } else {
    const host = await createHost({ socketPath, logPath: sessionHostLogPath(appDir) });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      host.shutdown().then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
