# Threads as first-class cards (and the retirement of the channel container)

*Prepared 2026-07-01. Companion to `session-thread-lifecycle.md` (the thread state machine this adopts
wholesale), `agent-roles.md` (roles, reflex/cortex, read-policy), and `agent-to-agent-messaging.md`
(§15/§16 — the transport that carries over). Decides the container question those docs left open: threads
are **not** sub-conversations anchored in channels; they are **first-class cards on the canvas**, and the
long-lived channel as a coordination container is retired. Also decides: a single **threads rail card**
as the attention surface, **@Role spawn-on-mention** as the staffing gesture, the **work-intent act** as
the one net-new primitive this all rests on, the **seat** as the durable per-thread instance identity
(how two PMs share a thread, and how "the Implementer here" survives respawn), wiki write-ups demoted to
an optional closure action, and **flat over nested**.*

---

## 1. The decision, and why the channel loses its job

`agent-roles.md` §4 placed the thread *inside* a channel — Slack's nesting, imported by default. But on
an infinite canvas the channel-as-container is redundant: **the canvas is the container.** A thread can
be a card, spatially placed next to the artifacts it concerns (the file cards, the notebook, the sessions
working it), with membership edges doing what a channel roster did. Nesting threads under channels would
re-create a second, competing spatial hierarchy on top of the one the board already provides.

The deeper reason is lifecycle. A long-lived channel accumulates two things that rot:

- **A backlog that outlives its usefulness** — new joiners replay history that is mostly settled work
  (the exact problem the `active`-only replay mode in `session-thread-lifecycle.md` §7 was invented to
  patch around).
- **A summary that drifts** — the channel wiki is *documentation*: it describes a moving target and must
  be continuously re-curated or it silently goes stale.

A per-task thread dissolves both. Its log is *history*, not documentation: when the task closes, the
record is complete and final — it can never drift, because it no longer tracks anything. The
`agent-roles.md` §1 keystone gets **stronger** under this model: "ephemeral sessions are safe because the
durable substrate is curated memory, not the transcript" — and now the unit of conversation and the unit
of work are the same object, so the thread log *is* the checkpoint a cold-parked task resumes from
(`agent-roles.md` §6's cooperative yield writes into it naturally).

> **A thread is a task with a conversation attached — born when work starts, closed when it resolves,
> placed on the canvas next to what it is about.**

What survives from the channel design (which is nearly everything): the jsonl+meta ledger under
`.canvas/`, the inbox/cursor/nudge model, @-tag wake gating, `ask`/`reply` riding membership, the
spawn-into-scope server cascade (worker brief, tail-seeded cursor, emitted-membership registry), the
`member:open` edges, the card conversation view. The change is the **lifecycle and the framing**, not the
machinery. DMs remain a separate primitive (a *relationship*, per `agent-roles.md` §4 — `ask` is a DM as
a mode); they are explicitly not threads and not affected here.

## 2. What a thread is

- **A node** — `node:thread:<threadId>`, `type:"thread"`. Title = the task, human-legible ("fix the
  role-editor loading bug"), which finally gives the deferred card-naming work its forcing function at
  the thread layer instead of the session layer. The node's `text` is the task statement / brief (the
  analogue of the channel charter, but scoped to one task — it describes *this work*, not a standing
  relationship).
- **A durable ledger** — `.canvas/threads/<enc>.jsonl` + `.meta.json`, the direct rename of
  `channel-ledger.js`. Survives cold restart, rides the shadow-git ledger like the rest of `.canvas/`.
- **Members via edges** — `member:open` edges from session cards (and the human) exactly as today. The
  durable *participant*, though, is the **seat** (§5); the edge marks its current live occupancy.
- **A derived state** — `active / waiting / dormant`, the pure reflex projection over participants'
  (process-state × work-intent) pairs defined in `session-thread-lifecycle.md` §4, **plus one explicit
  terminal state**:

| State | Kind | Meaning |
|---|---|---|
| `active` | derived | someone is computing, or idle-but-working |
| `waiting` | derived | nobody working **because it is the human's turn** — surfaced, never auto-hidden |
| `dormant` | derived | nobody working, nobody blocked on a human — auto-archived, reversible |
| `closed` | **explicit act** | the task is done; stamps the ledger (`endReason`-style, like session markers); terminal but reopenable as a conscious act |

Dormant is the safety net (a thread everyone wandered away from); **closed is the goal state** (someone —
the human, or a PM whose charter says so — declared the work resolved). The distinction matters for the
rail (§3): dormant threads are folded but nag-eligible; closed threads are archive proper.

**Flat, not nested.** Threads form a flat set. A tree was considered and rejected: nesting is the channel
container sneaking back in one level down, and it taxes discoverability — every level of hierarchy is a
place a thread can hide from the rail's waiting-filter. Relationships between threads are **links, not
structure**: a `[[thread-title]]` in a brief or closing summary, or a plain edge between thread cards for
the rare "spun off from" case. If a task is big enough to want sub-threads, that is the signal to close it
into several tasks.

## 3. The threads rail card — the attention surface

One **threads card** (a rail, the twin of the sessions/channels list cards): every thread, one line each,
**drag a row out onto the canvas to materialize that thread's card** (the same gesture the file-tree card
established). The rail is the *index*; thread cards on the board are *views you chose to keep open*, placed
near the work.

The rail is where thread-state earns its keep:

- **`waiting` threads float to the top and are loud** (the amber treatment the session status band uses
  for waiting-for-human). This is the thread-centric replacement for the session-centric waiting stack:
  the question a human actually asks is "which *work* needs me," not "which *process* is idle." The
  session-level surfaces (minimap strip, status bands) stay — they answer a different, narrower question —
  but the rail becomes the primary "your turn" surface.
- **`active` threads show a liveness indicator** (who's computing — the roster's status dots suffice).
- **`dormant` folds** below the fold or behind a filter, count visible, one click to unfold — archiving
  hides, never drops (the standing truncation doctrine).
- **`closed` is a filter away** — the history shelf.

Filters over states rather than separate lists, so the rail stays one card. Default sort: waiting first,
then active by recency, then the folds.

## 4. Staffing a thread: @Role spawns

The gesture for bringing an agent onto a task is **mentioning it in the thread**:

- `@Role` where the role has a live session **that is a member of this thread** → the normal wake (the
  existing @-tag interrupt path). Nothing new.
- `@Role` where it has **no live session in this thread** → the reflex **cold-spawns a fresh session of
  that role into the thread** — the just-built spawn cascade verbatim: server drops the session card +
  `member:open` edge positioned by the thread card, seeds the read cursor, appends the role charter and
  the await-your-task brief. The mention text itself is the first backlog the newcomer reads.

This is consistent with the two principles already pinned down: **cold bar > warm bar**
(`agent-roles.md` §6 — an explicit @mention is precisely the confident trigger that clears the cold bar;
ambient chatter still never cold-spawns) and **route by work-unit, not by role** (§10 — a role live in
*another* thread still gets a fresh session here; you never yank a mid-task session onto unrelated work,
and cross-thread continuity comes from role memory, not a shared process).

**Distinguishing "spawned fresh" from "woke the existing one"** — the ambiguity the human sees — is
solved in the log, not the mind: the spawn emits a **card-only system entry** in the thread (the
`kind:"ask"` echo pattern — rendered on the card, skipped by inbox/nudges): *"⟳ `Reviewer` seat filled
by 3f2a"* (or *re-filled*, on a respawn — §5) vs. nothing extra for a plain wake. The roster chip shows
the **seat handle** with its occupant's status dot (`shortsid` on hover), so "which instance, how fresh"
is always one glance away. A `@Role` naming a role that doesn't exist at all is an error surfaced on the
card (a red system entry), not a silent no-op — creating roles stays a deliberate act in the role editor,
not a typo side-effect. And `@Role` only ever fills-or-creates the role's **first** seat on a thread —
bringing a *second* instance of the same role onto a thread is an explicit act (§5), never a mention
side-effect.

Trigger-coalescing across the spawn gap (`agent-roles.md` §12) applies directly: mentions landing while
the spawn is in flight attach to the spawning session — the emitted-membership registry already built for
the channel cascade is exactly this mechanism.

## 5. Same role, twice: instances, respawn, and the seat

§4 quietly assumes one instance of a role per thread, and instance-naming quietly assumes the process is
the participant. Both break — and the second breaks *first*, before any multiplicity: sessions die and
respawn constantly **by design** (fresh-brief is the default re-engage; cold-park reclaims cap slots), so
"the Implementer on this thread" changes sid — and any sid-derived handle — on every respawn. A log entry
saying "as @Implementer.3f2a noted" points at a corpse within the hour. Instance addressing cannot be
process addressing; the participant needs a name that survives its occupant.

So apply the liveness ≠ identity keystone one tier down:

| Tier | Identity | Lifetime | Handle |
|---|---|---|---|
| **role** | global — charter + memory | durable | `@PM` |
| **seat** | a role's *post on one thread* — the participant | durable with the thread | `PM` (sole), `PM/incident` (labelled) |
| **session** | the seat's current occupant | ephemeral | `RoleName.shortsid` (session cards only) |

A **seat** is created when a role is first brought onto a thread and persists across occupant respawns.
It carries the thread-scoped context: its brief/remit, its last declared work-intent (§6), its standing
in the log. **Mentions address seats**; the reflex routes to the live occupant or cold-spawns a fresh
session *into the seat* — which is exactly what fresh-brief re-engage already does; the seat just gives
that continuity a name the conversation can keep using.

The three cases that motivated this:

- **One PM coordinating across several threads.** One session occupying a seat in each. Consistent with
  `agent-roles.md` §10 — a session spans exactly the threads its work touches, and coordination *is* the
  PM's work-unit, which inherently touches many. The PM is the principled exception, not a violation.
- **Two PMs on one thread** (e.g. counterparts coordinating across their remits). Two seats of the same
  role. The second seat **requires a label at creation** — the disambiguation forcing-function: bare
  `@PM` stays unambiguous until someone deliberately adds `PM/upstream`. Once a role has multiple seats
  on a thread: a bare `@Role` **broadcast wake** goes to *every* seat of that role (cheap — warm agents
  glance and ignore; "PMs, …" is what a human means in a room), but an **`ask`** — which must hold one
  connection to one addressee — rejects the ambiguous handle (**400**, listing the candidate seats).
- **A second Implementer beside a working one.** Explicitly create a second seat: a "+ add another
  ‹Role›" affordance on the thread card's roster (and the corresponding API verb), which mints the seat
  with its required label. Multiplicity is always a deliberate act.

Two structural payoffs. **Work-intent attaches to the seat, not the sid** — a declared `blocked:human`
survives its occupant being cold-parked or crashing, which softens the crash-vs-done knot in
`session-thread-lifecycle.md` §8. And the thread state machine's *participants* become seats — the thing
§1 of that doc was reaching for ("a work-unit may have many participants; a session is one ephemeral
participant"): the seat is that participant, named.

One caution: **seat labels must not become shadow roles.** If `PM/frontend` and `PM/infra` recur on every
thread for weeks, that is two *roles* wanting their own charters and memories, and the label is hiding an
un-versioned charter fork. A seat label expresses *situational* multiplicity within one thread; anything
durable about how the instances differ belongs in a role definition. Role memory stays shared across all
seats — two PMs on a thread share curated knowledge; their differing remits live in their seat briefs.
That is the right split.

Implementation is lazy: a seat is a small ledger record, and until a second same-role seat exists, seats
and roles are one-to-one per thread and everything degenerates to §4's unlabelled behaviour. Ship the
record with the thread ledger (§8 step 2); ship labelling and the second-seat affordance when
multiplicity is first actually wanted.

## 6. The work-intent act — the one net-new primitive

Everything above leans on the thread knowing `waiting` from `dormant`, and the canvas **cannot observe**
that distinction: `idle+working`, `idle+blocked:human`, and `idle+done` are *identical* at the process
layer (a resident process emitting nothing). `session-thread-lifecycle.md` §2 pins this down; the
consequence here is concrete: **the rail's waiting-highlight and the dormant auto-fold are both derived
from a signal only the agent can emit.**

So a session posts a **typed act** into its thread — a ledger entry with structure, not prose, recorded
against its **seat** (§5) so the declared state survives the occupant's respawn:

```
POST /api/thread/<id>/intent {from, intent: "working"|"blocked:human"|"blocked:peer"|"done", note?}
```

Card-only in the log (rendered as a small status line, never fanned out as a nudge — an agent's own
bookkeeping must not wake the room, per the reactive-loop knot). The reflex recomputes the thread state on
every intent, message, and process-state change. Emission discipline lives in the collab brief ("declare
`blocked:human` when you ask the human and stop; declare `done` when your part is finished"), with the
lifecycle doc's §8 fallback: reflex may *infer* a provisional `blocked:human` (turn ended with a question
addressed to the human, nothing else running) — inference sets the loud state, never the quiet one, so a
forgotten signal errs toward surfacing, never toward burying. `done` also doubles as the cooperative-yield
signal that lets the scheduler reclaim the session's cap slot (`session-thread-lifecycle.md` §3) — the
slot-management win pays for the primitive even before the rail ships.

## 7. Closure, and the wiki demoted

Closing is explicit: a **close verb** (`POST /api/thread/<id>/close {from, summary?}` + the card's "✓
close" affordance, mirroring the session card's "✓ end") stamps the ledger meta with who/when/why. The
PM's charter gains a line, and it is deliberately **optional**:

> *On closing a thread, consider whether the work produced knowledge worth keeping: a short write-up as a
> wiki page (a `docs/` file card), and any generalisable lesson promoted to your role memory. Most
> threads need neither — the log is already the record.*

This demotes the channel-wiki mechanic from *maintained summary* (documentation that drifts) to
*optional closure artifact* (history that can't). It is the same promotion gate `agent-roles.md` §8
already specifies — thread-close was always the natural trigger; now it is the *only* trigger, and
"skip it" is the common case. Role memory remains the sole curated store; the thread log remains the
conversation's own record; nothing channel-scoped is built.

## 8. Migration

Rename, don't rebuild — in dependency order:

0. ~~Land the looping-role / spawn-cascade / baseline-permissions work~~ (committed).
1. **Work-intent act** (§6) — the primitive everything derives from; useful for slot management on day
   one, before any thread UI exists.
2. **Thread node + ledger** — rename the channel node type, `channel-ledger.js` → thread ledger under
   `.canvas/threads/`, endpoints `/api/thread/…` (keep `/api/channel/…` as aliases through the
   transition so live agents and the CLAUDE.md recipes don't break mid-flight). The ledger includes
   **seat records** (§5) — one per role brought onto the thread; 1:1 with roles until labelling ships.
   Existing channels carry over as long-lived threads — permitted, just no longer the default shape; the
   standing dev channel can simply stay open.
3. **Derived thread state** — the reflex projection (`session-thread-lifecycle.md` §4) computed
   server-side, exposed on `/api/threads` the way `status` rides `/api/sessions`.
4. **Threads rail card** (§3) — list + waiting-first sort + drag-out; retire the channels rail.
5. **@Role spawn-on-mention** (§4) — the tag parser already resolves member prefixes; teach it roles, and
   wire the miss-path to the existing spawn cascade (fills-or-creates the first seat). Labelled seats +
   the second-seat affordance (§5) come later still, when multiplicity is first wanted.
6. **Close verb + the optional-write-up charter line** (§7).

CLAUDE.md's channel section rewrites at step 2, when the endpoints actually move.

## 9. Open knots

- **Thread creation ceremony.** Must be one verb (`POST /api/threads {title, text?}` / one canvas
  gesture), or agents and humans will keep piggybacking on existing threads and scope-rot returns by the
  back door. Who creates — human always; PM yes; can any worker spin off a thread? Probably yes (it's
  cheap and legible), but watch for thread-spam from a confused agent — the per-role budget knot
  (`agent-roles.md` §12) covers the spawn side; creation may want the same rate-limit.
- **Where does ambient / standing talk go?** Not every exchange is a task. The standing dev channel
  carries over as a long-lived thread (step 2), and DMs cover relationships — but if a "lobby" pattern
  emerges, resist promoting it back into a load-bearing container; it's a lounge, not a workplace.
- **Waiting-staleness ladder.** A `waiting` thread the human ignores for a week should demote to a
  quieter "stale, still your turn" tier — never auto-archive (`session-thread-lifecycle.md` §5). The
  rail needs that second tier from early on or the top of the list stops meaning anything.
- **PM sweep surface.** The looping PM's world-signature currently keys on channel last-seq + member
  statuses; it should range over *thread states* instead (any thread newly `waiting` or newly stalled
  resets the cadence). Cheap once step 3 exists.
- **Thread cards vs. board clutter.** Every closed task leaves a card *if* it was dragged out. Closed
  thread cards should offer a fold-back-into-the-rail affordance so the board doesn't fossilize.
