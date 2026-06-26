# Session state and work-unit / thread lifecycle

*Prepared 2026-06-26. Companion to `agent-roles.md` (the role/session/reflex-cortex model and the §5
ownership table this builds on) and `agent-to-agent-messaging.md` (channels §15, ask/reply §16 — the
transport). Scope: pin down **what state the canvas can observe and control about a session**, separate it
from **what only the agent knows**, and define the **work-unit / thread state machine** that those signals
drive — in particular the archive predicate. Motivated by a concrete want: when an agent session joins a
channel, replay only the *live* part of the backlog, not the whole history — which needs the canvas to
know which work is still live.*

---

## 1. The mistake this note exists to correct

An earlier framing said "thread ≈ work-unit ≈ session." That is true as a *scoping* statement (a session's
attention is scoped to one thread) but false as a *cardinality* statement, and the false reading hides the
hard part. Stated correctly:

> **A work-unit is durable and may have many participants. A session is one ephemeral participant.**

A piece of work can involve several agent roles plus humans, span multiple sessions over time, and pause to
wait on a human. The **thread** (or, today, the channel — we have no sub-threads yet) is the durable
*container*; sessions *participate in* it, possibly several at once, possibly in succession. So **thread
lifecycle is not session lifecycle** — it is a function *computed over the states of the participants*.
Defining that function is the whole point, and it requires first defining the per-session state cleanly.

## 2. Two layers that get conflated: process-state vs. work-intent

There are two different things one can mean by "the state of a session," and they are **orthogonal**.

**Process-state — what the canvas already observes (reflex, no LLM).** Straight from the live-session
record (`vite-fs-plugin.ts:1037`):

| State | Meaning | Observable today |
|---|---|---|
| `running` | a turn is in flight (`verb` is the progress label) | yes |
| `idle` | live, turn finished, waiting on stdin | yes |
| `exited` | process gone; **resumable** if a transcript exists | yes |

This says whether the *process is computing*. It says **nothing about whether the work is progressing,
finished, or stuck.**

**Work-intent — what only the agent knows (cortex), and the canvas cannot infer.** A session, about *its
current work-unit*, is in one of:

| Intent | Meaning |
|---|---|
| `working` | actively prosecuting the work-unit (even while `idle` between turns — it will continue when next nudged) |
| `blocked:human` | idle **because** it needs a human; will not progress without one |
| `blocked:peer` | waiting on another participant / an outstanding `ask` |
| `done` | finished its part of this work-unit; safe to park |

**The orthogonality is the whole problem.** All of `idle+working`, `idle+blocked:human`, and `idle+done`
present *identically* at the process layer — a resident process emitting nothing. The canvas cannot tell
"between turns, will continue" from "finished" from "stuck waiting for you." That ambiguity is why
`agent-roles.md` §5 assigns "is the work done / blocked?" to the cortex: **only the agent knows, so the
agent must say.** Work-intent has to be an *emitted signal*, not an inferred one.

This is the missing primitive. `agent-roles.md` names the decision but leaves it implicit; this note makes
it a first-class, structured status the session posts into its work-unit — a **typed act** (a message with
a `kind` and a structured payload the canvas understands without parsing prose), not free text.

## 3. The current boundary is fuzzy — and that is a prerequisite, not a detail

Today a session's only transitions out of `idle` are: a new prompt/nudge (→`running`), explicit
`terminate` (→`exited`), the child exiting on its own, or server restart (`killAll`). **There is no idle →
parked transition.** An idle session stays resident, holding one of the `MAX_LIVE_SESSIONS = 12` slots
(`vite-fs-plugin.ts:1409`), until one of those external events. So "parked / resumable" is effectively a
*terminate-or-restart* event, not a lifecycle the work itself drives.

Two consequences, and they converge:

1. **Thread lifecycle can't be automated without the work-intent signal.** You cannot compute "is this
   work-unit still live" from process-state alone (§2).
2. **The 12-slot cap wants the same signal.** An idle-but-`done` session is wasting a slot. A
   `done` signal lets the reflex scheduler park it cold (`terminate`, transcript retained → resumable) and
   reclaim the slot. This is `agent-roles.md` §6's *cooperative yield* — reflex says "serialize and
   yield," cortex checkpoints then dies — except here the cortex *initiates* it by declaring `done`.

So the ordering the design needs is: **make session work-intent legible first; derive thread lifecycle
from it second.** The slot-management win means the first half pays for itself even before threads exist.

## 4. The work-unit / thread state machine (the derived projection)

A thread's state is a pure function of its participants' (process-state, work-intent) pairs — computed by
reflex, cheaply, on every relevant event:

| Thread state | Condition | What the canvas does |
|---|---|---|
| **active** | any participant is `running`, or `idle + working` | show in the active list; deliver nudges normally |
| **waiting** | no participant active; ≥1 participant `blocked:human` (or a human is the pending actor); none `working` | **surface it** ("your turn") — do **not** archive |
| **dormant** | every agent participant is `done` or `exited`; none `working`; none `blocked:human` | **archive** (reversible) |

**Archive predicate = dormant = (no active agents) AND (not waiting on a human).** Both conjuncts are
required, and the second is the one the naive approach gets wrong (§5).

Quorum, not first-mover: **one** participant declaring `done` does not archive a thread — *all* agent
participants must be `done`/`exited` with none `working` or `blocked:human`. A thread with one agent done
and another still working stays **active**.

Re-activation is non-destructive and matches Discord's model: a new message or trigger event on a dormant
thread flips it back to **active** and re-engages a session (default: fresh-brief from the thread tail +
memory, per `agent-roles.md` §6 — *not* `--resume` of an old transcript). Archiving **hides**; it never
**drops** — which is the project's standing truncation doctrine (CLAUDE.md): a cap/state that hides content
must be reversible and must surface a flag, never silently lose bytes.

## 5. Why Discord's inactivity timer is the wrong import (the asymmetry)

Discord archives a thread on **raw inactivity** — time since the last message. For human-plus-agent *work*
that conflates two **opposite** attention states:

- **dormant** — nobody is working it and nobody needs to → *should* be hidden.
- **waiting** — nobody is working it *because it is the human's turn* → must be **surfaced**; hiding it
  buries the one thing that needs a person.

Both look like "no recent activity." A timer would archive the `waiting` thread — the worst outcome. This
is the concrete reason we need the `blocked:human` intent as a first-class, excluded state, and the reason
the state machine keys on *participant intent*, not on a clock. (A timer can still be a **secondary**
input — e.g. demote a long-`waiting` thread to a quieter "stale, still your turn" tier — but it must never
be the thing that decides dormant-vs-waiting.)

## 6. Humans as participants

A human has no process and emits no work-intent, so the machine must not require one from them. Two rules
keep humans first-class without tracking their liveness:

- **A human cannot hold a thread `active`.** "Active" requires a *computing* participant; a human reading
  is not work-in-progress. (Otherwise every thread a human has open stays active forever.)
- **A thread is `waiting` whenever an agent has declared `blocked:human` *or* the last act was an
  agent's question to the human with no agent left working.** That is enough to surface "your turn"
  without modelling human presence at all. Human presence (recently posted / viewing) is an optional
  *nicety* for the roster, not an input to the archive predicate.

## 7. What is observed, emitted, and derived — the summary table

| Datum | Layer | Source | Status today |
|---|---|---|---|
| `running` / `idle` / `exited` | process-state | reflex reads the live-session record | **exists** |
| `verb` (turn progress label) | process-state | reflex | **exists** |
| participant set of a thread | membership | `member:open` edges | **exists** (channels) |
| `working` / `blocked:human` / `blocked:peer` / `done` | work-intent | **cortex emits** (typed act) | **net-new** |
| thread = active / waiting / dormant | derived | reflex projection over the above | **net-new** |
| archive / un-archive | action | reflex, on dormant / on new event | **net-new** |
| onboarding replay = full / **active** / future | read-policy | reflex, seeded at `member:open` onboarding | extends the existing `full`/`future` flag (`vite-fs-plugin.ts:2234`) |

The last row is the original motivation: a third history mode, **`active`**, that replays only the
non-dormant threads of a channel — bounding the context an agent pulls on join, using thread-liveness as
the filter. It should arguably be the default *for agents* (humans can scroll; an agent pays tokens).

## 8. Open knots

- **Who emits `done` / `blocked:human`?** Three options: (a) **self** — the agent posts its own status
  (most accurate, needs prompting discipline so it actually does); (b) **inferred-with-confirmation** —
  reflex guesses from "turn ended with a question + no scheduled wakeup" and the agent can correct it;
  (c) **human/peer-issued** — someone else marks the thread blocked. Likely all three, with self as
  primary and inference as the fallback so an agent that forgets to signal doesn't pin a slot forever.
- **Stale `blocked:human`.** A thread can sit `waiting` indefinitely. Needs a demotion ladder (§5) so the
  active list isn't dominated by long-abandoned "your turn" threads — without ever silently archiving one.
- **Crash vs. done.** An `exited` participant might have *crashed* mid-work, not finished. For the archive
  predicate both read as "not active," which is safe (a new event re-engages). But the **re-engage brief**
  must distinguish them: a `done` checkpoint vs. a transcript that ends mid-thought. The cooperative-yield
  checkpoint (`agent-roles.md` §6) is what makes `exited` mean "parked," not "lost."
- **Reactive loops.** An agent's own act (a file edit, a status post) must not re-activate the thread it
  just parked and re-wake itself — the same loop-breaking the notebook scheduler already faces. Don't wake
  a participant on events it caused.
- **No sub-threads yet.** Channels are flat (confirmed: no thread/archive concept in the bus today). So the
  first container this machine ranges over is the **channel**; "archive a channel" is the v0. Sub-threads
  are a finer granularity added later — they change *what the projection ranges over*, not the projection
  logic.

## 9. Synthesis

> **Process-state is observed; work-intent is emitted; thread-state is derived.**

- The canvas already sees `running` / `idle` / `exited` — but those describe the *process*, not the *work*.
- The agent must **emit** its work-intent (`working` / `blocked:human` / `done`) because the idle process
  hides which it is. This is the one net-new primitive, and it doubles as the cooperative-yield signal that
  lets the scheduler reclaim a cap slot.
- A thread's state — **active / waiting / dormant** — is a cheap reflex projection over its participants'
  states. **Archive on dormant only**, with `waiting` (blocked on a human) explicitly excluded and
  surfaced. That asymmetry is why a raw inactivity timer (Discord's mechanism) is unsafe here, and why the
  emitted intent is a prerequisite rather than a nicety.
- The payoff that motivated it: an `active`-only onboarding replay, so a session joining a busy channel
  inherits the live work, not the whole graveyard.
