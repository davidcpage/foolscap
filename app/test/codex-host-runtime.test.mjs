import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexHostRuntime, mergeRateLimitUpdate } from "../codex-host-runtime.js";

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
      if (method === "account/rateLimits/read") return {
        rateLimits: {
          limitId: "codex", planType: account?.planType,
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          credits: { hasCredits: true, unlimited: false, balance: "42.5" },
        },
      };
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
    emitNotification(message) { for (const fn of notificationListeners) fn(message); },
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
    async onRequest() { return { behavior: "deny" }; },
    onClose() {},
    spawnServer: () => server,
  });
  assert.deepEqual(runtime.account, {
    type: "chatgpt", email: "person@example.test", planType: "business",
  });
  assert.equal(runtime.usage().billing, "chatgpt-plan");
  assert.equal(runtime.usage().rateLimits.primary.usedPercent, 12);
  await runtime.start("canvas-a", { cwd: "/repo/worktree", model: "gpt-test", developerInstructions: "brief" });
  const start = server.requests.find((r) => r.method === "thread/start");
  assert.deepEqual(start.params, {
    cwd: "/repo/worktree",
    model: "gpt-test",
    developerInstructions: "brief",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  runtime.close();
  assert.equal(server.killed, true);
});

test("Codex rate-limit updates merge sparse app-server state without clearing account metadata", () => {
  const initial = {
    rateLimits: { limitId: "codex", planType: "business", primary: { usedPercent: 10, resetsAt: 123 }, credits: { balance: "5" } },
    rateLimitsByLimitId: { codex: { limitId: "codex", planType: "business", primary: { usedPercent: 10 } } },
  };
  const merged = mergeRateLimitUpdate(initial, {
    limitId: "codex", planType: null, primary: { usedPercent: 22 }, credits: null,
  });
  assert.equal(merged.rateLimits.planType, "business");
  assert.equal(merged.rateLimits.primary.usedPercent, 22);
  assert.equal(merged.rateLimits.primary.resetsAt, 123);
  assert.deepEqual(merged.rateLimits.credits, { balance: "5" });
  assert.equal(merged.rateLimitsByLimitId.codex.planType, "business");
});

test("Codex runtime refuses new billed work if app-server switches away from ChatGPT auth", async () => {
  const server = fakeServer({ type: "chatgpt", email: "person@example.test", planType: "business" });
  const runtime = await createCodexHostRuntime({
    cwd: "/repo/app", onEvent() {}, async onRequest() {}, onClose() {}, spawnServer: () => server,
  });
  server.emitNotification({ method: "account/updated", params: { authMode: "apikey", planType: null } });
  assert.equal(runtime.usage().account.type, "apiKey");
  assert.match(runtime.usage().error, /refusing account type apiKey/);
  await assert.rejects(runtime.prompt("canvas-a", "must not bill API"), /refusing account type apiKey/);
  runtime.close();
});

test("Codex host runtime refuses API-key billing before starting a thread", async () => {
  const server = fakeServer({ type: "apiKey" });
  await assert.rejects(
    createCodexHostRuntime({ cwd: "/repo/app", onEvent() {}, async onRequest() {}, onClose() {}, spawnServer: () => server }),
    /requires ChatGPT login; refusing account type apiKey/,
  );
  assert.equal(server.killed, true);
  assert.deepEqual(server.requests.map((r) => r.method), ["account/read"]);
});

test("Codex host runtime normalizes approval and user-input requests, then maps canvas answers", async () => {
  const server = fakeServer({ type: "chatgpt", planType: "team" });
  const seen = [];
  const runtime = await createCodexHostRuntime({
    cwd: "/repo/app",
    onEvent() {},
    async onRequest(sid, request) {
      seen.push({ sid, request });
      return request.kind === "approval"
        ? { behavior: "allow" }
        : { text: 'Your questions have been answered: "Which color?"="blue".' };
    },
    onClose() {},
    spawnServer: () => server,
  });
  await runtime.start("canvas-a", { cwd: "/repo/a" });
  assert.deepEqual(await server.requestHandler()({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-new", turnId: "turn-a", itemId: "item-a", command: "git push", cwd: "/repo/a" },
  }), { decision: "accept" });
  assert.deepEqual(await server.requestHandler()({
    id: 8,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-new", turnId: "turn-a", itemId: "item-q",
      questions: [{ id: "color", question: "Which color?", header: "Color" }],
    },
  }), { answers: { color: { answers: ["blue"] } } });
  assert.deepEqual(seen.map((x) => [x.sid, x.request.kind]), [["canvas-a", "approval"], ["canvas-a", "input"]]);
  runtime.close();
});
