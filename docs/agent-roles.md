# Agent roles, ephemeral sessions, and the lifecycle that connects them

*Prepared 2026-06-25. Companion to `agent-to-agent-messaging.md` (channels §15, ask/reply §16 — the
transport this builds on), `agent-sessions-on-canvas.md` (the session forms and registry), and the
headless-session / `autoMemoryDirectory` notes. Decides how a durable **role** relates to the
**sessions** that instantiate it, and pins down the **session lifecycle** + **read-policy** that make a
busy, multi-party board survivable for agents. Developed as a two-agent dialogue, like its companion.
The headline: **make the role the addressable identity and demote the session to "the role currently
online"** — which dissolves the context-accumulation problem rather than solving it, because the durable
substrate becomes curated memory, not an immortal transcript.*

---

## 1. The keystone: liveness is orthogonal to identity

Today the model is session-centric. A *member* of a channel is a session id (sid); a channel fans out
to *live* sids; an `ask` requires the answerer be live (`vite-fs-plugin.ts`, §16). The session **is** the
identity. That is precisely what forces "resume forever": the only way to retain an expert's accumulated
knowledge is to keep its one process — and its ever-growing transcript — alive.

The move this doc proposes is one primitive:

> **The role is the addressable identity; a session is the role being online.**

This is the Slack reframe. `@alice` addresses a *person*, not a particular laptop; Alice can be offline,
messages wait; Alice can be logged in twice. Once identity and liveness decouple, the worry that started
this — context accumulating across resumed sessions — does not get *solved*, it gets **dissolved**:

> **Ephemeral sessions are safe *because* the durable substrate is curated memory, not the transcript.**
> Cold-spawning a fresh instance of a role loses the transcript but keeps the knowledge, because the
> knowledge was externalized into a small, deduped, human-auditable memory store. Resume-forever is the
> anti-pattern; the role is what makes ephemerality cheap.

Everything below hangs off that sentence.

## 2. Three axes that were tangled into one

The instinct is to ask for "expert sessions." That bundles three separable concerns:

| Axis | What it is | Mechanism |
|---|---|---|
| **Identity & instantiation** (roles) | a durable, named identity that sessions instantiate | role card = charter + memory dir + presence |
| **Knowledge** (private memory ↔ shared wiki) | what a role knows, and what everyone shares | one `[[link]]` mechanism, two scopes |
| **Communication** (channels) | who talks to whom | Slack-style channels; member = human \| role \| session |

Keeping them separate is what makes each tractable. The bulk of this doc is the lifecycle that ties
*identity* to *communication*; knowledge is sketched in §8 and largely reuses the existing memory format.

**Permissions are deliberately NOT a fourth axis.** The tempting next move is "this role may commit, that
one may not" — but encoding capability into identity makes permission a *second axis of role meaning*:
you'd get Builder-can-commit vs Builder-can't as distinct roles, cross-multiplying with knowledge and
duplicating roles. So capability is a **uniform baseline** granted to *every* session at spawn, not a
role attribute. The baseline (`BASELINE_ALLOWED_TOOLS` in `vite-fs-plugin.ts`) is added on top of
`--permission-mode auto` — allow-rules are additive, so anything without a rule still flows through the
classifier. Today the baseline is `git commit` (a local commit is normal for any session — ad-hoc
sessions are the norm) + the `scripts/canvas` spawn wrapper. The **red line** stays gated by the
classifier for everyone: `git push`, destructive ops, out-of-scope changes, large/costly fan-out — these
need a human nod. A role *may* NARROW the baseline in the rare case (e.g. a read-only reviewer that drops
commit) via a `role.md` override, but that is the exception, never how roles normally differ. The PM is
the proof: it is a *coordination stance + knowledge*, using the same baseline every session has — heavily
— not "the session with commit rights."

## 3. What a role is (and the two files you must not merge)

A role is three things, and collapsing them is a mistake:

- **Charter** (`role.md`) — the mandate / system prompt: "you are the Codebase Oracle, answer in
  `file:line`, be terse." Human-authored, stable, fed to the append-system-prompt. This is *behaviour
  config*, and it also declares the role's **policies** (trigger, read-scope, work-pattern — §6–§7).
- **Memory** (a `MEMORY.md` index + one-fact-per-file store) — what the role has *learned*. Grows, is
  curated and deduped. Read-write. Maps onto the per-role `autoMemoryDirectory` insight (headless-session
  memory): each role gets its own store, keyed by an encoded id, while cwd stays the repo.
- **Presence** — *derived*, not stored: "does this role have ≥1 live session," and how many.

Resist "a role is just a memory.md." Charter and memory have **different authors and lifecycles** — one
is a rarely-changed human mandate, the other is accumulated, possibly-wrong, needs-curating knowledge. If
they share a file, a noisy auto-write to memory can silently rewrite the role's behaviour. Two files, one
role directory.

A role card is `node:role:<roleId>` — a *view* over charter + memory-dir pointer + presence. It is
explicitly **not** a process card; the live instance keeps its existing `node:live:<sid>` card. Roles
also force the deferred **card-naming** work: a role needs a stable human handle ("Codebase Oracle," not
a UUID). That stops being optional here.

## 4. Conversations: channel, thread, DM — and ask as a *mode*, not a transport

Three conversation forms, deliberately distinct:

- **Channel** — multi-party, Slack-style. Designed to make sense **with zero agents in it**; agents are
  just one kind of member. The only real data-model change from today is generalizing membership: a
  member is `human | role | session`, not only a sid + the magic `"human"` post box.
- **Thread** — a scoped sub-conversation *anchored in a channel*. For humans, threads de-interleave a
  busy stream. For agents the payoff is bigger and different: **a thread is a scope of attention and a
  unit of work** (see §5, §7). It is the natural session boundary. *(Superseded 2026-07-01 on the
  anchoring only: threads are first-class canvas cards, not channel sub-conversations, and the channel
  container is retired — see `threads-as-cards.md`. Everything else in this section stands.)*
- **DM** — a standalone 2-party (or N-party) channel: a *relationship*. **`ask`/`reply` is a DM, not a
  thread.** It existed pre-roles because there was no durable identity to address — you had to point at a
  live sid and hold the wire open.

Once the role is addressable, `ask(role)` becomes **sugar**: find-or-create the 2-member channel
{asker, role}, post, optionally block for the reply. This collapses two messaging primitives into one
(channels) with `ask` as a **mode**:

- **sync consult** — post + hold the connection for the reply (the existing §16 timeout). The oracle
  pattern.
- **async consult** — post, don't block, get nudged when the answer lands.

Keep two things the collapse would otherwise drop:

1. **The synchronous-blocking affordance is the valuable part of the old RPC** — preserve it as a *mode*,
   not a separate transport.
2. **Mind spawn-cost vs. timeout.** If `ask(role)` on an *offline* role must cold-spawn a `claude -p`
   child + first turn, a 60s held connection can blow. Sync is the *warm-role* path; cold roles default
   to async-first (or need an explicit "warm the oracle" action). Design for this rather than discovering
   it as a 503.

The quiet bonus: a persistent DM channel gives a **graded memory hierarchy** for free —

| Layer | Scope | Lifetime |
|---|---|---|
| role memory | curated, shared across all consumers | durable |
| **DM history** | per-relationship, uncurated | durable |
| session transcript | per-instance | ephemeral |

A waking oracle can read the DM backlog ("what has this person asked me before") without that being in
its global memory. Note the asymmetry the rows already imply: only the **role memory** layer is *curated
knowledge*; the DM/channel log is the *conversation's own record*, and the transcript is disposable.
Curation always flows **up into role memory, keyed to identity** — never into a channel-scoped store (§8).

## 5. The session lifecycle: reflex vs. cortex

The crux of the whole design is *which decisions are programmatic and which are agentic*. You cannot put
an LLM in the wakeup loop — spawning a model to decide whether to spawn a model is cost-regress. So split
the system in two:

- **Reflex (the canvas app): fast, cheap, deterministic, always-on.** Trigger matching, nudge
  coalescing, briefing-packet assembly, presence tracking, routing, slot management. No LLM.
- **Cortex (the session): slow, expensive, summoned.** Reading, reasoning, deciding, posting.

The art is to push everything possible into reflex so the cortex is summoned **rarely** and **briefed
well**. (The per-session state model that this split rests on — process-state vs. emitted work-intent —
and the derived work-unit / thread state machine it feeds are pinned down in
`session-thread-lifecycle.md`; the "is the work done / blocked?" row below is where the two meet.) This
maps cleanly onto **OS process scheduling**, which both supplies vocabulary and tells you where durable
state lives:

| OS concept | Here | Existing mechanism |
|---|---|---|
| fork | spawn a session of a role | `POST /api/session/spawn` |
| initial memory image | the briefing packet (§7) | to build |
| resident / sleeping | parked warm | live session, idle |
| swapped to disk | parked cold | `terminate` + durable thread state |
| page fault / swap back | re-engage on reply | `resume`, *or* fresh-brief (§6) |
| filesystem (durable, shared) | role memory + thread/DM history | `autoMemoryDirectory`, channels |
| physical RAM / cores | `MAX_LIVE_SESSIONS=12` | the cap |

### Two lifecycle shapes (a charter attribute)

- **Consultation shape (the oracle):** `spawn → answer → die`. No parking; knowledge from memory, answer
  lands in the DM. Stateless between calls. Cheap.
- **Task shape (a multi-step worker):** `spawn → work → (block on actor) → checkpoint → park →
  re-engage → … → done → promote → die`. Stateful. The interesting one.
- **Looping shape (the PM):** `spawn → (heartbeat → sweep → act|sleep)* → wind-down → die`. A coordination
  role that must notice *silence* — a stalled thread emits no event, so a purely reactive session would
  never wake to catch it. It runs an **operating loop**: each tick, read inbox + board, sweep for stalled /
  blocked agents and drifting work, then act or sleep.

  The loop is a property of the **role**, declared by `loops: true` in `role.md` frontmatter and stamped on
  the spawned session (`role-format.js` → `role-ledger.js` → `/api/roles` → the session marker). It is NOT
  self-scheduled: built-in self-wake (`ScheduleWakeup` / `/loop` dynamic mode) does **not** fire inside a
  `claude -p` canvas child (tested — accepted but never re-invoked). So the **server** owns the wake: a
  single global heartbeat (`loopTick` in `vite-fs-plugin.ts`) wakes idle `loops:true` sessions by reusing
  the exact content-free nudge path a channel message uses (`sendSessionInput`) — never interrupting a
  running turn. The `@mention`/`ask` path stays the unchanged immediate **interrupt** for anything urgent;
  the heartbeat only has to catch the silent.

  **Adaptive cadence (all tunable consts):** active base ~75s, exponential ×2 backoff up to a 10-min ceiling
  when the channel is quiet, snapped back to base the moment a world-signature (channel last-seq + live
  member statuses) changes; 60s floor for cost / prompt-cache TTL. A looping session asleep between beats
  reads a calm **`scheduled`** presence band (teal, off `session-status.ts`), not the loud amber
  "waiting-for-human" — it's on a timer, making no demand on anyone. The loop has a **termination
  condition** (charter-defined): wind down via `/done` once every thread is settled, every spawned worker
  closed, and the wiki/memory current.

### The ownership table (the pin-down)

| Decision | Owner | Why |
|---|---|---|
| Does event E wake role R? (trigger match) | **Reflex** | Can't LLM-gate an LLM spawn |
| Cold-spawn vs. warm-nudge vs. ignore | **Reflex** (relevance × warmth) | Cost gate; **cold bar > warm bar** |
| What's in the briefing packet | **Reflex** (charter-declared scopes) | Deterministic, cheap |
| What *else* to read (deep context) | **Cortex** | Needs judgment |
| Is the work done / blocked? | **Cortex** | Only the agent knows |
| Park warm vs. park cold | **Reflex** (latency × slot-pressure × rebrief-cost) | Scheduler call |
| Checkpoint state before cold-park | **Cortex**, signalled by reflex | Only the agent knows its state |
| Re-engage: resume vs. fresh-brief | **Reflex** (default fresh-brief) | Keeps transcripts disposable |
| Promote learnings to memory | **Cortex** proposes, gated approval | Curation / trust |
| Evict under slot pressure / timeout | **Reflex** (scheduler) | Resource management |

## 6. Three load-bearing principles

**Cold bar > warm bar.** A warm session can glance at a nudge and ignore it cheaply, so the *nudge*
trigger can be loose. A cold spawn commits a whole process + context-gather, so the *spawn* trigger must
be confident: `@mention → spawn cold`; ambient channel chatter → `nudge if already warm, never
cold-spawn`. Same event, different threshold by warmth.

**Park-warm vs. park-cold is a scheduler decision, not an agent one.** The agent should not agonize over
"am I worth keeping warm." The canvas decides from cheap signals: expected reply latency (human reply in
hours → cold; peer role answering an ask in seconds → warm), slot pressure (near the cap → evict to
cold), rebrief cost (huge/expensive context → keep warm). The agent's only lifecycle job is the
*checkpoint* when told to yield — **cooperative yield**: reflex signals "serialize and yield," cortex
writes its own state down, then terminates.

**The durable state of a parked session is the *thread*, not the transcript.** This is what keeps the §1
thesis intact. On re-engage, default to **fresh-brief from the thread + memory**, *not* `--resume` of the
old transcript — otherwise the context-bloat is smuggled back in through the swap path. So "park cold" =
the agent does one cheap turn to checkpoint *where it is up to* into the thread / a work-note, then dies;
re-engage briefs a fresh instance from that checkpoint. Consultations skip this entirely (answer-and-die;
the answer is already durable in the DM).

## 7. Read-policy lives in three different bins

"Read-policy" is not one thing — it is three decisions, in different layers:

1. **Briefing (on spawn) — reflex.** The packet the canvas assembles deterministically: *charter +
   memory **index** (not contents) + the trigger event + the anchoring thread's tail*. "Who you are,
   what you know, why you were woken, the conversation you're joining." Its *scope* is declared in the
   charter ("oracle: trigger-thread only"; "PM: all unread in my channels").
2. **Deep read (during work) — cortex.** The agent pulls more via tool calls — more channel history,
   follows a `[[link]]`, greps code, asks a peer. The charter *biases* this ("prefer reading code over
   asking") but does not determine it.
3. **Delivery timing of mid-run nudges — reflex; act-or-not — cortex.** While a session works, new
   events arrive. The canvas decides *when to deliver* (idle-immediate for preempt-class events — a
   DM-ask, a human interrupt; turn-boundary for ambient chatter), which the existing coalesced nudge
   model already does (§15). The agent decides *whether to act*. So the canvas enforces "stay focused,
   defer the firehose," the agent keeps judgment.

The mid-run rule: an instance actively working a thread **stays focused and defers other threads to its
turn boundary**, with DMs/interrupts the only preempt class — otherwise an agent can never finish a
thought in a chatty channel.

## 8. Knowledge: one link mechanism, two scopes

This axis is mostly *not new*. The `[[name]]` link already exists in the memory format. What is being
named is *scope*:

- **role-private memory** — facts in the role's `autoMemoryDirectory`, curated by/for that role.
- **shared wiki** — docs that live in the repo (`docs/`) as canvas **file cards**, that *multiple*
  roles' memories link to *and* that humans read directly.

> **Memory binds to the ROLE, not the channel.** A third scope is tempting — "what was learned in *this
> channel*" — but it is a miscut. A channel (or DM) already *has* a durable record: **its log, plus any
> wiki docs the work produced.** That record IS the channel's memory; a separate curated channel-memory
> store would only duplicate it. So a *generalisable* lesson an agent learns while acting as a role goes to
> that **role's** memory — shared across all its instances, in *any* channel (two Oracles summoned into two
> different channels share it); the record of a *particular* collaboration stays that **channel's** log +
> docs. Role memory is keyed to *identity*, a channel's memory is the *conversation itself* — orthogonal,
> not nested. (This sharpens §4's hierarchy: the per-relationship "DM history" layer is the conversation
> record, never a curated knowledge store — curation always lands in role memory.)

So the "shared knowledge base" is `docs/` made first-class-linkable, with the existing file-card
substrate doing the rendering (plus backlink computation). The hard parts are not storage:

- **Curation & trust.** If ephemeral instances auto-write durable memory, a wrong fact poisons the role
  for everyone. Split it: instances append to a cheap *pending/notes* area; promotion into curated
  memory is **gated** (a human pass, or a periodic "librarian" role). This is the project's existing
  MEMORY.md discipline applied to roles. **Do not build auto-write-back until the curation problem has
  been felt by hand.** The natural promotion *trigger* is thread-close (§6).
- **Freshness.** A codebase oracle's memory goes stale as code moves. Date facts against commits (the
  shadow-git ledger can stamp "true at commit X") and re-validate on read — the same "verify it still
  exists before recommending it" discipline the memory rules already carry.

## 9. Triggers generalize beyond messages

A channel message is just one **event class**. The trigger policy is `event → spawn?` matching over *all*
classes the canvas already observes: channel message, @mention, DM/ask, cron, file change (shadow-git is
watching), notebook recompute, build failure. The briefing packet for a reactive wake carries the
*event* instead of a thread. One declarative matcher in the charter, one reflex evaluator.

## 10. Can a role share one session across channels?

Default **no** — the tempting "one session, many channels" daemon reintroduces the exact context-bloat
roles were built to kill (one process holding the *union* of every channel's traffic). The principle:

> **A session is a unit of work, not the role's presence.** Presence is *derived* ("is ≥1 session live"),
> not a dedicated daemon. A session spans exactly the channels its work touches — usually one, sometimes
> two — and is ephemeral. Cross-channel continuity comes from **memory**, not a long-lived process.

Corollary on routing: when a new consultation arrives for a role that already has live sessions, route it
to an **idle or fresh** session, **not** onto a session mid-task on something else — otherwise you pollute
that task's context.

> **Route by work-unit, not by role.** A message joins the session doing *its* work, or spawns one; it
> never lands on whichever session happens to be live.

## 11. The synthesis

All of it lines up into one lifecycle:

- A **thread** (or DM consultation) is born when work starts.
- A **session** instantiates the role to do it — scoped to that thread, ephemeral, spanning extra
  channels only if the work does.
- The **thread accumulates the durable record**; the transcript stays disposable.
- When the thread resolves, the session dies, and anything worth keeping is **promoted to role memory**
  (curated, gated — trigger: thread-close).
- **Presence** is derived; **read-policy** in the charter keeps each instance's attention scoped to its
  thread plus its DMs.

> **thread ≈ work-unit ≈ session scope.**

## 12. Open knots (all reflex-layer, all testable without an LLM)

- **Trigger coalescing across the spawn gap.** Five messages land before the role is up → spawn **one**
  session that reads all five, not five sessions. The spawn is in-flight while more events arrive; they
  must attach to the *spawning* session, not race a second one. Same membership-snapshot race the
  CLAUDE.md notes already warn about, now on the spawn path.
- **Eviction under a full cap.** `MAX_LIVE_SESSIONS=12` across all boards. A high-priority trigger
  arrives full → who is cold-parked? LRU-by-idle is the default, but evicting mid-delicate-work is
  exactly when checkpoint quality bites.
- **Checkpoint quality = resumability.** A cold-parked task is only as resumable as its checkpoint. Bad
  checkpoint → lost or repeated work. The argument for warm-parking anything mid-delicate-state regardless
  of slot pressure.
- **Reactive loops.** A role edits a file → file-change event → wakes the same role. Loop-breaking
  (don't wake a role on events it caused) — structurally the notebook's cycle/supersede problem.
- **Per-role budget / rate-limit.** A chatty channel could re-spawn a role into a token bonfire. The
  reflex layer needs a per-role rate-limit/budget, programmatic.
- **DM proliferation.** Every {actor, role} pair is a potential DM channel — O(actors²), mostly empty,
  lazily created. Functionally fine, but the canvas must fold DMs away (Slack's DM list vs. channel list)
  or it clutters.

## 13. First consumer: the Codebase Oracle

Build the oracle (codebase-oracle handoff) **as the first instance of the role abstraction**, not in the
abstract: charter + private memory dir + presence + spawn-on-ask + gated write-back. It exercises all
three axes with one real workload — the §16 ask/reply transport is the channel side, the
`autoMemoryDirectory` insight is the memory side, and the only genuinely new primitive is
role-as-addressable-identity-with-presence. Start with **human-promoted** memory and a pending-notes
scratch area; let auto-write-back and the librarian pass come only after the curation problem has been
felt.
