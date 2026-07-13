import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexAppServerPeer } from "../codex-app-server.js";
import { createCodexSessionRouter } from "../codex-session-router.js";

function fakeAppServer() {
  let client;
  let threadSeq = 0;
  let turnSeq = 0;
  const writes = [];
  const serverPending = new Map();

  const send = (message) => queueMicrotask(() => client.receiveLine(JSON.stringify(message)));
  const writeLine = (line) => {
    const message = JSON.parse(line);
    writes.push(message);
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      serverPending.get(message.id)?.(message);
      serverPending.delete(message.id);
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "initialize") return send({ id: message.id, result: { platformFamily: "unix" } });
    if (message.method === "thread/start") {
      const id = `thr_${++threadSeq}`;
      // Intentionally notify BEFORE resolving: the router must buffer this race until it learns the id.
      send({ method: "thread/started", params: { thread: { id } } });
      return send({ id: message.id, result: { thread: { id } } });
    }
    if (message.method === "thread/resume")
      return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    if (message.method === "turn/start") {
      const turnId = `turn_${++turnSeq}`;
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      return send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } } });
    }
    if (message.method === "turn/steer")
      return send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
    if (message.method === "thread/read")
      return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
    if (message.method === "thread/unsubscribe")
      return send({ id: message.id, result: { status: "unsubscribed" } });
    if (message.method === "test/error")
      return send({ id: message.id, error: { code: 499, message: "synthetic failure", data: { why: "test" } } });
  };
  client = createCodexAppServerPeer({ writeLine, requestTimeoutMs: 1000 });
  return {
    client,
    writes,
    notify(method, params) { send({ method, params }); },
    request(method, params) {
      const id = `server_${serverPending.size + 1}`;
      return new Promise((resolve) => {
        serverPending.set(id, resolve);
        send({ id, method, params });
      });
    },
  };
}

test("app-server peer performs initialize/initialized and correlates errors", async () => {
  const fake = fakeAppServer();
  await fake.client.ready;
  assert.deepEqual(fake.writes.slice(0, 2).map((m) => m.method), ["initialize", "initialized"]);
  await assert.rejects(
    () => fake.client.request("test/error"),
    (err) => err.message === "synthetic failure" && err.code === 499 && err.data.why === "test",
  );
});

test("one peer multiplexes canvas sessions by Codex thread id, including an early notification", async () => {
  const fake = fakeAppServer();
  const events = [];
  const router = createCodexSessionRouter({ client: fake.client, onEvent: (sid, message) => events.push({ sid, message }) });
  const a = await router.start("canvas-a", { cwd: "/repo/a", model: "gpt-a" });
  const b = await router.start("canvas-b", { cwd: "/repo/b", model: "gpt-b" });
  assert.deepEqual([a.threadId, b.threadId], ["thr_1", "thr_2"]);
  assert.deepEqual(router.list().map((s) => [s.sid, s.threadId]), [["canvas-a", "thr_1"], ["canvas-b", "thr_2"]]);
  assert.deepEqual(
    events.filter((e) => e.message.method === "thread/started").map((e) => e.sid),
    ["canvas-a", "canvas-b"],
    "notifications that raced thread/start were delivered after binding",
  );

  await router.prompt("canvas-a", "alpha");
  await router.prompt("canvas-b", "beta");
  fake.notify("item/agentMessage/delta", { threadId: "thr_2", turnId: "turn_2", itemId: "i2", delta: "B" });
  fake.notify("item/agentMessage/delta", { threadId: "thr_1", turnId: "turn_1", itemId: "i1", delta: "A" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((e) => e.message.method === "item/agentMessage/delta").map((e) => [e.sid, e.message.params.delta]),
    [["canvas-b", "B"], ["canvas-a", "A"]],
  );
  assert.equal(router.get("canvas-a").activeTurnId, "turn_1");
  assert.equal(router.get("canvas-b").activeTurnId, "turn_2");
  router.close();
});
test("server requests route to the owning canvas session and return its answer", async () => {
  const fake = fakeAppServer();
  const seen = [];
  const router = createCodexSessionRouter({
    client: fake.client,
    onRequest: async (sid, message) => {
      seen.push([sid, message.method]);
      return { decision: "accept" };
    },
  });
  await router.start("canvas-a");
  const answer = await fake.request("item/commandExecution/requestApproval", { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" });
  assert.deepEqual(seen, [["canvas-a", "item/commandExecution/requestApproval"]]);
  assert.deepEqual(answer.result, { decision: "accept" });
  router.close();
});

test("prompt, steer, interrupt, completion, read, and release use the bound logical thread", async () => {
  const fake = fakeAppServer();
  const router = createCodexSessionRouter({ client: fake.client });
  await router.resume("canvas-r", "thr_saved", { cwd: "/repo" });
  await router.prompt("canvas-r", "work");
  await router.steer("canvas-r", "focus tests");
  await router.interrupt("canvas-r");
  fake.notify("turn/completed", { threadId: "thr_saved", turn: { id: "turn_1", status: "interrupted" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(router.get("canvas-r").status, "idle");
  assert.equal(router.get("canvas-r").activeTurnId, null);
  assert.deepEqual(await router.read("canvas-r"), { thread: { id: "thr_saved", turns: [] } });
  assert.equal(await router.release("canvas-r"), true);
  assert.equal(router.get("canvas-r"), null);
  router.close();
});
