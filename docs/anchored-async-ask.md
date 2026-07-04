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
| **anchored async ask** (this doc) | *agent* → human/peer | **asynchronous** (asker winds down) | doc annotation + optional task thread | the agent needs a decision it can't make alone and won't hold a process for |

The anchored async ask is the **inverse of a human comment** (agent asks the human, not the reverse) with
the **timing of a thread** (patient, pull/push) rather than the RPC (blocking). It reuses the human-comment
substrate — annotations — for the *record*, and the thread substrate for the *wake*.

## 2. The model: a doc question is an annotation; its wake is a thread

Two artifacts, each doing the one job it's already good at:

- **The question is an annotation** (`kind:"question"`) — anchored to the span it's about, authored by the
  asking session, carrying the question text and (optionally) a set of **options** to choose among. This is
  the *content home*: the question and its answer live here, on the doc, forever, next to what they concern.
  It reuses everything `doc-annotations.md` just built — anchors, the ledger, auto-reanchor, the CLI.
- **The wake is a thread** — the asker's **task thread** (§4 of `threads-as-cards.md`: a task with a
  conversation). The annotation links to it (`ev:"thread"`, the escalation bridge that already exists). The
  thread is *only the wake/membership transport*: it carries no copy of the question text (that's on the
  doc), it exists so that when an answer lands, a nudge — and, via R1, a respawn — can reach a session to
  continue. A session that is already threadless (spawned by a bare human prompt, like the review session)
  **promotes its work to a task thread at the moment it asks a blocking question**: the moment the work must
  outlive the process (because it's now waiting on async human input) is exactly the moment it earns a
  thread. Non-blocking questions (§5) need no thread — they're pure patient annotations.

Keeping content on the annotation and wake on the thread avoids message-mirroring entirely: there is one
copy of the question (the doc) and one copy of the answer (the doc), and the thread just decides *who to
wake*. It also honors "threads are the one conversation substrate" — if the ask turns into real
back-and-forth, that discussion happens in the linked thread, normally, with the anchor as its opening
context.

## 3. Lifecycle

```
  raise ─────────────► surface ─────────────► answer ─────────────► wake-back ────────► apply/close
  agent creates a      doc card badges the    human replies on the  server nudges the   woken agent reads
  kind:"question"      span "awaiting";       doc annotation (or     asker's seat on     the answer, applies
  annotation on the    threads rail shows     picks an option) —     the linked thread;  it (edits the doc),
  span; if blocking    the task thread as     awaiting → answered    dormant ⇒ R1        resolves the
  & threadless, opens  waiting:human          & wakes the thread     respawns a fresh    question, continues
  a task thread &                                                    session             or asks the next
  declares blocked:                                                                       thing
  human; winds down
```

**1. Raise.** `canvas anno ask <doc> --anchor <span> --question "…" [--options "A|B|C"] [--blocking]`
creates the question annotation authored by the session's sid. If `--blocking` and the session has no task
thread, the server **opens one** (brief = the question, seat filled by the asker, `ev:"thread"` links
annotation↔thread) and the asker posts a one-line pointer into it. The asker then declares work-intent
`blocked:human` on the thread and **winds down** (ends its turn / `session/done`) — it does not sit live.
The durable trace is the doc annotation (question + where) plus the thread (wake channel), exactly the two
things a fresh session needs to continue.

**2. Surface.** The doc card renders the question as a distinct affordance (not a plain comment) badged
**awaiting-answer**, with its options if any. The **awaiting-an-answer sweep** (`canvas anno list`, no path)
distinguishes an agent-raised *awaiting* question from a human comment and from an *answered-but-unapplied*
one. On the board, the task thread shows `waiting:human` — the derived thread state already computes this
from the `blocked:human` intent, so "an agent is waiting on my decision" appears in the threads rail's
waiting-first section with **zero new machinery**. The human is pointed at the span from either surface.

**3. Answer.** The human answers **where the question lives — on the doc**: a reply on the annotation, or,
for a multiple-choice question, selecting an option (with optional elaboration). This is the natural place
because it's where they're already reading, and it keeps the answer anchored. `canvas anno answer <doc>
<id> --choice B --text "…"` is the CLI face; the card offers option buttons + a reply box in the popover.
(The human *may* instead reply in the linked thread — a normal thread message the continuing agent reads
via inbox — but that answer isn't anchored; the doc is the recommended path.)

**4. Wake-back.** When an `answer` lands on an *awaiting, blocking* question, the server fires a **nudge to
the linked thread's asker seat**. If a session still occupies the seat, it's nudged and pulls the answer.
If the seat is **dormant** (the common case — the asker wound down), this is precisely the
**respawn-on-message** hinge from `claude-tag-lessons.md` **R1**: the server reconstitutes a fresh session
seeded from the thread history + the doc, which reads the answer (via the sweep / inbox) and continues. The
nudge carries no answer text — the woken agent pulls the annotation, the one content home.

**5. Apply & close.** The continuing agent applies the decision (edits the doc, and the surviving comments
auto-reanchor per `doc-annotations.md` §4), then **resolves its own question** — resolution belongs to the
asker here, mirroring the author-owns-resolution rule. It then finishes, or raises the next question the
same way.

## 4. Data model — small, additive extensions to the annotation ledger

Everything rides the existing append-only per-doc jsonl and its fold-at-read. `foldAnnotations` already
ignores event kinds it doesn't know ("an event kind from the future — old readers keep folding what they
know"), so an old reader tolerates the new `answer` event; and unknown *fields* on `create` are simply not
surfaced. Additive, no migration.

- **`create` gains** `kind:"note"|"question"` (default `"note"` — a plain comment, today's behavior),
  optional `options:[{label, description?}]` (a multiple-choice ask), and `blocking:true` (the asker is
  waiting; drives the thread promotion + wake-back). Author is the session sid, as ever.
- **New `answer` event:** `{ev:"answer", id, by, choice?, text, ts}` — a distinguished reply that records
  the human's selection (`choice`, an option label) and/or free text. It appends to `replies` like a reply
  *and* marks the question answered. `by` is `"human"` or a sid (a peer may answer too).
- **Derived question state** (fold/read-time, never stored — the `orphaned` principle): a `kind:"question"`
  annotation is **`awaiting`** while unresolved with no `answer`, **`answered`** once an `answer` lands (and
  not yet resolved), **`resolved`** once the asker resolves it. The read surfaces this so the sweep and card
  can badge it; the wake-back triggers on the `awaiting → answered` transition of a `blocking` question.
- **The thread link is the existing `ev:"thread"`** — no new op. Its meaning here: "this question's wake
  channel is thread T." One task thread can back many questions (each its own annotation on its own span);
  the thread is per-task, the anchor per-span.

## 5. Blocking vs. ambient — proportional machinery

Not every agent question should wake anyone. Two tiers, chosen by `--blocking`:

- **Blocking** (`--blocking`): the agent is stuck until answered. Gets a thread + `blocked:human` +
  wake-back. This is the review case (a design fork). Heavier, because a human's turn genuinely gates
  progress and the answer must reliably bring compute back.
- **Ambient** (default for a question): "flagging this for later — no rush, I'm continuing." A pure patient
  annotation, no thread, no wake. It shows in the sweep as an open question but nudges no one; whoever next
  works the doc sees it. This is the cheap, card-frugal path for "I have a doubt but it doesn't block me."

The tier is the asker's honest call about whether it's *waiting*, the same judgement the work-intent
vocabulary already asks for — and it keeps thread cards proportional to genuine blocking decisions rather
than one-per-doubt.

## 6. Surfaces

**CLI** (extends the `scripts/canvas anno` family shipped with `doc-annotations.md`):

- `canvas anno ask <path> --question "…" [--anchor-exact "…" | --anchor-file f] [--options "A|B|C"]
  [--blocking] [--from <sid>]` — create a question. `--options` splits on `|`; anchor given as a quote
  (like `create`). Prints the id, `orphaned` (a mistyped quote is an orphan at birth), and — if it promoted
  to a thread — the thread id.
- `canvas anno answer <path> <id> [--choice LABEL] [--text "…" | --stdin | --text-file f] [--by <who>]` —
  answer a question (option and/or prose; `--stdin`/`--text-file` for a long answer, no shell-escaping).
- `canvas anno list` **grows question states**: the per-file listing marks each question `awaiting` /
  `answered` / `resolved`; the board sweep counts `awaiting` (needs a human) and `answered` (needs the
  agent to apply) separately from plain open comments — so "what's blocked on me" is one glance.

**Card UI** (host chrome, `NodeView.tsx` + `src/annotations.ts`, the annotation layer already there): a
question paints distinctly from a comment (a "?" affordance on the highlight); the popover shows the
question, option buttons (if any) + a reply box, and an **awaiting/answered** badge. The card's unresolved
count already badges the card; questions awaiting a human get the loud treatment, matching the session
status-band grammar.

**Threads rail:** free. A blocking ask's task thread carries `blocked:human`, so it sorts into the
waiting-for-human section of the rail (`threads-as-cards.md` §3) with no rail-specific work.

## 7. Multiple-choice: the durable, anchored replacement for `AskUserQuestion`

The in-session `ask` block's one genuine virtue is structured options with descriptions — the human clicks
a labelled choice. This design keeps that and makes it durable: `--options "Always-wake|Tag-gated|
Hybrid"` (with per-option descriptions in the object form) renders the same clickable choice **on the doc
card**, anchored to the span the decision concerns, and records the selection as an `answer` event. The
human gets the same one-click affordance; the agent gets a decision that survives the session, sits next to
the text it changes, and is visible to the whole board. This is the feature that lets us tell agents
"never use the in-session ask block for a real decision — ask on the doc" and mean it.

## 8. Dependency & build order

The **record + pull** half works on today's substrate; the **push** half (wake-back for a dormant asker)
needs R1.

1. **Question kind + answer op + derived state** (annotation ledger + read). Small, additive. *Yields:* an
   agent can raise an anchored, awaiting question; a human answers on the doc; the state is legible in the
   sweep and card. Continuation is **pull** — the human spawns/continues a session, which sweeps `answered`
   questions and applies them. This alone kills the ephemeral/invisible/mis-placed failures of the `ask`
   block; only the "answer auto-wakes compute" convenience is missing.
2. **CLI verbs** (`ask`, `answer`, sweep states) + the collab-brief norm ("for a real decision, ask on the
   doc, not the in-session block"). Small.
3. **Card affordance** (question paint, option buttons, awaiting/answered badge). Medium, host chrome.
4. **Thread promotion + nudge-on-reply** (blocking ask opens/links a task thread; an `answer` on a blocking
   question nudges the seat). Medium — the thread link, seats, and nudge plumbing all exist; the new bit is
   the trigger on the annotation-write path.
5. **Full push wake-back = R1 (respawn-on-message for dormant seats).** Once R1 lands, step 4's nudge to a
   dormant seat reconstitutes a fresh session from the thread + doc automatically — the async loop closes
   with no human re-spawn. Until then, step 4 nudges only a still-live seat and the dormant case falls back
   to pull (1). **This is the one hard dependency; everything before it is independently useful.**

## 9. Worked example — the review's three forks, done this way

Instead of a 3-question in-session `ask` block, the reviewing session would have:

1. `canvas anno ask docs/claude-tag-lessons.md --anchor-exact "conditioning the fan-out on each member's
   work-intent" --question "Wake model for R2?" --options "Always-wake members|Keep tag-gating|Hybrid"
   --blocking` — one anchored question per fork, each on the span it concerns (the R2 paragraph, the pinning
   non-rec, the PM/Coordinator naming). The first blocking ask promotes the threadless review into a task
   thread; the rest attach to it.
2. Declares `blocked:human`, winds down. The session card settles to waiting-for-human; the doc shows three
   awaiting questions on three spans; the threads rail shows the review thread waiting.
3. The human, reading the doc, clicks an option on each span (or `canvas anno answer …`). Each answer flips
   the question to `answered` and nudges the review thread's seat.
4. A fresh session reconstitutes (R1), reads the three answers off the doc, applies them (the R2 rewrite,
   the new R-PIN, the rename), resolves the questions, commits — the same outcome as the real session, but
   the decisions and their rationale now live on the doc, the board saw them pending, and no process hung.

The net: the *only* thing that happened in the ephemeral session was compute; every decision, its options,
and its answer are durable, anchored, and public — which is the whole philosophy, finally true for the
ask-the-human case too.
