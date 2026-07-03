// The session host: a small long-lived sidecar that OWNS the `claude -p` children, so the dev server can
// restart without killing the agent sessions that are implementing/testing the very change being tested.
// (Plain ESM, runs under bare `node` and node --test; the tmux model — a background server owns the
// processes, clients attach.)
//
// The dev server attaches as a client over a unix socket (ndjson, session-host-protocol.js) and speaks:
//
//   client → host   {op:"hello", req, ver, pid}       → reply {ok,pid,ver} | {ok:false,error:"busy",clientPid}
//                   {op:"spawn", req, id, cmd, args, cwd} → reply {ok,pid} | {ok:false,error}
//                   {op:"write", req?, id, data}      → reply {ok:false,error:"not-alive"} only on a dead id
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
export async function createHost({ socketPath, logPath }) {
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
  /** deaths not yet delivered/acked: {id, cwd, code, signal, ts, reason} */
  const exits = [];
  const conns = new Set(); // every open conn — server.close() waits for them, so shutdown must destroy them
  let attached = null; // the one client conn
  let attachedPid = null;
  let shuttingDown = false;

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

  const doSpawn = (id, cmd, args, cwd) => {
    if (children.has(id)) return { ok: false, error: "id already live" };
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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

  const handle = (conn, msg) => {
    const reply = (body) => sendTo(conn, { op: "reply", req: msg.req, ...body });
    switch (msg.op) {
      case "hello": {
        if (attached && !attached.destroyed && attached !== conn)
          return reply({ ok: false, error: "busy", clientPid: attachedPid });
        attached = conn;
        attachedPid = msg.pid ?? null;
        log(`client attached pid=${attachedPid ?? "?"}`);
        return reply({ ok: true, pid: process.pid, ver: PROTOCOL_VERSION });
      }
      case "spawn":
        return reply(doSpawn(msg.id, msg.cmd, msg.args ?? [], msg.cwd));
      case "write": {
        const entry = children.get(msg.id);
        if (!entry) return msg.req != null ? reply({ ok: false, error: "not-alive" }) : undefined;
        if (isUserWrite(msg.data)) entry.busy = true;
        entry.child.stdin.write(msg.data + "\n");
        return msg.req != null ? reply({ ok: true }) : undefined;
      }
      case "kill": {
        const entry = children.get(msg.id);
        if (!entry) return reply({ ok: false, error: "not-alive" });
        entry.killedByClient = true;
        entry.child.kill();
        return reply({ ok: true });
      }
      case "list":
        return reply({
          ok: true,
          sessions: [...children.entries()].map(([id, e]) => ({
            id,
            cwd: e.cwd,
            busy: e.busy,
            spawnedAt: e.spawnedAt,
            pid: e.child.pid,
          })),
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
