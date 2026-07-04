# Anchored async ask: an agent asks a question that lives on the doc, and is answered later

*Design, 2026-07-04. How a working session raises a question **anchored to a span of a document** and gets
it **answered asynchronously** — the human (or a peer) answering whenever, where the question lives, with
the answer reliably reaching *some* compute even though the asker's process is long gone. Builds on
`doc-annotations.md` (the anchor + ledger substrate, §7 escalation), `threads-as-cards.md` (threads, seats,
the wake model, work-intent), and `claude-tag-lessons.md` R1 (respawn-on-message for dormant seats), which
this needs for the full push loop. It replaces the in-session `AskUserQuestion` block for anything that is
a real decision rather than a throwaway confirmation.*

---

## 1. The problem this fixes

A session reviewing a doc hit three design forks it could not decide alone and needed the human to pick.
It reached for the **in-session `ask` block** — the session-card question UI — because that was the path of
least resistance. That path is wrong for a decision of any weight, in four ways:

- **Ephemeral.** The question and the human's answer live only in the session transcript. When the session
  ends, the *why* — the reasoning behind the fork, the options weighed — is gone; only the committed doc
  survives, and the doc doesn't record it.
- **Board-invisible.** No other human or agent can see that a decision is pending, or contribute.
- **Process-bound.** The asking session must stay *live* to receive the answer. It hangs — the exact
  "idle-but-actually-waiting" state the whole work-intent vocabulary exists to make legible, here made
  illegible again because the wait is buried inside one process.
- **Mis-placed.** The question is *about a specific span of a specific doc*, but it's asked in a chat
  channel disconnected from that span. The answer lands nowhere near what it's about.

The philosophy the rest of the system already follows: **sessions are ephemeral compute; the durable
substrate is the doc and the thread.** A question a human must answer is a durable record, not a live RPC.
So the fix is to make asking as easy as the `ask` block, but land the question **on the doc, anchored**,
and let the answer arrive **async**.

### What this is NOT — three adjacent things it must not be confused with

| Pattern | Direction | Timing | Home | Use it when |
|---|---|---|---|---|
| **ask/reply RPC** (`docs/agent-to-agent-messaging.md §16`) | agent → *peer* | **synchronous** (blocks ≤60s, both live) | in-memory, echoed card-only | consulting an oracle/peer that answers *now* in `file:line` |
| **human comment** (`doc-annotations.md`) | *human* → agent | patient | doc annotation | the human highlights a span and asks the agent |
| **anchored async ask** (this doc) | *agent* → human/peer | **asynchronous** (asker winds down) | doc annotation + a doc-watch seat | the agent needs a decision it can't make alone and won't hold a process for |

The anchored async ask is the **inverse of a human comment** (agent asks the human, not the reverse) with
the **timing of a thread** (patient, pull/push) rather than the RPC (blocking). It reuses the human-comment
substrate — annotations — for the *record*, and a **watched-surface seat** for the *wake* — the doc itself
becomes a wakeable surface (§2), rather than minting a thread per question.

## 2. The wake model: seats with notification levels on wakeable surfaces

The question itself is an **annotation** (`kind:"question"`) — anchored to its span, authored by the asking
session, carrying the question text and optional **options** to choose among. This is the *content home*:
question and answer live on the doc, forever, next to what they concern; it reuses everything
`doc-annotations.md` built (anchors, ledger, auto-reanchor, the CLI). That half doesn't change.

What changes is the **wake** — how compute learns there's something to do. Rather than mint a thread per
question, generalize the one primitive that already governs thread wakes: a **wakeable surface** — a thread,
and now a **doc** — carries **seats**, and each seat has a **notification level**, the Slack-channel choice:

- **`all`** — any comment activity on the surface wakes the seat's occupant.
- **`mentions`** — only activity that @-addresses the seat wakes it (a comment tagging its role; an `answer`
  to a question the seat asked, which is inherently addressed to it).
- **`paused`** — nothing auto-wakes it, but an explicit @-mention still overrides — a paused watcher can
  always be summoned by name.

A **seat** is a durable participant slot that outlives its occupant's process (`threads-as-cards.md` §5, here
generalized off the thread onto any surface): the level and binding persist; the live session is
interchangeable compute behind it. When qualifying activity lands, the server wakes the occupant — and if the
seat is **dormant** (no live process, the usual case since workers wind down), this is exactly
`claude-tag-lessons.md` **R1** *respawn-on-message*, generalized from "a thread message" to "activity on any
watched surface": the server reconstitutes a fresh session seeded from the durable record (the doc + its
annotations) to service it. So doc-wake and R1 aren't two mechanisms — they're one, sharing the
server-spawn-from-a-durable-record primitive.

**A doc's seat is filled by a "watch for comments" affordance** — right-click a doc card → *Watch for
comments* binds a **role** as a watcher at a chosen level (default `all`): a standing job owned by the *doc*,
not its creator (Tag's channel-watch, place-scoped). It can be **paused / resumed** — the seat persists,
armed or not — and **triggered explicitly by @-mention** even while paused. This is the arming policy, and it
is deliberately *not* a doc-wake special case: it's the same seat/level control a thread uses, one surface up.
(This refines `claude-tag-lessons.md` **R2**: R2's "default-wake every member" becomes the default *level*
`all`, with per-seat opt-down to `mentions`/`paused` now available — a static, self-declared preference, not
the dynamic work-intent conditioning R2 rightly warned against.)

Two things fill a doc's seats, and both fall out of this one primitive rather than needing a thread:

- **A human-armed watcher** (the affordance): a role subscribed at `all`, servicing incoming human comments
  — the human→agent direction ("someone asks on the doc; the watcher wakes and answers").
- **An ask-armed watcher** (implicit): when an agent raises a *blocking* question, it takes a seat on the doc
  at `mentions` level — so the eventual `answer` (addressed to it) wakes a continuation — then winds down.
  Asking *is* subscribing to the reply; no human setup needed. The seat is scoped to the question and
  released when it resolves.

**Thread escalation stays the exception**, not the default: a question that branches into real back-and-forth
escalates to a thread via the existing `ev:"thread"` op, with the anchor as its opening context. That
restores `doc-annotations.md` §7's original instinct — a thread is for "a comment that turns into real
discussion" — which the earlier draft's thread-per-question had overridden.

## 3. Lifecycle

```
  raise ─────────────► surface ─────────────► answer ─────────────► wake-back ────────► apply/close
  agent creates a      doc badges the span    human answers on the  the answer is         woken worker
  kind:"question"      "awaiting"; the        doc (reply, or picks  activity ADDRESSED    services the doc's
  annotation; if       annotation sweep       an option) —          to the asker's seat   whole open queue,
  blocking, takes a    lists the doc as       awaiting → answered   → wakes it; dormant   applies, resolves
  doc SEAT @mentions   having a question                            ⇒ R1 respawns a       its own question,
  & winds down         awaiting a human                             fresh worker          winds down when dry
```

**1. Raise.** `canvas anno ask <doc> --anchor <span> --question "…" [--options "A|B|C"] [--blocking]`
creates the question annotation authored by the session's sid. If `--blocking`, the asker **takes a seat on
the doc at `mentions` level** (arming the wake for its answer — §2), declares itself waiting, and **winds
down** (ends its turn / `session/done`) — no thread, no held process. The durable trace is just the doc
annotation (question + where) and the doc seat (who to wake) — exactly what a fresh worker needs to continue.

**2. Surface.** The doc card renders the question as a distinct affordance (not a plain comment) badged
**awaiting-answer**, with its options if any. The **awaiting-an-answer sweep** (`canvas anno list`, no path)
lists the doc as carrying a question *awaiting a human* — distinct from a human comment and from an
*answered-but-unapplied* one — so "what's waiting on me" is one glance at the sweep. (The waiting signal now
lives on the *doc*, where the question is, rather than on a thread marker; the sweep is the board-level
roll-up, the annotation analogue of the threads rail's waiting-first section.)

**3. Answer.** The human answers **where the question lives — on the doc**: a reply on the annotation, or,
for a multiple-choice question, selecting an option (with optional elaboration). This is the natural place —
it's where they're already reading, and it keeps the answer anchored. `canvas anno answer <doc> <id> --choice
B --text "…"` is the CLI face; the card offers option buttons + a reply box in the popover.

**4. Wake-back.** An `answer` on a question is **activity addressed to the seat that asked it**, so it clears
the `mentions` bar and wakes that seat. If a session still occupies it, it's nudged and pulls the answer; if
the seat is **dormant** (the common case — the asker wound down), R1 reconstitutes a fresh worker seeded from
the doc + its annotations. The wake carries no answer text — the woken worker pulls the annotation, the one
content home. (A human-armed watcher at `all` level wakes the same way on any incoming comment — the
human→agent direction; the two directions are the same mechanism at two levels.)

**5. Apply & close.** The woken worker services the doc's **whole open queue** (§5 — not just the one
question), applies each decision (editing the doc; surviving comments auto-reanchor per `doc-annotations.md`
§4), **resolves the questions it asked** (resolution belongs to the asker, mirroring the author-owns-
resolution rule), then **winds down when the queue is dry**. It does not stay resident waiting for the next
comment — fresh activity re-arms the seat and spawns again.

## 4. Data model — small, additive extensions to the annotation ledger

Everything rides the existing append-only per-doc jsonl and its fold-at-read. `foldAnnotations` already
ignores event kinds it doesn't know ("an event kind from the future — old readers keep folding what they
know"), so an old reader tolerates the new `answer` event; and unknown *fields* on `create` are simply not
surfaced. Additive, no migration.

- **`create` gains** `kind:"note"|"question"` (default `"note"` — a plain comment, today's behavior),
  optional `options:[{label, description?}]` (a multiple-choice ask), and `blocking:true` (the asker is
  waiting; arms the ask-armed doc seat + wake-back). Author is the session sid, as ever.
- **New `answer` event:** `{ev:"answer", id, by, choice?, text, ts}` — a distinguished reply that records
  the human's selection (`choice`, an option label) and/or free text. It appends to `replies` like a reply
  *and* marks the question answered. `by` is `"human"` or a sid (a peer may answer too).
- **Derived question state** (fold/read-time, never stored — the `orphaned` principle): a `kind:"question"`
  annotation is **`awaiting`** while unresolved with no `answer`, **`answered`** once an `answer` lands (and
  not yet resolved), **`resolved`** once the asker resolves it. The read surfaces this so the sweep and card
  can badge it; the wake-back triggers on the `awaiting → answered` transition of a `blocking` question.

**The doc-seat / watch record** (the new durable primitive, seat-shaped so it reuses `threads-as-cards.md`
§5 machinery). A doc's watchers live on a per-doc marker beside its annotation ledger (`.canvas/annotations/`
sibling, the `threads` marker convention): `{ role, level:"all"|"mentions"|"paused", state:"active"|"paused",
by, createdAt, seat? }`. A human-armed watcher (the affordance) is one such record; an ask-armed watcher is a
short-lived one the `--blocking` create writes and the `resolve` clears. The server's wake trigger reads this
marker + the derived annotation state — *not* raw appends — so it only wakes on activity that (a) qualifies
under a watcher's level and (b) isn't already being serviced (§5 single-flight). **Thread escalation stays the
existing `ev:"thread"`** — no new op, and now the exception (a question that becomes real discussion), not the
per-question default.

## 5. Proportional machinery: the ask tier, and the per-doc worker

**The tier (chosen by `--blocking`)** decides whether a question wakes anyone:

- **Blocking** (`--blocking`): the agent is stuck until answered. Arms an ask-armed doc seat (`mentions`) so
  the answer wakes a continuation. This is the review case (a design fork) — a human's turn genuinely gates
  progress and the answer must reliably bring compute back.
- **Ambient** (default for a question): "flagging this for later — no rush, I'm continuing." A pure patient
  annotation, no seat, no wake; it shows in the sweep as an open question but summons no one, and whoever
  next works the doc (or the standing watcher, if one is armed) sees it. The cheap path for "a doubt that
  doesn't block me."

The tier is the asker's honest call about whether it's *waiting* — the same judgement work-intent already
asks for — and it keeps auto-spawns proportional to genuine blocking decisions, not one-per-doubt.

**The per-doc worker (the efficiency dial the wake fires into).** A wake does not spawn one worker per
comment. The unit of work is **the doc's open-annotation queue**, serviced by **one worker per doc at a
time** (a single-flight claim on the doc). That worker **loops until the queue is dry** — re-reading after
each pass, so a comment that lands mid-pass is caught — then winds down. So a burst of five comments is one
worker, not five; a comment arriving after wind-down re-arms the seat and spawns a fresh one. Two rules keep
this honest:

- **Batch *within* a wake, don't stay resident *across* wakes.** One spawn drains the current queue and
  exits; it does not linger waiting for future comments (that would re-introduce the idle-process-holding-a-
  slot problem R1 exists to kill). Fresh spawn per wake event; loop-until-dry only spans a single burst.
- **The dial is batching granularity**, if we ever want to turn it: per-comment (max parallelism, max cost)
  ↔ **per-doc-until-dry** (the default — the doc is the natural context unit, and the sweep already reads the
  whole set) ↔ per-board (one worker drains every doc). Per-doc is the sweet spot; the others are knobs, not
  the norm.

## 6. Surfaces

**CLI** (extends the `scripts/canvas anno` family shipped with `doc-annotations.md`):

- `canvas anno ask <path> --question "…" [--anchor-exact "…" | --anchor-file f] [--options "A|B|C"]
  [--blocking] [--from <sid>]` — create a question. `--options` splits on `|`; anchor given as a quote
  (like `create`). Prints the id and `orphaned` (a mistyped quote is an orphan at birth).
- `canvas anno answer <path> <id> [--choice LABEL] [--text "…" | --stdin | --text-file f] [--by <who>]` —
  answer a question (option and/or prose; `--stdin`/`--text-file` for a long answer, no shell-escaping).
- `canvas anno watch <path> [--role R] [--level all|mentions|paused] [--by <who>]` and
  `canvas anno watch <path> --pause | --resume` — the CLI face of the "watch for comments" affordance: bind /
  re-level / pause / resume a watcher on a doc.
- `canvas anno list` **grows question + watch state**: the per-file listing marks each question `awaiting` /
  `answered` / `resolved`; the board sweep counts `awaiting` (needs a human) and `answered` (needs an agent
  to apply) separately from plain open comments, and shows which docs have an active watcher — so "what's
  waiting on me" and "what's watched" are one glance.

**Card UI** (host chrome, `NodeView.tsx` + `src/annotations.ts`, the annotation layer already there): a
question paints distinctly from a comment (a "?" affordance on the highlight); the popover shows the
question, option buttons (if any) + a reply box, and an **awaiting/answered** badge. The card's unresolved
count already badges it; questions awaiting a human get the loud treatment, matching the session status-band
grammar. The **doc card's right-click menu gains *Watch for comments*** (with the level choice and
pause/resume), and a watched doc shows a small watcher chip (role + level + active/paused dot) — the seat
roster, doc-sized.

**The waiting surface** is the annotation **sweep**, not the threads rail: since a blocking ask no longer
mints a thread, "an agent is waiting on my decision" lives on the doc and rolls up in `canvas anno list` /
the board's awaiting-questions view — the annotation analogue of the rail's waiting-first section. (A
question that *escalates* to a thread does show in the rail, as before — that's the exception path.)

## 7. Multiple-choice: the durable, anchored replacement for `AskUserQuestion`

The in-session `ask` block's one genuine virtue is structured options with descriptions — the human clicks
a labelled choice. This design keeps that and makes it durable: `--options "Always-wake|Tag-gated|
Hybrid"` (with per-option descriptions in the object form) renders the same clickable choice **on the doc
card**, anchored to the span the decision concerns, and records the selection as an `answer` event. The
human gets the same one-click affordance; the agent gets a decision that survives the session, sits next to
the text it changes, and is visible to the whole board. This is the feature that lets us tell agents
"never use the in-session ask block for a real decision — ask on the doc" and mean it.

## 8. Dependency & build order

The **record + pull** half works on today's substrate; the **push** half (a watch that auto-wakes a worker)
rides one shared primitive — *the server spawning a session seeded from a durable record* — which R1 needs
too. Build that once and both this and R1 land on it.

1. **Question kind + answer op + derived state** (annotation ledger + read). Small, additive. *Yields:* an
   agent can raise an anchored, awaiting question; a human answers on the doc; the state is legible in the
   sweep and card. Continuation is **pull** — the human spawns/continues a session, which sweeps `answered`
   questions and applies them. This alone kills the ephemeral/invisible/mis-placed failures of the `ask`
   block; only the "answer auto-wakes compute" convenience is missing.
2. **CLI verbs** (`ask`, `answer`, sweep states) + the collab-brief norm ("for a real decision, ask on the
   doc, not the in-session block"). Small.
3. **Card affordance** (question paint, option buttons, awaiting/answered badge). Medium, host chrome.
4. **Doc seats + notification levels** (the watch record beside the ledger; `watch`/`pause`/`resume` CLI +
   the right-click affordance; the derived "who to wake" read). Medium, and the reusable core — it
   generalizes `threads-as-cards.md` §5 seats off the thread onto any surface, so a thread's own wake policy
   can adopt the same levels (the R2 refinement). No auto-spawn yet: a live occupant is nudged; a dormant
   seat falls back to pull.
5. **The server-spawn-from-record primitive + the wake trigger** (single-flight per doc, loop-until-dry
   worker; the trigger reads the watch marker + derived annotation state, never raw appends). This is R1
   *respawn-on-message* generalized to "activity on any watched surface" — **the one hard dependency**, and
   the same code that closes R1's thread-seat loop. Once it lands, an answer (or any qualifying comment)
   auto-reconstitutes a per-doc worker; until then, everything above degrades cleanly to pull. Everything
   before step 5 is independently useful.

## 9. Worked example — the review's three forks, done this way

Instead of a 3-question in-session `ask` block, the reviewing session would have:

1. `canvas anno ask docs/claude-tag-lessons.md --anchor-exact "conditioning the fan-out on each member's
   work-intent" --question "Wake model for R2?" --options "Always-wake members|Keep tag-gating|Hybrid"
   --blocking` — one anchored question per fork, each on the span it concerns (the R2 paragraph, the pinning
   non-rec, the Coordinator naming). Each `--blocking` ask takes an ask-armed seat on the doc at
   `mentions` level. No thread.
2. Declares itself waiting, winds down. The session card settles to waiting-for-human; the doc shows three
   awaiting questions on three spans; the board's awaiting-questions sweep lists the doc.
3. The human, reading the doc, clicks an option on each span (or `canvas anno answer …`). Each answer is
   addressed to the seat that asked it → flips the question to `answered` and wakes that seat.
4. A per-doc worker reconstitutes (the shared spawn-from-record primitive / R1), services the doc's whole
   queue — reads the three answers, applies them (the R2 rewrite, the new R-PIN, the rename), resolves the
   questions, commits — then winds down when the queue is dry. Same outcome as the real session, but the
   decisions and their rationale now live on the doc, the board saw them pending, and no process hung.

The net: the *only* thing that happened in the ephemeral session was compute; every decision, its options,
and its answer are durable, anchored, and public — which is the whole philosophy, finally true for the
ask-the-human case too.
