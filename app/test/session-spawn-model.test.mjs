// Model choice at session spawn (thread "Model choice in sessions"). The contract: every spawned
// `claude -p` child is launched with an EXPLICIT `--model`, resolved explicit spawn param > role `model:`
// frontmatter > DEFAULT_SESSION_MODEL — never inherited from ~/.claude/settings.json (which pins Fable 5
// on the dev machine and silently burned Fable quota on every worker). These exercise the pure arg-assembly
// seam (buildSessionArgs / resolveSessionModel) hermetically — no live server, no real process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same resolve hook as middleware-hermetic.test.mjs: the split server modules import each other by the
// TypeScript/Vite `.js`-specifier convention; rewrite to the `.ts` sibling only when no `.js` exists.
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

const { buildSessionArgs, resolveSessionModel, resolveSessionEffort, isValidEffort, EFFORT_LEVELS, resolveClaudeCommand, DEFAULT_SESSION_MODEL } = await import("../server-sessions.ts");
const { projectCodexHistory } = await import("../codex-projection.ts");
const { readRole } = await import("../role-ledger.js");

test("Claude executable discovery honors the explicit GUI-safe override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-command-"));
  const command = path.join(dir, "claude");
  fs.writeFileSync(command, "#!/bin/sh\n");
  fs.chmodSync(command, 0o755);
  const prior = process.env.CANVAS_CLAUDE_COMMAND;
  process.env.CANVAS_CLAUDE_COMMAND = command;
  try {
    assert.equal(resolveClaudeCommand(), command);
  } finally {
    if (prior == null) delete process.env.CANVAS_CLAUDE_COMMAND;
    else process.env.CANVAS_CLAUDE_COMMAND = prior;
  }
});

test("Claude usage User-Agent uses GUI-safe executable discovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ua-"));
  const command = path.join(dir, "claude");
  fs.writeFileSync(command, "#!/bin/sh\necho 'Claude Code 9.8.7'\n");
  fs.chmodSync(command, 0o755);
  const prior = process.env.CANVAS_CLAUDE_COMMAND;
  process.env.CANVAS_CLAUDE_COMMAND = command;
  try {
    const { claudeUserAgent } = await import("../server-orchestration.ts");
    assert.equal(await claudeUserAgent(), "claude-code/9.8.7");
  } finally {
    if (prior == null) delete process.env.CANVAS_CLAUDE_COMMAND;
    else process.env.CANVAS_CLAUDE_COMMAND = prior;
  }
});

test("Codex thread/read history projects every turn item without rollout-file scraping", () => {
  const projected = projectCodexHistory({ thread: { turns: [{ status: "failed", error: { message: "safe failure" }, items: [
    { id: "u", type: "userMessage", content: [{ type: "text", text: "hello" }, { type: "image", imageUrl: "data:x" }] },
    { id: "r", type: "reasoning", summary: ["considering"], content: [] },
    { id: "c", type: "commandExecution", command: "pwd", cwd: "/repo", status: "completed", aggregatedOutput: "/repo" },
    { id: "w", type: "webSearch", query: "docs", status: "completed" },
    { id: "a", type: "agentMessage", text: "done" },
  ] }] } });
  const text = projected.lines.join("\n");
  assert.ok(text.includes("hello") && text.includes("[image attached]"));
  assert.ok(text.includes("considering"));
  assert.ok(text.includes('"name":"Bash"') && text.includes("/repo"));
  assert.ok(text.includes('"name":"Codex:webSearch"'), "unknown app-server items survive via generic activity rows");
  assert.ok(text.includes("done"));
  assert.equal(projected.error, "safe failure");
});
const { parseRoleFile } = await import("../role-format.js");

/** The value following a flag in an argv array (asserts the flag appears exactly once). */
function flagValue(args, flag) {
  const hits = args.map((a, i) => (a === flag ? i : -1)).filter((i) => i >= 0);
  assert.equal(hits.length, 1, `${flag} must appear exactly once in ${JSON.stringify(args)}`);
  return args[hits[0] + 1];
}

const baseOpts = {
  id: "11111111-2222-3333-4444-555555555555",
  resume: false,
  mcpConfig: { mcpServers: {} },
  settingsOverride: { autoMemoryDirectory: "/tmp/x" },
  appendPrompt: "brief",
};

// ── The spawn-arg contract: --model always rides, carrying the resolved model ──────────────────────
test("buildSessionArgs launches `claude -p` with the given --model", () => {
  const args = buildSessionArgs({ ...baseOpts, model: "claude-sonnet-5" });
  assert.equal(args[0], "-p");
  assert.equal(flagValue(args, "--session-id"), baseOpts.id);
  assert.equal(flagValue(args, "--model"), "claude-sonnet-5");
});

test("buildSessionArgs keeps --model on the --resume path too", () => {
  const args = buildSessionArgs({ ...baseOpts, resume: true, model: DEFAULT_SESSION_MODEL });
  assert.equal(flagValue(args, "--resume"), baseOpts.id);
  assert.equal(flagValue(args, "--model"), DEFAULT_SESSION_MODEL);
});

// ── Precedence: explicit spawn param > role `model:` frontmatter > the Opus default ────────────────
test("resolveSessionModel: explicit param beats the role's model beats the default", () => {
  const role = { model: "claude-fable-5" };
  assert.equal(resolveSessionModel("claude-haiku-4-5-20251001", role), "claude-haiku-4-5-20251001");
  assert.equal(resolveSessionModel(null, role), "claude-fable-5");
  assert.equal(resolveSessionModel(null, { model: null }), DEFAULT_SESSION_MODEL);
  assert.equal(resolveSessionModel(null, null), DEFAULT_SESSION_MODEL);
  assert.equal(resolveSessionModel("", null), DEFAULT_SESSION_MODEL); // an empty param is "not given"
  assert.equal(DEFAULT_SESSION_MODEL, "claude-opus-4-8");
});

test("a role's `model:` frontmatter flows from role.md text into the spawn argv", () => {
  const role = parseRoleFile("---\nname: Coordinator\nmodel: claude-fable-5\n---\n\ncoordinate", "pm");
  const args = buildSessionArgs({ ...baseOpts, model: resolveSessionModel(null, role) });
  assert.equal(flagValue(args, "--model"), "claude-fable-5");
});

test("absent both param and role model, the spawn argv carries the Opus default", () => {
  const bare = parseRoleFile("---\nname: Generalist\n---\n\nhelp", "generalist");
  const args = buildSessionArgs({ ...baseOpts, model: resolveSessionModel(null, bare) });
  assert.equal(flagValue(args, "--model"), "claude-opus-4-8");
});

// ── The shipped Coordinator/pm role pins Fable (read through the real ledger, bundled layer) ───────
test("bundled pm role resolves with model claude-fable-5; generalist has none", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-model-")); // no board overrides → bundled layer answers
  try {
    assert.equal(readRole(tmpRepo, "pm")?.model, "claude-fable-5");
    assert.equal(readRole(tmpRepo, "generalist")?.model, null);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ── Reasoning effort: the --effort flag rides only when explicitly resolved ─────────────────────────
test("buildSessionArgs adds --effort when set, omits it entirely when null/absent", () => {
  const withEffort = buildSessionArgs({ ...baseOpts, model: "claude-opus-4-8", effort: "xhigh" });
  assert.equal(flagValue(withEffort, "--effort"), "xhigh");
  // Null / absent effort → no flag at all (the CLI applies its own default effort).
  assert.ok(!buildSessionArgs({ ...baseOpts, model: "claude-opus-4-8", effort: null }).includes("--effort"));
  assert.ok(!buildSessionArgs({ ...baseOpts, model: "claude-opus-4-8" }).includes("--effort"));
});

test("isValidEffort accepts exactly the contract levels; EFFORT_LEVELS is that set", () => {
  assert.deepEqual([...EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
  for (const lvl of EFFORT_LEVELS) assert.equal(isValidEffort(lvl), true);
  for (const bad of ["minimal", "ultra", "MAX", "", null, undefined, 3]) assert.equal(isValidEffort(bad), false);
});

test("resolveSessionEffort: explicit param beats role `effort:` beats null (unset)", () => {
  const role = { effort: "high" };
  assert.equal(resolveSessionEffort("low", role), "low");
  assert.equal(resolveSessionEffort(null, role), "high");
  assert.equal(resolveSessionEffort("", role), "high"); // empty param is "not given"
  assert.equal(resolveSessionEffort(null, { effort: null }), null);
  assert.equal(resolveSessionEffort(null, null), null);
  assert.equal(resolveSessionEffort("bogus", null), null); // an invalid level resolves to unset, never leaks
});

test("a role's `effort:` frontmatter flows from role.md text into the spawn argv", () => {
  const role = parseRoleFile("---\nname: Deep\neffort: max\n---\n\nthink hard", "deep");
  const args = buildSessionArgs({ ...baseOpts, model: "claude-opus-4-8", effort: resolveSessionEffort(null, role) });
  assert.equal(flagValue(args, "--effort"), "max");
});

// ── Provider-aware model resolution: role/default model is IGNORED on a provider mismatch ───────────
test("resolveSessionModel is provider-aware: Claude keeps its default, Codex has none", () => {
  // Claude (default provider): explicit > role > DEFAULT_SESSION_MODEL, exactly as before.
  assert.equal(resolveSessionModel("claude-sonnet-5", null, "claude"), "claude-sonnet-5");
  assert.equal(resolveSessionModel(null, { model: "claude-fable-5" }, "claude"), "claude-fable-5");
  assert.equal(resolveSessionModel(null, null, "claude"), DEFAULT_SESSION_MODEL);
  // Codex: NO hardcoded default — absent stays absent (null); the app-server picks the plan default.
  assert.equal(resolveSessionModel(null, null, "codex"), null);
});

test("resolveSessionModel ignores a role/default model that doesn't match the target provider", () => {
  // A Claude role model is dropped on a Codex spawn (never send claude-* to codex) — falls through to null.
  assert.equal(resolveSessionModel(null, { model: "claude-fable-5" }, "codex"), null);
  // A Codex role model is dropped on a Claude spawn — falls through to the Claude default.
  assert.equal(resolveSessionModel(null, { model: "gpt-5.6-codex" }, "claude"), DEFAULT_SESSION_MODEL);
  // An EXPLICIT model is trusted as-is regardless of shape (the picker only offers the provider's models).
  assert.equal(resolveSessionModel("gpt-5.6-codex", null, "codex"), "gpt-5.6-codex");
  assert.equal(resolveSessionModel("claude-haiku-4-5-20251001", { model: "gpt-x" }, "claude"), "claude-haiku-4-5-20251001");
});

test("default resolveSessionModel provider is claude (back-compat with the two-arg call sites)", () => {
  assert.equal(resolveSessionModel(null, null), DEFAULT_SESSION_MODEL);
  assert.equal(resolveSessionModel(null, { model: "claude-fable-5" }), "claude-fable-5");
});
