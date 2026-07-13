// Logical-session multiplexing over ONE Codex app-server peer. Canvas session ids remain Foolscap's
// public identity; provider thread ids remain private routing keys persisted by the caller in session
// markers. This module owns no files and starts no process, so the long-lived sidecar can host it directly.

export function createCodexSessionRouter({ client, onEvent = () => {}, onRequest = null }) {
  const maxEarlyThreads = 100;
  const byCanvas = new Map(); // sid -> {threadId,status,activeTurnId,cwd,model}
  const byThread = new Map(); // provider thread id -> sid
  const early = new Map(); // threadId -> notifications that raced the thread/start response

  const threadIdOf = (message) => {
    const p = message?.params;
    return typeof p?.threadId === "string" ? p.threadId : typeof p?.thread?.id === "string" ? p.thread.id : null;
  };

  const deliver = (sid, message) => {
    const state = sid ? byCanvas.get(sid) : null;
    if (state) {
      if (message.method === "turn/started") {
        state.status = "running";
        state.activeTurnId = message.params?.turn?.id ?? state.activeTurnId;
      } else if (message.method === "turn/completed") {
        state.status = message.params?.turn?.status === "failed" ? "failed" : "idle";
        state.activeTurnId = null;
      } else if (message.method === "thread/status/changed") {
        const type = message.params?.status?.type;
        state.status = type === "active" ? "running"
          : type === "idle" ? "idle"
          : type === "notLoaded" ? "notLoaded"
          : type === "systemError" ? "failed"
          : state.status;
      }
    }
    onEvent(sid, message);
  };

  const unsubscribe = client.onNotification((message) => {
    const threadId = threadIdOf(message);
    if (!threadId) return deliver(null, message); // account/config/app-scoped event
    const sid = byThread.get(threadId);
    if (sid) return deliver(sid, message);
    const q = early.get(threadId) ?? [];
    q.push(message);
    if (q.length > 100) q.splice(0, q.length - 100);
    early.set(threadId, q);
    if (early.size > maxEarlyThreads) early.delete(early.keys().next().value);
  });

  client.setRequestHandler(async (message) => {
    if (!onRequest) throw new Error(`No canvas handler for Codex request ${message.method}`);
    const threadId = threadIdOf(message);
    return onRequest(threadId ? (byThread.get(threadId) ?? null) : null, message);
  });

  const bind = (sid, threadId, spec = {}) => {
    if (byCanvas.has(sid)) throw new Error(`canvas session ${sid} is already bound`);
    const occupied = byThread.get(threadId);
    if (occupied && occupied !== sid) throw new Error(`Codex thread ${threadId} is already bound to ${occupied}`);
    const state = {
      sid,
      threadId,
      status: "idle",
      activeTurnId: null,
      cwd: spec.cwd ?? null,
      model: spec.model ?? null,
    };
    byCanvas.set(sid, state);
    byThread.set(threadId, sid);
    for (const message of early.get(threadId) ?? []) deliver(sid, message);
    early.delete(threadId);
    return { ...state };
  };

  return {
    async start(sid, spec = {}) {
      await client.ready;
      const result = await client.request("thread/start", spec);
      const threadId = result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no thread id");
      return bind(sid, threadId, spec);
    },
    async resume(sid, threadId, spec = {}) {
      await client.ready;
      const result = await client.request("thread/resume", { ...spec, threadId });
      const returned = result?.thread?.id;
      if (returned !== threadId) throw new Error(`thread/resume returned unexpected thread id ${String(returned)}`);
      return bind(sid, threadId, spec);
    },
    async prompt(sid, text, overrides = {}) {
      const state = byCanvas.get(sid);
      if (!state) throw new Error(`unknown canvas session ${sid}`);
      if (state.activeTurnId) throw new Error(`canvas session ${sid} already has an active turn`);
      const result = await client.request("turn/start", {
        ...overrides,
        threadId: state.threadId,
        input: [{ type: "text", text }],
      });
      state.status = "running";
      state.activeTurnId = result?.turn?.id ?? null;
      return result;
    },
    async steer(sid, text) {
      const state = byCanvas.get(sid);
      if (!state) throw new Error(`unknown canvas session ${sid}`);
      if (!state.activeTurnId) throw new Error(`canvas session ${sid} has no active turn`);
      return client.request("turn/steer", {
        threadId: state.threadId,
        expectedTurnId: state.activeTurnId,
        input: [{ type: "text", text }],
      });
    },
    async interrupt(sid) {
      const state = byCanvas.get(sid);
      if (!state) throw new Error(`unknown canvas session ${sid}`);
      if (!state.activeTurnId) throw new Error(`canvas session ${sid} has no active turn`);
      return client.request("turn/interrupt", { threadId: state.threadId, turnId: state.activeTurnId });
    },
    async read(sid, includeTurns = true) {
      const state = byCanvas.get(sid);
      if (!state) throw new Error(`unknown canvas session ${sid}`);
      return client.request("thread/read", { threadId: state.threadId, includeTurns });
    },
    async release(sid) {
      const state = byCanvas.get(sid);
      if (!state) return false;
      await client.request("thread/unsubscribe", { threadId: state.threadId });
      byCanvas.delete(sid);
      byThread.delete(state.threadId);
      return true;
    },
    get(sid) {
      const state = byCanvas.get(sid);
      return state ? { ...state } : null;
    },
    list() {
      return [...byCanvas.values()].map((state) => ({ ...state }));
    },
    close() {
      unsubscribe();
      client.setRequestHandler(null);
    },
  };
}
