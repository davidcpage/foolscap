// The session-host's ONE shared Codex app-server runtime. This is deliberately a small adapter around
// codex-app-server + codex-session-router: session-host.js owns canvas-session lifecycle and its socket;
// this module owns Codex initialization, the ChatGPT-billing guard, and thread/turn calls.

import { spawnCodexAppServer } from "./codex-app-server.js";
import { createCodexSessionRouter } from "./codex-session-router.js";

export async function createCodexHostRuntime({ cwd, onEvent, onRequest, onClose, spawnServer = spawnCodexAppServer }) {
  const server = spawnServer({ cwd });
  let intentionalClose = false;
  let account = null;
  let rateLimitState = null;
  let usageError = null;
  let usageFetchedAt = null;
  let billingError = null;
  const router = createCodexSessionRouter({
    client: server,
    onEvent: (sid, message) => {
      if (!sid && message.method === "account/rateLimits/updated") {
        rateLimitState = mergeRateLimitUpdate(rateLimitState, message.params?.rateLimits);
        usageError = billingError;
        usageFetchedAt = Date.now();
      } else if (!sid && message.method === "account/updated") {
        const authMode = message.params?.authMode;
        if (authMode && authMode !== "chatgpt") {
          const type = authMode === "apikey" ? "apiKey" : authMode;
          account = mergePresent(account, { type, planType: message.params?.planType });
          billingError = `Codex app-server requires ChatGPT login; refusing account type ${type}`;
          usageError = billingError;
        } else {
          account = mergePresent(account, { type: authMode, planType: message.params?.planType });
          billingError = null;
          usageError = null;
        }
      }
      onEvent(sid, message);
    },
    onRequest: async (sid, message) => {
      if (!sid) throw new Error(`Codex request ${message.method} was not associated with a canvas session`);
      const answer = await onRequest(sid, normalizeRequest(message));
      if (message.method === "item/tool/requestUserInput")
        return { answers: answersFor(message.params?.questions, answer?.text) };
      if (message.method === "item/permissions/requestApproval") {
        if (answer?.behavior !== "allow") return { permissions: {}, scope: "turn" };
        return { permissions: message.params?.permissions ?? {}, scope: "turn" };
      }
      return { decision: answer?.behavior === "allow" ? "accept" : "decline" };
    },
  });
  server.onClose((reason) => {
    if (!intentionalClose) onClose(reason);
  });

  try {
    await server.ready;
    const accountResult = await server.request("account/read", { refreshToken: true });
    account = accountResult?.account;
    if (account?.type !== "chatgpt") {
      const actual = account?.type ?? (accountResult?.requiresOpenaiAuth ? "not logged in" : "unknown");
      throw new Error(`Codex app-server requires ChatGPT login; refusing account type ${actual}`);
    }

    try {
      rateLimitState = await server.request("account/rateLimits/read", null);
      usageFetchedAt = Date.now();
    } catch (err) {
      // Authentication is the billing safety boundary; usage telemetry is best-effort and must not
      // prevent sessions from starting when the account endpoint is temporarily unavailable.
      usageError = err instanceof Error ? err.message : String(err);
    }

    const threadSpec = (spec) => ({
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      // The app-server's native per-thread reasoning-effort field (verified against the installed codex: the
      // ReasoningEffort enum is a superset of our low|medium|high|xhigh|max). Absent = the plan default.
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      ...(spec.developerInstructions ? { developerInstructions: spec.developerInstructions } : {}),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const requireChatgpt = (fn) => (...args) => {
      if (billingError) return Promise.reject(new Error(billingError));
      return fn(...args);
    };

    return {
      pid: server.pid,
      // The ChatGPT account EMAIL is deliberately NOT exposed here. Both surfaces this runtime feeds are
      // shared/durable — provider-bound rides the session feed, usage() rides the every-tab usage feed and
      // is persisted into the shadow-git-versioned plan-usage cache — so an email here fans a billing
      // identity out to every agent and into repo history. That contradicts foldCodexEvent's own "email
      // deliberately not copied into the repo marker" intent (review finding 4). planType is kept: it's
      // non-identifying and the usage card shows it. The auth guard keys off account.type, never the email.
      account: { type: account.type, planType: account.planType },
      usage: () => ({
        provider: "codex",
        billing: "chatgpt-plan",
        account: { type: account.type, planType: account.planType },
        ...(rateLimitState ?? {}),
        error: usageError,
        fetchedAt: usageFetchedAt,
      }),
      start: requireChatgpt((sid, spec) => router.start(sid, threadSpec(spec))),
      resume: requireChatgpt((sid, providerSessionId, spec) => router.resume(sid, providerSessionId, threadSpec(spec))),
      prompt: requireChatgpt((sid, text) => router.prompt(sid, text)),
      steer: requireChatgpt((sid, text) => router.steer(sid, text)),
      interrupt: (sid) => router.interrupt(sid),
      read: (sid) => router.read(sid, true),
      // Historical cards are not live logical sessions, so read their provider conversation directly
      // without binding/subscribing it into the router or spending a turn.
      readThread: requireChatgpt((providerSessionId) =>
        server.request("thread/read", { threadId: providerSessionId, includeTurns: true })),
      release: (sid) => router.release(sid),
      close() {
        intentionalClose = true;
        router.close();
        server.kill();
      },
    };
  } catch (err) {
    intentionalClose = true;
    router.close();
    server.kill();
    throw err;
  }
}

function mergePresent(previous, update) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(update ?? {})) {
    // App-server documents rolling rate-limit/account updates as sparse: nullable metadata being
    // unavailable must not erase a previously observed value.
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function mergeRateLimitSnapshot(previous, update) {
  const merged = mergePresent(previous, update);
  for (const key of ["primary", "secondary", "credits", "individualLimit"]) {
    if (update?.[key] && typeof update[key] === "object")
      merged[key] = mergePresent(previous?.[key], update[key]);
  }
  return merged;
}

export function mergeRateLimitUpdate(previous, update) {
  if (!update || typeof update !== "object") return previous;
  const prior = previous ?? {};
  const snapshot = mergeRateLimitSnapshot(prior.rateLimits, update);
  const byId = { ...(prior.rateLimitsByLimitId ?? {}) };
  const limitId = update.limitId ?? snapshot.limitId;
  if (typeof limitId === "string" && limitId) byId[limitId] = mergeRateLimitSnapshot(byId[limitId], update);
  return {
    ...prior,
    rateLimits: snapshot,
    ...(Object.keys(byId).length ? { rateLimitsByLimitId: byId } : {}),
  };
}

function normalizeRequest(message) {
  const p = message.params ?? {};
  if (message.method === "item/tool/requestUserInput")
    return { kind: "input", questions: p.questions ?? [], turnId: p.turnId, itemId: p.itemId };
  if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(message.method))
    throw new Error(`unsupported Codex server request ${message.method}`);
  const toolName = message.method === "item/commandExecution/requestApproval" ? "Bash"
    : message.method === "item/fileChange/requestApproval" ? "Edit"
    : message.method === "item/permissions/requestApproval" ? "Permissions"
    : "Codex";
  const input = toolName === "Bash"
    ? { command: p.command, cwd: p.cwd, reason: p.reason }
    : toolName === "Edit"
      ? { grantRoot: p.grantRoot, reason: p.reason }
      : { cwd: p.cwd, permissions: p.permissions, reason: p.reason };
  return { kind: "approval", toolName, input, turnId: p.turnId, itemId: p.itemId };
}

function answersFor(questions, text) {
  const value = typeof text === "string" ? text : "";
  const result = {};
  for (const q of Array.isArray(questions) ? questions : []) {
    if (typeof q?.id !== "string") continue;
    const escaped = String(q.question ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = value.match(new RegExp(`"${escaped}"="([^"]*)"`));
    result[q.id] = { answers: [match?.[1] || value] };
  }
  return result;
}
