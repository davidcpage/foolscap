# Harness best practices & the skills question

Research backing a decision: keep `app/harness.md` as one always-on ~126-line appended brief, or
split it into lazily-loaded **Agent Skills** (a `thread` skill, a `doc-annotations` skill, …). This doc
synthesises Anthropic's official guidance on prompt readability, agent design, and the Skills mechanism,
then gives a feasibility verdict for skills under our headless `claude -p` spawn path.

All claims cite official sources (docs.claude.com / code.claude.com / anthropic.com/engineering).

---

## 1. Writing instructions a model reliably FOLLOWS (not just parses)

From Anthropic's prompt-engineering and context-engineering guidance
([Claude 4 best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices),
[system prompts](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts),
[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):

- **Clear and direct, at the right altitude.** Use simple, direct language. Anthropic's own framing:
  avoid the two failure modes — *hardcoded, brittle logic* and *vague high-level guidance* — and aim for
  the "right altitude" in between. Treat the model like a capable new hire on day one: state the task and
  the necessary detail explicitly.
- **Structure with headings / sections / delimiters.** Break the prompt into clearly-labelled parts.
  Anthropic recommends XML-style tags (`<document>`, `<instructions>`, `<example>`) to delineate parts so
  the model can tell them apart. Distinct, scannable sections beat one undifferentiated wall.
- **Show, don't only tell.** Curate a few *diverse, canonical* examples of the desired behaviour —
  "examples are the pictures worth a thousand words." A single worked example of a thread post or an
  `anno ask` call teaches format better than a paragraph describing it.
- **Density is a cost, not a virtue.** Context is a finite budget; every token competes for attention.
  The context-engineering guidance is explicit that more instruction is not better — find the *smallest
  set* of high-signal tokens that reliably steer behaviour. A dense wall of always-on text spends budget
  on rules that don't apply to the current task and can dilute the ones that do.
- **One home per fact.** State each rule once, in the place it belongs; duplicated/overlapping guidance
  is a readability and consistency tax (and a maintenance one).
- **Don't over-engineer.** Only include instructions that are directly needed; prune the rest.

**Implication for our harness:** the ~126 lines are *correct* but dense, and much of it is conditional
(doc-annotations only matter when a doc is in play; ask/reply only when consulting an oracle). Readability
best-practice pushes toward *less always-on text, more structure, and on-demand detail* — which is exactly
the shape Agent Skills provide.

## 2. Building effective agents (the patterns)

From [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents):

- **Patterns:** augmented LLM (tools + retrieval + memory), prompt chaining, routing, parallelization,
  orchestrator–workers, evaluator–optimizer, and autonomous agents. Our multi-agent board is closest to
  **orchestrator–workers** (a coordinator delegates thread-scoped subtasks to worker sessions).
- **Simplicity first.** Start simple; add machinery only when it demonstrably improves outcomes. Increase
  complexity deliberately.
- **Invest in the agent–computer interface (ACI).** Treat tool/interface docs with the same care as a UI:
  clear documentation, tested, with formatting overhead removed. Our harness *is* the ACI for the canvas
  bus — so its clarity directly governs how reliably sessions use the endpoints.
- **Transparency.** Prefer explicit planning/steps the agent (and observers) can follow.

**Implication:** the harness is an ACI manual. ACI guidance ("clear documentation, minimal formatting
overhead") is an argument for making each capability's instructions *legible on demand at the point of
use*, rather than pre-loading all of them.

## 3. Agent Skills — the mechanism (progressive disclosure)

Primary sources:
[Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
[Extend Claude with skills (Claude Code)](https://code.claude.com/docs/en/skills),
[Equipping agents for the real world](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).

A **Skill** is a directory with a `SKILL.md` (plus optional bundled files/scripts). Its whole point is
**progressive disclosure** — load information in stages, not upfront:

| Level | What | When loaded | Token cost |
|-------|------|-------------|-----------|
| **1 · Metadata** | `name` + `description` (YAML frontmatter) | Always, at startup, injected into system prompt | ~100 tokens/skill |
| **2 · Body** | `SKILL.md` markdown (workflows, guidance) | When the skill is *triggered* (read via bash/Read) | < 5k tokens |
| **3 · Resources** | Bundled files (`REFERENCE.md`, scripts, schemas) | On demand, only when referenced | ~unlimited (0 until touched) |

- **Always-loaded = just name + description.** So you can install many skills with negligible context
  penalty; the model only knows *that each exists and when to use it*.
- **Triggering is model-decided from the `description`.** When a request matches a skill's description,
  the model reads `SKILL.md` and only then does the body enter context. The description must say both
  *what it does* and *when to use it* — that sentence is the entire trigger surface, so it must be good.
- **Explicit invocation too.** In Claude Code a skill is also invocable directly as `/skill-name`
  (custom commands have merged into skills; `.claude/commands/x.md` ≡ `.claude/skills/x/SKILL.md`).

### SKILL.md format & constraints
```yaml
---
name: thread-collab            # ≤64 chars; lowercase/numbers/hyphens; no "anthropic"/"claude"; no XML
description: How to talk to peers on a foolscap board via threads … Use when the session is a member of a thread or needs to post/ask/pin.  # non-empty, ≤1024 chars, no XML
---
# body: instructions + examples, keep < ~5k tokens; move detail to referenced files
```
- Keep `SKILL.md` lean (< ~5k words); push long reference material into `references/` files linked from
  the body so they cost nothing until read.

### Discovery locations & precedence (Claude Code)
- **Personal:** `~/.claude/skills/<name>/SKILL.md` — all your projects.
- **Project:** `<repo>/.claude/skills/<name>/SKILL.md` — that repo only (loads from the start dir up to
  repo root; nested `.claude/skills/` load on demand when editing in subdirs).
- **Plugin:** `<plugin>/skills/<name>/SKILL.md`, namespaced `plugin:skill`.
- **Precedence:** enterprise > personal > project; any of these overrides a bundled skill of the same
  name. Live-added under a watched dir takes effect mid-session; a brand-new top-level skills dir needs a
  restart.
- **Invocation control (frontmatter):** `disable-model-invocation: true` makes a skill manual-only
  (`/name`) and keeps its description out of context — for side-effectful actions you don't want the model
  auto-firing.

## 4. Feasibility verdict — do Skills work under headless `claude -p`?

**Verdict: YES for our spawn path, with high confidence — with one reliability nuance worth a quick test.**

Why (our spawn path uses the **raw `claude` CLI binary**, `cmd: "claude"` — *not* the TS/Python SDK):

1. **The raw CLI `-p` loads skills by default.** Per
   [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): *"Without [`--bare`],
   `claude -p` loads the same context an interactive session would, including anything configured in the
   working directory or `~/.claude`."* `--bare` is what would *skip* skill auto-discovery — and our spawn
   does **not** pass `--bare` (see flags below). So skills in the session's cwd `.claude/skills/` and in
   `~/.claude/skills/` are auto-discovered.
2. **Skills are invocable in `-p`.** Same page: *"User-invoked skills and custom commands work in `-p`
   mode: include `/skill-name` in the prompt string and Claude Code expands it."* Metadata is in the
   system prompt at startup and the Skill tool is available, matching interactive CLI behaviour — so
   model-decided auto-triggering is also in play, not only explicit `/name`.
3. **Empirically confirmed in *this* repo.** `app/vite-fs-plugin.ts` (`foldSessionEvent`) already reads a
   `skills` array off the `system`/`init` event of our live `claude -p --output-format stream-json`
   sessions — commented *"VERIFIED LIVE 2026-06-20 against a real `claude -p` capture."* The CLI is
   already advertising a skill listing to our headless sessions today.

**The SDK caveat that does NOT apply to us:** the *Agent SDK packages* (Python/TS) do **not** load
filesystem settings by default and need `settingSources: ['user','project']` to see `.claude/skills`
([Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)). We invoke the CLI binary,
which enables discovered skills by default — so this restriction is irrelevant to the current spawn. (It
*would* matter if the spawn were ever ported to the SDK packages.)

**What still needs a live test (the nuance):**
- **Auto-trigger reliability in headless.** Confirm the model *reliably auto-invokes* the right skill from
  its description mid-turn (vs. only when `/name` is typed) in a non-interactive worker. Test: place a
  skill, spawn a worker into a thread, and see whether it loads the skill unprompted when the task calls
  for it.
- **Permission interaction.** Our sessions run `--permission-mode auto` + a baseline `--allowedTools` and
  route prompts through the permission-relay MCP. Verify the Skill tool (and the bash/Read it uses to open
  `SKILL.md`) fires without tripping a deny/hold.
- **cwd / deployment placement.** A spawned session's cwd is the **board's repo** (`repoPath`), so
  project skills must live at `<board repo>/.claude/skills/`. For the dev repo that's foolscap itself; for
  **externally-mounted boards** the cwd is a different repo that won't contain our skills. Portable homes:
  `~/.claude/skills/` (per-machine, applies everywhere) or bundle as a plugin via `--plugin-dir`. Decide
  this before splitting — an always-on brief has no such placement dependency.

## 5. Codebase facts (as of this research)

- **No skills exist yet.** There is a `.claude/` directory at the repo root but it is **empty** — no
  `.claude/skills/`, no skills anywhere in the repo.
- **Exact spawn flags** (`app/vite-fs-plugin.ts`, `ensureLiveSession`, `cmd: "claude"`, `cwd: repoPath`):
  ```
  -p
  --session-id <id>            (or --resume <id> on resume)
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --verbose
  --permission-mode <auto>     (SESSION_PERMISSION_MODE)
  --allowedTools <baseline>    (BASELINE_ALLOWED_TOOLS — commit + scripts/canvas; additive over auto)
  --disallowedTools AskUserQuestion
  --mcp-config <json>          (the per-session permission-relay MCP)
  --permission-prompt-tool <PERMISSION_TOOL>
  --append-system-prompt <appendPrompt>
  ```
  No `--bare` (so skills auto-discover) and no `--model` (default model). `appendPrompt` = ask-convention
  + `collabBrief` (the harness) + board memory + role charter + worker brief.
- **`app/harness.md` structure** (~126 lines, ALL-CAPS section leads, not markdown headings) — ~13 topic
  blocks, each a candidate skill body or a trimmed always-on line:
  1. CANVAS ENVIRONMENT (identity: board/session/server) — *inherently always-on*
  2. READ THE BOARD (`GET /api/canvas`, records)
  3. THREADS (post / join / leave / invite / ask / pin recipes)
  4. RECEIVING (nudges + `GET /api/inbox`)
  5. CHECKPOINT-POLL (peek-and-act discipline)
  6. ANSWERING ASKS (`/api/asks` + reply)
  7. DECLARE YOUR WORK-INTENT (working/blocked/done + done-when+proof)
  8. WINDING DOWN (`/api/session/<id>/done`, ephemerality)
  9. DOC ANNOTATIONS (+ ASK-ON-THE-DOC, THE REVISION RULE, RESOLUTION-BELONGS-TO-AUTHOR)
  10. PUBLIC CHANNELS ARE THE RECORD
  11. THREAD MODE vs STANDALONE MODE
  12. NORMS (read/talk/claim; the RED LINE)

  Natural split: a small always-on core (1, plus a one-line pointer to each capability + the RED LINE from
  12) + on-demand skills — e.g. **`thread`** (2–8, the peer-comms machinery) and **`doc-annotations`**
  (9). The dense recipe blocks (3, 9) are exactly the "keep it out of context until used" case Skills are
  built for; the norms/identity (1, 12) are the "must always be present" case that stays inline.

---

### Bottom line
Readability guidance and the Skills progressive-disclosure model both point the same way: keep a *small,
high-signal always-on core* (identity + red-line norms + a one-line pointer per capability) and move the
dense, conditional recipes into on-demand skills. This is mechanically supported on our exact spawn path
(raw `claude -p`, no `--bare`), and already partly proven (the init event advertises skills to our live
sessions today). The remaining risk is *behavioural* — does a headless worker auto-load the right skill
reliably — and that is cheaply testable before committing to the split.

**Sources:**
[Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ·
[Skills in Claude Code](https://code.claude.com/docs/en/skills) ·
[Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills) ·
[Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless) ·
[Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) ·
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) ·
[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
[Claude 4 prompt best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices) ·
[System prompts](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts)
