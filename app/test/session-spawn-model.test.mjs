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

const { buildSessionArgs, resolveSessionModel, DEFAULT_SESSION_MODEL } = await import("../server-sessions.ts");
const { readRole } = await import("../role-ledger.js");
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
