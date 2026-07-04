# Doc annotations: highlight-and-comment on file-backed cards, no custom format

Notion-style inline commenting on doc cards — select a span, attach a question, get an answer in place —
**without the file ever learning about it**. The doc stays pure markdown; comments are **standoff
annotations** in a `.canvas/annotations/` sidecar ledger, anchored by quoted text (the W3C Web Annotation
`TextQuoteSelector` shape), rendered by the doc card as highlights, and served over the bus so an agent can
read "what is the human asking about, exactly" as structured tool output.

The motivating loop: Claude writes a design doc in `docs/`; the human reads it and questions come up *at
specific sentences*; today those questions detour through chat ("in §3, when you say X…") and the context
re-derivation is pure waste. The fix is to let the question live at the sentence — and since the docs are
authored and revised by agents, the *answer* can land there too.

## 1. The decision: standoff, not inline

Two ways to attach a comment to a span of a markdown file:

- **Inline markup** — CriticMarkup (`{==span==}{>>question<<}`), HTML comments, or a bespoke syntax woven
  into the file.
- **Standoff** — the file is untouched; a separate record *points into* the text.

We take standoff. Inline markup is tempting (anchors survive edits perfectly, "it's still markdown") but it
fails the things this repo actually optimizes for: it dirties the doc's git history with meta-conversation,
every agent read of the file now contains stale question/answer residue, external renderers show glyph soup,
and it *is* a custom format — just an inline one. The whole file-backed-card bet is "the file is the truth";
a doc whose bytes change when someone asks a question about it breaks that.

Standoff's classic cost — anchors drift when the doc is edited — is unusually benign here; §4.

## 2. What this is NOT

- **Not a rich-doc format.** No block IDs, no JSON doc model. `docs/*.md` stay grep-able, agent-native,
  editable in anything. (Rejected alternatives in §8.)
- **Not a chat system.** A comment is an anchor plus a short exchange. Discussion that outgrows a reply or
  two escalates to a **thread** (`threads-as-cards.md`) — we do not grow a second conversation machinery.
- **Not on the intent log.** Like thread conversation state, annotations are **off-log but durable**
  (`.canvas/annotations/`, canvas-home content per `canvas-home.md` — shadow-versioned, out of the human's
  git). Channel discipline unchanged: the log carries card arrangement; content lives in `.canvas/`.
- **Not markdown-only in principle.** Anchors are plain-text quotes, so any file card whose body is text
  (source files included) can carry them. Doc cards are the first consumer; nothing narrows to `.md`.

## 3. The anchor: quote + context, offset as a hint

Don't invent the anchor format. The W3C Web Annotation Data Model's `TextQuoteSelector` — used by
Hypothes.is and kin — is the standard answer:

```jsonc
{
  "exact":  "the renderer reads channel 1 only",   // the selected text, verbatim
  "prefix": "Channel discipline: ",                 // ~32 chars of context either side
  "suffix": ", persistence/index",
  "offset": 1834                                    // char offset into the SOURCE at creation time — a hint
}
```

Resolution at render/read time, in order:

1. **Offset fast path** — does `exact` still sit at `offset`? (Unedited doc: always.)
2. **Exact search** — find `exact` in the source; disambiguate multiple hits by `prefix`/`suffix` score.
3. **Fuzzy** — best approximate match above a threshold (edit-distance on `prefix + exact + suffix`).
4. **Orphan** — no resolution. The annotation is NOT dropped (§4).

Anchors resolve against the **markdown source**, not the rendered DOM — the source is the durable
coordinate system; the card maps a source range to DOM highlights at paint time (§6). All selectors live
in one owned module (`app/src/anchors.ts`), pure string-in/range-out, so core/interaction never learn
about annotations.

## 4. Anchor drift: the agent is in the maintenance loop

The reason standoff annotation is usually painful is that nobody re-anchors comments after an edit. Here
the docs are mostly **revised by agents, on request** — and the reviser can be *required* (brief + CLAUDE.md
convention) to read a doc's open annotations before editing it, then, as part of the same change: answer
what it can (reply), mark addressed questions **resolved**, and **re-anchor** survivors whose text moved
(rewrite the selector against the new source). The agent is part of the anchoring-maintenance loop — an
assumption Notion never gets to make.

When resolution still fails, the failure is loud, not silent: the card shows an **orphaned strip** (top of
card) listing each unresolvable annotation with its quote intact. The quote *is* the payload — "this asked
about text that has since changed" is often exactly the answer the human needs, and an agent sweeping
comments can usually re-attach or resolve an orphan from the quote alone.

## 5. Record & storage: a per-doc ledger in `.canvas/annotations/`

Follow the thread-ledger pattern (`.canvas/threads/`, `threads-as-cards.md`): one **append-only jsonl per
annotated file**, folded to current state at read. Events:

```jsonc
{"ev":"create",   "id":"anno:<uuid>", "path":"docs/foo.md", "anchor":{…}, "text":"why not X?",
 "author":"human", "ts":…}
{"ev":"reply",    "id":"anno:<uuid>", "from":"<sid or human>", "text":"because Y — see §3", "ts":…}
{"ev":"resolve",  "id":"anno:<uuid>", "by":"…", "ts":…}          // also: "reopen"
{"ev":"reanchor", "id":"anno:<uuid>", "anchor":{…}, "by":"…", "ts":…}
{"ev":"thread",   "id":"anno:<uuid>", "thread":"node:…", "ts":…}  // escalated; replies live there now
```

- **Location:** `<repo>/.canvas/annotations/<slug(path)>.jsonl` in the annotated file's **board** repo —
  annotations travel with the repo they annotate, like board records and threads. Shadow-versioned for free
  under the generalized force-add (`canvas-home.md` §4); nothing new to exclude (Gate 1 stays
  `.canvas/roots/` only).
- **Identity:** `author`/`from` is `"human"` or a session sid — same convention as thread messages. Bus
  writes attribute the same way.
- **Append-only, fold at read** — survives concurrent writers (human commenting while an agent replies)
  without locking, and the ledger doubles as provenance for the exchange.

## 6. Server & card

**Endpoints** (fs-plugin, per-board like everything else):

- `GET  /api/annotations?board=<id>&path=<path>` → folded state: `{path, annotations:[{id, anchor, text,
  author, ts, resolved, replies:[…], orphaned}]}`. `orphaned` is computed at read time by resolving each
  anchor against the current file bytes — derived, never stored (the `thread-state.js` principle).
  Omitting `path` lists all annotated files with open/orphan counts — the "what's awaiting an answer"
  sweep surface.
- `POST /api/annotations?board=<id>` `{path, op:"create"|"reply"|"resolve"|"reopen"|"reanchor", …}` →
  appends the event, nudges watchers. Server-side writes, so **no live tab is required** to comment or
  reply — an agent can answer annotations on a board nobody has open.
- Changes publish on the file's existing watch stream (the card already re-renders on doc edits; annotation
  events ride the same invalidation).

**Card UI** (the doc/file card, `NodeView.tsx` territory):

- Select text in the rendered card → floating "comment" affordance → popover input. Selection maps
  rendered-DOM → source offsets (the fiddly bit; one direction only, at creation time) to mint the selector.
- Open annotations paint as highlights; click opens the exchange (comment + replies + resolve button) in a
  margin popover. Resolved ones invisible by default, toggleable.
- Orphans in the top-of-card strip (§4). Unresolved count badges the card — same at-a-glance grammar as
  session status bands.

## 7. The agent loop

What the whole feature is *for* — three interactions, cheapest first:

1. **Sweep on request.** "Answer my comments on `docs/foo.md`" → the session GETs the annotations, and each
   arrives as `{quote, prefix, suffix, question}` — a citation better than any chat paraphrase. It replies
   per-annotation (`op:"reply"`), resolves what's settled, edits the doc where the right answer is "fix the
   doc", and re-anchors what its edit moved (§4).
2. **Revision convention.** Any agent editing an annotated doc reads open annotations first — brief-level
   rule, no new machinery.
3. **Escalation.** A comment that turns into real discussion becomes a **thread** (`ev:"thread"`): the
   annotation card-links to it and further replies happen there, with the anchor as the thread's opening
   context. Threads stay the one conversation substrate.

No new wake machinery: replies to the human render on the card (and badge it); agents are pulled in by
prompt or revision convention, not pushed — comments are patient by nature. If push is ever wanted, it's a
nudge + inbox entry, the existing §15/§16 transport, added then, not now.

## 8. Rejected alternatives

- **CriticMarkup / inline HTML comments** — rejected §1. Inline wins only for docs living outside the
  repo/canvas entirely, which isn't our situation.
- **Custom rich-doc format (Notion-style block IDs)** — stable anchors, but forfeits greppability,
  agent-native reads, external editors; abandons "the file is the truth". Not close.
- **Comments as git artifacts (PR-review style, notes refs)** — anchors by line number (brittler than
  quotes for prose), requires commit-discipline the docs flow doesn't have, and puts conversation in the
  *human's* git — exactly what `.canvas/` exists to avoid.
- **Comments as canvas nodes (sticky-per-comment + edge to the doc card)** — pollutes the board with
  conversation confetti and puts content on the intent log. The *board* isn't the unit a comment belongs
  to; the *file* is. (A future "show annotations as pins" view can derive from the ledger if wanted.)

## 9. Build order

1. **Ledger + endpoints** — `annotations.js` (thread-ledger sibling), GET/POST, fold-at-read, orphan
   detection via `anchors.ts` resolution. Agent-testable end to end with curl before any UI exists.
2. **Card render + create** — highlights, selection→selector, popover create/reply/resolve, orphan strip.
   This is the Notion moment.
3. **Conventions** — brief + CLAUDE.md additions: revisers read open annotations first; the sweep recipe.
4. **Later, if earned** — thread escalation wiring, annotation pins on the board, nudge-on-reply,
   annotations on non-doc file cards (should mostly fall out of 1–2).

Step 1 alone already yields the core value: highlight → ask → "answer my comments on the architecture doc" →
answers land where the questions live.
