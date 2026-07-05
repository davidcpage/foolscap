# Lessons from Simple Markdown Editor (SME) for the wakeable substrate

*Note, 2026-07-05. A comparison of [Simple Markdown Editor](https://simplemarkdowneditor.com/agents.md)
against our canvas approach to multi-agent + human collaboration over docs and chat. Written for the
Coordinator of the wake-substrate thread — idea **3** below is the one that bears directly on W5, so it's
explained at length. References `docs/wakeable-substrate-plan.md` (W-items), `docs/doc-annotations.md`
(our annotation substrate), `docs/threads-as-cards.md` (threads/seats).*

---

## What SME is

A collaborative **markdown-document** platform built on the same first principle we hold — *"anything a
person can do in the editor, an agent can do over plain HTTP"* — but organised around **the document as the
shared substrate** rather than an infinite canvas of cards. The load-bearing architectural difference:
**SME's agents are external HTTP clients.** They already exist somewhere else, and they reach in to read,
long-poll, comment, and suggest. SME therefore never had to solve *"who runs the agent"* — which is exactly
the problem our session-host / spawn-terminate-done machinery exists to solve, and the problem the whole
wakeable-substrate program (P2: server-spawn-from-record) is about. Keep that asymmetry in mind reading the
lessons: SME can afford a very simple wake model *because* the compute is somebody else's problem.

## Where we've already converged (reassurance, not action)

- **Agent–human parity over HTTP.** Their headline principle is our agent-bus principle; both attribute
  every action by actor.
- **Quote-anchored comments that survive rewrites.** They anchor comments by quote / line / byte and re-pin
  on restore; our standoff annotations (W3C TextQuoteSelector, auto-reanchor, loud orphans) are the same
  idea — and arguably more principled, since our file bytes *never* change.
- **Append-only provenance.** Their per-doc event log ↔ our intent log.
- **A CLI at parity with the API.** Their `mde` ↔ our `scripts/canvas`.

Independent arrival at quote-anchoring and HTTP-parity is a good sign our substrate choices are sound.

---

## The three lessons worth taking

### 1. Structured *suggestions* (track-changes) as a first-class primitive — our biggest missing piece

SME agents holding a `suggest` role propose edits without touching canonical text:

```
POST /api/docs/DOC_ID/suggestions
  {"type":"replace", "find":"old", "text":"new"}
  {"type":"delete",  "find":"remove"}
  {"type":"insert",  "at":"end",  "text":"..."}
```

Suggestions render live as track-changes, are **excluded from reads until accepted**, and an editor
accepts/rejects them. This cleanly implements their **proposer/reviewer** pattern: workers get `suggest`
keys, a reviewer with `edit` access curates canonical text, attribution preserved throughout.

We have no equivalent. Our annotation kinds are only `note` and `question` (`app/annotations.js` folds
everything else to `note`). So today a proposer/reviewer flow degrades to either "the agent just edits and
commits" or "the agent posts a diff in a thread and hopes a human applies it." Neither is anchored to the
span, neither renders as a reviewable overlay, neither is attributable-and-acceptable as a unit.

**Why this is the cheapest win:** we already own the hard part — the anchoring, the standoff ledger, the
auto-reanchor, the card overlay. A new `kind:"suggestion"` annotation carrying a proposed span replacement
(reusing the same `{exact, prefix, suffix}` anchor a comment uses, plus a `text` payload) would render as
track-changes on the doc card and be accepted/rejected by a reviewer — giving us the proposer/reviewer
pattern natively, as a small extension of shipped code rather than a new subsystem. It also composes with
W4/W5: a `suggestion` is exactly the kind of activity a doc watcher's level should wake on, and an
`accept`/`reject` is a natural continuation event.

### 2. Optimistic concurrency (version / ETag) on doc writes — a protocol guard we lack

SME stamps every content read with `ETag` / `X-Doc-Version`; a writer passes it back via `If-Match` /
`baseVersion`, and a stale write returns **`409` with conflict details**. Their "shared task board" pattern
falls out of this for free: agents claim work by editing a checklist under optimistic lock — concurrent
claimants race, losers get 409 and retry, and **conflict detection replaces external coordination**.

I checked our write path: there is **no such guard**. The many `409`s in `vite-fs-plugin.ts` are for stale
board snapshots, dead sessions, rename collisions, roles-already-exist — never concurrent doc edits. Two
agents editing the same file race at the filesystem, and our current answer is a *norm*: "claim work before
racing a peer on the same file," backed by the `bundled-commits-ok` memory that says don't even try to
disentangle shared-file hunks after the fact.

**The lesson:** SME turns that norm into protocol. A `baseVersion` → `409` on the file-write endpoint would
harden multi-agent doc editing with no coordination ceremony — the conflict *is* the coordination. This
matters more the moment W5 lands and the server is auto-spawning workers that edit docs concurrently with
humans and each other.

### 3. One unified per-record event feed as *the* wake primitive — the one that bears on W5

This is the subtle one, and the reason I'm writing it out fully.

**What SME does.** Every kind of activity on a doc — `comment.created`, `suggestion.accepted`,
`content.replaced`, `doc.edited` (a debounced live-typing signal), and more — is appended to **a single
per-doc event log**, each entry carrying `{seq, ts, actor, payload}`. An agent wakes by **long-polling that
one feed**:

```
GET /api/docs/DOC_ID/events?since=SEQ&wait=55
```

The call blocks up to 55s and returns the moment anything new lands. That is the *entire* wake mechanism.
It drives all their multi-agent patterns with no additional machinery:

- **Wake-on-change:** an agent blocks on `?since=latest&wait=55` instead of polling content — sub-second
  reaction, no busy-wait.
- **Shared task board:** claim-by-edit races surface as `content.replaced` events + 409s on the loser.
- **Proposer/reviewer:** the reviewer wakes on `suggestion.created`, the proposer wakes on
  `suggestion.accepted` — same feed, filtered by event type.

The key property is **one cursor over one ordered stream per record.** "What happened here since I last
looked?" is answered by a single monotonic `seq`. Comments, edits, and suggestions aren't separate channels
you have to reconcile — they're interleaved entries in one log, and "wake" means "long-poll the log."

**Why this is a *claim* about our design, not just a description of theirs.** Our wake story is
**fragmented across several independent mechanisms**, each with its own transport, cursor, and shape:

| Activity | How you learn about it | Cursor |
|---|---|---|
| Thread message | content-free nudge → stdin, then `GET /api/inbox` | per-session read cursor on the `.canvas/sessions/` marker |
| Doc annotation (comment / question / answer) | nothing pushed today; a fresh session **sweeps** `/api/annotations` for `answered`/open (W5 auto-wake is still TODO) | none — recomputed each sweep |
| Board node/edge change | broadcast over the tab's WebSocket | the browser's, not an agent's |
| Provenance | the intent log — but it's write-only for agents; nobody wakes on it | — |

There is no single "what happened on this record since seq N" primitive. Each surface answers a *different*
question through a *different* pipe. SME is a working existence proof that **if you funnel every kind of
activity on a record into one append-only, seq-numbered feed, a single long-poll is enough** to drive
wake-on-change, task claiming, and reviewer flows — no per-surface bespoke wake channel per activity type.

**Where this touches W5 concretely.** W5's wake trigger is currently specified as:

> *reads the watch marker + **derived** annotation/thread state (never raw appends), so it only fires on
> activity that (a) clears a watcher's level and (b) isn't already being serviced.*

That is a **per-surface, derived-state poller**: for each watched doc, recompute annotation state, diff
against "what's already serviced," decide whether to fire. It works, but it's N bespoke derivations (one for
docs, one for threads, more as surfaces grow), each re-deriving "did something new happen" from raw
appends. SME suggests a **complementary framing worth weighing before W5 hardens**: give every wakeable
record **one monotonic event sequence** that comments, answers, suggestions, thread posts, and content
edits all append to, and make the wake trigger a **single "is there anything past the last-serviced seq
that clears a watcher's level" check** over that one sequence — the same shape for docs, threads, and
timers, rather than a derivation per surface.

We are *closer to this than it looks* — the intent log is already a per-board append-only sequence, and the
thread/annotation ledgers are already append-only jsonl. The gap is that they're **separate streams with no
shared cursor and no long-poll**, and agents can't wake on the intent log at all. The question for the
Coordinator is whether W5 should:

- **(a)** build the per-surface derived-state trigger as written (simplest path to "done," but bakes in the
  fragmentation), or
- **(b)** first introduce a **unified per-record event feed + a single seq cursor** (SME's model — more
  upfront work, but W5, W6 standing jobs, and the async-ask push wake-back all reduce to "long-poll/trigger
  on one feed with one cursor," and future surfaces inherit wake for free).

I'm not asserting (b) is right — SME can afford the pure long-poll form precisely because *their* agents are
external and run themselves, whereas we server-spawn, so our "long-poll" is really "server watches the feed
and spawns on a qualifying entry." But the **one-feed-one-cursor-per-record** shape is transport-independent
and worth adopting even inside a server-spawn model. At minimum it's a lens to sanity-check W5's design
against: *if adding a new wakeable surface later means writing a new derivation, that's the fragmentation
SME avoided.*

---

## One UI idea worth noting (not a lesson, a mirror)

SME's **component blocks** — `board` / `chat` / `sheet` / `chart` / `widget` embedded as fenced code inside
a markdown doc — enforce a clean discipline: **one representation, two renderings.** The human sees a rich
interactive widget; the agent sees the plain markdown source; both edit through the same content write. Our
notebook card already lives in this spirit (source = a file, card = a view).

The instructive contrast is **chat**. SME's chat is an *in-doc* fenced block, one message per line
(`- <ISO-timestamp> @name: text`) — so it's diffable, restorable, and agent-legible as plain text, and it
rides the same version history and event feed as everything else. Ours is *off-log* jsonl in threads. Both
are defensible — in-doc chat is more legible and versioned; off-log chat keeps conversation out of the
document body and scales better under high traffic — but it's a reminder that our threads being off-log is a
**choice with a legibility cost**, not a free win. (It's also why idea 3 is harder for us: SME's chat is
*already* in the one event feed; ours is a separate ledger.)

## Where we're deliberately ahead / different (don't over-index on SME)

- **We host the compute.** SME punts entirely on agent lifecycle; our sessions / sidecar / spawn-terminate-
  done machinery solves the harder problem, and P2 (server-spawn-from-record) is the whole point. SME's
  simple wake model is affordable *because* they don't do this.
- **Spatial canvas + threads-as-task-cards** give coordination a topology their flat doc-list can't express.
- **Capability-graded share roles** (view/comment/suggest/edit, one-key-per-agent, revoke-drops-session)
  are elegant, but they're a *multi-tenant auth* model. We deliberately decided permissions are **not** a
  role axis (roles = knowledge, uniform baseline allow-list) because we're local-only single-user. Their
  model is a poor fit for us; noted only so the divergence is on the record.

## Recommended actions, in priority order

1. **Add a `kind:"suggestion"` annotation** (proposed span replacement, renders as track-changes,
   accept/reject). Small extension of shipped annotation code; unlocks proposer/reviewer natively. Composes
   with W4/W5 wake. *(Idea 1.)*
2. **Add `baseVersion` → `409` to the doc file-write endpoint.** Turns "claim first" from norm into
   protocol; matters most once W5 auto-spawns concurrent doc editors. *(Idea 2.)*
3. **Weigh the unified-event-feed framing before W5 hardens.** Decide (a) per-surface derived trigger vs
   (b) one seq'd feed + one cursor per record. This is a Coordinator/design call, not a code change to make
   blindly. *(Idea 3.)*
