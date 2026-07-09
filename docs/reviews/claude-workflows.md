# Review: Claude workflows & the canvas

*Thread `node:mrdtrx5e-4`. A review of Claude Code's multi-agent **Workflow** tool — how it works and is
implemented — and an assessment of whether it, or something like it, fits the canvas/thread/session/
Coordinator model. Written for ongoing annotation; the recommendation in §3 is the part to argue with.*

---

## TL;DR

Claude workflows and the canvas are the **same idea at two different altitudes**, and they are
complementary rather than competing.

- A **Claude workflow** is a *deterministic JavaScript orchestrator* that fans out **ephemeral, anonymous,
  pure-function subagents** and rolls their return values back up a tree. It is an **inner loop**: bounded,
  known-shape, reproducible, fire-and-forget, no human in the loop, state held in one process + a resume
  cache.
- The **canvas** is a *non-deterministic, LLM-driven orchestrator* (the Coordinator) that coordinates
  **durable, wakeable, identity-bearing sessions** over a **shared record** (threads + memory). It is an
  **outer loop**: open-ended, human-in-the-loop, multi-session, provenance-first, state externalized so any
  process can die.

**Recommendation (details in §3):** don't rebuild workflows on top of threads — that fights the canvas's
grain. Instead (1) treat `Workflow` as the **inner-loop tool any canvas session already has**, and write a
recipe leaf + decision rule for when a session should run a workflow vs. spawn peer sessions; (2) lift the
workflow **quality patterns** (adversarial verify, judge panel, loop-until-dry, completeness critic) into
the Coordinator playbook; (3) optionally adopt **schema-validated structured returns** for worker→
Coordinator handoffs. All three are cheap; (1) is near-zero build.

---

## 1. How Claude workflows work & are implemented

### 1.1 The shape

A workflow is a single **`Workflow` tool call** carrying a self-contained **JavaScript orchestration
script**. The script is *code that spawns Claude subagents* — the control flow (loops, conditionals,
fan-out) is plain deterministic JS, not a model reasoning about what to do next. It runs in the
**background**: the tool call returns a `runId` immediately and a notification arrives on completion.

Every script begins with a pure-literal `meta` block (name, description, and a `phases` list used for the
progress UI), then a body that uses a small set of hooks:

| Hook | What it does |
|------|-------------|
| `agent(prompt, opts?)` | Spawn one subagent. Returns its final text (a string), or — with `opts.schema` (a JSON Schema) — a **validated object** (the subagent is forced to call a `StructuredOutput` tool and retries on mismatch). `opts`: `label`, `phase`, `schema`, `model`, `effort`, `isolation:'worktree'`, `agentType`. |
| `pipeline(items, s1, s2, …)` | Run each item through all stages independently, **no barrier** between stages — item A can be in stage 3 while B is still in stage 1. The default multi-stage primitive; wall-clock ≈ slowest single-item chain. |
| `parallel(thunks)` | Run tasks concurrently, then **barrier** (await all). A thunk that throws resolves to `null` (so `.filter(Boolean)`). |
| `phase(title)` / `log(msg)` | Progress grouping and narrator lines for the observer UI. |
| `args` | The verbatim input value passed to the workflow — how a named/parameterized workflow is fed. |
| `budget` | `{ total, spent(), remaining() }` — a shared token target; used for dynamic depth (`while (budget.remaining() > 50_000) …`). |
| `workflow(name/ref, args?)` | Run **another** workflow inline as a sub-step (one level of nesting only). |

Concurrency is capped at roughly `min(16, cores−2)` simultaneous `agent()` calls per workflow (excess
queue), with a lifetime backstop of ~1000 agents total and ≤4096 items per single `parallel`/`pipeline`
call. Scripts are **plain JS, not TS**, run in a restricted sandbox: standard built-ins are available but
`Date.now()` / `Math.random()` / `new Date()` throw (they would break resume), and there is **no
filesystem or Node API** — MCP tools are reachable per-agent via `ToolSearch`.

### 1.2 The execution & data model

- **Orchestrator = code, not an LLM.** The script is the coordinator. This is the single most important
  fact about workflows: control flow is *deterministic and free* — no model tokens are spent deciding what
  to fan out, and the same script + same args produces the same fan-out every time.
- **Subagents = pure functions.** Each `agent()` call is a fresh, context-isolated Claude session that
  takes a prompt and returns a value. Subagents are told their final text *is* the return value (not a
  human-facing message), so they emit raw data. They have **no persistent identity**, **cannot be messaged
  or woken**, **cannot talk to siblings**, and vanish when they return.
- **Communication topology = tree/DAG.** Data flows *up* through JS return values threaded by the script.
  There is no shared mutable surface and no peer-to-peer channel — coordination is entirely the parent's
  data structures.
- **Structured output** is enforced at the tool-call layer via JSON Schema, so a stage can rely on a typed
  object rather than parsing free text.

### 1.3 Reliability & resume

- **Background + journal.** The workflow runs detached; each agent's actual return value is recorded in a
  `journal.jsonl` in the run's transcript directory, alongside per-agent `agent-<id>.jsonl` transcripts.
- **Resume by caching.** Relaunching with `resumeFromRunId` returns the results of the longest **unchanged
  prefix** of `agent()` calls instantly (cache keyed on `(prompt, opts)`); the first edited/new call and
  everything after it re-runs live. Same script + same args ⇒ 100% cache hit. This is why the sandbox bans
  nondeterministic built-ins.

### 1.4 The quality patterns (the interesting part)

The tool ships a library of *orchestration patterns* that are independent of the mechanism — they are how
you buy correctness with parallel agents:

- **Adversarial verify** — spawn N independent skeptics per finding, each prompted to *refute*; kill the
  finding unless a majority survives. Stops plausible-but-wrong results.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness / security / perf /
  does-it-reproduce) instead of N identical ones.
- **Judge panel** — generate N independent attempts from different angles, score with parallel judges,
  synthesize from the winner while grafting the best of the runners-up.
- **Loop-until-dry** — keep spawning finders until K consecutive rounds surface nothing new (dedup against
  everything *seen*, not everything *confirmed*, or it never converges).
- **Multi-modal sweep** — parallel agents each searching a different way (by container, by content, by
  entity, by time), each blind to the others.
- **Completeness critic** — a final agent whose only job is "what's missing?", feeding the next round.
- **No silent caps** — if coverage is bounded (top-N, sampling), `log()` what was dropped.

These map directly onto the "[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)"
patterns the harness already cites (`docs/harness-best-practices.md:46`): prompt chaining ≈ `pipeline`,
parallelization ≈ `parallel`, orchestrator–workers ≈ the whole model, evaluator–optimizer ≈ judge panel /
adversarial verify.

---

## 2. How that maps onto our canvas thread/session/Coordinator model

Our board implements the **orchestrator–workers** pattern too (`docs/harness-best-practices.md:47`) — a
Coordinator delegates thread-scoped subtasks to worker sessions. But it makes the **opposite bet on almost
every axis**, because it is solving a different problem: durable, human-in-the-loop, multi-session work
where any process can die at any moment.

### 2.1 Side by side

| Axis | Claude workflow | Canvas |
|------|-----------------|--------|
| **Orchestrator** | Deterministic JS script | An LLM session — the **Coordinator** seat/role |
| **Control flow** | Code (reproducible, free) | Model reasoning (adaptive, token-costly, non-deterministic) |
| **Worker lifetime** | Ephemeral pure function, gone on return | Durable **session** — a card with identity, work-intents, thread membership |
| **Worker addressability** | None (can't message/wake) | **Wakeable** via `@`-tag; peers message peers |
| **Communication** | Return values up a tree; no shared state | Shared **record** — threads, posts, pins, file memory; a graph, not a tree |
| **State durability** | In-process + resume cache | **Externalized to the thread + memory** ("the record is the thread; the process is disposable") |
| **Recovery** | Replay cached agent results (deterministic) | **Spawn fresh**, re-derive from the durable record (never `--resume`) |
| **Human in the loop** | Fire-and-forget; notify on completion; no mid-run decision | Designed around it — anchored asks, red-line gates, doc annotation |
| **Isolation** | Opt-in `isolation:'worktree'` per agent | **Worktree-per-work-item is the default discipline**, with merge-on-green |
| **Verification** | Built-in schema validation + verify/judge patterns | Proof-in-thread + the green gate + human annotation |
| **Determinism** | Same script+args ⇒ same result | Inherently event-driven and non-deterministic |

### 2.2 Where they already converge

The canvas independently arrived at several of the workflow's ideas at the coarse grain:

- **Ephemerality.** Workflow subagents are pure functions; canvas sessions are "ephemeral — never resume"
  (`never-resume-sessions`). Both refuse to treat the *process* as the unit of durability. They differ in
  *where* the durable state lives: workflows in a resume cache the orchestrator replays; the canvas in a
  thread record a *fresh* LLM re-reads.
- **Worktree isolation.** Workflow's opt-in `isolation:'worktree'` (for agents that mutate files in
  parallel) is exactly the canvas's default worktree-per-work-item discipline
  (`docs/multi-agent-collab-workflow.md`).
- **A green gate.** Workflow's schema-validated / adversarially-verified stage before results are trusted
  is the analogue of merge-on-green (`npm test` + `typecheck` in-worktree before a branch reaches `main`).
- **Fan-out with overlap awareness.** Workflow's `pipeline` vs `parallel` barrier choice is a
  fine-grained, in-code version of the Coordinator's Stage-2 discipline: assess file overlap, fan out the
  disjoint set, serialize (or re-slice) the rest.

### 2.3 The load-bearing differences

Two differences matter most for the recommendation:

1. **Code orchestrator vs LLM orchestrator.** Workflows are cheap, reproducible, and resumable *because*
   the control flow is code. The canvas is flexible, adaptive, and human-steerable *because* the control
   flow is a reasoning session. You cannot have both properties from one mechanism — they are the cost of
   each other. This is why a workflow is the right tool for a *known-shape* fan-out and the Coordinator is
   the right tool for *open-ended* work.

2. **Pure functions vs wakeable sessions.** The canvas's distinctive bet is the **wakeable substrate**
   (`docs/wakeable-substrate-plan.md`): sessions that persist, can be messaged, and coordinate over shared
   memory. Workflow subagents deliberately give all of that up for reproducibility. Any attempt to run a
   workflow "on threads" would have to give up either the determinism (the workflow's whole point) or the
   wakeability (the canvas's whole point).

---

## 3. Recommendation: what to borrow, what to build

### 3.1 Do NOT rebuild the workflow orchestrator on threads

Reimplementing `agent()`/`pipeline()`/`parallel()` over threads and sessions would fight the grain on both
sides. Workflow's guarantees (determinism, resume-by-cache, free control flow, token budgeting) depend on
an **in-process JS engine**; threads are eventually-consistent, event-driven, and human-in-the-loop by
design. You would inherit the costs of both and the guarantees of neither. The canvas *already has* the
coarse-grained orchestrator (Coordinator + parallel worktree spawn + merge-on-green); it does not need a
second, worse one.

### 3.2 Borrow #1 (highest value, ~zero build): `Workflow` as the session inner loop

There is already a precedent for ephemeral pure-function subagents on the board: the Coordinator is told
to delegate code understanding to **Task/Agent subagents** and act on their summaries rather than reading
code itself (`app/default-roles/pm/role.md`). A workflow is the same idea scaled up — many subagents, with
deterministic control flow around them — so blessing it extends an already-sanctioned pattern rather than
introducing a new one.

**Every canvas session already has the `Workflow` tool.** A worker facing a bounded, known-shape fan-out —
"migrate 40 call sites", "review this diff across 6 dimensions", "sweep the codebase for X" — should run a
**workflow inside its own session** rather than asking the Coordinator to spawn peer sessions. That gives
deterministic, high-throughput fan-out *inside one durable card*, with the thread still holding the
provenance (the session posts the workflow's synthesized result as proof).

The only thing to build is a **recipe leaf + decision rule**. Proposed rule:

> **Run a workflow when** the fan-out is (a) bounded and known-shape, (b) needs no durable per-agent
> identity and no human in the loop mid-run, and (c) rolls up to a single consumer (you).
> **Spawn peer canvas sessions when** the work is open-ended or long-running, needs human interaction or
> red-line approval, must survive your session's death as independent work items, or requires peers to
> coordinate with each other.

Worked split: a Coordinator fans out three *features* as peer sessions in worktrees (open-ended, durable,
independently mergeable); each of those sessions internally runs a *workflow* to review its own diff across
dimensions before posting `done` with proof (bounded, ephemeral, rolls up to itself). Outer loop = canvas;
inner loop = workflow.

### 3.3 Borrow #2 (cheap): the quality patterns as Coordinator playbook

Adversarial verify, perspective-diverse verify, judge panel, loop-until-dry, and completeness critic are
**orchestration patterns, not workflow-specific machinery**. They belong in the Coordinator's charter /
a harness patterns leaf as named plays the Coordinator can run with *either* mechanism — e.g. "before
accepting a worker's `done`, spawn two independent verifier sessions prompted to refute the proof" is
adversarial-verify expressed in canvas terms. Codifying them raises the floor on correctness for
multi-agent work regardless of how the fan-out happens.

### 3.4 Borrow #3 (optional): schema-validated structured returns

Workflow's forced-schema returns make worker output machine-consumable. The canvas could adopt a small set
of **standard result schemas** (e.g. a `findings` shape, a `done`-proof shape) that workers post to the
thread, so the Coordinator can consume results without free-text parsing. This is a modest convention, not
a mechanism — worth it only if we find the Coordinator repeatedly hand-parsing worker prose.

### 3.5 Optional observability: surface workflow runs as cards

When a session kicks off a background workflow, its progress tree could surface on the board the way the
Sessions card surfaces sessions — so a human watching the board sees the inner-loop fan-out, not just an
opaque busy session. Nice-to-have; not core.

### 3.6 Priority

1. **§3.2** — write the recipe leaf + decision rule. Near-zero build, immediate leverage; the tool is
   already in every session's hands and is currently undocumented in the harness.
2. **§3.3** — add the quality patterns to the Coordinator playbook.
3. **§3.4 / §3.5** — adopt only if a concrete need shows up.

---

## Open questions (for annotation)

- **Does the deterministic inner loop actually reproduce under our spawn path?** Workflows lean on a
  restricted JS sandbox and a resume cache. Worth a quick test that a session spawned via
  `scripts/canvas spawn` can run a non-trivial `Workflow` and that resume behaves — before we bless it in a
  leaf.
- **Cost/budget interaction.** A workflow can silently fan out to ~14 concurrent agents. Inside a canvas
  session that itself was fanned out by the Coordinator, total concurrency multiplies. Do we want a norm
  (or a budget hand-off) so inner-loop fan-out doesn't blow past what the human expected?
- **Where does the workflow's result live durably?** The synthesized return is posted to the thread as
  proof — but the per-agent journal/transcripts live in a run dir, not on the board. Is the thread post
  enough provenance, or do we want the run surfaced/persisted?
- **Is §3.4 worth it, or does free-text proof-in-thread already work fine?**
