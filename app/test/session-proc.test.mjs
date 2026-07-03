// The SessionProc seam: localProc (dev-server-owned child) and remoteProc (session-host-owned child)
// must be indistinguishable to the plugin — same lines, same write/kill behavior, same exit reasons.
// The shared contract runs against both; remote gets wired in with the session-host client.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { localProc, remoteProc } from "../session-proc.js";
import { createHost } from "../session-host.js";
import { connectSessionHost } from "../session-host-client.js";

const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

const userMsg = (text) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

/** Collecting hooks + waiters, shared by both halves of the contract. */
function recorder() {
  const lines = [];
  let exit = null;
  const waiters = [];
  const poke = () => {
    for (const w of [...waiters]) w();
  };
  return {
    lines,
    exitInfo: () => exit,
    hooks: {
      onLine: (line) => {
        lines.push(line);
        poke();
      },
      onExit: (info) => {
        exit = info;
        poke();
      },
    },
    waitFor: (pred, timeoutMs = 15000) => // generous: the full suite runs many spawning files in parallel
      new Promise((res, rej) => {
        const check = () => {
          if (pred()) {
            clearTimeout(t);
            res();
            return true;
          }
          return false;
        };
        const t = setTimeout(() => rej(new Error("timeout in waitFor")), timeoutMs);
        if (!check()) waiters.push(check);
      }),
  };
}

/**
 * The contract, parameterized over how a proc is made: spawn a fake claude, see its init line, run one
 * turn, kill it, and read the right exit reason. `makeProc(opts, hooks)` must look like localProc.
 */
export async function runProcContract(makeProc, t) {
  await t.test("lines stream, a turn round-trips, write returns true while alive", async () => {
    const r = recorder();
    const p = makeProc({ cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() }, r.hooks);
    assert.equal(p.alive, true);
    await r.waitFor(() => r.lines.some((l) => l.includes('"init"')));
    assert.equal(p.write(userMsg("round trip")), true);
    await r.waitFor(() => r.lines.some((l) => l.includes('"type":"result"')));
    assert.ok(r.lines.some((l) => l.includes("echo: round trip")), "the assistant line came through");
    p.kill();
    await r.waitFor(() => r.exitInfo() !== null);
  });

  await t.test("kill() → reason 'killed', alive flips, write returns false", async () => {
    const r = recorder();
    const p = makeProc({ cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() }, r.hooks);
    await r.waitFor(() => r.lines.length > 0);
    p.kill();
    await r.waitFor(() => r.exitInfo() !== null);
    assert.equal(r.exitInfo().reason, "killed");
    assert.equal(p.alive, false);
    assert.equal(p.write(userMsg("too late")), false);
    p.kill(); // idempotent — a second kill of a dead proc must not throw
  });

  await t.test("a self-death → reason 'self' with the child's exit code", async () => {
    const r = recorder();
    const p = makeProc({ cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() }, r.hooks);
    await r.waitFor(() => r.lines.length > 0);
    p.write(userMsg("die"));
    await r.waitFor(() => r.exitInfo() !== null);
    assert.equal(r.exitInfo().reason, "self");
    assert.equal(r.exitInfo().code, 3);
  });
}

test("localProc honours the SessionProc contract", async (t) => {
  await runProcContract((opts, hooks) => localProc(opts, hooks), t);
});

test("localProc: a spawn of a nonexistent binary surfaces as onExit reason 'self', not a throw", async () => {
  const r = recorder();
  const p = localProc({ cmd: "/nonexistent/definitely-not-a-binary", args: [], cwd: os.tmpdir() }, r.hooks);
  await r.waitFor(() => r.exitInfo() !== null);
  assert.equal(r.exitInfo().reason, "self");
  assert.equal(p.alive, false);
});

test("remoteProc honours the SAME SessionProc contract, over an in-process host", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sproc-"));
  const socketPath = path.join(dir, "s.sock");
  const host = await createHost({ socketPath, logPath: path.join(dir, "s.log") });
  const client = await connectSessionHost({ socketPath });
  let n = 0;
  try {
    await runProcContract((opts, hooks) => remoteProc(client, `contract-${n++}`, hooks, { spawn: opts }), t);

    await t.test("remote extra: a failed host spawn surfaces as onExit 'self', like localProc", async () => {
      const r = recorder();
      const p = remoteProc(client, "bad-spawn", r.hooks, {
        spawn: { cmd: "/nonexistent/definitely-not-a-binary", args: [], cwd: os.tmpdir() },
      });
      await r.waitFor(() => r.exitInfo() !== null);
      assert.equal(r.exitInfo().reason, "self");
      assert.equal(p.alive, false);
    });

    await t.test("remote extra: adoption (no spawn opt) attaches to a child already in the host", async () => {
      const spawner = recorder();
      remoteProc(client, "adoptee", spawner.hooks, {
        spawn: { cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() },
      });
      await spawner.waitFor(() => spawner.lines.length > 0);
      // A "restarted dev server": fresh hooks, same id, no spawn — lines and kill flow to the new owner.
      client.detach("adoptee");
      const r = recorder();
      const p = remoteProc(client, "adoptee", r.hooks);
      assert.equal(p.write(userMsg("after adoption")), true);
      await r.waitFor(() => r.lines.some((l) => l.includes("echo: after adoption")));
      p.kill();
      await r.waitFor(() => r.exitInfo() !== null);
      assert.equal(r.exitInfo().reason, "killed");
    });
  } finally {
    client.close();
    await host.shutdown();
  }
});
