# A review of Linear — and what it teaches this canvas

*Written for the "Linear review" thread. Purpose: distill Linear's philosophy, model, UI, and
(where it teaches something) implementation into a prioritized set of lessons for closing our
workflow gap — **there is no one canonical place to capture future work on this canvas; it
scatters across sticky-note todos and unstaffed threads.** Research is web-based (the Linear
MCP connector is unauthenticated here); sources are linked inline and listed at the end.*

---

## 1. Philosophy — the "Linear Method"

Linear is opinionated software wearing a project tracker. Its worldview, published as the
[Linear Method](https://linear.app/method), is that most issue trackers fail not on features but
on **friction and drift**: work gets captured badly, then rots in an unread backlog. The method is
a set of practices designed to keep a team's real state legible and moving.

The load-bearing opinions, and what each rejects:

- **"Write issues, not user stories."** An issue is a direct, implementation-focused statement of
  work — not a ceremonial "As a user, I want…" template. *Rejects:* agile story ritual that adds
  words without adding clarity.
- **Momentum over estimation.** The method emphasizes *generating momentum* and a *predictable
  rhythm* (cycles) rather than precise up-front estimates and long-range Gantt planning. *Rejects:*
  estimate theatre and the illusion of a plannable distant future.
- **Scope down, launch and keep launching.** Break work into small pieces and ship continuously.
  *Rejects:* big-batch releases held until "perfect."
- **A curated backlog, not a landfill.** Linear treats an unbounded, unread backlog as an
  anti-pattern. Work is meant to flow through a small number of well-understood states, and stale
  work is expected to be pruned or explicitly parked — not silently accumulated.
- **The tool should be fast enough to disappear.** Speed is treated as a *feature of correctness*:
  if capturing a thought is slow, the thought is lost. This is why the whole product is
  keyboard-first and local-first (§3, §4).

The throughline: **capture must be frictionless, and structure must be imposed later, deliberately,
by a human review step** — not demanded at the moment of capture. That single idea is the most
important thing this canvas can borrow.

---

## 2. Model — how work is captured, then triaged into structure

Linear's data model is a small, opinionated hierarchy
([Concepts](https://linear.app/docs/conceptual-model)):

- **Issue** — the atomic unit of work. Has an assignee, priority, labels, a status, and a rich
  markdown description. Everything else is a container or a lens over issues.
- **Project** — a set of issues aimed at one outcome (a feature, a launch), with milestones and a
  progress view.
- **Initiative** — groups projects into a larger, possibly cross-team effort.
- **Cycle** — a team's repeating, time-boxed planning period (a sprint by another name), giving
  execution a predictable cadence.
- **Team** — owns *its own* workflow, triage process, and cadence. Customization is per-team, not
  global; alignment across teams is by convention, not enforced uniformity.

**Workflow states** are the spine
([Issue status](https://linear.app/docs/configuring-workflows)). Issues move through an ordered set
of statuses grouped into fixed categories: **Triage → Backlog → Todo → In Progress → Done**, plus
**Canceled / Duplicate**. The categories are fixed (so the system always understands "is this
active?"), but the named states within them are per-team-configurable. List views group by status;
board views turn statuses into columns.

The crucial move is the **separation of capture from structure**:

1. **Capture is cheap and always available** — anyone (a teammate, an integration, a non-Linear
   user via [Asks](https://linear.app/changelog/2025-06-05-asks-fields-and-triage-routing), a Slack
   message, a Sentry alert, a support ticket) can create an issue with almost no required fields.
2. **New/incoming work lands in Triage, not in the workflow** — a holding area, explicitly *outside*
   the active states.
3. **A human (or a rule) triages it into structure later** — assigning team, priority, project,
   labels, and a real status.

So Linear never asks the capturer to know where the work belongs. It asks only that the work be
*written down somewhere canonical*, and guarantees that a review step will later route it. Nothing
that enters the system is silently lost, because there is exactly one front door.

---

## 3. UI patterns — the low-friction affordances

The philosophy would be inert without the interface that makes it true. The affordances that keep
future work from getting lost:

- **Command bar (`⌘K`).** Do any action by name, from anywhere, with fuzzy search — you don't need
  the exact command name ([keyboard-first design](https://medium.com/linear-app/invisible-details-2ca718b41a44)).
  It is the universal escape hatch: whatever you want to do, `⌘K` finds it.
- **`C` — create an issue from anywhere.** A single keystroke, from any screen, opens a capture
  form. This is the "never lose a thought" primitive: the cost of recording future work is one key,
  with no context switch. You can capture without deciding team, project, or priority — those are
  optional and get filled at triage.
- **Keyboard-first everything.** `S` status, `P` priority, `L` labels, `G I` go-to-inbox, `G T`
  go-to-triage. Nearly every action is reachable without the mouse
  ([shortcuts](https://keycombiner.com/collections/linear/)). Hands stay on the keyboard, so
  capture and triage are both fast enough to actually happen.
- **The Triage queue as an inbox** ([Triage docs](https://linear.app/docs/triage)). Incoming work
  accumulates in one reviewable list. Triage is driven by single keys: **`1` accept** (into the
  workflow), **`3` decline** (cancel with a reason), **`2`/`MM` merge duplicate** (fold into a
  canonical issue, moving attachments/requests over), **`H` snooze** (hide until a chosen time or
  until new activity). The whole "decide what to do with this" loop is a few keystrokes per item.
- **Triage rules / routing.** Filterable conditions auto-set team, status, assignee, label,
  project, and priority for incoming issues — so predictable intake is routed automatically and only
  the genuinely ambiguous items need a human.
- **Snooze and duplicate-merge as first-class.** Two quiet but important affordances: *snooze* lets
  you defer without losing (it comes back), and *merge* keeps the queue from filling with
  near-duplicates. Both fight the two failure modes of any inbox — overwhelm and duplication.

The pattern to internalize: **one canonical inbox + single-key capture + single-key triage + a
review step that assigns structure.** Capture is unconditional; structure is a later, cheap,
human-in-the-loop act.

---

## 4. Implementation — the sync engine, insofar as it teaches something

Linear's speed is not incidental; it's architectural, and the architecture rhymes with ours.
(Sources: [bytemash](https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/),
[reverse-engineering writeup, endorsed by Linear's CTO](https://github.com/wzhudev/reverse-linear-sync-engine).)

- **Local-first.** The browser's IndexedDB is treated as a real database. Every change happens
  locally first; the network is pushed out of the interaction path, so most actions are instant
  (sub-50ms). *This is exactly our stance* — a local-only, reactive store; the renderer reads a
  pull channel with no server round-trip.
- **A monotonic sync log is the source of truth.** Every change increments a globally
  monotonically-increasing `lastSyncId`; all transactions follow one total order across the whole
  database. A client compares its `lastSyncId` to the server's to detect gaps, and either
  **bootstraps** (full load) or applies **incremental delta packets** since its last known id.
- **Mutations are transactions, not in-place writes.** Changes are expressed as typed transaction
  objects (`Creation`, `Update`, `Deletion`, `Archival`), each carrying a `changeSnapshot` of *what
  changed and the previous value*. Client operations never write the local DB directly — they update
  an in-memory model optimistically, and the DB only reflects server-approved delta packets.
- **The change log — not the table state — is canonical.** The server's ordered sequence of sync
  actions is the ultimate truth; the materialized tables are a projection of it.

**Why this matters for us:** it is a mirror of our own design (CLAUDE.md): a reactive store behind
`Subscribable<T>`, a **push diff stream** for persistence/undo/indexes, and a durable **intent log**
(one `IntentEvent` per gesture) for provenance/agents/sync. Linear's `lastSyncId` total order is our
intent-log ordering; their typed transactions with a change-snapshot are our channel-3 intent
events; their "log is truth, tables are a projection" is our board record store
(`events.jsonl` + `snapshot.json`). The lesson is not "copy their sync protocol" — it's that a
**capture-then-triage workflow sits naturally on an append-only intent/event log**: every captured
item is an event; triage is a later event that assigns structure; nothing is lost because the log
is the canonical record. Our substrate is already the right shape.

---

## 5. Lessons for this canvas — prioritized

Our gap: **no one canonical place to capture future work; it scatters across sticky-note todos and
unstaffed threads.** Each lesson below says *what Linear does*, *why it works*, and *how it maps
onto our primitives* (threads-as-cards + seats, file memory in `.canvas/memory`, the
Coordinator/worker model, worktrees, doc annotations).

### P0 — One canonical inbox with a mandatory review step
- **Linear:** all incoming work lands in a single Triage queue, *outside* the active workflow, and a
  human/rule triages it into structure. There is exactly one front door.
- **Why it works:** it removes the capturer's burden of deciding *where* work belongs, while
  guaranteeing nothing is silently lost — every item is seen at least once.
- **Maps to us:** a **single canonical "Triage" thread-as-card** (or a dedicated capture surface)
  that is the *only* sanctioned place to drop future work. The **Coordinator seat owns triage** —
  its heartbeat already gives it a natural review cadence — and routes each item to a real thread
  (staffed) or to file memory (a durable decision/reference), or declines it with a reason. This
  directly replaces "unstaffed threads + sticky notes" with one reviewed queue.

### P0 — Frictionless capture that does *not* require structure up front
- **Linear:** `C` creates an issue from anywhere in one keystroke, with team/project/priority all
  optional.
- **Why it works:** the cost of recording a future-work thought is ~zero, so thoughts actually get
  recorded instead of lost. Structure is deferred to triage.
- **Maps to us:** a one-shot **"capture to the Triage thread"** primitive — a single CLI verb /
  affordance that appends an item to the canonical queue with nothing required but a line of text
  and the author's session id. No thread-creation, no staffing decision, no seat assignment at
  capture time. (Contrast today: capturing future work means either creating+briefing a whole
  thread or dropping a sticky note — both too heavy, hence the scatter.)

### P1 — Fixed status *categories*, configurable names
- **Linear:** state names are per-team-configurable, but the categories (triage/backlog/active/
  done/canceled) are fixed so the system always knows "is this live?"
- **Why it works:** flexibility for humans, legibility for the machine — the system can always
  answer "what is active / waiting / done."
- **Maps to us:** we already have this shape — the **work-intent enum**
  (`working` / `blocked:human` / `blocked:peer` / `done`) and the active/waiting/dormant derivation
  are our fixed categories. The lesson: give **captured-but-not-yet-triaged** items an explicit
  category too (e.g. `captured` / `triaged` / `parked`), so an untriaged item is a *distinct,
  countable state*, not an ambiguous unstaffed thread. Silence is ambiguous (Principle 4) — an
  untriaged item should look untriaged.

### P1 — Snooze and merge as first-class queue hygiene
- **Linear:** `H` snoozes (returns later); `2`/`MM` merges duplicates into a canonical issue.
- **Why it works:** the two ways an inbox dies are overwhelm (never emptied) and duplication (same
  work logged five times). Snooze defers without loss; merge collapses dupes.
- **Maps to us:** triage actions on the canonical queue should include **park/snooze** (defer an
  item with a wake condition — e.g. re-surface after date, or when a related thread closes) and
  **merge/fold** (point a duplicate at the canonical item, or fold a captured note into an existing
  thread's brief). Parked items belong in **file memory** as durable `project`-type facts with a
  re-surface hook, so a deferral survives session death (Principle 1: nothing lives only in a
  running process).

### P2 — Triage routing rules for predictable intake
- **Linear:** filterable rules auto-assign team/status/priority for known intake shapes; humans only
  handle the ambiguous remainder.
- **Why it works:** it keeps the human review step small — routine work routes itself.
- **Maps to us:** lightweight, declarative routing the Coordinator applies — e.g. items tagged to a
  known area auto-open a thread with a default brief and a suggested seat; items that are clearly
  reference-shaped get filed to `.canvas/memory` instead of a thread. Start manual (Coordinator
  judgement), add rules only where a pattern proves itself. **Out of scope to build now** — this is
  a later follow-up, noted for the recommendation.

### P2 — Capture where the work is: doc annotations as an intake channel
- **Linear:** issues can be created from Slack, support tools, Sentry — capture meets you where the
  thought occurs, and still funnels into Triage.
- **Why it works:** you don't have to leave your context to record work; the funnel still converges
  on one queue.
- **Maps to us:** a **doc annotation** ("this section needs work") should be able to **promote
  itself into the canonical Triage queue** — the annotation is the in-context capture, and promotion
  puts it in the one place that gets reviewed. This turns our existing annotation primitive into a
  second front door that still converges on one inbox (not a new scatter site).

---

## 6. Recommendation — one canonical future-work capture mechanism

**Adopt a single canonical "Triage" thread-as-card as the one front door for all future work, owned
by the Coordinator seat, backed by the intent log and file memory.** Concretely:

1. **One canonical Triage thread** exists per board (a well-known thread-as-card, pinned/wayfound so
   it's always findable). It is the *only* sanctioned place to record future work. This kills the
   "sticky-note todos + unstaffed threads" scatter by giving work exactly one home.

2. **A one-keystroke-equivalent capture primitive** — a single CLI verb (e.g.
   `scripts/canvas capture "<line of future work>"`) that appends a `captured` item to the Triage
   thread with only text + author required. No structure demanded at capture time. Each capture is
   an append-only event on our existing intent log, so it is durable the instant it lands
   (Principle 1) and legible to every session and to agents.

3. **The Coordinator triages on its heartbeat.** Its existing review cadence becomes the triage
   loop: for each `captured` item it either **accepts** (opens+briefs a real thread and, if the
   human approves staffing, spins a worker), **files** (promotes to a durable `.canvas/memory` fact
   for reference/parked work with a re-surface hook), or **declines** (marks resolved/won't-do with
   a reason). Every item leaves the queue with an explicit outcome — nothing rots.

4. **A distinct `captured` state** so untriaged items are countable and visible (a badge on the
   Triage card), making "unreviewed future work" a loud state rather than silent scatter
   (Principle 4).

**Why this direction and not the alternatives:** it reuses primitives we already have
(threads-as-cards, seats, the Coordinator/worker model, the intent log, file memory) rather than
inventing a new artifact type; it puts the review step on a role that already has a heartbeat; and
it matches the one idea that makes Linear work — **capture is unconditional and structure is imposed
later by a cheap, guaranteed review step.** A pure sticky-note or a per-item thread both fail the
same way (no guaranteed review, no single home); a canonical Triage thread + Coordinator ownership
fixes exactly that.

**Scope note:** this document is the review + recommendation only. Building the capture verb, the
`captured` state, and the Coordinator triage loop is a deliberate follow-up thread, not this one.

---

## Sources

- [The Linear Method](https://linear.app/method)
- [Linear Docs — Concepts](https://linear.app/docs/conceptual-model)
- [Linear Docs — Issue status / workflows](https://linear.app/docs/configuring-workflows)
- [Linear Docs — Triage](https://linear.app/docs/triage)
- [Linear Changelog — Asks fields and Triage routing](https://linear.app/changelog/2025-06-05-asks-fields-and-triage-routing)
- [Linear — Invisible details (keyboard-first design)](https://medium.com/linear-app/invisible-details-2ca718b41a44)
- [Linear keyboard shortcuts](https://keycombiner.com/collections/linear/)
- [Bytemash — "Linear sent me down a local-first rabbit hole"](https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/)
- [wzhudev — reverse-engineering Linear's sync engine (endorsed by Linear's CTO)](https://github.com/wzhudev/reverse-linear-sync-engine)
