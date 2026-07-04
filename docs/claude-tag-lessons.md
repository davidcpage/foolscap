# What Claude Tag teaches us about agents in threads

*Prepared 2026-07-03, from public documentation only. A survey of how Anthropic's **Claude Tag** — their
Slack-native agent, launched 2026-06-23 — lets an agent participate in team channels, mapped against our
own thread/session design. Companion to `threads-as-cards.md` (our thread model), `agent-roles.md`
(roles, seats, the liveness≠identity keystone), and `session-thread-lifecycle.md` (the state machine).
The short version: **the two designs converge to a striking degree** — thread = unit of work, a shared
agent identity that survives its process, memory scoped to the place rather than the person — which is
strong independent validation of our direction. Where they differ, Tag is ahead of us on exactly four
things worth adopting, and behind us on everything multi-agent.*

---

## 1. What Claude Tag is

Claude Tag is Anthropic's agent that lives inside a Slack workspace. Anyone in a channel types
`@Claude` plus a task, and Claude works the task — in public, in that Slack thread — using tools an
administrator has connected (GitHub, databases, dashboards, the workspace's own message history). It
replaces the earlier per-user "Claude in Slack" app (that one routed coding requests to a personal
Claude Code session on the web; Tag retires it on 2026-08-03).

The reason it's worth our attention: Slack channels full of humans-plus-one-agent are the closest
production analogue to our canvas boards full of humans-plus-agent-sessions. Anthropic has now shipped,
at enterprise scale, answers to the same questions we've been working through in `threads-as-cards.md` —
what is the unit of work, what wakes an agent, who is "the agent" across restarts, where does memory
live, who is allowed to do what. Their answers are public and unusually detailed.

### Vocabulary crosswalk

Both systems invented words for the same underlying ideas. This table is the decoder ring for the rest
of the doc; each concept is explained fully in the section cited.

| Concept | Claude Tag calls it | We call it | Where |
|---|---|---|---|
| The unit of work + conversation | a Slack **thread** (session-scoped) | a **thread card** (`type:"thread"` node) | §2 |
| The running agent process | a **session** in an ephemeral **sandbox** | a live `claude -p` **session** (a sidecar child) | §2 |
| Durable agent identity across process restarts | the org's one **provisioned service account** | a **seat** on a thread (role-keyed) | §4 |
| What wakes an agent | any reply in an active thread | a content-free **nudge** + inbox pull | §3 |
| Long-term knowledge | **channel memory** / workspace store | role memory (`autoMemoryDirectory`), per-role | §5 |
| Unprompted agent activity | **standing work** (schedules, channel watches) | (none yet — the gap `canvas-session-self-wake` found) | §7 |
| Who may do what | **Access bundles** attached to channel scopes | uniform spawn-time baseline allow-list | §4 |
| "How is the work going?" | an in-place-edited **checklist** message | the **work-intent** act + derived thread state | §6 |

---

## 2. Their session model: "the thread is durable; the sandbox is not"

**Declarative facts** (from `claude.com/docs/claude-tag/concepts/how-it-works`):

- An `@Claude` mention *with the task in the same message* starts a **working session**. The session is
  scoped to that Slack thread. Two threads in one channel are two sessions with two separate sandboxes;
  sessions never share state directly. This is precisely our "a thread is a task with a conversation
  attached" (`threads-as-cards.md` §1) — they arrived at thread ≈ work-unit ≈ session independently.
- The session runs in an **ephemeral sandbox** Anthropic hosts — a real working environment (files,
  code execution, PRs). When the thread goes quiet, the sandbox is *released*. When the next reply
  arrives, it is *rebuilt* and the session resumes from the thread's history. Their docs elevate this to
  a design principle, verbatim: **"the thread is durable; the sandbox is not."** Files that existed only
  in the sandbox do not survive the quiet period; anything that matters must have been posted to the
  thread (or committed, or written to memory) before going idle.
- Consequence: **Tag has no concept of an idle live agent.** There is no process sitting around waiting,
  no liveness cap to manage, no "is it still running?" question. Compute exists exactly while there is
  work; identity and context live entirely in the durable substrate.

**Where we stand.** Our sessions are real long-lived `claude -p` processes. The session-host sidecar
(shipped 2026-07-03, now the default) made them survive dev-server restarts — the *availability* half of
this principle: what an agent *is* (its identity, thread history, transcript) now outlives infrastructure
churn, so there is always something to come back to. The *ephemerality* half we don't have: Tag releases
compute the moment a thread goes quiet and rebuilds it on the next reply, while our idle worker still
holds a process and a slot against `MAX_LIVE_SESSIONS=12`, and when a session exits, a message addressed
to it goes nowhere until a human resumes it. We already built
the durable substrate Tag rebuilds from — the thread ledger (`.canvas/threads/`), the transcript
(`--resume`), and the seat — we just don't yet *use* it to reconstruct compute on demand.

> **Recommendation R1 — adopt: respawn-on-message for dormant seats.** A seat is *dormant* when it is
> still a member of the thread but the session that last filled it has exited — the durable seat row
> survives on the thread marker, but no live process backs it, so a message addressed to it currently
> dead-letters. R1: when a thread message addresses a dormant seat, the server **reconstitutes** a live
> agent for it rather than dropping the message. The default reconstitution is a **fresh spawn seeded
> from thread history + memory** — which keeps Tag's invariant that the thread (not the sandbox) is the
> only durable substrate; the prior transcript is an *archive the fresh agent can retrieve on demand*,
> not authoritative state that silently rides along. `--resume` of the seat's last sid stays available as
> an **explicit, assumed-expensive escalation** (human- or agent-invoked) for when you genuinely want to
> continue the same head — never the efficiency default, because it replays the whole transcript.
>
> **The idle lifecycle (decided).** A session is *not* killed the instant it goes idle. It is kept alive
> for a short grace window (~5 minutes, a server-side idle timer) and only then exits. That window — not
> `--resume` — is the cheap-continuity path the resume-vs-respawn debate was chasing: a follow-up within it
> continues the **still-live** session with its context (and prompt cache) already warm, no reconstitution
> at all; past it, the session exits, the seat goes dormant, and the next addressed message respawns fresh.
> So the efficiency comes from *briefly keeping the real session alive*, which sidesteps the open empirical
> (does process-exit evict the cache, does `--resume` reuse it) entirely. **The cap-pressure motivation was
> overblown:** we have never approached `MAX_LIVE_SESSIONS=12`, and an idle session burns no tokens — the
> cap is a self-imposed guard, not a real constraint, so there is no urgency to reap idle workers. R1's
> real value is the keystone, not slot-reclamation: it makes the **seat the thing you address** — today a
> seat is inert data (a role→sid row) once its occupant exits; under R1 addressing it brings a live agent
> back, sessions being interchangeable compute behind a durable seat. That is `agent-roles.md` §1's
> *liveness ≠ identity* made true in practice. The sidecar and the seat re-fill machinery
> (`threads-as-cards.md` §5) are the two halves already built; this is the hinge between them.
>
> **The principle underneath** — the invariant the keep-alive / respawn / explicit-resume choice all serve:
> *never rely on session context that isn't in the thread history, memory, or docs.* Whatever lives only in
> a live process is disposable, which is exactly what lets those three be interchangeable implementations
> picked on cost alone. The corollary norm, adopted from Tag
> verbatim: **before going idle an agent must leave anything it needs in the thread (or its memory)** —
> state that lived only in the exited process is legitimately lost.

---

## 3. Their wake model: replies reach the working session by default

**Declarative facts:**

- The mention is needed **once**. "Once a session is active in a thread, it belongs to everyone there" —
  colleagues reply in-thread *without* re-mentioning `@Claude`, and the agent reads new replies as it
  works, folding corrections into work already in progress. Asking "how's it going?" in the thread is
  enough to get a check-in; a reply *is* the wake signal.
- Context is read fresh per wake: up to **50 messages from the start of the thread** (the root message
  plus oldest replies, other bots filtered out), and the **last 20 channel messages** when mentioned bare
  in a channel. Note the thread window is **head-biased** — because in Slack the root message is the only
  place the task statement lives, the head is load-bearing and the *recent* tail is what falls off in
  long threads (their docs tell users to restate critical info when that happens).

**Where we stand.** Our wake gating is `@`-tag based: *no tag = wake no one* (`channel-tagging` — the
tag gates the wake, never the content). That rule was designed for the long-lived channel, where it is
correct: a channel is a *room*, and waking every member on every message is noise. But we retired the
channel as the coordination container. A **thread** is a *task with active workers*, and in a task, a
reply from a teammate is signal by default — Tag's model matches the new container better than our
inherited one does.

> **Recommendation R2 — adapt: wake is a per-seat notification level, defaulting to wake-all.** Within a
> thread, the default is that a new message nudges **every member**, no tag required — matching Tag's "once
> a session is active in a thread it belongs to everyone there." A thread is a *task with active workers*,
> not a room, so a teammate's reply is signal by default. But that "wake me on everything" is only the
> **default level of a per-seat setting**, not a fixed rule: each seat carries a **notification level** —
> `all` (any message wakes it) / `mentions` (only an `@`-address wakes it) / `paused` (nothing auto-wakes;
> an explicit `@`-mention still overrides) — the Slack-channel choice, owned by the seat. The `@`-tag keeps
> the two jobs it does uniquely well, neither of them the everyday wake at `all`: **inviting a new member**,
> and **addressing** a specific seat — reaching a `mentions`/`paused` seat, or waking a dormant one back
> into the task (with R1, that address is what reconstitutes it).
>
> This stays clear of the trap the first draft named: **conditioning the fan-out on each member's work-intent**
> — making "does this wake me?" depend on reasoning about others' declared, *moving* state — is the hidden
> rule that makes a feature unreliable. A notification level is different in kind: a **static, self-declared
> preference**, not a dynamic inference over others' status, so it's the safe way to let a member turn its
> own traffic down without reintroducing that coupling. (A member that wants fully out `leave`s the thread;
> `paused` is the softer, still-addressable opt-out.) The change is to the nudge fan-out condition only; the
> content path (inbox pull, cursor, tool-output delivery) is untouched.
>
> **The generalization is the real point.** Wake policy is not thread-specific: thread messages, doc-comment
> notifications (`anchored-async-ask.md`), and timer / standing-job fires (R6) are **one primitive — a
> per-seat notification level on a wakeable surface**, where a *seat* is the durable participant slot
> (§4 / `agent-roles.md`) and a *surface* is anything that generates activity (a thread, a doc, a schedule).
> A doc's seat is filled by a "watch for comments" affordance, a thread's by membership, a timer's by the
> standing job — same three levels, same `@`-mention override, everywhere. A member sets "how much does this
> surface wake me" once, per seat, rather than each surface inventing its own gate.
>
> **Non-recommendation — do not import the head-biased context window.** Tag's 50-message head window is
> a workaround for Slack's flat threads, where the root message is the only home the task statement has,
> so it must be kept in view as the tail scrolls off. We don't have that constraint, and the better fix
> is R-PIN below (a pinnable head-context tray) rather than a hard-coded head bias: the task statement,
> the done-condition, and any framing that must stay in view become *pinned posts*, re-read on every wake
> regardless of how long the thread grows. Our tail-for-logs / head-for-documents truncation rule
> (CLAUDE.md) is right for the raw surfaces; pinning is what keeps the load-bearing few messages present.
>
> **Recommendation R-PIN — adopt: pinnable thread posts as the head-context tray.** Make any thread
> message **pinnable**; the pinned set is the thread's *head context*, re-read on every wake ahead of the
> recent tail. This subsumes three things the doc otherwise scatters: the task statement (the first
> pinned post, replacing a static `title`+`text` brief that lives in a separate channel from the
> conversation and can't evolve with the task), the done-condition (R5, a pinned post), and any framing a
> long thread must keep in view (Tag's head-window problem, solved without a head bias). Pinning must not
> reorder the log: a pinned post stays in its chronological place, and the card renders a collapsible
> **pinned tray** at the top that *references* the pinned messages (fold/unfold), so provenance and order
> are preserved. This is the canvas-native answer to "the task's framing evolves and the brief is a
> separate channel" — one conversation, with a durable, editable head. (Mechanism overlaps the deferred
> *pins* idea in the doc-annotations step-4 backlog.)

---

## 4. Their identity model: one shared agent, capability follows the place

**Declarative facts** (from `concepts/agent-identity`):

- There is **one provisioned service account** per organization — "one Claude". In a channel, everyone
  talks to the *same* agent: "anyone can see what it's working on, and can pick up the conversation
  from where the last person left off." Its acts are attributed to the service identity (posts from the
  Claude app, PRs from the Claude GitHub App), never to the requesting human.
- Capability is scoped to the **place, not the person**: admins attach **Access bundles** (sets of
  credentials/connections) to a channel, workspace, or org scope, and "what Claude can do never changes
  based on who asked." A human's own permissions are irrelevant inside a channel; personal connectors
  apply only in DMs, which run on the individual's own account.
- A running thread **locks its configuration at start** — the connections, skills, and plugins it was
  born with stay fixed for its whole life; an admin change never reaches a thread already in flight.
- Governance rides the identity: an audit log of every act *with who requested it*, and **spend limits
  per channel** and per org.

**Where we stand.** Three of these four are validation of decisions we already made, now confirmed at
production scale:

- *Capability is not a property of the asker* — our `session-permission-model`: a uniform baseline
  allow-list at spawn, and a human "yes" relayed through a channel does **not** lift a permission gate
  (`channel-relayed-nod-permission-block`). Tag's "never changes based on who asked" is the same red line.
- *Permissions are not a role axis* — ours are uniform per session; Tag's attach to the channel. Neither
  system makes capability part of the role/persona, confirming `agent-roles.md`'s split (roles are
  knowledge and stance, not capability sets). Tag does show what the *next* axis is if we ever need
  differentiated capability: scope it to the **thread or board** (the place), never the role.
- *Config locks at start* — we append the collab brief and allow-list at spawn and never hot-patch a
  running session. Same principle, same reason (a running task must be deterministic about what it can do).

The genuine difference: Tag has **one** agent identity; we have many sessions filling many **seats** (a
seat being our durable per-thread participant — role-keyed, surviving its occupant's respawn,
`threads-as-cards.md` §5). Tag's "one Claude everyone shares, pick up where the last person left off" is
in fact a *single universal seat* — our seat generalizes their model rather than conflicting with it.

> **Recommendation R3 — note for later, not now: per-thread spend accounting.** Tag's per-channel token
> budgets are the mature version of our blunt `MAX_LIVE_SESSIONS=12`. With R1 removing the cap's main
> job (idle-process pressure), the natural successor control is *spend per thread* — recorded on the
> thread marker, surfaced on the card, enforceable later if ever needed. Cheap to record now, no urgency
> to enforce. Attribution we already have (the intent log's `actor`); Tag confirms "who requested each
> act" is the audit primitive to preserve.

---

## 5. Their memory model: memory follows places, not users

**Declarative facts** (from `users/memory`):

- Memory **belongs to channels, never to individual users**. Three kinds accumulate: explicit
  instructions ("remember for this channel: …"), facts Claude auto-saves while working, and past session
  transcripts it can retrieve on request. Public channels feed a **workspace-shared store**; private
  channels keep isolated stores (and a private→public conversion does *not* migrate the private memory).
- Memory is a **shared, inspectable object**: any channel member can ask "what do you remember about
  this channel?", correct stale entries, and have the correction itself recorded.
- Teaching the agent has an explicit **hierarchy**, ordered by *scope of applicability* from narrowest
  (this one channel) to widest (the whole org); precedence on conflict runs the other way — the narrower
  layer wins, like CSS specificity. The five layers: **channel memory** (facts/instructions scoped to
  this one channel; narrowest, highest precedence) → repo **`CLAUDE.md`** (instructions attached to a
  specific code repo) → **standing channel instructions** (persistent "always do X here" rules a user
  sets, distinct from accumulated memory) → an **org skills repository** (shared skills/instructions
  available org-wide) → **org-wide custom instructions** (global defaults for every channel; widest,
  lowest precedence). Anyone can *draft* a change to the org layers (as a PR to the skills repo); admins
  approve.

**Where we stand.** Our memory is **person-scoped**: each role carries its own store via
`autoMemoryDirectory` (`headless-session-memory`), plus the repo-level `CLAUDE.md`. We have nothing
scoped to the *place* — no thread- or board-level memory — and nothing a teammate can inspect or correct
without being the role. Tag's hierarchy shows these are complementary layers, not alternatives: the role
store answers "what does the Implementer know?", a place store answers "what has this board/thread
settled?". Today the second question is answered only by the thread log (history, not curation) and the
deprioritised wiki idea.

> **Recommendation R4 — adopt, small: a board-scoped memory file as a card, and one home per fact.**
> A single curated file (`.canvas/memory.md`, shadow-versioned like the rest of `.canvas/` per
> `canvas-home.md`), included in every spawned session's brief and rendered as an ordinary **markdown
> file card** so any human or agent can read and edit it — Tag's "memory is a shared, inspectable object"
> made canvas-native, with zero new machinery. Structure ("one fact per line, newest-first, prefer
> append") is a *convention the brief states*, not an enforced schema; promote it to a custom card type
> only if per-fact affordances (resolve, pin, provenance, dedup) later earn their keep. This gives
> settled decisions a home that isn't a rotting wiki (curated *norms and facts*, not documentation of
> moving work — the distinction `threads-as-cards.md` §1 drew) and isn't locked inside one role's head.
> **Per-thread memory is *not* needed**: thread-specific facts live as explicit thread comments (a pinned
> post if they're load-bearing), and the closure write-up covers the rest. **Role memory hangs off the
> one `memory.md`, not a second store** (decided): keep `role.md` as the role's shared **charter** — its
> stance, knowledge, and how it works, versioned with the role and portable across repos — and put
> accumulated role *memory* in ordinary markdown files **linked from the board's `memory.md`**, pulled into
> context only when relevant. This reuses the memory index's existing lazy-loading habit (a `memory.md` that
> links out to per-topic markdown files, loaded on demand) rather than inventing a board-scoped role-notes
> store — which would just be *another place to look up*, the very thing we're trying to avoid. So there is
> exactly **one memory home per board** (`memory.md`, the index), the role's identity stays global on
> `role.md`, and role-specific facts are linked leaves under that one index — "one home per fact" without a
> second lookup location. This also settles the earlier charter-vs-notes scope wrinkle (identity global on
> `role.md`, notes place-scoped as linked memories) without a parallel notes file to keep in sync.

---

## 6. Their progress + completion discipline

**Declarative facts** (from `users/good-habits` — this page is norms Anthropic converged on from real
enterprise usage, and reads like a peer review of our `channel-coordination-norms`):

- Long tasks post **one checklist message, edited in place** as work progresses — not a stream of
  status messages. (Their noted downside: Slack doesn't notify on edits, so a thread "can look frozen
  while the list is still moving." Our canvas has no such problem — cards are live surfaces.)
- **Every task states its completion condition up front**, in one of exactly three shapes: an
  *objective check* the agent can verify alone ("done when CI is green"), *human approval* of prepared
  work ("draft the memo, post for approval"), or *human selection* between prepared options ("research A
  and B, recommend one"). "Post project status and tag me" closes; "look at this" doesn't.
- Self-closing tasks must post **proof of done**: links, test output, diffs — evidence, not assertion.
- Work happens **in the open by default**: first drafts belong in the thread, not polished work in DMs;
  teammates steer by *replying in the existing thread*, never by opening a parallel one. Closed threads
  are marked (a ✅ reaction) so review queues stay legible.

**Where we stand.** Our **work-intent act** (`working / blocked:human / blocked:peer / done`,
`threads-as-cards.md` §6) and the derived thread state built on it are our version of "how is the work
going" — arguably richer, since it distinguishes *why* nothing is happening, which Tag's checklist
can't. But our `done` is **self-reported and unverifiable**: nothing says what done was supposed to
mean, so neither the Coordinator nor the derived state can tell a real completion from an agent giving up
politely. Tag's discipline fixes exactly that gap. Our open-work norms (`channel-coordination-norms`,
`pm-spawning-and-engagement`'s assign-in-thread-never-DM rule) already match theirs.

> **Recommendation R5 — adopt: a pinned done-condition, and proof-at-done as a norm.** Convention first,
> schema later: whoever opens the thread posts an explicit `Done when: …` message in one of Tag's three
> shapes and **pins it** (R-PIN) — a pinned post, not a line buried in the `text` brief, so the condition
> is head context on every wake and can be refined mid-task by repinning. The collab brief instructs
> agents that a `done` intent must be accompanied by a thread message with evidence against that
> condition. The Coordinator's review act becomes checking proof against condition instead of trusting
> the flag. Costs a paragraph in two briefs; no code. (If pins prove too loose, `doneWhen` graduates to a
> field on the thread node and the rail can render unmet-condition threads distinctly.)
>
> **Non-recommendation — the in-place checklist.** Solves a Slack rendering constraint we don't have;
> our thread card + intents + status bands already out-render it. Nothing to borrow.

---

## 7. Their proactivity model: standing work is a platform feature

**Declarative facts** (from `users/proactivity`):

- All unprompted behaviour is **standing work**: jobs a user sets up conversationally and the *platform*
  executes — **schedules** ("every weekday at 9am, read the open threads here, check the linked PRs,
  post a one-line status per item"), **channel watches** ("once a day, post here if anything is relevant
  to user education — skip days with nothing"), and **subscriptions** (react when a PR updates / CI
  finishes).
- Jobs belong to the **channel**, not their creator: they keep running if the creator leaves the org,
  and stop only when removed from the channel. They run with the channel's access, same as a manual
  request; users list, edit, and disable them by asking in-channel.
- The agent does **not** self-schedule at the process level. Proactivity is the platform firing sessions
  on triggers — never an agent process keeping itself alive to poll.

**Where we stand.** This is independent confirmation of the conclusion we reached empirically:
`canvas-session-self-wake` established that our `claude -p` sessions *cannot* self-wake (ScheduleWakeup
timers never fire headless), so a looping Coordinator needs a canvas-native server heartbeat. Anthropic, with
full control of their own runtime, *still* chose platform-side standing jobs over agent self-scheduling
— which tells us the architecture isn't a workaround, it's the right shape: triggers are declarative
data owned by the place, and compute appears when they fire (the same "compute is ephemeral, the durable
substrate is not" principle as §2).

> **Recommendation R6 — adopt the shape: standing jobs on the thread marker, server-fired.** A `watch`
> entry on the thread's **durable marker** (its `.canvas/threads/` meta record — the same off-log store
> that already holds the thread's seats, work-intents, and read cursors), carrying an interval +
> instruction and executed by the server/sidecar: on fire, nudge a named seat with the instruction — or,
> with R1, reconstitute it if dormant. First consumer is already queued: the step-4 threads rail wants a
> ping on process-state changes, and the looping-Coordinator heartbeat becomes "a standing job on the
> Coordinator's thread" instead of bespoke plumbing. Borrow the two norms wholesale: **"skip days with
> nothing"** — a firing that finds nothing to report posts nothing, so a daily watch never becomes daily
> noise — and **jobs survive their creator** (the job is the thread's, not the spawner's — consistent
> with seats outliving occupants).

---

## 8. Where we are ahead — do not import

For balance, the places Tag's public design has nothing to teach us, or is behind:

- **Agent-to-agent coordination: absent.** Tag is one agent among humans. It has no peer messaging, no
  ask/reply consultation (our §16 oracle RPC), no seats-with-roles, no work-intent vocabulary, no
  derived thread state. Everything multi-agent in `threads-as-cards.md` is ours alone; there is no
  external pattern to defer to yet.
- **The trust boundary: ours is stronger.** Tag injects channel context into the model's working context
  and must warn users that "Claude may follow directions from other messages" — a live prompt-injection
  surface. Our wake model was built to avoid exactly this: message content **never enters stdin as a
  user turn**; it arrives as tool output via the inbox pull, and permission gates don't yield to relayed
  approvals. Keep this; do not "simplify" toward Tag's model.
- **The task-statement problem: better tools available.** Tag's head-biased 50-message window exists
  because in Slack the root message is the only home the task has. We don't have that constraint — the
  task already lives outside the log — and R-PIN makes the framing a *pinnable* head-context tray that
  stays present as the task evolves, without a hard-coded head bias (see R2's non-recommendation).
- **Live rendering.** Tag fights Slack's medium (edited messages don't notify; threads look frozen). The
  canvas is a live surface — status bands, intents, and feeds already render what Tag has to fake.

## 9. Summary of recommendations

| # | What | Verdict | Cost | Why |
|---|---|---|---|---|
| R1 | Respawn-on-message for dormant seats (fresh-seed default, transcript-on-demand, resume as explicit escalation) | **Adopt** | server: message→seat resolution + reconstitute cascade | Completes liveness≠identity; dissolves cap pressure; keeps Tag's "thread is the only durable substrate" invariant |
| R2 | Default-wake **every** thread member; `@`-tag = invite/address only | **Adapt** | nudge fan-out condition only | Tag-gating was a channel-era rule; a thread is a task, where teammate replies are signal. One clear invariant, no work-intent reasoning |
| R-PIN | Pinnable thread posts as an editable head-context tray | **Adopt** | pin flag on messages + a fold/unfold tray on the card | One durable, editable head for the task statement, the done-condition, and load-bearing framing — replaces the static brief and Tag's head window |
| R3 | Per-thread spend recorded on the marker | Note for later | small, no enforcement | The mature successor to the blunt session cap; cheap to record now |
| R4 | Board-scoped memory as a markdown card; role memory folds into one structured role file | **Adopt (small)** | one `.canvas/` file + card + brief line | The place-scoped layer we lack; shared + inspectable; one home per fact (no role.md-vs-store split) |
| R5 | Pinned `Done when:` + proof-at-done norm | **Adopt** | two brief paragraphs, no code | Makes `done` verifiable; gives the Coordinator a review act; rides R-PIN instead of the brief |
| R6 | Standing jobs on thread markers, server-fired | **Adopt the shape** | server timer + nudge/reconstitute | Confirmed architecture (Anthropic chose it *with* runtime control); unblocks the looping Coordinator and the rail's ping |

Suggested order: **R-PIN + R5 first** (R5 rides the pinning mechanism; both are cheap and immediately
useful), **R2** with the step-4 rail work (same nudge code), **R1** next (the structural one), **R6**
once R1 exists (reconstitution is what a firing trigger wants to do), **R4** anytime, **R3** ambient.

---

## Sources

All public; fetched 2026-07-03.

- [Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) — Anthropic's launch post
- Claude Tag documentation: [overview](https://claude.com/docs/claude-tag/overview) ·
  [how it works](https://claude.com/docs/claude-tag/concepts/how-it-works) ·
  [agent identity](https://claude.com/docs/claude-tag/concepts/agent-identity) ·
  [memory](https://claude.com/docs/claude-tag/users/memory) ·
  [proactivity](https://claude.com/docs/claude-tag/users/proactivity) ·
  [good habits](https://claude.com/docs/claude-tag/users/good-habits)
- [Use Claude in Slack](https://support.claude.com/en/articles/12461605-use-claude-in-slack) — the
  predecessor app's help page (context windows, surfaces, deprecation date)
- [Claude Code in Slack](https://code.claude.com/docs/en/slack) — the coding-specific predecessor
  (intent routing, session flow, the trusted-conversation warning)
- [TechCrunch, 2026-06-23](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/)
  — memory accumulation and identity-scoping details from Anthropic interviews
