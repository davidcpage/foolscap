import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexHostRuntime } from "../codex-host-runtime.js";

function fakeServer(account) {
  const requests = [];
  const notificationListeners = new Set();
  const closeListeners = new Set();
  let requestHandler = null;
  let killed = false;
  const server = {
    pid: 99,
    ready: Promise.resolve({}),
    requests,
    requestHandler: () => requestHandler,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "account/read") return { account, requiresOpenaiAuth: !account };
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "thread/unsubscribe") return {};
      throw new Error(`unexpected ${method}`);
    },
    notify() {},
    receiveLine() {},
    close() {},
    get closed() { return killed; },
    onNotification(fn) { notificationListeners.add(fn); return () => notificationListeners.delete(fn); },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
    setRequestHandler(fn) { requestHandler = fn; },
    kill() { killed = true; },
    get killed() { return killed; },
  };
  return server;
}

test("Codex host runtime requires ChatGPT auth and applies the confined first-slice policy", async () => {
  const server = fakeServer({ type: "chatgpt", email: "person@example.test", planType: "business" });
  const runtime = await createCodexHostRuntime({
    cwd: "/repo/app",
    onEvent() {},
    onClose() {},
    spawnServer: () => server,
  });
  assert.deepEqual(runtime.account, {
    type: "chatgpt", email: "person@example.test", planType: "business",
  });
  await runtime.start("canvas-a", { cwd: "/repo/worktree", model: "gpt-test", developerInstructions: "brief" });
  const start = server.requests.find((r) => r.method === "thread/start");
  assert.deepEqual(start.params, {
    cwd: "/repo/worktree",
    model: "gpt-test",
    developerInstructions: "brief",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  runtime.close();
  assert.equal(server.killed, true);
});

test("Codex host runtime refuses API-key billing before starting a thread", async () => {
  const server = fakeServer({ type: "apiKey" });
  await assert.rejects(
    createCodexHostRuntime({ cwd: "/repo/app", onEvent() {}, onClose() {}, spawnServer: () => server }),
    /requires ChatGPT login; refusing account type apiKey/,
  );
  assert.equal(server.killed, true);
  assert.deepEqual(server.requests.map((r) => r.method), ["account/read"]);
});
