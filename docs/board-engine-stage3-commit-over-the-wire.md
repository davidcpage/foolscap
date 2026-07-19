# Board engine stage 3 — tabs commit over the wire (offline / queue-retry UX design pass)

*Prepared 2026-07-18 on thread `node:eda2d188` ("Board engine stage 3 — offline/queue UX design
pass"), child of `node:thread:arch-review-meta`. This is the **pre-implementation design pass** that
`docs/board-engine-server-side.md` §9 stage 3 requires before stage-3 implementation staffs:
"[stage 3] changes offline semantics … and deserves its own design pass on the queue/retry UX before
staffing." Design only — no product-code changes. Companion reading: the accepted Wave-4 design
(`board-engine-server-side.md`, esp. §§3, 8, 9, 10), the 07-11 architecture review §§3.1/3.4/4,
CLAUDE.md's three-channel discipline.*

---

## 0. TL;DR

Stage 3 is **smaller than §9's framing suggests**, because stage 2 already did half of it. Human
edits are *already* server-sequenced and server-persisted (stage 2's `appendTabEvent` reassigns the
seq and folds into the live server store). What genuinely remains:

1. **Rebroadcast human commits to *other* tabs** — today only agent `/api/command` calls
   `broadcastBusDiff`; a human edit in tab A is invisible to tab B until B reloads. This is the
   headline deliverable (multi-tab live convergence for human edits).
2. **Unify the two write endpoints** — `/api/command` (server re-executes the command) and
   `/api/board/persist/event` (server trusts the tab's diff) collapse into one server commit path.
3. **Harden offline/reconnect** — the outbound side is already robust (`requestRetry` = infinite
   serialized retry = an offline queue). The **missing** piece is *inbound gap-fill*: on reconnect a
   tab never catches up the bus diffs it missed while the socket was down.
4. **Retire the tab-echo + move snapshot-writing server-side** — the stage-4 dependency.

The design keeps the posture the accepted design already commits to: **fully optimistic local echo**
(channel-1 locality → drags stay 60fps regardless of the wire), **server as single sequencer**, and
**last-writer-wins at commit** (§10, "sufficient for a local-first single-human board"). No CRDT/OT.

It also adopts the human's 07-18 ruling as a first-class principle (D7, §6.1): **card/display state has
zero effect on engine/ledger state** — membership becomes ledger-first and unconditional, the
`member:open` edge becomes a server-repainted projection, and the display-tier session-card gate on
`/join` (threads.ts:398) is deleted.

**One scoping note flagged to the Coordinator (not a blocking fork):** §9 stage 3 reads as though the
human write path does *not* yet go server-side. Stage 2's implementation choice (reassign seq in
`appendTabEvent`, board-engine.ts:250) already routed human persistence + sequencing through the
server. So stage 3's real surface is (1)–(4) above, not "move the whole human write path server-side."
This *reduces* scope; it does not make the design ambiguous. Details in §8, decision **D0**.

---

## 1. The write path today (verified baseline)

Two distinct write paths reach the same durable files and the same live server store — but only one
of them tells other tabs.

### 1.1 Agent / bus command — `POST /api/command`

`handleCommand` (routes/canvas.ts:45) → `dispatchBusCommand` (server-delivery.ts:346) →
`commitBoardCommand` (board-engine.ts:217) → `broadcastBusDiff` (server-delivery.ts:385).

- The server **re-executes the command**: `commitBoardCommand` inlines `Editor.commit` — validates
  against `defaultCommands`, runs the handler in one `store.transact(...)` → one channel-2 diff.
- Seq **minted server-side**: `seq = entry.watermark + 1`, durable `appendBoardEvent` *before* the
  watermark bump (board-engine.ts:223-231).
- **Broadcast to every socket on the board**: `broadcastBusDiff(boardId, event.diff, event.seq)` →
  `c.send({ ch: "bus", diff, seq })` (server-delivery.ts:393). No origin exclusion (an agent command
  has no originating tab).
- Response: `{ ok, board, seq, id? }` (canvas.ts:75); `id` present when the command minted a record
  (`ensureCommandId`, server-delivery.ts:310 — the tab/agent pre-mints or the server mints a node/edge
  id and echoes it).
- Tab consumption: `feeds.ts` owns the one `/api/ws` socket; a `{ch:"bus"}` frame →
  `onBusDiff` → `agentBus.ts:31` `store.applyDiffAsChange(diff, "remote")` + `persistence.adoptSeq(seq)`.
  Applied as a **`"remote"`** channel-2 change → no second IntentEvent, never popped by ⌘Z (selective
  undo, undo.ts:24).

### 1.2 Human gesture / discrete edit — `POST /api/board/persist/event`

`NodeView` opens a gesture lazily (`m.editor.beginGesture("moveNode","user")`, NodeView.tsx:263) or
issues a discrete `editor.commit({type:"setText",actor:"user",…})` (NodeView.tsx:813). Either way the
tab produces **one IntentEvent locally** (the gesture coalesces 60fps frames into one diff at
`end()`, editor.ts:89-108), applies it optimistically to its own store, and `Persistence.append` →
`RemoteEventStore.append` → `POST /api/board/persist/event` (remote-store.ts:107, `keepalive:true`,
wrapped in `requestRetry`).

- Server side: `handleBoardPersistWrite` (routes/board-persist.ts:39) → `appendTabEvent`
  (board-engine.ts:250) — **ignores the tab's provisional seq, reassigns `watermark+1`**, appends
  durably, folds the diff into the live store, returns `{ ok, seq }`.
- The tab **adopts the authoritative seq**: `onServerSeq` → `persistence.adoptSeq(seq)`
  (remote-store.ts:116-123, App.tsx:128).
- **But the server does NOT broadcast this diff.** Other tabs never learn of the human edit until they
  reload. This is the gap.

### 1.3 The two orderings, and the primitives already in place

- `IntentEvent = Command + { id, ts, seq, parent, diff }` (log.ts:23). `seq` = server-assigned
  total order; **`parent` = the `store.version` the act was based on** (causal basis, the LWW input) —
  never a sequence number (log.ts:9-28).
- `tryCommit(cmd, base)` rejects (`null`) if `store.version !== base` (editor.ts:47) — the built-in
  optimistic-concurrency check, unused so far.
- `applyDiffAsChange(diff, "remote")` (store.ts:115) is the remote-ingest primitive; idempotent when
  the records are already in the diff's target state (a re-`put` of identical values emits nothing).
- Diff inversion (added↔removed swap) already exists for undo (undo.ts) — the rollback primitive.

### 1.4 Reconnect today (the real weakness)

- **Outbound is robust.** `requestRetry` (remote-store.ts:38) retries network/5xx forever with
  exponential backoff (250ms→5s), throws only on 4xx (a malformed request never heals). The
  Persistence write chain is serialized, so order holds across an outage. This *is* an offline queue.
- **Inbound is not.** The WS auto-reconnects after 2s (`feeds.ts:146`) and re-arms watch subscriptions
  + fires `reconnectListeners` on `onopen` — but there is **no gap-fill for bus diffs missed while the
  socket was down** (`pendingBus` only buffers before the first consumer attaches, not across a drop).
  A tab that was offline while peers edited silently diverges until reload.

---

## 2. Section 1 — wire protocol for tab commits

**Decision D1: the wire message is the coalesced `IntentEvent` the tab already produces, sent at
gesture-end / commit granularity (one wire message per intent event, never per frame). The server
sequences + persists + folds + rebroadcasts; it does NOT re-execute the command for gesture writes.**

Why not "send the command and let the server re-execute" (the tidy §3-C ideal)? Because **gesture
command payloads do not carry their result.** `gesture.end({ids:[id]}, "moveNode")` carries only
`{ids}`; the final positions were applied via live atom mutation during the drag and exist *only in
the coalesced diff* (editor.ts:89-108, store.ts:146-170). The server has no way to reconstruct the
move from `{ids}`. The **diff is the source of truth** for any gesture. This is not a defect — it is
what gesture coalescing *is* — so the wire protocol carries the diff.

Consequences and how each invariant is preserved:

- **One IntentEvent per gesture, end to end.** The tab already enforces this (coalescing → one event);
  the wire message *is* that one event; the server assigns it one seq and emits one channel-2 diff.
  The invariant never has to be re-established downstream — it is carried, not recomputed.
- **Discrete commands (`setText`, `setTitle`, `addNode`) still carry full payloads**, so for those the
  server *could* re-execute. We deliberately **do not special-case them**: treating every human write
  uniformly as "sequence + persist + fold + broadcast the tab's diff" is simpler and removes the
  divergence risk of a server re-execution producing a different diff than the tab already showed the
  user. Validation of *malformed* writes moves to a cheap structural check on the event (well-formed
  diff, known record types, actor present), not a full re-run — see D4 on the reject path.
- **id minting stays client-first for optimistic echo.** For `addNode`/`addEdge` the tab pre-mints the
  record id (core already does `p.id ?? nodeId()`) and includes it in the diff, so the optimistic
  local record and the eventually-confirmed record **share identity** — nothing to reconcile.
  `ensureCommandId` (server-delivery.ts:310) stays as the server-side fallback for id-less agent
  commands and as the id-echo mechanism.

**Transport (Decision D2): outbound commits stay HTTP `POST` (unified endpoint); inbound broadcast +
catch-up ride the existing `/api/ws`.** Rationale: `requestRetry`'s serialized infinite-retry + 4xx
semantics + `keepalive`-on-close are exactly the offline-queue behaviour we want, and they are proven.
A duplex WS-only write path would have to re-implement all three. So the two endpoints of §1 **unify
into one server commit path** — call it `commitTabEvent(event, tabId)` — reached by `POST` (the
`/api/command` and `/api/board/persist/event` routes both delegate to it during the overlap; `/event`
retires in stage 4). The single path: structural-validate → `seq = watermark+1` → durable append →
fold into live store → `broadcastBusDiff` to **all sockets except the originating `tabId`**.

*(Open question OQ-T on whether outbound should instead move to WS for a single duplex channel — §7.)*

---

## 3. Section 2 — offline / disconnect semantics, queue & retry, UX

The board is **local-first**: it stays fully editable offline because every human write is applied
optimistically to the local store *before* it touches the wire (§4). Offline is therefore a
**convergence** problem (get the queued writes to the server, and get the missed writes from it), not
an availability problem.

### 3.1 Outbound queue (already mostly built)

**Decision D3: keep `requestRetry`'s serialized infinite-retry as the outbound commit queue.** While
disconnected, the human keeps editing; each coalesced event enqueues behind the serialized Persistence
chain and flushes in order on reconnect, each carrying its `parent` version. Network/5xx → retry
forever (the server is merely unreachable; the edit is valid). 4xx → the edit is *malformed* (a bug),
so it throws to `Persistence.onError` and is **rolled back** (§4), never silently retried.

One change from today: the queue must be **inspectable** so the UI can show a pending count and so
reconnect can dedupe (§3.3). Today it is an opaque promise chain. Stage 3 makes the pending events an
explicit ordered list (id + event), drained head-first as each `POST` acks.

### 3.2 Inbound catch-up (the genuinely new piece)

**Decision D4: on every (re)connect, a tab gap-fills from its last adopted seq.** The tab knows its
watermark (the highest seq it has adopted). On `onopen`-after-reconnect it requests
`GET /api/board/persist/log?board=…&since=<watermark>` (the server already has `IntentLog.since(seq)`,
log.ts) and applies each returned event's diff as `applyDiffAsChange(diff,"remote")` in seq order,
adopting each seq. This closes the silent-divergence hole in §1.4. A **gap detector** on the live
socket (an inbound `seq > watermark + 1`) triggers the same catch-up, so a dropped frame self-heals
without a full reconnect.

### 3.3 Idempotency / dedupe on replay

Two hazards, both handled by the **client-minted event `id`** (`evt:uid`, editor.ts:64):

- **Lost-ack resend.** A tab `POST`s a commit, the server commits + assigns a seq, but the ack is lost
  to a disconnect before the tab records it. On reconnect the tab would resend the same event. **Fix:
  the tab catches up *before* it flushes its outbound queue** — the caught-up range (§3.2) already
  contains that event (matched by `id`), so the tab drops it from its pending list. Order: reconnect →
  catch up inbound → reconcile pending by id → flush the remainder.
- **Server-side dedupe window (belt-and-braces).** The server remembers the last *N* committed event
  ids per board (bounded ring) and no-ops a re-seen id, returning the already-assigned seq. This covers
  a resend that races the catch-up. `N` sized to the outbound queue's realistic depth (a few hundred).

### 3.4 What the user sees (UX)

The bar for a local-first solo board is *unobtrusive but honest* — the truncation lessons apply:
**never silently drop a queued edit.**

- **Editing continues normally offline** — no modal, no lock. The canvas is fully live.
- **A quiet connection indicator.** Reuse the composer's existing `feedsConnected()` "reconnecting…"
  affordance (feeds.ts:87), promoted to a small board-level status pill: *online* (hidden / subtle) /
  *reconnecting…* / *offline — N edits pending*.
- **A pending-sync count** when the outbound queue is non-empty, so the human knows edits haven't
  landed yet. Clears as the queue drains on reconnect.
- **On reconnect:** flush + catch-up run; the pill returns to *online*; no user action required in the
  happy path.
- **Conflict / reject (rare):** a non-destructive toast ("this change couldn't be saved" / "a newer
  change replaced yours"), never a silent revert with no notice. See §4 and OQ-C.

---

## 4. Section 3 — optimistic local echo vs server confirmation

**Decision D5: fully optimistic. The tab applies every human write locally the instant it happens
(channel-1 during a drag, one coalesced `"user"` commit at gesture end); server confirmation is
asynchronous and, in the happy path, invisible.** The only thing "confirmation" does normally is (a)
adopt the authoritative seq (already wired: `adoptSeq`) and (b) let other tabs converge. Latency
posture: **zero added latency** for the acting user, at any RTT — the accepted design's hard
requirement ("channel-1 locality keeps drags at 60fps regardless of the wire", §9).

Reconcile matrix:

| Server outcome | Meaning | Tab action |
|---|---|---|
| **ack, seq assigned** (happy path) | committed, sequenced | adopt seq; drop from pending; nothing visual |
| **network / 5xx** | server unreachable | keep the optimistic edit; retry (§3.1); show *pending* |
| **4xx malformed** | the event is a bug | **roll back**: apply the inverse diff as `"remote"`, pop the matching entry from the undo stack, toast; drop from pending |
| **conflict (stale `parent`)** | a peer's commit landed first | **LWW re-apply** (default): the diff is absolute, so folding it last simply wins; no rollback. Only the deleted-target sub-case needs a policy — OQ-C |

**Rollback mechanics.** The optimistic edit lives in the local undo stack as a `"user"` diff. To roll
it back the tab applies its **inverse** (the added↔removed/updated-swap the undo manager already
computes, undo.ts) as a `"remote"` change so it is not itself undoable, and removes the now-void entry
from the undo stack (so ⌘Z doesn't try to revert something already gone). Because 4xx = a malformed
command = a code bug, rollback is an **edge/safety path, not a routine event** on a solo board.

**Undo interaction (unchanged, and correct).** Local `"user"` commits populate the per-tab undo stack;
inbound `"remote"` diffs (peer edits, catch-up, rollbacks) are *never* popped by ⌘Z (selective undo by
`ChangeSource`, undo.ts:24). This is exactly today's agent-bus behaviour — stage 3 adds no new undo
surface. A future *shared* undo is explicitly out of scope (§10 of the accepted design).

**Conflict policy = last-writer-wins at commit, no client rebase loop.** `tryCommit`/`parent` give us
the machinery to *detect* a stale base, but for a local-first single-human board the accepted design
declares LWW "sufficient" (§10). We therefore **fold the diff anyway** (LWW) rather than rejecting and
re-basing on the client — with the single exception of a diff whose target record was deleted by a
peer (would resurrect it), which is a genuine semantic fork → **OQ-C**. Keeping `parent` on the wire
means the policy is swappable later (a real multi-human mode could switch to reject-and-rebase without
a protocol change).

---

## 5. Section 4 — multi-tab convergence

- **Ordering: one sequencer, total order by seq.** Every write — human *and* agent — mints its seq
  from the single per-board `entry.watermark` (board-engine.ts:223 for `/command`, :250 for the tab
  path). Each tab folds inbound diffs in seq order. This is the whole convergence guarantee: same
  events, same order, same fold code (the server store and every tab store run core's `applyDiff`).
- **Seq handover is already solved (stage 2).** Both write paths mint from the one watermark; the tab
  adopts the server seq via `adoptSeq`; the dedicated second-writer *tripwire* is retired
  (board-engine.ts:240) because a single counter cannot produce a conflicting seq. Stage 3 changes
  nothing here except that human commits now also *broadcast* their seq to peers.
- **Own-echo vs peer-broadcast (Decision D6): exclude the originating tab from the broadcast, keyed by
  the `?tab=` id already on the WS (feeds.ts:116).** The origin has already applied its own edit
  optimistically; re-sending it the server's diff is redundant. Idempotent `applyDiffAsChange` is the
  safety net if a diff *does* reach the origin (a re-`put` of identical values is a no-op), so
  exclusion is an optimization, not a correctness dependency — which keeps agent broadcasts (no origin)
  working unchanged.
- **Gap / out-of-order handling:** a tab that receives `seq > watermark+1` (a missed frame, or frames
  reordered after a reconnect) does **not** apply out of order — it treats the gap as a trigger for the
  §3.2 `since(watermark)` catch-up, which delivers the missing events in order. On one ordered WS this
  is rare; after a reconnect it is the norm, and the same mechanism covers both.

---

## 6. Section 5 — stage-4 retirement dependencies

Each item below is scaffolding that exists **only because a human edit is a local tab commit the
server does not mediate**. Stage 3 makes every human commit an explicit server-mediated act, which is
the precondition that lets stage 4 delete them. Current locations from the code map:

| Scaffolding (still present) | Why it exists today | What stage 3 changes | Safe to delete because |
|---|---|---|---|
| **`emittedMembers` front-running** (server-snapshot.ts:110-134, TTL 60s) | a `/join`'s `member:open` edge lags ~400ms behind the debounced snapshot save, so a `/message` right after a join wouldn't see the member | the join edge is committed by the server **at commit time**, synchronously with the ledger write | there is no lag to front-run — the edge and the fact land together |
| **`announceNewMemberships` snapshot-diff onboarding** (server-delivery.ts:408) | a human alt-drag join is a local tab commit the server sees *only* by diffing member edges across a snapshot save | every human join/leave flows through the server commit path as an explicit act | the server onboards directly at commit; no snapshot diffing to infer joins |
| **`snapshotCache` read path** (board-persist.js:79,90-199) | memoized stale snapshot reads, from before the live server store | stage 1 already superseded it as a *read* path; stage 3 makes the snapshot a pure **compaction output** written by the server | nothing reads the cache for freshness; it's write-only compaction state |
| **reconciler grace heuristics** — client join-window (BUG-4b, loader.ts:968) + `reconcileBoardEngineOnSnapshot` (board-engine.ts:138) | the client window tolerates the ~400-500ms edge-before-marker gap; the engine reconciler rehydrates if a *directly-authored* snapshot save is ahead of the watermark | the join edge+marker are written together server-side (kills BUG-4b); the server becomes the **sole** snapshot writer (tab echo retired) | no edge-before-marker window exists; no external writer can put a snapshot ahead of the watermark |
| **server-owned join/leave edges** (§6 of the accepted design) — `durableMembers`/`emittedMembers` mirrors + dual onboarding paths + the **session-card join gate** (threads.ts:398) | membership fact (ledger) and view (`member:open` edge) are written by different code that must remember both (§3.4 dual-source), and a *display*-tier card gates the *engine*-tier join (§6.1) | the server writes **both** the ledger fact and the edge view at the one commit point; the edge becomes a repaint-on-reopen projection of the ledger, never a precondition (**D7**) | the mirrors + second onboarding path have no writer to reconcile against, and the edge cannot disagree with the fact because it is computed *from* it (§6.1) |
| **`pendingBusReplay` + 503-on-no-tab** | (already removed in stage 2 — listed for completeness) | — | already gone (vite-fs-plugin.ts:281; canvas.ts:70) |

**The through-line:** stage 3's single server-mediated commit path collapses the §3.4 "dual-source
state" shape that every one of these patches works around. That is precisely why the accepted design
sequences the retirements *after* stage 3 has soaked (§9 "overlap, then retire") — the scaffolding and
the new path coexist for one release, then the scaffolding deletes.

### 6.1 The display/engine tier boundary — the session-card join gate

*(Added per the 07-18 assignment addendum: a live repro + the human's ruling on the meta thread —
"card/display state must have ZERO effect on engine state.")*

The sharpest instance of the §3.4 dual-source shape in membership is a **display-tier fact gating an
engine-tier act**. Today `/join` and `/invite` refuse the operation when no session-card node exists
for the sid: `if (!sessionNode) return 400` (routes/threads.ts:398-399), because the `member:open`
edge is created **anchored to that card** (`payload: { from: sessionNode, to: threadId, type }`,
threads.ts:405). The edge — the *view* — cannot exist without the card, so the *fact* (membership)
inherits the card's lifecycle. Concretely: **closing a session card is a genuine `removeNode`, but
durable membership survives in the ledger** — so a display-tier close orphans the engine-tier edge and
a subsequent `/join` is refused for a member the ledger still holds (repro'd 07-18 by the Coordinator's
own seat). This is the BUG-5 class (a view artifact mutating a durable fact) reappearing at the
join gate.

**Decision D7: membership is ledger-first and unconditional; the `member:open` edge is a
server-derived projection with the card's lifetime, never a precondition for the fact.** Stage 3's
server-mediated commit path is exactly what makes this enforceable:

- **`/join` / `/invite` persist durable membership unconditionally** — the ledger append (the fact)
  does **not** consult, require, or gate on a session-card node. The `if (!sessionNode) return 400`
  gate is deleted; a member with no card on the board is a perfectly valid ledger member.
- **The `member:open` edge becomes a pure server-repainted projection.** When (and only when) a session
  card for the sid exists, the server derives + commits the edge anchored to it; on **card reopen**
  (a `removeNode`→later re-`addNode` of the session card) the server repaints the edge from the ledger
  fact. No card ⇒ no edge painted ⇒ *zero* effect on the membership fact. The edge's absence is a
  display absence, not a membership loss.
- **This closes the tier leak in both directions:** a close cannot drop membership (the fact is
  ledger-only), and a reopen cannot lose it (the edge repaints from the fact). The join no longer waits
  on `waitForEdgePersisted` for *membership* correctness — the ledger append is the durable truth; the
  edge is cosmetic and eventually-consistent with the card.

**Why this is a stage-4 retirement dependency.** The client-created / snapshot-inferred join-leave edge
scaffolding (`announceNewMemberships`, `emittedMembers`, the reconciler join-window, the
`durableMembers` mirror — the §6 table) all exist to reconcile a *client- or display-authored* edge
against the ledger fact. Once the edge is **only ever** a server projection of the ledger — written by
the server at the one commit point, repainted on card reopen, never authored by a tab and never gating
the fact — there is nothing left to reconcile: the edge cannot disagree with the fact because it is
computed *from* it. So D7 is the precondition that makes the "server-owned join/leave edges" row of the
§6 table (and its mirrors) safely deletable in stage 4. The general rule it instantiates —
**engine/ledger facts never gate on, and are never mutated by, display-tier node lifecycle** — is the
same rule that retires `snapshotCache`-as-read-path and the reconciler grace heuristics; the join gate
is just its most load-bearing violation today.

*(Sequencing note: deleting the `if (!sessionNode)` gate and making the edge a repaint-on-reopen
projection is a **stage-3** protocol change — it is part of routing membership through the
server-mediated path — while deleting the now-orphaned reconciliation scaffolding is the **stage-4**
cleanup that D7 unblocks.)*

---

## 7. Section 6 — decisions, open questions, and a staged sketch

### 7.1 Decisions made in this pass

- **D0 — scope refinement.** Stage 2 already server-sequences + server-persists human writes
  (`appendTabEvent`). Stage 3's real surface is: rebroadcast-to-peers, endpoint unification, inbound
  catch-up, and the tab-echo retirement. (Flagged to the Coordinator; not a blocking fork.)
- **D1 — wire message = the coalesced `IntentEvent` (carries the diff), at gesture-end/commit
  granularity.** The server sequences + folds + broadcasts the diff; it does not re-execute gesture
  commands (their payloads don't carry the result).
- **D2 — one server commit path, `POST` outbound, WS inbound.** `/api/command` and
  `/api/board/persist/event` unify; `/event` retires in stage 4. Keep `requestRetry` as the outbound
  queue.
- **D3 — outbound = serialized infinite-retry queue** (today's `requestRetry`), made inspectable for
  the pending-count UI and reconnect dedupe.
- **D4 — inbound catch-up via `since(watermark)` on every reconnect + on a live seq gap.**
- **D5 — fully optimistic echo; async confirmation; LWW at commit; roll back only on 4xx.**
- **D6 — broadcast excludes the origin tab (`?tab=`), idempotent re-apply as the safety net.**
- **D7 — membership is ledger-first and unconditional; the `member:open` edge is a server-derived,
  repaint-on-card-reopen projection, never a precondition for the fact.** Delete the
  `if (!sessionNode) return 400` join gate (threads.ts:398). Engine/ledger facts never gate on, and
  are never mutated by, display-tier node lifecycle. See §6.1. (Added per the 07-18 addendum.)

### 7.2 Open questions for human review

- **OQ-C — deleted-target conflict policy.** A queued offline edit updates a record a peer *deleted*
  while the tab was offline. Options: (a) **drop the edit + notify** (the delete is the newer intent —
  *recommended*); (b) resurrect the record (LWW-by-diff, but a delete feels more intentional than a
  move); (c) surface an interactive conflict. Recommend (a). This is the one place plain LWW isn't
  obviously right — a human call.
- **OQ-T — outbound transport.** Keep outbound commits on `POST` (reuse `requestRetry`'s serialized
  retry + `keepalive` + 4xx semantics — *recommended*) or move to a duplex WS write channel (one
  socket, but re-implement all three)? Recommend `POST`; confirm.
- **OQ-Q — queue bound + warning threshold.** How many pending edits / how long offline before we warn
  the user convergence is at risk? Recommend a *soft* warning at a threshold, **never a hard drop**
  (truncation lessons). Pick the threshold.
- **OQ-R — reject/rollback UX polish.** For a solo board 4xx rejects are rare; recommend a minimal
  toast + silent inverse. Is that enough, or do we want a visible "unsaved change" affordance? Human
  call on polish level.
- **OQ-L — client rebase loop.** Confirm LWW-only (no `tryCommit`-reject-then-client-rebase) is
  acceptable for stage 3, revisited only if a real multi-human mode arrives. The design keeps `parent`
  on the wire so the switch is a policy change, not a protocol change.

### 7.3 Staged implementation sketch (work items, gates, risks)

Proposed as **one implementation thread, cut after stages 1–2 have soaked** (per §9's "stage 3+4 are a
third thread"), sequenced internally:

- **S3-a — broadcast human commits + unify the endpoint + ledger-first membership (D7).** Make
  `appendTabEvent` call `broadcastBusDiff` (excluding the origin `tabId`); route `/api/command` and
  `/api/board/persist/event` through one `commitTabEvent`. In the same pass, make `/join`/`/invite`
  persist durable membership unconditionally (delete the `if (!sessionNode) return 400` gate,
  threads.ts:398) and turn the `member:open` edge into a server repaint-on-card-reopen projection of the
  ledger fact (§6.1). *Gate:* two tabs, a human move in A appears live in B; agent broadcasts unchanged;
  single-tab behaviour identical; **close a session card with live membership → membership survives, a
  re-`/join` is not refused, and the edge repaints on card reopen** (the 07-18 repro). Behavioural probe
  in the gate (the `dev-server-serves-stale-plugin-code` lesson). *Risk:* origin double-apply — covered
  by idempotent `applyDiffAsChange`; verify no undo-stack pollution on the origin.
- **S3-b — inbound catch-up + gap detector.** `GET …/persist/log?since=<seq>` consumer on reconnect;
  seq-gap trigger on the live socket; server dedupe ring. *Gate:* kill+restore the socket mid-edit on a
  peer; the offline tab converges with no reload and no dup. *Risk:* catch-up vs live-frame race —
  order is reconnect→catch-up→reconcile-pending→flush (D4/§3.3).
- **S3-c — offline UX.** Pending-count + connection pill from the now-inspectable queue; reject toast +
  inverse-rollback path. *Gate:* offline edit → pending shown → reconnect → converges → pill clears; a
  synthetic 4xx rolls back cleanly. *Risk:* rollback must pop the undo entry (§4).
- **S3-d — retire the tab echo; snapshot-writing + compaction move server-side.** Delete
  `RemoteEventStore.append`'s durable role / the `/event` route; the server debounces + compacts
  (moving `board-persist.js`'s schedule server-side). *Gate:* no tab writes `events.jsonl`/
  `snapshot.json`; a headless-only board still compacts. *Risk:* the snapshot-writer clock move — keep
  the watermark-409 stale-guard until the tab writer is fully gone.
  > **RULED 2026-07-19 (human, arch-review-meta seq 98): S3-d is RE-SCOPED INTO STAGE 4.** This sketch
  > item contradicted D2 (§2, §7.1 — "`/event` retires in stage 4") and §6's overlap-then-retire
  > sequencing; the ruling resolves the contradiction in D2/§6's favour. Stage 3 shipped as S3-a/b/c
  > (merged 272b9f8 + 8495eed); the retirements above land with the stage-4 scaffolding deletion, after
  > soak.
- **Stage 4 (separate work item, after soak):** delete the §6 scaffolding per that table, plus S3-d
  above (per the 2026-07-19 ruling).

**Cross-cutting risks:** (1) Vite plugin-graph reloads — the queue + dedupe ring live on the pinned
`globalThis` `fsState` like every other cross-request map, rehydrate-from-files on drift (§10 of the
accepted design). (2) The contract-test suite lags contract changes — update `test/http-contract`
in the same work item, mint seqs from the live counter, never hardcode
(`contract-tests-lag-contract-changes`). (3) `keepalive`'s 64KB budget bounds the last-write-on-close;
a gesture diff is small, so this stays fine — do not batch commits into one oversized `POST`.

---

## 8. The one scoping note, expanded (for the Coordinator)

`board-engine-server-side.md` §9 stage 3 says "tab-side `RemoteEventStore`/snapshot echo and the
per-tab debounced save retire; **multi-tab live convergence for human edits arrives as a side
effect**." Read literally it frames the human write path as still tab-authoritative. Stage 2's
*implementation* went further than §9 anticipated: `appendTabEvent` (board-engine.ts:250) already
reassigns the seq server-side and folds into the live store, so human persistence + sequencing are
*already* server-authoritative. The "side effect" (peer convergence) is therefore the **primary**
remaining work, not a freebie — it needs an explicit `broadcastBusDiff` on the tab path plus the
inbound catch-up that no code path implements yet.

This is a **scope refinement, not a fork**: the end-state in §9 is unchanged and every decision here
serves it. Surfacing it because it (a) makes stage 3 cheaper than the doc implies and (b) relocates the
real risk from "route human writes server-side" (done) to "inbound reconnect convergence" (new). No
decision here contradicts the accepted design; OQ-C/OQ-T/OQ-Q/OQ-R/OQ-L are the genuine choices left
open for human review.
