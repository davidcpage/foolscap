// The session-host sidecar: children survive client detach, the busy bit tracks turns, exits carry the
// reason that separates a crash from a kill from a host shutdown, and one client holds the attachment.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHost } from "../session-host.js";
import { makeLineSplitter, isResultLine, isUserWrite } from "../session-host-protocol.js";

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

test("spawn → line events stream; a turn answers and the busy bit falls back to idle", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c = await connect(socketPath);
    assert.equal((await c.request({ op: "hello", ver: 1, pid: process.pid })).ok, true);
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
    await c.request({ op: "hello", ver: 1 });
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

test("children survive client detach; a reattaching client lists them with a correct busy bit", async () => {
  const { socketPath, logPath } = tmpSock();
  const host = await createHost({ socketPath, logPath });
  try {
    const c1 = await connect(socketPath);
    await c1.request({ op: "hello", ver: 1 });
    await c1.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: "/tmp" });
    c1.send({ op: "write", id: "s1", data: userMsg("hang") });
    await sleep(100);
    await c1.close();

    const c2 = await connect(socketPath);
    assert.equal((await c2.request({ op: "hello", ver: 1 })).ok, true, "slot freed by the detach");
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
    await c1.request({ op: "hello", ver: 1, pid: 111 });
    const c2 = await connect(socketPath);
    const r = await c2.request({ op: "hello", ver: 1, pid: 222 });
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
    await c.request({ op: "hello", ver: 1 });
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
    await c1.request({ op: "hello", ver: 1 });
    const spawned = await c1.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: "/tmp" });
    await c1.close();
    process.kill(spawned.pid); // dies with nobody attached — no owner asked for this → "self"
    await sleep(150);

    const c2 = await connect(socketPath);
    await c2.request({ op: "hello", ver: 1 });
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
  await c.request({ op: "hello", ver: 1 });
  await c.request({ op: "spawn", id: "s1", cmd: process.execPath, args: [FAKE], cwd: os.tmpdir() });
  const done = c.waitEvent((e) => e.op === "exit" && e.id === "s1");
  await host.shutdown();
  assert.equal((await done).reason, "shutdown", "the remote-mode shuttingDown guard");
  assert.ok(!fs.existsSync(socketPath), "socket removed on clean shutdown");
  await c.close();
});

test("a stale socket file is reclaimed; a LIVE host's socket is not", async () => {
  const { socketPath, logPath } = tmpSock();
  fs.writeFileSync(socketPath, ""); // an unclean death leaves the path behind
  const host = await createHost({ socketPath, logPath });
  await assert.rejects(() => createHost({ socketPath, logPath }), /another session host is live/);
  await host.shutdown();
});
