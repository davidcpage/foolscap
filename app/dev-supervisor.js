// dev-supervisor.js — the thin lifecycle OWNER of the dev stack (plain ESM; runs under bare `node`).
//
// The dev stack today is a vite dev server plus two long-lived SIDECARS (session-host.js owns the
// `claude -p`/codex children; jupyter-host's gateway owns the kernels) that the dev server auto-starts
// DETACHED so they outlive a dev-server restart — the property the whole architecture exists for (an agent
// session is implementing/testing the very change that reloads the server, so the reload must not kill it).
// The wart that buys: Ctrl-C on the dev server does NOT reap the detached sidecars — they linger until an
// explicit `session-host:stop` / `jupyter-host:stop`, an orphan the user has to hunt down.
//
// This supervisor gives the stack a single long-lived owner so ONE Ctrl-C reaps everything, WITHOUT
// dissolving the outlive property. It is deliberately TINY and follows the human-approved "track + reap"
// shape (analysis: thread node:thread:b726f7ce seq 8; impl brief: node:a68cb962):
//
//   - It launches vite as an OWNED child in its own process group; it does NOT spawn the sidecars.
//     The sidecars keep their existing auto-start-on-first-attach path unchanged, so bare `vite`, the
//     contract tests, and CI all keep working with no supervisor present (one code path).
//   - On its own exit it REAPS: kill vite first, then send the session-host its socket `shutdown` op and
//     stop the jupyter gateway (both are the sidecars' existing stop-everything verbs), bounded-wait, exit.
//   - `restart-server` bounces ONLY the vite child; the detached sidecars are untouched (they're in their
//     own process groups) and the fresh vite re-attaches + adopts the live sessions exactly as a manual
//     restart does today. `restart-jupyter` drops the gateway (kernels relaunch on demand — a cheap loss).
//   - There is deliberately NO session-host restart verb: the host owns the child stdin pipes in-process,
//     so bouncing it kills every live agent session. That is "stop everything", i.e. teardown — not a
//     targeted bounce. (Documented, not offered.)
//
// It is a lifecycle OWNER, not a restart ENGINE: Vite's own same-pid re-eval stays the primary iterate
// loop (editing a plugin/config file → server.restart() re-evaluates the module in-process, sidecars
// untouched). `restart-server` earns its keep only for a wedged server or a change Vite can't hot-eval.
//
// macOS has no PR_SET_CHILD_SUBREAPER: if the supervisor is `kill -9`'d, its children reparent to launchd
// and keep running — the exact orphan we solve on a CLEAN exit is back. That is accepted as unrecoverable
// and documented; the supervisor traps every clean exit path (SIGINT/SIGTERM/socket `stop`) instead.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sessionHostSocketPath } from "./session-host-protocol.js";
import { appDirKey } from "./jupyter-host-protocol.js";
import { stopGateway } from "./jupyter-host.js";

const KILL_TIMEOUT_MS = 5000; // grace before a group SIGKILL when reaping/bouncing vite
const SIDECAR_TIMEOUT_MS = 4000; // grace for the session-host to end its children on `shutdown`
const RESPAWN_DELAY_MS = 1000; // backoff before auto-restarting a vite that died on its own
const FAST_CRASH_MS = 3000; // a vite exit sooner than this counts as a "fast crash" (e.g. port in use)
const MAX_FAST_CRASHES = 5; // give up auto-restarting after this many consecutive fast crashes
const CONTROL_VERBS = new Set(["restart-server", "restart-jupyter", "stop", "status"]);

/** The supervisor's control socket — checkout-scoped (one supervisor per app checkout, like the sidecars
 *  and the one dev server) and in tmpdir, NOT the watched tree (a socket under chokidar is fatal). Keyed
 *  by the resolved app dir with the SAME hash the sidecars use, so parallel worktrees stay isolated. */
function supervisorSocketPath(appDir) {
  return path.join(os.tmpdir(), `canvas-dev-supervisor-${appDirKey(appDir)}.sock`);
}

const nowIso = () => new Date().toISOString();
const log = (msg) => process.stdout.write(`${nowIso()} [dev-supervisor] ${msg}\n`);

/** Probe a socket: "live" (someone answered), "dead" (stale file), or "absent". */
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

/** Send one op to a running supervisor's control socket and print its reply. Used by the CLI verbs
 *  (a second `node dev-supervisor.js <verb>` invocation talks to the long-lived owner). */
function sendControl(appDir, op, timeoutMs = 20000) {
  const socketPath = supervisorSocketPath(appDir);
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buf = "";
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      conn.destroy();
      fn(arg);
    };
    conn.once("error", () => finish(reject, new Error("no dev supervisor running for this checkout")));
    conn.setEncoding("utf8");
    conn.once("connect", () => conn.write(JSON.stringify({ op }) + "\n"));
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        msg = { ok: false, error: "bad reply" };
      }
      finish(resolve, msg);
    });
    setTimeout(() => finish(reject, new Error("control request timed out")), timeoutMs);
  });
}

/** Tell the session-host to stop-everything over its existing socket `shutdown` op (the same authority as
 *  `session-host.js --stop`). A missing/refused socket means no host is running — a clean no-op. */
function stopSessionHost(appDir, timeoutMs) {
  return new Promise((resolve) => {
    const conn = net.connect(sessionHostSocketPath(appDir));
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      if (msg) log(msg);
      conn.destroy();
      resolve();
    };
    conn.once("connect", () => conn.write(JSON.stringify({ op: "shutdown", req: 1 }) + "\n"));
    conn.once("error", () => finish("no session-host to reap"));
    conn.setEncoding("utf8");
    conn.once("data", () => finish("session-host stopping (its sessions ending)"));
    setTimeout(() => finish("session-host stop timed out — its pid may need a manual kill"), timeoutMs);
  });
}

async function stopJupyter(appDir) {
  try {
    const stopped = await stopGateway(appDir);
    log(stopped ? "jupyter gateway stopped" : "no jupyter gateway to reap");
  } catch (err) {
    log(`jupyter stop error: ${String(err)}`);
  }
}

async function runSupervisor(viteArgs) {
  const appDir = new URL(".", import.meta.url).pathname;
  const viteBin = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  const controlSocket = supervisorSocketPath(appDir);

  // One supervisor per checkout. A LIVE control socket means another supervisor already owns this stack —
  // refuse rather than start a twin (a second supervisor whose vite loses the strictPort race would, on
  // giving up, reap the FIRST supervisor's sidecars and kill its sessions). A dead socket is reclaimed.
  const probe = await probeSocket(controlSocket);
  if (probe === "live") {
    log(`another dev supervisor already owns this checkout (${controlSocket}) — refusing to start a twin`);
    process.exit(1);
  }
  if (probe === "dead") {
    try {
      fs.unlinkSync(controlSocket);
    } catch {
      /* already gone */
    }
  }

  let viteChild = null;
  let everUp = false; // vite stayed up past FAST_CRASH_MS at least once → we truly own the stack
  let shuttingDown = false;
  let restarting = false;
  let fastCrashes = 0;

  const spawnVite = () => {
    // detached:true → vite is its OWN process-group leader. Two consequences we rely on: (1) a terminal
    // Ctrl-C (SIGINT to the supervisor's group) does NOT reach vite directly — the supervisor mediates the
    // teardown; (2) the session-host, spawned by vite as a detached grandchild in ITS own group, is NOT
    // killed when we group-kill vite (`kill(-vitePid)`), so a `restart-server` leaves the sidecar alive.
    const child = spawn(process.execPath, [viteBin, ...viteArgs], {
      cwd: appDir,
      stdio: "inherit",
      detached: true,
      env: process.env,
    });
    viteChild = child;
    const startedAt = Date.now();
    log(`vite dev server started (pid ${child.pid})${viteArgs.length ? ` args: ${viteArgs.join(" ")}` : ""}`);
    setTimeout(() => {
      if (viteChild === child) everUp = true;
    }, FAST_CRASH_MS).unref?.();
    child.on("error", (err) => log(`vite spawn error: ${String(err)}`));
    child.on("exit", (code, signal) => {
      if (viteChild === child) viteChild = null;
      if (shuttingDown || restarting) return; // an intended kill (teardown / restart-server) — no respawn
      const uptime = Date.now() - startedAt;
      log(`vite exited unexpectedly (code=${code} signal=${signal ?? "-"}, up ${uptime}ms)`);
      fastCrashes = uptime < FAST_CRASH_MS ? fastCrashes + 1 : 0;
      if (fastCrashes >= MAX_FAST_CRASHES) {
        // Only reap the sidecars if we ever actually owned a running stack. A vite that never came up
        // (e.g. strictPort 5173 already held by a bare `npm run dev:bare`) must NOT tear down that other
        // stack's session-host — we never owned it.
        log(`vite crash-looped ${fastCrashes}× — giving up${everUp ? " and tearing down the stack" : " (never started; leaving any existing sidecars alone)"}`);
        void teardown(1, everUp);
        return;
      }
      log(`auto-restarting vite in ${RESPAWN_DELAY_MS}ms (sidecars + live sessions preserved)`);
      setTimeout(() => {
        if (!shuttingDown) spawnVite();
      }, RESPAWN_DELAY_MS).unref?.();
    });
    return child;
  };

  // Group-kill the current vite child and wait (bounded) for it to exit; SIGKILL the group on timeout.
  const killVite = (timeoutMs) =>
    new Promise((resolve) => {
      const child = viteChild;
      if (!child) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finish);
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return finish();
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        finish();
      }, timeoutMs).unref?.();
    });

  const restartServer = async () => {
    restarting = true;
    log("restart-server: bouncing ONLY vite (sidecars + live sessions untouched)");
    await killVite(KILL_TIMEOUT_MS);
    spawnVite();
    restarting = false;
    return "vite bounced; the fresh server re-attaches and re-adopts live sessions";
  };

  const restartJupyter = async () => {
    log("restart-jupyter: dropping the gateway (kernels relaunch on demand)");
    await stopJupyter(appDir);
    return "jupyter gateway dropped; it relaunches on the next cell run";
  };

  let tornDown = false;
  const teardown = async (exitCode, reapSidecars) => {
    if (tornDown) return;
    tornDown = true;
    shuttingDown = true;
    log(reapSidecars ? "teardown: vite → session-host → jupyter" : "shutting down (leaving sidecars)");
    await killVite(KILL_TIMEOUT_MS);
    if (reapSidecars) {
      await Promise.all([stopSessionHost(appDir, SIDECAR_TIMEOUT_MS), stopJupyter(appDir)]);
    }
    controlServer.close();
    try {
      fs.unlinkSync(controlSocket);
    } catch {
      /* already gone */
    }
    log("teardown complete");
    process.exit(exitCode);
  };

  // The control channel: a second `node dev-supervisor.js <verb>` connects here and asks the running owner
  // to act. One JSON op per line, one reply; tiny, no correlation counter needed (one op per connection).
  const controlServer = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        return conn.end(JSON.stringify({ ok: false, error: "bad frame" }) + "\n");
      }
      const reply = (body) => conn.end(JSON.stringify(body) + "\n");
      if (msg.op === "restart-server") return void restartServer().then((m) => reply({ ok: true, message: m }));
      if (msg.op === "restart-jupyter") return void restartJupyter().then((m) => reply({ ok: true, message: m }));
      if (msg.op === "status")
        return reply({
          ok: true,
          vitePid: viteChild?.pid ?? null,
          everUp,
          sessionHostSocket: sessionHostSocketPath(appDir),
        });
      if (msg.op === "stop") {
        reply({ ok: true, message: "tearing down the stack" });
        return void teardown(0, true);
      }
      reply({ ok: false, error: `unknown op ${JSON.stringify(msg.op)}` });
    });
    conn.on("error", () => {}); // close bookkeeping is enough
  });

  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(controlSocket, resolve);
  });

  // Trap every clean exit path. A `kill -9` of THIS process can't be trapped — children reparent to
  // launchd (accepted, documented).
  process.on("SIGINT", () => void teardown(0, true));
  process.on("SIGTERM", () => void teardown(0, true));

  log(`owning the dev stack (control socket ${controlSocket})`);
  spawnVite();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const appDir = new URL(".", import.meta.url).pathname;
  const [first, ...rest] = process.argv.slice(2);

  if (first && CONTROL_VERBS.has(first)) {
    // CLI verb: talk to the running supervisor.
    try {
      const reply = await sendControl(appDir, first);
      if (first === "status") {
        console.log(JSON.stringify(reply, null, 2));
      } else if (reply.ok) {
        console.log(reply.message ?? "ok");
      } else {
        console.error(reply.error ?? "request failed");
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(String(err.message ?? err));
      process.exitCode = 1;
    }
  } else {
    // Start mode. `start` is an optional explicit verb; any other args are forwarded to vite (e.g.
    // `node dev-supervisor.js --port 5199 --strictPort` for an isolated worktree stack).
    const viteArgs = first === "start" ? rest : process.argv.slice(2);
    await runSupervisor(viteArgs);
  }
}
