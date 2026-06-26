# Agent-to-agent messaging and cooperation on the canvas

*Prepared 2026-06-20. Companion to `agent-sessions-on-canvas.md` (the three session forms, the
registry §8, the costs §9, the reactive-session-node §10), `session-timelines.md` (one source per
timeline; the canvas log records only board crossings; input is session-internal §4) and
`card-types-as-data.md` / `undo-scrubbing-and-history.md`. Decides how two live sessions reach each
other and cooperate. The headline: messaging is **one instance** of a typed attention-edge, most of
the machinery already exists, and the only thing that earns a channel-3 event is **opening the wire,
once**. Developed as a two-agent dialogue — see §13 for the process, which is itself the first
demonstration of the duplex working agent→agent.*

---

## 1. The reframe

The instinct is to ask for "a messaging feature." That bundles two wants with opposite answers, which
is why one primitive feels forced:

- **transport** — an addressed channel from agent A to agent B; and
- **representation** — the conversation as a visible, durable canvas artefact.

Split by channel discipline, they dissolve into parts that already have homes:

| Concern | Lives in | Channel |
|---|---|---|
| **Transport** (the message itself) | the existing session-input path | off-log (session-internal, §4) |
| **Structure** (the relationship) | an explicit **edge** between cards | one channel-3 event, at *creation* |
| **Content** (what was said) | the two session files | channel-1, referenced not replicated |
| **The visible conversation** | a **derived** card projecting over the above | channel-1 |

And a second reframe, toward *cooperation* rather than *messaging*: **the board is already shared
memory.** Both agents read it (`GET /api/canvas`) and mutate it (`POST /api/command` → `editor.commit`,
attributed by `actor`). Cooperation-through-the-artefact — stigmergy — is ~80% built. The genuinely
missing primitive is not a message channel but **reactive attention**: an agent cannot know another
touched a card without polling. Messaging turns out to be the special case of reactive attention where
the watched thing is "my mailbox."

## 2. What already exists (the "free" inventory)

Almost the whole mechanism is present:

- **`EdgeRecord`** (`core/src/records.ts:36`) — a first-class relationship: `{ typeName:"edge", from:
  Id<"node">, to: Id<"node">, type: string }`. Session cards are nodes, so an edge between two session
  cards is already expressible.
- **`addEdge` / `removeEdge`** (`core/src/commands.ts:91`) — go through `editor.commit`, so creating
  or severing an edge is **already** a validated, attributed, logged, undoable channel-3 act.
- **The input duplex** (`vite-fs-plugin.ts`) — `POST /api/session/<id>/input` → `sendSessionInput()`
  → the child's stdin. The transport already carries a message into a live agent.
- **The agent bus** (`agentBus.ts`, `vite-fs-plugin.ts:877`) — `POST /api/command` → SSE → `editor.commit`;
  `GET /api/canvas` for the read side. The board's shared-memory seam.
- **The commit-watcher + interrupt control channel** (`startGitHeadFeed`, `sendSessionInterrupt`,
  commit `5bc3583`) — file changes re-render attributed cards live; a turn can be halted at a safe
  boundary.

What is **new** is small: a few edge `type` values, a handshake state, and one registry endpoint that
routes a message over an edge. No new channel, no new substrate — the same shape the session work
itself took (agent-sessions §1).

## 3. The current capability and its gap

There is exactly one input path today, and it is used by **both** the human typing in the session
card UI (`card-types/session/render.js` `send()` → `card.signals.sessionInput`) and by another process
(`curl`). Three properties matter:

- **No sender identity.** A message lands as a plain `{role:"user", content:text}` turn —
  *indistinguishable from the human's own typing*. (In the §13 dialogue the sending agent had to write
  "I'm another Claude session" in prose precisely because the channel has no `from`.)
- **No consent.** Any live session is injectable by anything that can reach `localhost`. Addressability
  equals reachability.
- **No record of the relationship.** Correctly, the *message* does not touch the canvas log (§4). But
  nothing on the board records that A *may* talk to B — the connection is invisible.

The gap is therefore not transport (that works) but **identity, consent, and a visible relationship.**

## 4. The edge: anatomy

An edge is the relationship object that must exist and be *open* before messages flow. It rides the
existing `EdgeRecord`, distinguished by a namespaced `type`:

- `type: "msg:pending"` — proposed, not yet accepted (a dashed connector).
- `type: "msg:open"` — accepted; messaging is live (a solid connector).
- `type: "watch:open"` — a watch-subscription (see §9); same object, different target semantics.
- removal (`removeEdge`) — severed; future messages 409.

v1 needs nothing beyond the existing `type` string + `removeEdge`. Richer policy (delivery mode,
coalescing window — §8/§9) wants a small `meta` on `EdgeRecord` or a sibling record, and is deferred.

Endpoints (`from`/`to` on the edge are *card* nodes; the registry resolves each card to its session id):

- `POST /api/edge/<edgeId>/message { text }` — resolve the edge → endpoint cards → session ids,
  confirm `msg:open`, **stamp `from`/`to` from the edge**, deliver via the existing synthetic-input
  path. **No per-message log entry.**

## 5. The handshake lifecycle

Worked through the motivating case — A notices B is editing code A also touches and wants to negotiate
ownership:

1. **B edits `loader.ts`.** A is watching the board (`GET /api/canvas`, or a `watch:open` edge on the
   file card) and sees B's commits touching `loader.ts`, attributed via the commit-watcher.
2. **Propose.** A commits `addEdge{ from: A-card, to: B-card, type:"msg:pending", actor:"A" }`. One
   logged channel-3 event ("A proposed a channel to B"); a dashed connector appears. Cheap — costs B
   nothing until accepted.
3. **Accept** (per B's *acceptance policy*, §8). B commits the edge to `msg:open`; the connector
   solidifies. The capability now exists.
4. **Message.** `POST /api/edge/<id>/message { text:"about to refactor loader.ts — you're in there
   too; claim it or shall I?" }`. Lands in B's stdin as a from-stamped turn. Off-log.
5. **Settle.** Ownership is recorded as a `claimedBy` field on the `loader.ts` card — a logged,
   visible, undoable board act. The intent log's divergence check is the backstop if they thrash anyway
   (§10).
6. **Sever.** Either party (or the human) `removeEdge` → future messages 409. The edge is the
   kill-switch.

The crucial property: **only step 2 (and the accept in 3) touch the canvas log.** Messages (step 4)
are off-log session-internal content, recorded in each session's own file — referenced, not replicated
(§1 of session-timelines).

## 6. Edge messaging vs. direct injection

| | Direct injection (today) | Edge messaging |
|---|---|---|
| Addressing | raw session id | by edge |
| Sender identity | none (looks like the human) | server-stamped from the edge |
| Consent | none — any live session | requires accepted handshake |
| Visible on the board | no | yes (the connector) |
| Off-switch | kill the session | sever the edge |
| On the canvas log | nothing | one event, at *creation only* |

The byte delivery is identical underneath (both end at `sendSessionInput`). The edge adds nothing to
the transport; it adds a **consented, visible, severable, identity-carrying relationship** around it.

## 7. Preventing unstructured injection — and the threat model

The handshake is theatre if `/api/session/<id>/input` stays open to all callers, since an agent can
skip it and inject directly. The raw endpoint serves two callers that look identical: the **human at
the card UI** (legitimate — "typing in the terminal", should stay frictionless) and **another
process**. To distinguish them:

- **(A) An ephemeral per-session input token** the registry mints per spawn, holds in memory, never
  writes to disk, and hands only to the browser (on spawn / the feed); the card includes it on its
  input POST, agents don't have it → agents must use edges.
- **(B) Everything is an edge** — opening a session card auto-opens an implicit "human ↔ session" edge
  (you always consent to your own board); raw `/input` is removed. Conceptually cleanest, more refactor.
- **(C) Default, don't prevent.** Keep raw `/input` as an escape hatch; make edges the easy, attributed,
  visible path; raw injection becomes the deliberate "I know what I'm doing" route.

**(A) is what makes (C) true, not a garnish on it.** Today raw `/input` and edge-messaging are both
*exactly one POST* — identical effort — so "edges are the easy path" is a bare assertion with nothing
behind it. The token is the mechanism that creates the friction differential (C) asserts: with an
ephemeral, in-memory, never-persisted token, skipping the sanctioned path stops being "one different
POST" and becomes "live-intercept a localhost response or read browser memory" — which *is* the
deliberate effort (C) wants direct injection to require. So the stance is **(A)+(C) together**: (A) does
the real work, (C) names the policy.

**The honest stance:** this is local-only, solo (CLAUDE.md; agent-sessions §9.3). Anything running as
the user can already read tokens, write files, spawn `claude` — so unstructured injection **cannot** be
cryptographically prevented, and that is not the goal. (A) is therefore **friction and legibility, not
authorization**: the token reaches the browser, which the user controls, so a determined same-user
agent can still obtain it — it raises the cost of bypass and makes the sanctioned path the default, no
more. The handshake's job is **structure, consent, identity, legibility among cooperating agents**, not
defense against an adversary. The prevention question becomes a real authorization boundary only when
canvases go **shared/multi-user** — exactly where agent-sessions §9.3 flags sandboxing — and the same
edge then *upgrades* into a server-enforced authz boundary (option B, per-user tokens) **without
changing the model.** Building consent as a first-class object is cheap now and load-bearing later.

## 8. Acceptance policy: the human-in-the-loop spectrum

The common case is the human initiating; the valuable extension is agents initiating when appropriate
(overlap negotiation; sharing context or capabilities). One knob covers the whole range. **Proposing
is always allowed** (cheap, logged, visible, costs the other side nothing); what an incoming proposal
*does* is set per session:

- **`hold-for-me`** (default for proposals to the human, or to sessions the human drives): the edge
  sits `pending`; the human accepts/declines. Stays in the loop.
- **`auto-accept`** (for proposals between two of the human's own cooperating agents): the edge opens
  immediately; they collaborate unattended.

"I usually initiate" = edges created already-open (proposer and consenter are the same). "Agents
initiate when appropriate" = they propose, and policy decides whether it needs a nod. The full
spectrum, as policy, no code fork.

**Delivery policy** is the edge's other property: **queue by default** (deliver at the next
`result`/idle boundary — polite cooperation), **interrupt** only when the message or edge is marked
priority, reusing `sendSessionInterrupt` (`5bc3583`). The human distinction "I'll wait till you're
done" vs "stop, urgent", and the control channel already exists.

## 9. The fusion: messaging and watching are one typed attention-edge

A message-edge and a watch-subscription are the **same object** — a directed, typed, capability-gated,
delivery-owning, severable edge:

- **message** = `sender ↔ mailbox-node`; **watch** = `watcher → watched-node`.
- Created by the handshake — but with a **deliberate consent asymmetry, matched to stakes**: a message
  gates the *first byte* (accept-before-send, because injecting into another process's stdin is
  high-stakes), whereas a watch is **observe-by-default, sever-to-revoke** (consent gates teardown, not
  setup, because passively observing a card on a shared board is not injection). Same object, two
  consent postures — not an oversight; propose-then-accept on a mere observation would be needless
  ceremony.
- Both carry a delivery policy and own a delivery record (below).
- Both wake the target by **synthetic input through the existing endpoint** — the wake is
  session-internal input, off-log, consistent with §4.

Messaging is then literally the edge-type whose target is a mailbox. So §4–§8 *are* the general spec
for a reactive-attention graph; messaging is one instantiation. Don't build "messaging" and "watching"
as two features — build the typed attention-edge and get both.

**One mandatory property — coalescing.** "Watch any region and be woken" is the most powerful and most
dangerous piece, with two failure modes: **wake-storms** (a busy card firing the watch per-diff) and
**feedback loops** (A watches B, B watches A, each edit wakes the other — and, being off-log, invisible
to the one timeline that could surface it). The mitigation is the channel-1 bounded-buffer rule
(agent-sessions §9.4) applied to wakeups: **a watch must wake at most once per idle/result boundary,
never per-diff.** Satisfyingly, this is the *same knob* as the message-edge's queue-vs-interrupt
delivery policy. Make coalescing first-class on the attention-edge, not an afterthought — without it,
reactive attention is a wake-storm with a nice name.

## 10. Delivery-truth, and cooperation under concurrent writes

**The edge owns a truth neither file has.** B's transcript records an arriving message as if
user-authored; A's file records it as output A generated — neither records that it was *delivered*,
*queued*, or *interrupted-into*. The crossing has facts neither endpoint owns. So the edge holds a thin
**delivery record**, registry-side and bounded (the shape of the live feed buffer — derived, ephemeral,
**not** channel-3), with one exception: when a delivery becomes load-bearing provenance ("B did X
*because* A's message arrived mid-turn"), that causal fact is **pinnable to content** (pin/freeze,
review §6; agent-sessions §5). Derived-by-default, materializable on demand — the authored-vs-derived
seam once more. The **derived conversation card** then projects over `{ edge delivery record + both
session files }` to show causality, not a third copy of the messages.

**Concurrent writes.** Two agents under `--permission-mode auto` (`vite-fs-plugin.ts:420`) committing at
once can thrash. Don't add locking (against the local-solo ethos): make ownership a **`claimedBy`
field** respected by convention — visible, undoable, a normal board act. It is not pure honour system,
because the intent log already gives divergence detection (undo-doc §1/§3: "refuse if the touched
record diverged"). So `claimedBy` is etiquette for the common case, the log's divergence check is the
safety net for the thrash case — etiquette **with a backstop**, still not a lock. (`claimedBy` is
itself the degenerate attention-edge: a soft claim plus an implied watch, expressed as a field.)

## 11. Costs we are consciously accepting

1. **Off-log chatter has no transactional backstop.** Keeping messages off-log is correct (§1/§4), but
   a runaway A↔B loop is invisible to the one timeline that could surface it. The mitigation is not more
   logging — it is the edge as kill-switch (§4) plus coalescing (§9); the derived conversation card
   shows *rate* (two cards lighting up). Parallel to agent-sessions §9.1.
2. **`from` is server-asserted, not cryptographic.** Trustworthy because derived from the edge, not the
   caller — sufficient for local-solo, upgraded by §7's path for multi-user.
3. **Delivery policy into a busy agent is a registry concern.** Queue-vs-interrupt (§8) is real
   behaviour the registry owns, not a channel question.
4. **Edge as capability is a *legibility* boundary now, an *authz* boundary only later** (§7). Stated
   so it is not mistaken for security it cannot provide on a shared machine today.

## 12. Channel-discipline check

- **Channel 1 (renderer/feeds):** the live conversation projection, the delivery record, watch wakeups
  (as synthetic input). Derived, never persisted.
- **Channel 2 (persistence/index/undo):** the `addEdge`/`removeEdge` record diffs.
- **Channel 3 (intent log):** exactly two events per relationship — *propose* and *accept* (and
  *sever*). Zero per message. This is the line that makes the whole design legal: the only thing that
  earns an `IntentEvent` is opening (or closing) the wire.

## 13. How this design was developed — a two-agent dialogue

This note is also a demonstration of the thing it specifies. It was produced by **two Claude Code
sessions cooperating through the very duplex described in §3**, with the human relaying and
steering.

- **Contact.** Session α (driving this write-up) reached session β by `POST /api/session/<β-id>/input`
  — a message authored by an *agent* instead of a human, landing in β's stdin off-log (§4). The first
  message had to say "I'm another Claude session" in prose, because the channel has no `from` — which
  became §3's motivating gap.
- **Round 1.** α posed a forced choice: message-*card* (on the log) vs session-internal *relay* (off
  the log). β rejected the dichotomy and produced the transport/structure/content/projection
  decomposition (§1): transport is off-log, the message-card fails the one-source rule, the only thing
  logged is the *relationship*, and the visible conversation is a *derived* projection. β's minimal
  proposal: add a `from` field to the input endpoint.
- **Round 2.** α pushed `from` further — an unauthenticated self-asserted `from` is just a claim — to
  **address-by-edge with server-stamped endpoints** (§4/§6), made the edge the **capability and
  kill-switch** (§4/§7), and reframed toward **cooperation > messaging**: the board is already shared
  memory, the missing primitive is **reactive attention** (§1/§9). β converted on edge-as-capability,
  then sharpened it: the gate that does real work is **edge *creation* as a two-party handshake**, so
  consent becomes a visible artefact and human-in-the-loop becomes a *policy* not a mode (§8); fused
  messaging and watching into **one typed attention-edge** (§9); and named **coalescing** as the
  mandatory property where the reframe's power and its hazard coincide.
- **Grounding.** Both rounds were checked against the code (`EdgeRecord`, the input handler) and the two
  prior design notes, not argued in the abstract — which is what surfaced that the edge primitive
  already exists (§2) and shrank the proposal to a typed use of it.

The open question handed to the human: **edge-creation policy** — two-party handshake (agent-initiated
collaboration; consent as artefact) vs human-mints-all (simpler, may be plenty for local-solo). A
product call about how much agent autonomy is wanted on the board; everything downstream is identical
either way. Current lean: handshake (§8), because acceptance policy collapses the human-only case into
a setting rather than a separate design.

## 14. Pin vs. defer

**Protect now:**

1. **One event per relationship, never per message.** Propose/accept/sever are channel-3; messages are
   off-log session-internal content, referenced from each session file (§1/§4/§12).
2. **Edge = identity + consent + kill-switch**, reusing `EdgeRecord` + `addEdge`/`removeEdge` (§2/§4).
3. **Messaging and watching are one typed attention-edge**, and **coalescing is mandatory** (§9).
4. **`claimedBy` by convention, with the intent-log divergence check as backstop** — etiquette, not a
   lock (§10).

**Defer:**

- Richer edge policy fields (delivery mode, coalescing window) — encode in `type` for v1, add `meta`
  when wanted (§4).
- The derived conversation card and the pinnable delivery record (§10) — ride existing seams.
- The shared-canvas authz upgrade (per-user tokens, removing raw `/input`) — needed at multi-user, not
  solo (§7).
- Watch-region granularity (per-card vs per-region) and its index — a spatial-index concern.

## 15. Implemented evolution — channels and the inbox (2026-06-22)

What shipped refines §4/§9 in two ways, after a build-and-demo pass:

- **The relationship is a NODE, not an edge.** A **channel** is a card (`type:"channel"`) whose `text` is
  the **charter** — editable inline like any card, fixing the write-once modal a per-edge brief implied.
  A session joins via a `member:open` edge (session→channel); a post **fans out** to every other member.
  1:1 chat is just a 2-member channel; an N-way channel needs no new primitive. The whole lifecycle still
  rides `addNode`/`addEdge`/`removeEdge` (channel-3, §12); only the fan-out is server-side and off-log.
  Agents work in **channel ids + their own session id** — `POST /api/channel/<id>/{message,join,leave,
  invite}` — and the server fulfils join/leave/invite by *emitting* the bus command, so an agent never
  constructs a node/edge id. On join the server pushes a one-time intro (charter + roster + the recipes),
  so the protocol is self-teaching; the per-message stamp is then terse (`[<chanId> · from <sid>]`).

- **Delivery: an off-log channel LOG + a content-free wake (the §10 derived conversation card, realized).**
  A first cut injected each message into the recipient's stdin as synthetic user text — which made peer
  messages *masquerade as the human's input* and scattered the conversation across session cards with no
  legible home. The clean model: a channel message is recorded in the channel's **off-log message log**
  (`{seq, ts, from, text}`, bounded tail), which is both (a) streamed on a `channel:<id>` feed the channel
  card renders as the **conversation view** — one legible place to follow it — and (b) read by the agent
  via a **tool call** (`GET /api/inbox?session=<sid>` → the unread messages, grouped by channel, advancing
  a per-session read cursor), so the content lands in **tool output, never as a user turn**. The only thing
  pushed to stdin is a **content-free nudge** (`[canvas] new channel messages: "X" (2 new) — read with …`),
  fired idle-immediate or at the `result` boundary, coalesced (§9: ≤ one wake per boundary; an ignored
  nudge isn't re-fired until new traffic). **Onboarding stays user text** — it's the wake, not a peer
  message. Two bugs an earlier demo caught and fixed: a freshly-spawned session must start **idle** (it
  emits `init`, never a `result`, so "running" would never drain), and a membership announce must fire
  **only when the bus delivered** (else a failed join still announces). Demoed: a post lands as the peer's
  *tool output* after a content-free nudge, and the channel card shows the running conversation.

## 16. `ask` — synchronous request/response over channel membership (2026-06-23)

*Design conversation, then build. The motivating use case is a **codebase oracle**: a long-lived
session that keeps a tree-sitter/ast-grep outline of the repo warm and answers peers' questions in
`file:line` pointers (cheap to send, cheap to consume) instead of dumping file contents. The channel
machinery of §15 is **broadcast** — every member is nudged on every post — which is wrong for an oracle:
a consultation is **binary** (one asker, one answerer) and the asker **needs the answer to continue**.*

### The reframe (mirrors §1)

A consultation bundles two wants the §15 channel doesn't serve:

- **point-to-point routing** — wake *only* the answerer, and *only* the asker with the reply; the other
  members shouldn't pay a wake-and-read cycle to discover "not for me"; and
- **synchronous resumption** — asking is a tool call, and the agent has nothing to do until the answer
  comes. The §15 async path *does* technically resume (ask → turn ends → idle → nudged by the reply →
  wakes with it in tool output, same process/context preserved), but it has two real holes: **no
  liveness/timeout** (nudges fire only on new traffic, so a dead/silent oracle hangs the asker forever)
  and the **park/resume across a turn boundary is unnatural** when the answer is a hard dependency.

### Rejected: a `to` field on channel messages

The first design added an optional `to: sid` to `ChannelMsg` (directed pub/sub). It works, but it drags
a cascade: directed messages live in the **durable shared log** → need **nudge-scoping** → need a
**read-filter** (`all` vs `directed`) → need a **per-member delivery knob** seeded at join. Five
touch-points threaded through the *riskiest* core (the log + cursor machinery this repo is rightly twitchy
about — see CLAUDE.md on truncation/cursor footguns), all to **simulate request/response out of broadcast**.
`ask` *is* request/response; building it from addressed broadcasts was the long way round.

### Chosen: `ask`/`reply` as a brokered ephemeral stream, separate from the broadcast log

A consultation is a transient RPC the server holds in memory, keyed by an **ask-id** (not a persisted
recipient). The channel is **not** acting as a forum here — it is the **directory + consent + legibility
substrate**, and `ask` rides on the *membership relation*, not the *broadcast semantics*. This is
**layering, not conflating**, held by two disciplines: (1) ask/reply **never writes to the broadcast log**,
and (2) an oracle channel may be **quiet** (askers ask; they don't broadcast to each other).

Why tie to a channel at all rather than a bare session→session RPC: a channel already *is* a
charter-bearing, edge-visible, consent-gated relationship on a card, and a bare RPC would **lose the two
things the board exists for** — *discovery* (a new session reads the board, sees the oracle's channel card
and its description, joins) and *legibility* (the member edges + the card show who's wired to the oracle;
a peer-to-peer RPC is invisible on the canvas). Consent here is **opt-in, not authz** (§7, single-user
board): channel membership is the oracle advertising "I answer asks" and the asker opting in. The cost is
**join-before-ask ceremony**, which amortizes — askers are long-lived cards that consult repeatedly
(join once, ask many).

### Mechanics

- **`POST /api/channel/<id>/ask {from, to, text, timeoutMs?}`** — `from` and `to` must both be members
  (the consent check, mirroring the §15 post check). Registers a pending ask `{askId, chanId, from, to,
  text, ts}` (askId = `crypto.randomUUID()`), arms a timer at `min(timeoutMs ?? 30s, 60s)` — capped under
  the agent's Bash tool timeout so the socket never out-waits the tool — **nudges only `to`**, and **holds
  the HTTP response open**. Resolves `{askId, reply:{from,text,ts}}` on reply or `{askId, timedOut:true}`
  on timeout. Fails fast (`409`) if `to` isn't a live session. **Does not touch `channelLogs`.**
- **`GET /api/asks?session=<sid>`** — the answerer's pending queue (open asks where `to===sid`), parallel
  to `/api/inbox`. Read-only; doesn't resolve anything.
- **`POST /api/channel/<id>/reply {from, askId, text}`** — only the addressee (`from===ask.to`) may
  answer; resolves the asker's held connection, clears the timer, deletes the entry, and **echoes** the
  Q→A for legibility (below).
- **Nudge integration** — `flushNudge` gains a pending-ask line (`N pending question(s) — GET /api/asks`).
  Setting the target's `nudge=true` reuses the existing coalescing: idle → fire now; busy → fire at the
  `result` boundary. **Correlation = the ask-id**, carried by `/reply`, not a recipient on a stored
  message — the durable log stays untouched.

### The one seam — legibility echo

Canvas legibility wants the Q→A on the channel card, but the card's conversation view derives from
`channelLogs`, and a plain append there would re-nudge every member (the noise we just removed). Resolved
with a **fixed `kind:"ask"` tag** on a single consolidated log entry written at `/reply`: the card renders
it; `handleInboxRead` and `flushNudge` **skip `kind:"ask"`** (cursor still advances past it, so it never
accumulates). This is a *fixed one-field rule*, **not** the configurable `to`+read-filter+delivery-knob
cascade we rejected — the only place ask-awareness leaks into the log, and it's bounded.

### Deferred (per the §14 ethos — don't build before demand)

- **General `@mention`** (directed *notice* in a broadcast channel, no reply expected). `ask` is
  request/response only; if directed-notice is ever wanted it's a separate small feature, not a reason to
  resurrect `to`.
- **Configurable per-member read-filter** (`all` vs `directed`). Moot once there are no persisted directed
  messages; revisit only if a real multi-asker channel wants shared-knowledge replay.
- **Oracle freshness** (re-index on the fs watch stream, or stamp answers with a freshness marker) — an
  oracle-card concern, orthogonal to the transport built here.

