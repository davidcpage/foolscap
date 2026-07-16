// The MAIN model pill must show the MAIN agent's model — a Task/Agent SUBAGENT (sidechain) turn must never
// overwrite it, and an ACTIVE subagent on a distinct model gets its OWN secondary chip. Driven against the
// REAL, ctx-bound foldSessionEvent (server-sessions.ts) with a minimal fake ServerContext (the wake-fallback
// pattern), plus a replay of a REAL `claude -p` stream capture containing a live subagent run.
//
// Empirical grounding (CC 2.1.211, captured with the exact buildSessionArgs flags — see fixtures/
// subagent-stream.jsonl): a subagent runs as a `local_agent` task OFF the parent stream; its assistant turns
// are NOT inlined and carry no model here. The live discriminator is the top-level `parent_tool_use_id`
// (null for the main agent). We track a subagent from its Task/Agent tool_use block and drop it on the
// matching tool_result, a terminal task_notification, or the turn's `result`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Rewrite a relative `.js` import to its `.ts` sibling when the `.js` doesn't exist (same hook the other
// server-module tests use; must precede the dynamic import below).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const sessions = await import("../server-sessions.ts");
const serverCtx = await import("../server-context.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Minimal fake context: foldSessionEvent only reaches foldShadowEdits + flushNudge from it (both no-ops
// here); the disk-touching helpers it calls (clearBlockedIntents, updateCanvasSession) are keyed on the
// session's own temp repoPath and are best-effort.
function wire() {
  serverCtx.setServerContext({
    foldShadowEdits: () => {},
    flushNudge: () => {},
  });
}

// A bare LiveSession with just the fields foldSessionEvent reads/writes.
function makeSession(model = null) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ses-subagent-"));
  return {
    id: "s-test",
    repoPath,
    cwd: repoPath,
    lines: [],
    inflight: null,
    status: "running",
    skills: null,
    verb: null,
    usage: null,
    model,
    effort: null,
    turnOut: 0,
    nudge: false,
    read: {},
    pendingEdits: new Map(),
  };
}

// event builders mirroring the verified live shapes
const asst = (model, { ptui = null, content } = {}) => ({
  type: "assistant",
  parent_tool_use_id: ptui,
  message: { model, content: content ?? [{ type: "text", text: "hi" }], usage: { output_tokens: 1 } },
});
const toolUse = (name, id, input) => asst("claude-sonnet-5", { content: [{ type: "tool_use", name, id, input }] });
const toolResult = (toolUseId) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: [] }] } });
const messageStart = (model, ptui = null) => ({ type: "stream_event", parent_tool_use_id: ptui, event: { type: "message_start", message: { model, usage: { input_tokens: 1, output_tokens: 0 } } } });

test("a subagent (parent_tool_use_id) assistant turn does NOT overwrite the main model pill", () => {
  wire();
  const s = makeSession("claude-sonnet-5");
  sessions.foldSessionEvent(s, asst("claude-haiku-4-5-20251001", { ptui: "toolu_sub" }));
  assert.equal(s.model, "claude-sonnet-5", "sidechain assistant must not latch onto the main pill");
  sessions.foldSessionEvent(s, messageStart("claude-haiku-4-5-20251001", "toolu_sub"));
  assert.equal(s.model, "claude-sonnet-5", "sidechain message_start must not latch onto the main pill either");
});

test("a MAIN-agent refusal fallback STILL overwrites the model pill (parent_tool_use_id absent)", () => {
  wire();
  const s = makeSession("claude-fable-5");
  sessions.foldSessionEvent(s, asst("claude-opus-4-8")); // no ptui → the main agent fell back
  assert.equal(s.model, "claude-opus-4-8", "the intended refusal-fallback overwrite must be preserved");
  sessions.foldSessionEvent(s, messageStart("claude-sonnet-5")); // main-agent live message_start
  assert.equal(s.model, "claude-sonnet-5");
});

test("a Task/Agent tool_use registers a subagent with its requested model + type", () => {
  wire();
  const s = makeSession("claude-sonnet-5");
  sessions.foldSessionEvent(s, toolUse("Agent", "toolu_1", { model: "haiku", subagent_type: "general-purpose" }));
  assert.equal(s.subagents.size, 1);
  assert.deepEqual(s.subagents.get("toolu_1"), { model: "haiku", subagentType: "general-purpose" });
  assert.equal(s.model, "claude-sonnet-5", "registering a subagent must not touch the main pill");
});

test("a subagent with no requested model is tracked but omitted from the published (model-known) chips", () => {
  wire();
  const s = makeSession("claude-sonnet-5");
  sessions.foldSessionEvent(s, toolUse("Task", "toolu_x", { subagent_type: "general-purpose" })); // inherits parent model
  assert.equal(s.subagents.get("toolu_x").model, null);
  const known = [...s.subagents.values()].filter((x) => x.model);
  assert.equal(known.length, 0, "an inherited-model subagent yields no distinct chip");
});

test("a matching tool_result drops the subagent chip (synchronous path)", () => {
  wire();
  const s = makeSession("claude-sonnet-5");
  sessions.foldSessionEvent(s, toolUse("Agent", "toolu_2", { model: "haiku" }));
  sessions.foldSessionEvent(s, toolResult("toolu_2"));
  assert.equal(s.subagents.size, 0, "the subagent chip clears the moment its tool_result lands");
});

test("a terminal task_notification drops a background subagent; a non-terminal one keeps it", () => {
  wire();
  const s = makeSession("claude-sonnet-5");
  sessions.foldSessionEvent(s, toolUse("Agent", "toolu_3", { model: "haiku" }));
  sessions.foldSessionEvent(s, { type: "system", subtype: "task_notification", tool_use_id: "toolu_3", status: "in_progress" });
  assert.equal(s.subagents.size, 1, "an in-flight notification must not drop the chip");
  sessions.foldSessionEvent(s, { type: "system", subtype: "task_notification", tool_use_id: "toolu_3", status: "completed" });
  assert.equal(s.subagents.size, 0, "a completed notification drops the chip");
});

test("the turn's result event clears any lingering subagent chips (stale-pill backstop)", () => {
  wire();
  const s = makeSession("claude-sonnet-5");
  sessions.foldSessionEvent(s, toolUse("Agent", "toolu_4", { model: "haiku" }));
  sessions.foldSessionEvent(s, { type: "result", subtype: "success", result: "done" });
  assert.equal(s.subagents === undefined || s.subagents.size === 0, true, "no subagent survives the turn boundary");
});

test("REPLAY of a real claude -p subagent capture: main model stays put, no chip lingers at turn end", () => {
  wire();
  const s = makeSession(null);
  const lines = fs.readFileSync(path.join(HERE, "fixtures/subagent-stream.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  let sawSubagent = false;
  for (const line of lines) {
    sessions.foldSessionEvent(s, JSON.parse(line));
    if (s.subagents && s.subagents.size) sawSubagent = true;
  }
  // The capture's main agent ran on sonnet; the haiku subagent's turns never inlined, so the pill is sonnet.
  assert.equal(s.model, "claude-sonnet-5", "the main pill reflects the MAIN agent across a real subagent run");
  // A subagent WAS tracked mid-run (from the Agent tool_use) and cleared by the turn's end (result/tool_result).
  assert.equal(sawSubagent, true, "the Agent tool_use should have been tracked as a live subagent mid-run");
  assert.equal(s.subagents === undefined || s.subagents.size === 0, true, "no stale chip remains after the turn");
});
