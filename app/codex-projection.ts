// The dev-server counterpart to the sidecar codex-*.js family (codex-app-server / codex-host-runtime /
// codex-session-router). Those modules run in the session-host and EMIT Codex app-server notifications as
// `codex_event` frames; THIS module is where the dev server INTERPRETS those frames — projecting a Codex
// thread/read into the session-card message codec (projectCodexHistory) and folding a live event stream
// into a LiveSession (foldCodexEvent). It is the Codex-specific half of the session engine; server-sessions.ts
// stays the generic (provider-agnostic) engine and reaches foldCodexEvent through the ServerContext seam
// (getServerContext().foldCodexEvent), exactly as it reaches foldShadowEdits.
//
// The generic engine ops the fold path needs (resumeRunning / persistServingState / settlePermission /
// PERMISSION_HOLD_MS) are imported straight from server-sessions.ts. That import is one-way — server-sessions
// never statically imports this module (it dispatches via the seam) — so there is no runtime import cycle.

import { getPendingPermissions, getServerContext } from "./server-context.js";
import { updateCanvasSession } from "./session-ledger.js";
import { PERMISSION_HOLD_MS, persistServingState, resumeRunning, settlePermission } from "./server-sessions.js";
import type { LiveSession } from "./server-types.js";

const codexUserText = (content: unknown): string => Array.isArray(content)
  ? content.map((p: any) => p?.type === "text" ? (p.text ?? "")
    : p?.type === "image" || p?.type === "localImage" ? "[image attached]"
    : p?.type === "skill" ? `[skill: ${p.name ?? p.path ?? "attached"}]`
    : "").filter(Boolean).join("\n")
  : "";

/** Complete provider-authored thread/read projection into the existing session-card message codec. */
export function projectCodexHistory(result: any): {
  lines: string[];
  error: string | null;
} {
  const lines: string[] = [];
  let error: string | null = null;
  const assistant = (content: any[]) => lines.push(JSON.stringify({
    type: "assistant", message: { role: "assistant", content },
  }));
  for (const turn of result?.thread?.turns ?? []) {
    for (const item of turn?.items ?? []) {
      if (item?.type === "userMessage") {
        const text = codexUserText(item.content);
        if (text) lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
      } else if (item?.type === "agentMessage" && typeof item.text === "string") {
        assistant([{ type: "text", text: item.text }]);
      } else if (item?.type === "reasoning") {
        const thinking = [...(item.summary ?? []), ...(item.content ?? [])].filter((x) => typeof x === "string").join("\n");
        if (thinking) assistant([{ type: "thinking", thinking }]);
      } else if (item?.type === "plan" && typeof item.text === "string") {
        assistant([{ type: "text", text: item.text }]);
      } else {
        const activity = codexActivityBlock(item);
        if (activity) {
          assistant([activity]);
          lines.push(JSON.stringify({
            type: "user",
            message: { role: "user", content: [{
              type: "tool_result", tool_use_id: activity.id, content: codexActivityResult(item),
            }] },
          }));
        }
      }
    }
    if (turn?.status === "failed") error = String(turn.error?.message ?? turn.error ?? "Codex turn failed");
  }
  return { lines, error };
}

function seedCodexHistory(s: LiveSession, result: any): void {
  if (s.lines.length) return;
  const projected = projectCodexHistory(result);
  s.lines.push(...projected.lines);
  if (projected.error) s.error = projected.error;
}

export function foldCodexEvent(s: LiveSession, e: any): void {
  const { flushNudge } = getServerContext();
  const p = e?.params ?? {};
  switch (e?.method) {
    case "canvas/provider-bound":
      s.providerSessionId = typeof p.providerSessionId === "string" ? p.providerSessionId : s.providerSessionId;
      // The app-server's resolved serving model (from thread/start): fold it so a Codex spawn with no explicit
      // model still shows what it ran — the previously-blank Codex pill — and doesn't overwrite an explicit
      // model with a blank. Only take a real string.
      if (typeof p.model === "string" && p.model) s.model = p.model;
      updateCanvasSession(s.repoPath, s.id, {
        provider: "codex",
        providerSessionId: s.providerSessionId,
        ...(s.model ? { model: s.model } : {}), // durable serving model → the pill survives Done
        // Plan provenance is durable; the signed-in email is deliberately not copied into the repo marker.
        codexAccount: p.account
          ? { type: p.account.type, planType: p.account.planType }
          : null,
      });
      break;
    case "canvas/history":
      seedCodexHistory(s, p);
      break;
    case "turn/started":
      resumeRunning(s);
      s.verb = "Thinking";
      s.error = null;
      break;
    case "item/agentMessage/delta": {
      const itemId = typeof p.itemId === "string" ? p.itemId : "agent-message";
      if (!s.inflight || s.inflight[0]?.id !== itemId)
        s.inflight = [{ type: "text", text: "", id: itemId }];
      s.inflight[0].text = (s.inflight[0].text ?? "") + (typeof p.delta === "string" ? p.delta : "");
      s.verb = "Responding";
      resumeRunning(s);
      break;
    }
    case "item/started": {
      const activity = codexActivityBlock(p.item);
      if (activity) s.inflight = [activity];
      if (p.item?.type === "commandExecution") s.verb = "Running";
      else if (p.item?.type === "fileChange") s.verb = "Editing";
      else if (p.item?.type === "mcpToolCall") s.verb = "Using tool";
      resumeRunning(s);
      break;
    }
    case "item/completed":
      if (p.item?.type === "agentMessage" && typeof p.item.text === "string") {
        s.lines.push(JSON.stringify({
          type: "assistant", message: { role: "assistant", content: [{ type: "text", text: p.item.text }] },
        }));
        s.inflight = null;
      } else {
        const activity = codexActivityBlock(p.item);
        if (activity) {
          s.lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [activity] } }));
          s.lines.push(JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: activity.id, content: codexActivityResult(p.item) }] },
          }));
          s.inflight = null;
        }
      }
      break;
    case "turn/plan/updated":
      s.plan = (p.plan ?? []).map((x: any) => ({ step: String(x.step ?? ""), status: x.status }));
      break;
    case "thread/tokenUsage/updated": {
      const last = p.tokenUsage?.last;
      if (last) s.usage = { input: Number(last.inputTokens) || 0, output: Number(last.outputTokens) || 0 };
      break;
    }
    case "turn/completed":
      s.inflight = null;
      s.status = "idle";
      s.verb = null;
      if (s.autoWake) s.idleSince = Date.now();
      persistServingState(s); // make the folded Codex serving model durable so the pill survives Done
      if (s.nudge) flushNudge(s);
      if (p.turn?.status === "failed") {
        s.error = String(p.turn?.error?.message ?? p.turn?.error ?? "Codex turn failed");
      }
      break;
    case "thread/status/changed":
      if (p.status?.type === "active") resumeRunning(s);
      else if (p.status?.type === "idle" || p.status?.type === "notLoaded") {
        s.status = "idle";
        s.verb = null;
      }
      break;
    case "canvas/error":
      s.status = "idle";
      s.verb = null;
      s.error = typeof p.message === "string" ? p.message : "Codex session error";
      break;
    case "canvas/request":
      if (p.kind === "approval" && typeof p.requestId === "string") registerCodexPermission(s, p);
      else if (p.kind === "input" && typeof p.requestId === "string") {
        const questions = Array.isArray(p.questions) ? p.questions : [];
        const ask = questions.map((q: any) => ({
          question: q.question, header: q.header, multiSelect: false,
          options: Array.isArray(q.options) ? q.options : [],
        }));
        s.lines.push(JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `\`\`\`ask\n${JSON.stringify({ questions: ask })}\n\`\`\`` }] },
        }));
        s.inflight = null;
      }
      break;
    case "canvas/request-resolved": {
      const pending = getPendingPermissions(getServerContext().fsState);
      const held = pending.get(p.requestId);
      if (held?.providerRequestId) {
        clearTimeout(held.timer);
        pending.delete(p.requestId);
      }
      break;
    }
  }
}

function codexActivityBlock(item: any): any | null {
  if (!item || typeof item.id !== "string") return null;
  if (item.type === "commandExecution")
    return { type: "tool_use", id: item.id, name: "Bash", input: { command: item.command, cwd: item.cwd } };
  if (item.type === "fileChange")
    return { type: "tool_use", id: item.id, name: "Edit", input: { changes: item.changes } };
  if (item.type === "mcpToolCall")
    return { type: "tool_use", id: item.id, name: item.tool ?? item.name ?? "MCP", input: item.arguments ?? {} };
  // Preserve every remaining provider item instead of silently dropping it from resumed history. The
  // renderer already has a generic tool row; keep provider-private detail behind that debug-shaped input.
  if (typeof item.type === "string") {
    const { id, type, status, result, error, aggregatedOutput, output, ...input } = item;
    return { type: "tool_use", id, name: `Codex:${type}`, input };
  }
  return null;
}

function codexActivityResult(item: any): string {
  if (item?.type === "commandExecution") return String(item.aggregatedOutput ?? item.output ?? item.status ?? "completed");
  const value = item?.result ?? item?.error ?? item?.output ?? item?.status ?? "completed";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function registerCodexPermission(s: LiveSession, p: any): void {
  const pending = getPendingPermissions(getServerContext().fsState);
  if (pending.has(p.requestId)) return;
  const timer = setTimeout(
    () => settlePermission(p.requestId, { behavior: "deny" }),
    PERMISSION_HOLD_MS,
  );
  pending.set(p.requestId, {
    permId: p.requestId, sid: s.id, toolName: p.toolName ?? "Codex", input: p.input ?? {},
    ts: Date.now(), timer, providerRequestId: p.requestId,
  });
}
