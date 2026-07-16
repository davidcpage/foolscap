// The logical-session router multiplexes canvas sids over one Codex app-server peer. These tests pin the
// bind/release bookkeeping directly (no process), since that's where the review's poison-a-sid bug lived.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexSessionRouter } from "../codex-session-router.js";

// A minimal fake app-server peer: canned thread/start ids, a toggleable thread/unsubscribe failure, and a
// record of every request so a test can assert what was called.
function fakeClient({ failUnsubscribe = false } = {}) {
  const requests = [];
  return {
    requests,
    setFailUnsubscribe(v) { failUnsubscribe = v; },
    ready: Promise.resolve(),
    onNotification() { return () => {}; },
    setRequestHandler() {},
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "thread/unsubscribe") {
        if (failUnsubscribe) throw new Error("thread/unsubscribe boom");
        return {};
      }
      return {};
    },
  };
}

test("release cleans local routing in a finally even when thread/unsubscribe rejects (finding 6)", async () => {
  const client = fakeClient({ failUnsubscribe: true });
  const router = createCodexSessionRouter({ client });
  const bound = await router.start("sid-1");
  assert.equal(bound.threadId, "thread-1");
  assert.ok(router.get("sid-1"), "session is bound after start");

  // The unsubscribe rejects — the caller sees the rejection, but the local byCanvas/byThread entries must
  // still be dropped (the pre-fix bug left them pinned, so a respawn threw "already bound" until restart).
  await assert.rejects(() => router.release("sid-1"), /thread\/unsubscribe boom/);
  assert.equal(router.get("sid-1"), null, "byCanvas entry cleaned despite the rejected unsubscribe");

  // Proof the sid isn't poisoned: a fresh bind of the SAME sid (and the same thread id) succeeds.
  client.setFailUnsubscribe(false);
  const rebound = await router.start("sid-1");
  assert.equal(rebound.threadId, "thread-1", "the sid rebinds cleanly — not permanently poisoned");
});

test("a normal release cleans routing and returns true", async () => {
  const client = fakeClient();
  const router = createCodexSessionRouter({ client });
  await router.start("sid-2");
  assert.equal(await router.release("sid-2"), true);
  assert.equal(router.get("sid-2"), null);
  assert.equal(await router.release("sid-2"), false, "releasing an unknown sid is a no-op false");
});

// ── The serving model bound onto a session: the app-server's resolved model, else the requested one ──
test("start forwards the model+reasoningEffort spec to thread/start", async () => {
  const client = fakeClient();
  const router = createCodexSessionRouter({ client });
  await router.start("sid-m", { cwd: "/repo", model: "gpt-5.6-codex", reasoningEffort: "high" });
  const startReq = client.requests.find((r) => r.method === "thread/start");
  assert.equal(startReq.params.model, "gpt-5.6-codex");
  assert.equal(startReq.params.reasoningEffort, "high");
});

test("start binds the app-server's resolved model when the response names one (a no-explicit-model spawn)", async () => {
  // A spawn with NO explicit model: the app-server picks the plan default and reports it in the thread.
  const client = fakeClient();
  client.request = async (method, params) => {
    client.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-x", model: "gpt-5.6-codex" } };
    return {};
  };
  const router = createCodexSessionRouter({ client });
  const bound = await router.start("sid-x", { cwd: "/repo" });
  assert.equal(bound.model, "gpt-5.6-codex", "the actual serving model is folded onto the bound state");
});

test("start falls back to the requested model when the response omits one", async () => {
  const client = fakeClient(); // thread/start returns { thread: { id } } only — no model
  const router = createCodexSessionRouter({ client });
  const bound = await router.start("sid-y", { cwd: "/repo", model: "gpt-5.6-codex" });
  assert.equal(bound.model, "gpt-5.6-codex");
  // Neither requested nor reported → null (the marker/pill stays honestly blank until an event names it).
  // A fresh router/client so the second bind isn't rejected as a duplicate of the canned thread id.
  const bare = await createCodexSessionRouter({ client: fakeClient() }).start("sid-z", { cwd: "/repo" });
  assert.equal(bare.model, null);
});
