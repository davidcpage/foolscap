# Implementation plan: the wakeable substrate & background sessions

*Plan, 2026-07-04. The execution roadmap for the cluster of work that emerged from the doc-annotations
build and the Claude Tag review. This doc is the **program of work** — what to build, in what order, with
what dependencies and done-criteria. It references the design docs for the *why/how* and does not repeat
them: `claude-tag-lessons.md` (R1–R6 rationale + decisions), `anchored-async-ask.md` (the ask feature + the
wake model), `doc-annotations.md` (the annotation substrate), `threads-as-cards.md` (threads, seats),
`agent-roles.md` (roles). Meant to be picked up and executed by a fresh session (or several); keep the
**Status** column current as the source of truth.*

---

## The through-line

**Make sessions genuinely background: the durable substrate — docs, threads, memory — becomes *wakeable*,
and the server spawns compute from it on demand.** A session stops being a thing you manage and becomes
interchangeable compute summoned by activity on a durable record, doing its work and winding down. Every
item below is an instance of that.

Two **foundational primitives** carry most of the recommendations; factor them out and build them once:

- **P1 — seats with notification levels on wakeable surfaces.** A seat (durable participant slot,
  `threads-as-cards.md` §5) generalizes off the thread onto any surface that emits activity — a thread, a
  **doc**, a timer. Each seat has a level: `all` / `mentions` / `paused` (the Slack-channel choice), with an
  `@`-mention always overriding. This is R2 (recast) and `anchored-async-ask.md` §2.
- **P2 — server-spawn-from-a-durable-record.** The server fires compute from a durable trigger: it
  reconstitutes a session seeded from a thread's history or a doc's annotations when a qualifying wake lands,
  runs a single-flight loop-until-dry worker, and applies the idle lifecycle (keep-alive grace → exit →
  respawn). This is R1's reconstitution, `anchored-async-ask.md`'s push wake-back, doc-wake, and the base for
  R6 — one mechanism.

Almost everything else sits on P1 and P2.

## Already shipped (baseline)

- **Doc-annotations substrate** — ledger, anchors, endpoints, card UI, conventions. `doc-annotations.md`
  steps 1–3 (commits `5429c29`, `da5de34`, `0c45b78`).
- **Auto-reanchor + `canvas anno` CLI** — server re-anchors moved-but-resolvable comments on read/write;
  `list`/`reply`/`batch`/`resolve`/`reopen`. `doc-annotations.md` §4 step 5 (commit `32e51e7`).
- **Threads as cards** — thread nodes/ledger, seats, work-intent, derived state. `threads-as-cards.md`
  steps 1–3 (per memory; `5c51c84`, `71bc447`, `1a61a4e`).

## Work items

Effort: S(mall) ≈ hours, M(edium) ≈ a session, L(arge) ≈ multiple sessions. Independent items (no unmet
dep) can run in parallel sessions.

| # | Item | Implements | Depends | Effort | Status |
|---|---|---|---|---|---|
| W1 | anchored-async-ask **record layer** | async-ask §4/§6 steps 1–2 | — | M | DONE `9e6988a` |
| W2 | anchored-async-ask **card affordance** | async-ask §6 step 3 | W1 | M | TODO |
| W3 | **R4 board `memory.md`** card + linked role memory | claude-tag R4 | — | S | TODO |
| W4 | **P1: seats + notification levels** | R2 recast, async-ask §2 | threads (built) | M | TODO |
| W5 | **P2: server-spawn-from-record + wake trigger** | R1, async-ask §8 step 5, doc-wake | W4 (+W1) | L | TODO |
| W6 | **R6 standing jobs** (server-fired watches) | claude-tag R6 | W5 | M | TODO |
| W7 | **R-PIN + R5** (pinnable posts, done-condition, proof) | claude-tag R-PIN/R5 | threads (built) | M | TODO |
| W8 | **R3 per-thread spend** accounting | claude-tag R3 | W5 marker | S | LATER |
| W9 | **PM → Coordinator** repo-wide rename | claude-tag review loose end | — | S | TODO |

### W1 — anchored-async-ask record layer (pull-mode)
- `create` gains `kind:"note"|"question"`, `options:[{label,description?}]`, `blocking:true`; new `answer`
  event `{ev,id,by,choice?,text,ts}` (forward-compatible — `foldAnnotations` ignores unknown kinds); derived
  question state `awaiting`/`answered`/`resolved` at read (never stored).
- `canvas anno ask` / `canvas anno answer` verbs; `anno list` shows question states (awaiting vs answered vs
  plain comment) in the per-file listing and the board sweep.
- Collab-brief + CLAUDE.md norm: *for a real decision, ask on the doc (an anchored question), not the
  in-session `AskUserQuestion` block.*
- **Done when:** an agent raises an anchored question (with options); a human answers on the doc or via CLI;
  the sweep distinguishes awaiting/answered; a fresh session can sweep `answered` questions and apply them.
  Continuation is **pull** (no auto-wake yet) — this alone retires the in-session ask-block anti-pattern.
- **Shipped** (commit `9e6988a`): `create` gains `kind:"note"|"question"` + `options` + `blocking`;
  new `answer` event (`{ev,id,by,choice?,text}`) rides `replies` and marks the question answered; derived
  `questionState` = awaiting/answered/resolved, read-time only (`annotations.js` + `.d.ts`). The
  `/api/annotations` write handler takes the `answer` op (400 on a note) and the question create fields; the
  read adds per-question `state` and the sweep adds `awaiting`/`answered` counts. `scripts/canvas anno ask`
  / `answer` verbs; `anno list` shows Q-wait/Q-answ + option labels per file and awaiting/answered in the
  sweep (awaiting floats to the top). Norm added to the collab brief + `CLAUDE.md`: *for a real decision,
  ask on the doc, not the in-session block.* Tests: `annotations.test.mjs` (fold + state) +
  `http-contract.test.mjs` (live question round-trip). **W2 note:** the read already emits `kind`,
  `options`, `blocking`, `answer`, and `state` per annotation — the card affordance is a pure render over
  that; `answer` events carry an optional `choice` on their `replies` entry.

### W2 — anchored-async-ask card affordance
- Question paints distinctly from a comment (a "?" on the highlight); popover shows the question, option
  buttons + a reply box, and an awaiting/answered badge (host chrome, `NodeView.tsx` + `src/annotations.ts`).
- **Done when:** a human can ask and answer a question entirely from the doc card.

### W3 — R4 board memory.md + linked role memory
- `.canvas/memory.md` rendered as an ordinary markdown file card, included in every spawned session's brief;
  structure ("one fact per line, newest-first, links to per-topic markdown, lazy-loaded") is a **convention**
  the brief states. Role memory = markdown leaves **linked from `memory.md`**, loaded on demand; `role.md`
  stays the shared charter. No separate role-notes store.
- **Done when:** a `memory.md` card exists, rides the spawn brief, and links at least one role-memory file
  pulled into context on demand.

### W4 — P1: seats + notification levels
- Generalize the seat onto any surface; each seat carries `level ∈ {all, mentions, paused}`. The **watch
  record** (per-doc marker beside the annotation ledger): `{role, level, state:"active"|"paused", by,
  createdAt}`.
- `canvas anno watch <doc> [--role --level] [--pause|--resume]` + the doc card's right-click **"watch for
  comments"** affordance; a watched doc shows a watcher chip.
- Thread wake adopts the same levels (R2): default `all`, per-seat opt-down to `mentions`/`paused`,
  `@`-mention override. The change is the nudge fan-out condition only.
- **Done when:** a thread or doc seat carries a level; the wake fan-out respects it; an `@`-mention reaches a
  `mentions`/`paused` seat; a doc can be watched/paused from CLI and card.

### W5 — P2: server-spawn-from-record + wake trigger
- **Idle lifecycle (R1):** a session is kept alive ~5 min (server-side idle timer) then exits; default
  reconstitution is a **fresh spawn seeded from thread history + memory**; `--resume` is an explicit,
  assumed-expensive escalation only.
- **Reconstitution:** on a qualifying wake (an addressed thread message to a dormant seat; annotation
  activity a watcher's level covers), the server spawns a session seeded from the durable record.
- **Wake trigger:** reads the watch marker + **derived** annotation/thread state (never raw appends), so it
  only fires on activity that (a) clears a watcher's level and (b) isn't already being serviced. **Single-
  flight per doc**; the worker **loops until the queue is dry**, then winds down (batch within a wake, never
  resident across).
- Closes: R1 dormant-seat respawn, `anchored-async-ask.md` push wake-back (an `answer` wakes the ask-armed
  seat), doc-wake (a comment wakes the doc's watcher), and is the base for R6.
- **Done when:** an answer/comment on a watched doc auto-spawns a per-doc worker that services the whole open
  queue and winds down; an addressed message to a dormant thread seat respawns it; the idle keep-alive→exit
  timer runs.

### W6 — R6 standing jobs
- A `watch` entry with an interval + instruction on a thread/doc marker, server-fired (rides P2's spawn):
  on fire, wake/reconstitute the named seat with the instruction. Norms: **"skip days with nothing"** (a
  firing that finds nothing posts nothing) and **jobs survive their creator** (owned by the place).
- **Done when:** a scheduled instruction fires a worker on its interval and no-ops silently when there's
  nothing to do.

### W7 — R-PIN + R5
- **R-PIN:** any thread message is pinnable; the pinned set is the head-context tray, re-read on every wake,
  kept in chronological place, rendered as a collapsible tray on the card.
- **R5:** the thread's `Done when:` condition is a pinned post; a `done` intent must be accompanied by a
  thread message with proof against it; the Coordinator's review = checking proof against condition.
- **Done when:** a message can be pinned and shows in a tray; a Done-when + proof-at-done norm is in the
  briefs.

### W9 — PM → Coordinator rename
- Repo-wide mechanical rename (currently doc-only in `claude-tag-lessons.md`): `docs/agent-roles.md`, the
  PM-named memories, the role definition, the briefs. Independent, do anytime.

## Suggested sequence

`W1` first (retires the ask-block anti-pattern, ships on today's substrate) — with `W3`, `W7`, `W9` runnable
in parallel sessions (no unmet deps). Then `W2` (rides W1). Then the primitives in order: `W4` (P1), then
`W5` (P2) — the structural core that unlocks the push half of async-ask, R1, doc-wake, and R6 at once. Then
`W6` (rides P2). `W8` is ambient/later.

## How to drive this (the carry-forward mechanism)

- **This doc is the durable source of truth** — the ordered checklist, kept current in the Status column. A
  fresh session's first move is to read this doc + the referenced design sections for its item.
- **A driving thread** (`type:"thread"`, referencing this doc as its brief link) is the coordination home:
  handoffs, status, who's on which item, and blocking questions live there — one task with a conversation,
  per our own model. The thread's `Done when:` is "all non-LATER items shipped & verified."
- **Increments are kicked as fresh sessions**, one per item (or a small parallel set for the independent
  W1/W3/W7/W9). Each session: reads this doc, does its item, runs the package's tests + typecheck,
  smoke-tests against the live board, commits, updates the Status column and posts a handoff to the thread.
- **Not a fully-autonomous Coordinator — yet.** The self-driving version (a Coordinator that wakes builders
  via standing jobs) depends on exactly the machinery this plan builds (P2 + R6 + the self-wake heartbeat,
  which is only partial — see `canvas-session-self-wake`). Bootstrapping the build with its own unbuilt
  output is fragile. So: **before W5, drive manually** (human- or thin-Coordinator-kicked sessions + this
  doc + the thread). **After W5+W6 land, the project can graduate to being driven by its own machinery** —
  a nice dogfood milestone, and a real acceptance test of P2.

## Open questions (carried, not blocking)

- **R1 cache empirical** — whether process-exit evicts the prompt cache / `--resume` reuses it. The 5-min
  keep-alive design *sidesteps* this (never depends on resume reusing a cache), so it's **not on the
  critical path**; worth a one-off measurement if we ever want explicit-resume to be cheap.
- **R3 spend accounting** — deferred; cheap to record on the thread marker once P2's marker exists.
- **Multiplicity of seats** — labelled multiple seats of one role on a surface (`threads-as-cards.md` §5)
  is still 1:1; not needed until a real case appears.
