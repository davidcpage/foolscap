# Review: Databricks Omnigent vs pi-ai as an underlying agent server

> **Status:** draft for annotation/discussion. Written by session `16d2af7b` for thread
> *"Review: Databricks omniagent vs pi-ai as agent server"* (`node:mrdtsd3c-8`).
>
> **Naming note.** The brief and this file say *"omniagent"*; the actual product is **Omnigent**
> (Databricks, open-sourced June 2026, Apache-2.0, repo `omnigent-ai/omnigent`). Filename kept as
> specified in the Done-when condition. All content below uses the correct name.

---

## TL;DR / recommendation

- **These two are not the same kind of thing.** Omnigent is a **meta-harness / control plane** that sits
  *above* agent harnesses (Claude Code, Codex, Pi, SDKs). pi-ai is a **unified multi-provider LLM SDK**
  that sits *below* an agent loop. "Omnigent vs pi-ai as agent server" is apples-to-oranges: one is the
  orchestration+governance layer, the other is the model layer. Both are relevant to us, at *different*
  layers.
- **Omnigent is a near-mirror of what foolscap already is.** Its server/runner/UI decomposition,
  WebSocket event streaming, persisted session history, URL session-sharing, and file-comment
  collaboration map almost one-to-one onto our agent bus / session-host / board / threads / annotations.
  We should **not adopt it as our agent server** — that would mean replacing our own equivalent stack with
  a heavier Python+Node+tmux, cloud-deploy-oriented one, and abandoning the board-as-shared-surface model
  that is our actual differentiator. But its existence **validates our architecture**, and it has **three
  ideas worth stealing** (below).
- **pi-ai is a genuinely attractive candidate for one specific job: decoupling us from the hardwired
  `claude -p` model call** and giving us multi-provider support + cost/token tracking + cross-provider
  handoffs. But adopting it is not free — `claude -p` currently gives us the *entire* Claude Code harness
  (tools, skills, permissions, subagents) for nothing, and pi-ai gives us only the LLM wire layer. Using
  it means owning the agent loop ourselves (which is what Pi's `pi-agent-core` is). **Recommendation: not
  now.** Keep `claude -p` as the runner; revisit pi-ai only if/when multi-model support becomes a real
  requirement.
- **Highest-value takeaways for us are three Omnigent ideas, not either codebase wholesale:**
  1. **OS sandbox + egress-proxy secret injection** ("Omnibox") — we have *nothing* here, and it's the
     biggest real gap.
  2. **Stateful, contextual policy enforcement at the harness layer** (cost budgets, permission rules) —
     ours is human-nod + settings rules; Omnigent enforces programmatically, server-side.
  3. **Model/harness-agnostic runner with a uniform "messages+files in, text+tool-calls out" interface** —
     a design north-star even if we stay Claude-only.

---

## 1. What Omnigent offers

Omnigent is an open-source **meta-harness** (Databricks, Apache-2.0). It sits *above* the agent harnesses
you already use and makes them interoperable. Its pitch is three C's — **Compose, Control, Collaborate.**

**Architecture — three components:**

- **Server** — the central coordinator. Manages session history (every conversation, message, and tool
  call persisted to a database), artifacts, catalogs, an **MCP proxy with server-side policy
  enforcement**, skills, and auth/accounts (built-in or OIDC/SSO). Clones locally or deploys to a VPS,
  Railway, Render, Fly.io, Cloudflare, or Databricks Apps.
- **Runner** — the per-session process that executes the agent loop. It manages the underlying harness
  (Claude Code, Codex, Claude Agents SDK, OpenAI Agents SDK, Pi, custom), runs tools, and streams events
  back to the server over **WebSocket**. Runs on a "host" you register — by default your laptop.
- **UI** — terminal, native macOS app, mobile, and web (localhost:6767). All interfaces attach to the
  *same* live session and stay synchronized.

**The core abstraction:** every harness reduces to the same interface — *"messages and files in, text
streams and tool calls out."* That uniformity is what lets you switch harness/model with "one-line
changes" and combine sub-agents built on *different* harnesses inside one orchestration.

**Compose.** Custom agents are declared as **YAML**. Example agents shipped: *Polly* (delegates to
parallel coding sub-agents in separate **git worktrees**) and *Debby* (runs Claude and GPT side-by-side for
comparison). Covers patterns like a cheap worker calling a frontier advisor, or a lead orchestrating
parallel subagents.

**Control.** **Stateful, contextual policies** enforced *at the meta-harness layer, not via prompts*, at
three scopes (server-wide / per-agent / per-session, strictest-first):
- **Cost budgets** — track LLM spend per session, pause at a threshold.
- **Permission policies** — state-dependent rules, e.g. *require human approval for `git push` after an
  `npm install`*.
- **File-access controls** — restrict an agent to editing only files it created.
- **Omnibox OS sandbox** (from Databricks' security team) — locks down OS access, intercepts/transforms
  network requests, and does **egress-proxy secret injection**: agents never see credentials like GitHub
  tokens; the proxy injects them only into approved egress requests.

**Collaborate.** Share a live session by **URL**; teammates watch the agent work, chat with it, co-drive,
comment on files, or fork the conversation — replacing copy-paste between tools.

**Stack:** Python 3.12+, Node.js 22 LTS, tmux. MCP proxying today; broader MCP (agents working across
sessions) on the roadmap.

## 2. What pi-ai offers

`@earendil-works/pi-ai` is a **unified multi-provider LLM SDK**, published standalone to npm (MIT),
TypeScript (~94%). It is one package in the **Pi** monorepo:

- `@earendil-works/pi-ai` — unified multi-provider LLM API (this package).
- `@earendil-works/pi-agent-core` — agent runtime: tool-calling + state management (builds *on* pi-ai).
- `@earendil-works/pi-coding-agent` — the interactive coding-agent CLI (the thing analogous to
  Claude Code / one of the harnesses Omnigent wraps).
- `@earendil-works/pi-tui` — terminal UI with differential rendering.

So within Pi's own stack the layering is: **pi-ai (model wire) → pi-agent-core (agent loop) →
pi-coding-agent (harness/CLI).** pi-ai is the *bottom* layer.

**What pi-ai does:**
- Three-layer design: a `Models` collection (sync catalog reads, async request methods) → provider
  factories (auth + model catalogs) → wire-protocol implementations (`anthropic-messages`,
  `openai-completions`, …).
- `models.stream()` / `models.complete()` emit **standardized events** across all providers: text deltas,
  tool-argument deltas, thinking blocks.
- **Tool-calling is mandatory** — only models supporting function/tool calling are included ("no tools =
  no agentic workflow"). Tool args validated against **TypeBox** schemas.
- **Context** is a plain serializable JSON object (system prompt + messages + tools) — easy to persist and
  hand off between sessions/models.
- **Cross-provider handoffs**: messages transfer between providers; thinking blocks convert to tagged text
  for compatibility.
- **Auto auth resolution**: env vars, stored creds, OAuth, ambient (AWS profiles, gcloud ADC).
- **Token + USD cost tracking** on every response.
- 30+ providers (OpenAI, Anthropic, Google/Vertex, Bedrock, Mistral, Groq, xAI, DeepSeek, Copilot,
  OpenRouter, and OpenAI-compatible endpoints: Ollama, vLLM, llama.cpp). Provider SDKs lazy-loaded.

## 3. Omnigent vs pi-ai, side by side

They occupy opposite ends of the stack. The honest comparison is *layer*, not feature-for-feature.

| | **Omnigent** | **pi-ai** |
|---|---|---|
| **Layer** | Meta-harness / control plane (above harnesses) | LLM wire SDK (below the agent loop) |
| **Is it an "agent server"?** | Yes — literally a server+runner+UI | No — a library; you embed it |
| **Unit of work** | A *session* wrapping a whole harness | A *model request* (stream/complete) |
| **Multi-agent** | First-class (compose, orchestrate, worktrees) | Out of scope (single request/response) |
| **Governance** | Cost/permission/file policies, OS sandbox, secret injection | None (just per-call cost/token *reporting*) |
| **Collaboration** | URL session-sharing, co-drive, file comments | None |
| **Multi-provider** | Via whatever harness the runner wraps | Its entire reason to exist (30+ providers) |
| **State/persistence** | Server DB of sessions/messages/tool-calls | Serializable `Context` object (you persist it) |
| **Stack** | Python + Node + tmux | Pure TypeScript |
| **License** | Apache-2.0 | MIT |
| **Relationship** | *Wraps* Pi (and Claude Code, Codex, SDKs) | *Underlies* Pi's own harness |

If forced to pick "which is the agent server": **Omnigent is**, pi-ai is not. But that reframes the real
question for us (§5–6): we don't need an agent server — **we already are one.**

## 4. How Omnigent maps onto foolscap (the convergence)

The most important finding of this review: **Omnigent independently arrived at almost exactly foolscap's
architecture.** Component-by-component:

| Omnigent | foolscap equivalent | Notes |
|---|---|---|
| **Server** (central coordinator, session DB, MCP proxy, policies) | `vite-fs-plugin.ts` + agent bus + `board-persist.js` + thread ledger | We persist to `.canvas/board/` (events.jsonl + snapshot) and `.canvas/threads/`, not a SQL DB |
| **Runner** (per-session process, streams events over WS) | `session-host.js` sidecar spawning `claude -p` | Ours is Claude-only; theirs is harness-agnostic |
| **UI** (terminal/app/mobile/web, all synced to one session) | The board (React) over `/api/ws` | Ours is a *canvas*, not a session viewer — this is our differentiator |
| **WebSocket event stream** | `/api/ws` (feeds + bus + file-watch, one socket/tab) | Same "one socket, multiplexed" instinct (we did it to dodge the 6-connection pool cap) |
| **URL session sharing, co-drive** | The shared board itself; sessions as cards | Ours is *always* shared; theirs is opt-in-per-session |
| **Comment on files in-session** | Doc annotations (standoff, W3C quote anchors) | We arguably went *further* here |
| **YAML custom agents** | Role charters (`app/default-roles/`, frontmatter+body) | Convergent |
| **Skills / catalogs** | Skills; harness recipe leaves | Convergent |
| **Multi-agent: Polly → parallel worktrees** | Our worktree-spawn primitive + per-work-item worktrees | *Directly* convergent — same merge-on-green-in-isolation instinct |
| **Multi-agent: lead orchestrates subagents** | Coordinator seat + thread membership | Convergent |
| **Cost/permission/file policies (enforced)** | Permission model + red lines (human-nod, settings rules) | **Gap: ours is advisory/human-gated, not programmatically enforced** |
| **Omnibox OS sandbox + egress secret injection** | *nothing* | **Biggest gap** |
| **MCP proxy with server-side policy** | *nothing* | Gap (we consume MCP tools client-side, no proxy/policy) |

The overlap is so high that adopting Omnigent as our server would be *rip-and-replace of our own stack*,
not filling a hole — and it would cost us the thing Omnigent doesn't have: **the infinite canvas as the
shared substrate.** Omnigent's collaboration model is "share a session"; ours is "the board is one shared
memory that many sessions read and write." That is a deeper, more general model and it's the reason to keep
building our own.

## 5. Fit as our underlying agent server

**Omnigent — no (do not adopt as the server).**
- It duplicates ~80% of what we have, in a heavier stack (Python + Node + tmux vs our TS/React + Node
  middleware).
- It is oriented toward *cloud deploy + enterprise governance (OIDC/SSO, accounts, Databricks Apps)*; we
  are deliberately **local-only, single-repo, board-travels-with-the-repo**. Those philosophies pull in
  opposite directions.
- Its collaboration primitive (share-a-session) is *narrower* than our board-as-shared-memory model.
- Adopting it would mean re-homing threads, annotations, roles, and the canvas onto someone else's session
  abstraction — high cost, and we'd lose our differentiator.

**pi-ai — maybe, for one job, later (not the "server," the model layer).**
- pi-ai could replace the hardwired `claude -p` invocation with a **provider-agnostic model layer**:
  multi-model (Claude/GPT/Gemini/local), per-call cost+token tracking, cross-provider handoffs, a
  serializable `Context` that fits our "record is the thread" principle nicely.
- **But** `claude -p` today gives us the *entire Claude Code harness for free* — tools, skills, the
  permission system, subagents, the whole loop. pi-ai gives only the LLM wire layer. To use it we'd have
  to own the agent loop (i.e. adopt/rebuild something like `pi-agent-core`). That is a large, ongoing
  commitment for a benefit (multi-model) we don't currently need.
- It's pure TypeScript/MIT — a clean *technical* fit with `app/`. The cost is architectural scope, not
  integration friction.

## 6. Recommendation

1. **Keep our own agent server.** Do not adopt Omnigent. Its existence is *strong external validation* of
   the server/runner/UI + WebSocket + persisted-session design we already have.
2. **Keep `claude -p` as the runner** for now. Don't adopt pi-ai yet — the multi-model benefit doesn't pay
   for owning our own agent loop. Note pi-ai as the **first-choice option the day multi-provider becomes a
   real requirement** (e.g. cheap-worker/frontier-advisor patterns, or local-model dev). Revisit then.
3. **Steal three ideas from Omnigent, prioritized:**
   - **(High) OS sandbox + egress-proxy secret injection.** Our biggest real gap. Agents currently run
     with our full ambient credentials/filesystem. Even a lightweight version (egress proxy that injects
     tokens agents can't read) would materially harden us. Worth a dedicated spike.
   - **(Medium) Programmatic, stateful policy enforcement at the bus layer.** Turn our red-lines /
     permission norms from advisory-human-gated into *enforced* server-side policies (cost budget per
     session that pauses a runner; "require nod for push after dependency change" as a real rule). This
     complements — doesn't replace — the human-nod model.
   - **(Lower) An explicit "runner interface" abstraction.** Even staying Claude-only, formalizing
     "messages+files in, text+tool-calls out" would make a future pi-ai / multi-model swap a
     one-file change instead of a refactor.
4. **Watch, don't buy.** Both projects are young (mid-2026) and moving fast. Track Omnigent's MCP-proxy /
   cross-session roadmap and pi-agent-core's maturity; either could change the calculus in a quarter.

---

## Sources

- [Introducing Omnigent — Databricks Blog](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents)
- [Omnigent docs — Databricks](https://docs.databricks.com/aws/en/omnigent/)
- [Databricks Open-Sources Omnigent — MarkTechPost](https://www.marktechpost.com/2026/06/13/databricks-open-sources-omnigent-a-meta-harness-that-composes-governs-and-shares-ai-agents-across-claude-code-codex-and-pi/)
- [omnigent-ai/omnigent — GitHub](https://github.com/omnigent-ai/omnigent)
- [Shared Server — Omnigent docs](https://omnigent.ai/docs/deploy/overview)
- [pi-ai package — earendil-works/pi (packages/ai)](https://github.com/earendil-works/pi/tree/main/packages/ai)
- [Pi — earendil-works/pi (repo root)](https://github.com/earendil-works/pi)
