// The session-host sidecar: children survive client detach, the busy bit tracks turns, exits carry the
// reason that separates a crash from a kill from a host shutdown, and one client holds the attachment.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHost } from "../session-host.js";
import { makeLineSplitter, isResultLine, isUserWrite, PROTOCOL_VERSION } from "../session-host-protocol.js";

const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

function tmpSock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shost-"));
  return { socketPath: path.join(dir, "s.sock"), logPath: path.join(dir, "s.log") };
}

const userMsg = (text) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

/** A minimal protocol client: request/reply correlation + a findable event stream. */
function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    conn.setEncoding("utf8");
    let req = 0;
    const replies = new Map();
    const events = [];
    const waiters = [];
    conn.on(
      "data",
      makeLineSplitter((line) => {
        const msg = JSON.parse(line);
        if (msg.op === "reply") {
          replies.get(msg.req)?.(msg);
          replies.delete(msg.req);
        } else {
          events.push(msg);
          for (const w of [...waiters]) w();
        }
      }),
    );
    const client = {
      events,
      request: (body) =>
        new Promise((res) => {
          const r = ++req;
          replies.set(r, res);
          conn.write(JSON.stringify({ ...body, req: r }) + "\n");
        }),
      send: (body) => conn.write(JSON.stringify(body) + "\n"),
      waitEvent: (pred, timeoutMs = 15000) => // generous: the full suite runs many spawning files in parallel
        new Promise((res, rej) => {
          const check = () => {
            const m = events.find(pred);
            if (m) {
              clearTimeout(t);
              res(m);
              return true;
            }
            return false;
          };
          const t = setTimeout(() => rej(new Error("timeout waiting for event")), timeoutMs);
          if (!check()) waiters.push(check);
        }),
      close: () =>
        new Promise((res) => {
          if (conn.destroyed) return res(); // the host may have dropped us already (its shutdown sweep)
          conn.once("close", res);
          conn.destroy();
        }),
    };
    conn.once("connect", () => resolve(client));
    conn.once("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("protocol helpers: result-line and user-write predicates parse, not just grep", () => {
  assert.ok(isResultLine('{"type":"result","subtype":"success"}'));
  assert.ok(!isResultLine('{"type":"assistant","text":"say \\"type\\":\\"result\\" out loud"}'), "nested string must not flip the bit");
  assert.ok(!isResultLine("not json"));
  assert.ok(isUserWrite(userMsg("hi")));
  assert.ok(!isUserWrite(JSON.stringify({ type: "control_request", request: { subtype: "interrupt" } })));
});

test("hello rejects an old sidecar protocol before it can misread provider-aware spawns", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c = await connect(socketPath);
    const r = await c.request({ op: "hello", ver: PROTOCOL_VERSION - 1 });
    assert.deepEqual({ ok: r.ok, error: r.error, ver: r.ver }, {
      ok: false, error: "version-mismatch", ver: PROTOCOL_VERSION,
    });
    await c.close();
  } finally {
    await host.shutdown();
  }
});

test("spawn → line events stream; a turn answers and the busy bit falls back to idle", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c = await connect(socketPath);
    assert.equal((await c.request({ op: "hello", ver: PROTOCOL_VERSION, pid: process.pid })).ok, true);
    assert.equal((await c.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() })).ok, true);
    await c.waitEvent((e) => e.op === "line" && e.id === "s1" && e.line.includes('"init"'));

    c.send({ op: "write", id: "s1", data: userMsg("hello there") });
    await c.waitEvent((e) => e.op === "line" && e.line.includes('"type":"result"'));
    const list = await c.request({ op: "list" });
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].busy, false, "result line folded busy back to false");
    await c.close();
  } finally {
    await host.shutdown();
  }
});

test("busy bit: a user write sets it, a hung turn holds it, an interrupt-style write does not touch it", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c = await connect(socketPath);
    await c.request({ op: "hello", ver: PROTOCOL_VERSION });
    await c.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
    c.send({ op: "write", id: "s1", data: userMsg("hang") });
    await sleep(100);
    assert.equal((await c.request({ op: "list" })).sessions[0].busy, true, "unanswered turn → busy holds");
    // A control_request rides the same stdin without opening a turn — and must not flip an idle child busy.
    await c.request({ op: "spawn", id: "s2", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
    c.send({ op: "write", id: "s2", data: JSON.stringify({ type: "control_request", request: { subtype: "interrupt" } }) });
    await sleep(100);
    const byId = Object.fromEntries((await c.request({ op: "list" })).sessions.map((s) => [s.id, s.busy]));
    assert.deepEqual(byId, { s1: true, s2: false });
    await c.close();
  } finally {
    await host.shutdown();
  }
});

test("one host-owned Codex runtime multiplexes logical sessions and releases one without killing the other", async () => {
  const { socketPath, logPath } = tmpSock();
  let factoryCalls = 0;
  let closeCalls = 0;
  const prompts = [];
  const releases = [];
  const codexRuntimeFactory = async ({ onEvent }) => {
    factoryCalls++;
    return {
      pid: 4242,
      account: { type: "chatgpt", email: "plan@example.test", planType: "team" },
      async start(sid) { return { threadId: `thread-${sid}` }; },
      async resume(sid, threadId) { return { sid, threadId }; },
      async prompt(sid, text) {
        prompts.push([sid, text]);
        onEvent(sid, { method: "turn/started", params: { threadId: `thread-${sid}`, turn: { id: `turn-${sid}` } } });
        onEvent(sid, { method: "item/agentMessage/delta", params: { threadId: `thread-${sid}`, itemId: `item-${sid}`, delta: `reply:${text}` } });
        onEvent(sid, { method: "turn/completed", params: { threadId: `thread-${sid}`, turn: { id: `turn-${sid}`, status: "completed" } } });
      },
      async steer() {},
      async interrupt() {},
      async read() { return { thread: { turns: [] } }; },
      async release(sid) { releases.push(sid); return true; },
      close() { closeCalls++; },
    };
  };
  const host = await createHost({ socketPath, logPath, codexRuntimeFactory });
  try {
    const c = await connect(socketPath);
    await c.request({ op: "hello", ver: PROTOCOL_VERSION });
    const a = await c.request({ op: "spawn", id: "ca", provider: "codex", cwd: "/tmp/a" });
    const b = await c.request({ op: "spawn", id: "cb", provider: "codex", cwd: "/tmp/b" });
    assert.deepEqual(
      [a.provider, a.providerSessionId, b.providerSessionId],
      ["codex", "thread-ca", "thread-cb"],
    );
    assert.equal(factoryCalls, 1, "both logical sessions share one app-server runtime");

    c.send({ op: "write", id: "ca", data: userMsg("alpha") });
    c.send({ op: "write", id: "cb", data: userMsg("beta") });
    await c.waitEvent((e) => e.op === "line" && e.id === "ca" && e.line.includes("reply:alpha"));
    await c.waitEvent((e) => e.op === "line" && e.id === "cb" && e.line.includes("reply:beta"));
    assert.deepEqual(prompts, [["ca", "alpha"], ["cb", "beta"]]);

    await c.request({ op: "kill", id: "ca" });
    await c.waitEvent((e) => e.op === "exit" && e.id === "ca" && e.reason === "killed");
    assert.deepEqual(releases, ["ca"]);
    assert.deepEqual((await c.request({ op: "list" })).sessions.map((s) => s.id), ["cb"]);
    assert.equal(closeCalls, 0, "releasing a thread does not kill the shared app-server");
    await c.close();
  } finally {
    await host.shutdown();
  }
  assert.equal(closeCalls, 1, "host shutdown owns app-server shutdown");
});

test("spawn env EXTENDS the host's environment for that child (per-spawn knobs like MCP_TOOL_TIMEOUT)", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c = await connect(socketPath);
    await c.request({ op: "hello", ver: PROTOCOL_VERSION });
    // The child prints one env var and idles; PATH must survive (extend, never replace).
    const probe = 'console.log(JSON.stringify({v: process.env.CANVAS_TEST_KNOB ?? null, path: !!process.env.PATH})); setInterval(() => {}, 1000);';
    await c.request({ op: "spawn", id: "e1", cmd: process.execPath, args: ["-e", probe], cwd: os.tmpdir(), env: { CANVAS_TEST_KNOB: "660000" } });
    const line = await c.waitEvent((e) => e.op === "line" && e.id === "e1");
    assert.deepEqual(JSON.parse(line.line), { v: "660000", path: true });
    // And a spawn WITHOUT env keeps the plain inherited environment (the pre-env wire shape).
    await c.request({ op: "spawn", id: "e2", cmd: process.execPath, args: ["-e", probe], cwd: os.tmpdir() });
    const bare = await c.waitEvent((e) => e.op === "line" && e.id === "e2");
    assert.deepEqual(JSON.parse(bare.line), { v: null, path: true });
    await c.close();
  } finally {
    await host.shutdown();
  }
});

test("children survive client detach; a reattaching client lists them with a correct busy bit", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c1 = await connect(socketPath);
    await c1.request({ op: "hello", ver: PROTOCOL_VERSION });
    await c1.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: "/tmp" });
    c1.send({ op: "write", id: "s1", data: userMsg("hang") });
    await sleep(100);
    await c1.close();

    const c2 = await connect(socketPath);
    assert.equal((await c2.request({ op: "hello", ver: PROTOCOL_VERSION })).ok, true, "slot freed by the detach");
    const list = await c2.request({ op: "list" });
    assert.deepEqual(
      list.sessions.map((s) => ({ id: s.id, cwd: s.cwd, busy: s.busy })),
      [{ id: "s1", cwd: "/tmp", busy: true }],
      "the child kept running, mid-turn, across the detach",
    );
    await c2.close();
  } finally {
    await host.shutdown();
  }
});

test("second attached client is rejected busy — first wins, no takeover", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c1 = await connect(socketPath);
    await c1.request({ op: "hello", ver: PROTOCOL_VERSION, pid: 111 });
    const c2 = await connect(socketPath);
    const r = await c2.request({ op: "hello", ver: PROTOCOL_VERSION, pid: 222 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "busy");
    assert.equal(r.clientPid, 111, "the rejection names the holder");
    await c1.close();
    await c2.close();
  } finally {
    await host.shutdown();
  }
});

test("exit reasons: a client kill is 'killed', a self-death while attached is 'self'", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c = await connect(socketPath);
    await c.request({ op: "hello", ver: PROTOCOL_VERSION });
    await c.request({ op: "spawn", id: "k", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
    await c.request({ op: "spawn", id: "d", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
    await c.request({ op: "kill", id: "k" });
    const killed = await c.waitEvent((e) => e.op === "exit" && e.id === "k");
    assert.equal(killed.reason, "killed");
    c.send({ op: "write", id: "d", data: userMsg("die") });
    const died = await c.waitEvent((e) => e.op === "exit" && e.id === "d");
    assert.equal(died.reason, "self");
    assert.equal(died.code, 3, "the child's own exit code rides the event");
    assert.equal((await c.request({ op: "write", id: "d", data: userMsg("x") })).error, "not-alive");
    await c.close();
  } finally {
    await host.shutdown();
  }
});

test("a death while detached lands in the exits backlog with cwd, and ack-exits prunes it", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c1 = await connect(socketPath);
    await c1.request({ op: "hello", ver: PROTOCOL_VERSION });
    const spawned = await c1.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: "/tmp" });
    await c1.close();
    process.kill(spawned.pid); // dies with nobody attached — no owner asked for this → "self"
    await sleep(150);

    const c2 = await connect(socketPath);
    await c2.request({ op: "hello", ver: PROTOCOL_VERSION });
    const list = await c2.request({ op: "list" });
    assert.equal(list.sessions.length, 0);
    assert.equal(list.exits.length, 1);
    assert.equal(list.exits[0].id, "s1");
    assert.equal(list.exits[0].reason, "self");
    assert.equal(list.exits[0].cwd, "/tmp", "the backlog carries cwd so the client can find the marker");
    await c2.request({ op: "ack-exits", ids: ["s1"] });
    assert.equal((await c2.request({ op: "list" })).exits.length, 0, "acked exits are pruned");
    await c2.close();
  } finally {
    await host.shutdown();
  }
});

test("host shutdown kills the children as reason:'shutdown' (not a crash) and unlinks the socket", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  const c = await connect(socketPath);
  await c.request({ op: "hello", ver: PROTOCOL_VERSION });
  await c.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
  const done = c.waitEvent((e) => e.op === "exit" && e.id === "s1");
  await host.shutdown();
  assert.equal((await done).reason, "shutdown", "the remote-mode shuttingDown guard");
  assert.ok(!fs.existsSync(socketPath), "socket removed on clean shutdown");
  await c.close();
});

test("the socket 'shutdown' op stops everything — even while another client holds the hello slot", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  const devServer = await connect(socketPath);
  await devServer.request({ op: "hello", ver: PROTOCOL_VERSION });
  await devServer.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
  const exited = devServer.waitEvent((e) => e.op === "exit" && e.id === "s1");

  const stopper = await connect(socketPath); // `--stop` — a second conn, no hello needed
  assert.equal((await stopper.request({ op: "shutdown" })).ok, true);
  assert.equal((await exited).reason, "shutdown", "children end as a clean stop, not a crash");
  await host.shutdown(); // idempotent — the op already ran it
  assert.ok(!fs.existsSync(socketPath));
  await devServer.close();
  await stopper.close();
});

test("a stale socket file is reclaimed; a LIVE host's socket is not", async () => {
  const { socketPath, logPath } = tmpSock();
  fs.writeFileSync(socketPath, ""); // an unclean death leaves the path behind
  const host = await createHost({ socketPath, logPath });
  await assert.rejects(() => createHost({ socketPath, logPath }), /another session host is live/);
  await host.shutdown();
});
