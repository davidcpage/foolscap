// The dev server's client to the session-host sidecar (plain ESM; imported by session-proc.js /
// vite-fs-plugin.ts and the contract tests).
//
// One socket carries everything: request/reply frames (correlated by `req`) and per-session events
// (`line`, `exit`) routed to the hooks attached per id. Lifecycle:
//
// - connectSessionHost() connects, auto-STARTING the host first when the socket is absent/stale (spawned
//   detached — it must outlive us, that's the point). A `hello` claims the single client slot; a "busy"
//   rejection (another dev server holds it) throws, and the caller falls back to in-process sessions.
// - On socket loss it reconnects forever (2s cadence, re-running autostart — a crashed host is replaced).
//   After a reconnect it re-lists: any attached id the fresh host doesn't know is DEAD (a kill -9'd host
//   takes its children with it) → that session's hooks get onExit({reason:"self"}) → stamped crashed.
// - While disconnected: writeSession returns false, spawnSession throws (the spawn handler 500s — better
//   a loud failure than a session silently spawned under in-process ownership in host mode).

import net from "node:net";
import { spawn } from "node:child_process";
import { makeLineSplitter } from "./session-host-protocol.js";

const RECONNECT_MS = 2000;
const CONNECT_TRIES = 10; // × 200ms — covers the autostarted host's boot
const isMissing = (err) => err && (err.code === "ENOENT" || err.code === "ECONNREFUSED");

function connectOnce(socketPath) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    conn.once("connect", () => resolve(conn));
    conn.once("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect (auto-starting the host if needed), claim the client slot, return the client. */
export async function connectSessionHost({ socketPath, hostScript, clientPid }) {
  let req = 0;
  const replies = new Map(); // req → resolve
  const hooks = new Map(); // session id → ProcHooks
  let conn = null;
  let connected = false;
  let closed = false;

  const wire = (c) => {
    c.setEncoding("utf8");
    c.on(
      "data",
      makeLineSplitter((line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.op === "reply") {
          replies.get(msg.req)?.(msg);
          replies.delete(msg.req);
        } else if (msg.op === "line") {
          hooks.get(msg.id)?.onLine(msg.line);
        } else if (msg.op === "exit") {
          const h = hooks.get(msg.id);
          hooks.delete(msg.id);
          h?.onExit({ code: msg.code ?? null, reason: msg.reason });
        }
      }),
    );
    c.on("error", () => {}); // close handles the bookkeeping
    c.on("close", () => {
      if (conn !== c) return;
      connected = false;
      conn = null;
      if (!closed) void reconnectLoop();
    });
  };

  const request = (body) =>
    new Promise((resolve, reject) => {
      if (!connected || !conn) return reject(new Error("session host not connected"));
      const r = ++req;
      replies.set(r, resolve);
      conn.write(JSON.stringify({ ...body, req: r }) + "\n");
    });

  // Connect with autostart: a missing/stale socket means no host — spawn one DETACHED (it self-logs; it
  // must survive us) and retry while it boots. Any other error propagates.
  const establish = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await connectOnce(socketPath);
        wire(c);
        conn = c;
        connected = true;
        return;
      } catch (err) {
        if (!isMissing(err) || attempt >= CONNECT_TRIES) throw err;
        if (attempt === 0 && hostScript) {
          spawn(process.execPath, [hostScript], { detached: true, stdio: "ignore" }).unref();
        }
        await sleep(200);
      }
    }
  };

  const hello = async () => {
    const r = await request({ op: "hello", ver: 1, pid: clientPid ?? process.pid });
    if (!r.ok) throw new Error(`session host busy (client pid ${r.clientPid ?? "?"} holds the slot)`);
  };

  // Forever-reconnect after a drop. On success, sweep: attached ids the fresh host doesn't list are gone
  // for good — surface each as a self-death so the plugin stamps crashed and frees the card.
  const reconnectLoop = async () => {
    while (!closed && !connected) {
      try {
        await establish();
        await hello();
        const r = await request({ op: "list" });
        const live = new Set((r.sessions ?? []).map((s) => s.id));
        for (const [id, h] of [...hooks]) {
          if (!live.has(id)) {
            hooks.delete(id);
            h.onExit({ code: null, reason: "self" });
          }
        }
      } catch {
        connected = false;
        conn?.destroy();
        conn = null;
        await sleep(RECONNECT_MS);
      }
    }
  };

  await establish();
  await hello();

  return {
    get connected() {
      return connected;
    },
    attach(id, h) {
      hooks.set(id, h);
    },
    detach(id) {
      hooks.delete(id);
    },
    spawnSession(id, spec) {
      if (!connected || !conn) throw new Error("session host not connected");
      // Fire-and-forget: a spawn failure comes back as an exit event (the host reports a failed spawn the
      // same way a self-death reads), keeping ensureLiveSession synchronous.
      // `env` extends the HOST's environment for this child (an old host ignores the field — the spawn
      // still lands, just without the knobs; degrade, don't reject).
      void request({ op: "spawn", id, cmd: spec.cmd, args: spec.args, cwd: spec.cwd, env: spec.env }).then((r) => {
        if (!r.ok) {
          const h = hooks.get(id);
          hooks.delete(id);
          h?.onExit({ code: null, reason: "self" });
        }
      });
    },
    writeSession(id, data) {
      if (!connected || !conn) return false;
      conn.write(JSON.stringify({ op: "write", id, data }) + "\n");
      return true;
    },
    killSession(id) {
      if (!connected || !conn) return;
      conn.write(JSON.stringify({ op: "kill", id, req: ++req }) + "\n");
    },
    async list() {
      const r = await request({ op: "list" });
      return { sessions: r.sessions ?? [], exits: r.exits ?? [] };
    },
    async ackExits(ids) {
      if (ids.length) await request({ op: "ack-exits", ids });
    },
    close() {
      closed = true;
      conn?.destroy();
    },
  };
}
