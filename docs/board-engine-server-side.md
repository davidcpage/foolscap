# Board engine server-side — the Wave-4 design

*Prepared 2026-07-12 on thread `node:thread:snapshot-event-fold` ("C — fold event-log into server
reads"). Resolves the central fork left open by `architecture-review-2026-07-11.md` §3.1/§8 (Wave 4)
and this thread's brief: read-time fold of `events.jsonl` vs a server-maintained materialized view
vs hosting the board engine in the server process. One decision, one doc. Companion reading:
`tldraw-architecture-and-feasibility.md` (the three channels), `threads-as-cards.md` (ledger vs
view), the BUG-5 membership contract (`app/test/membership-durable.test.mjs`).*

---

## 1. The decision

**Host the board engine in the server process, staged so that stage 1 *is* the materialized
fold.** The server instantiates core's `Store` per board, hydrates it exactly the way a tab does
(snapshot + event-tail fold), keeps it current as events append, and serves every server-side read
from it. Then command authority moves server-side: `/api/command` commits into a server `Editor`,
the durable event append happens at commit time in the server, and tabs receive the resulting
*diff* over the existing WS. Finally (separable, later) human gestures commit over the same wire
and the tab-side Persistence is retired.

The pure read-time fold and the standalone materialized view are **rejected as terminal designs**
— not because they're wrong about reads, but because the split-brain is equally a *write* problem,
and both leave it in place (§3). The fold is not wasted, though: it is literally the hydrate step
of the hosted engine (`core/src/persist.ts:139-166` already implements it), so the staging below
never builds anything the end-state deletes. This satisfies the review's §8 rule — "don't invest
in split-brain symptom patches Wave 4 deletes" — by making the interim step *be* the first Wave-4
increment.

Why this is now cheap enough to be the right call rather than the ambitious one:

- **core/ is verified server-runnable.** Zero DOM/browser coupling anywhere in the package; signia
  is touched only by `store.ts` and `subscribable.ts`; the whole test suite already runs under
  `node --test` with no DOM shim; `persist.ts:186` even carries the one Node accommodation
  (`unref?.()` on the debounce timer) put there for exactly a Node host.
- **The concurrency primitives already exist, unused.** `store._version` + `IntentEvent.parent`
  (optimistic base, `core/src/log.ts:14`), `Editor.tryCommit(cmd, base)` (`core/src/editor.ts:47`),
  `ChangeSource:"remote"` and `store.applyDiffAsChange(diff, "remote")` (`core/src/store.ts:115`)
  were designed for ingesting peer diffs. Hosting the engine server-side is the design they were
  waiting for.
- **Wave 2 removed the last schema obstacle.** The server already imports core's record contract
  (`app/server-snapshot.ts:2` ← `core/src/records.ts`, commit 4698526, whose message says
  "prerequisite for Wave 4"). The server consuming core's *code* is the same import path the
  constants already travel.

## 2. Where the truth lives today (verified baseline)

The durable contract is already log-authoritative on paper (`app/board-persist.js:16-17`):
`events.jsonl` is the append-only intent log (one `IntentEvent` per line, each carrying its
materialized `RecordsDiff`); `snapshot.json` is a fast-load **cache** with a `seq` watermark; boot
replays the event tail (`seq >` watermark) on top. Writes to both THROW on failure — these files
are the board.

But three facts make the paper contract false in practice:

1. **The server never folds.** `GET /api/canvas` (`vite-fs-plugin.ts` → `handleCanvasGet`) and
   every resolver in `server-snapshot.ts` (`boardSnapshotRecords`, `threadNode`,
   `threadMemberSids`, …) read the memoized `snapshot.json` only; `events.jsonl` is consulted
   solely to *describe* recent intent. So server reads trail the truth by the tab's ~400ms
   debounced snapshot save — arbitrarily long if the tab dies mid-debounce.
2. **Only a browser tab writes the durable files.** A bus command (`POST /api/command` →
   `dispatchBusCommand`, `server-delivery.ts:319-349`) is a *broadcast to tabs*; a live tab
   applies it via `editor.commit` (`app/src/agentBus.ts:25-39`) and only then echoes the event
   back (`POST /api/board/persist/event`) and later the debounced snapshot. With no tab, the
   command sits in the in-memory `pendingBusReplay` buffer (additive commands only, cap 500, lost
   on server restart) until some future tab attaches.
3. **Every tab is its own sequencer.** Tabs mint `seq` locally (`log.ts:56-62`); the server's
   `/event` route carries a tripwire that *detects* a second writer's conflicting seqs
   (`routes/board-persist.ts:42-57`) but can't prevent them. Multi-writer today is a logged fault,
   not a supported mode; human edits don't cross the bus at all (a second tab converges only on
   reload).

Every hard bug in this week's cluster traces here, and the fixes so far (id-echo, the replay
buffer, the BUG-5 ledger-first gates) are perimeter patches around the same hole.

## 3. The fork, resolved

**(A) Read-time fold** — per request, `readBoardPersist` + replay `seq >` watermark over the
snapshot (the browser's `hydrate`, run server-side per read).

- *For:* smallest diff; stateless (no hot-reload state concerns); compaction already bounds the
  tail (`COMPACT_KEEP_TAIL=2000`, `board-persist.js:203`), so per-request cost is a bounded parse.
- *Against — disqualifying:* it fixes only reads. The event a fold would surface **isn't in
  `events.jsonl` yet** when the caller is headless: a bus `addNode` becomes durable only after a
  tab round-trips it, and with no tab it's a volatile buffer entry. "Headless-created nodes usable
  instantly" — this thread's naming problem — is *not delivered by the fold at all*. It narrows
  gap (a) (the ~400ms debounce race: the event echo is fast, unbounded only by a browser network
  hop) and fully closes gap (b) (tab dies mid-debounce, event landed) — real but partial. It also
  re-parses per request what a resident store holds for free.

**(B) Server-maintained materialized view** — an in-memory records map, hydrated once, updated as
`/event` appends land.

- *For:* fresh reads at O(diff) per append instead of O(tail) per read.
- *Against — strictly dominated:* the correct implementation of "a records map you fold diffs
  onto" **is core's `Store`** (`applyDiff`, `loadSnapshot` — the exact code the browser runs). A
  hand-rolled map would re-create the duck-typed second copy of core that Wave 2 just deleted.
  And a view still doesn't fix writes: the 503-on-no-tab, the volatile buffer, and the tab-echo
  write path all remain. B built properly *is* stage 1 of C, stopped one step short of the payoff.

**(C) Server-hosted engine** — the server owns a live `Store`+`Editor` per board; `/api/command`
commits directly; the durable append happens at commit; tabs become subscribing clients.

- *For:* fixes reads **and** writes in one move. A headless `addNode` is durable in `events.jsonl`
  and visible to `GET /api/canvas`/`threadNode` before the HTTP response returns — no polling, no
  orphan window, no replay buffer, no 503, no debounce race. One sequencer (kills the tripwire's
  hazard, enables real multi-tab convergence later). Commands get validated by the same
  `defaultCommands` handlers everywhere. The channel model stays singular (§8).
- *Against, honestly:* a resident stateful store in a dev server that hot-reloads its plugin graph
  (mitigation: the `globalThis.__canvasFsState` pinning pattern already solves exactly this class;
  rehydrate-from-files is also always available and cheap — it's what every tab does at boot).
  Stage 3 (human gestures over the wire) touches the renderer's write path and offline behaviour —
  which is why it's staged *last* and separable, not a reason to reject the direction.

**Decision: C, staged as §9.** A and B are subsumed, not merely rejected: A's fold is C's hydrate;
B's view is C's store.

## 4. The durable-persist contract, end-state (design question 2)

**`events.jsonl` is read-authoritative; `snapshot.json` is compaction output. This was always the
documented contract — the change is that the server finally honours it, and becomes its sole
writer.**

End-state contract:

- **One writer.** The server appends every event at commit time (`Editor.commit` with a
  server-side `Persistence` over the same files) and writes snapshots on its own
  debounce/compaction schedule. The `POST /api/board/persist/event|snapshot` routes — the tab
  echo — are retired with stage 3; during stages 1–2 they continue to serve tab-originated
  (human) events unchanged.
- **`seq` is minted at the single append point.** Today each tab mints `seq` in its
  `MemoryIntentLog`; end-state the server assigns it (it already tracks
  `fsState.lastEventSeq`), and the append/commit response carries the authoritative value.
  The second-writer tripwire becomes an assertion instead of a shrug.
- **The tab's debounced Persistence save**: unchanged through stages 1–2 (the snapshot it writes
  is a cache; the server reads its live store, so a stale or racing snapshot save can no longer
  make anything wrong — the watermark 409 guard stays as belt-and-braces). Retired in stage 3,
  when the snapshot writer becomes the server's compaction job.
- **Undo is untouched at every stage.** The undo stack is per-tab, in-memory, channel-2-diff-based
  and *selective by ChangeSource* (`core/src/undo.ts:28`): server-pushed remote diffs arrive via
  `applyDiffAsChange(diff, "remote")` and are never popped by a human's ⌘Z, exactly as agent-bus
  commits are never popped today. Undo never reads the event log (`board-persist.js:200`), so
  changing the log's writer changes nothing for it. (A future *shared* server-side undo, if ever
  wanted, has the per-actor source filter as its primitive — out of scope here.)
- **IndexedDB adoption** (read-once import) is unaffected; it feeds the same files.

## 5. Fold semantics: ordering, tombstones, compaction (design question 3)

A server-side read must match what a tab would render. The guarantee comes from **running the same
code, not equivalent code**:

- **Fold = `hydrate`.** Load snapshot, replay events in *file-append order*, skipping
  `seq ≤` watermark, folding each event's materialized `diff` with `applyDiff`
  (`persist.ts:157-166`, `diff.ts:37`). The server's store hydrates through this exact path, so a
  folded read and a tab render are the same computation over the same inputs by construction.
  File order (not a seq sort) is deliberately the truth — it's what the browser does, and it's
  well-defined even across the legacy dual-sequencer logs the tripwire has already logged.
- **Tombstones are unnecessary within the log.** `RecordsDiff.removed` carries the removal; a
  fold deletes the key; add-then-remove nets to absence. Cascade correctness (removeNode deletes
  its edges + layout) lives in the command handler (`commands.ts:53-62`), which is upstream of the
  diff — replay never re-runs handlers, it folds their recorded output. The one *external*
  tombstone in the system today — `bufferBusReplay` pruning a buffered create when its remove
  arrives — is retired with the buffer itself in stage 2.
- **Compaction is already correct and keeps its shape.** `compactBoardEvents`
  (`board-persist.js:195-227`) drops events `seq ≤ watermark − 2000`; a snapshot at watermark S
  materializes all removals at S, so dropped history can never resurrect a record. What changes:
  the *trigger* moves from "once per page load" (a browser-coupled schedule — the F-W1 census
  flagged the unbounded-between-loads gap) to a server-side job after its own snapshot writes.
  Same algebra, better clock. Camera and per-tab view state are not in the document
  (localStorage/sessionStorage tiers) and never enter the fold.
- **Ephemeral read overlays die.** `snapshotCache` memoization, `emittedMembers` front-running,
  and the replay buffer all exist to paper over stale reads; a live store supersedes the first
  two's *purpose* (the third is a write patch, §3). They are deleted in stage 4, not before —
  overlap, then retire.

## 6. Membership authority (design question 5 — first-class per the 07-12 triage)

**End-state rule: the board engine is authoritative for *document* facts (nodes, edges, layout);
the thread ledger stays authoritative for *orchestration* facts (thread existence, membership,
seats, intents, pins). The `member:open` edge is a derived view of a ledger fact — permanently.**

Hosting the engine server-side does **not** move membership into the board store, and the design
explicitly rejects that consolidation:

- Membership has a different lifecycle than the canvas (durable members survive card removal;
  seats survive occupant respawn; the marker survives the card) and a different consistency grade
  (fsync'd ledger appends vs debounced document saves). BUG-5's root cause was precisely letting a
  *view* artifact (a `member:open` edge vanishing from a racing snapshot save) mutate the durable
  fact. The e9f2d92 contract — snapshot diffs may announce joins but never drop members; leaves
  are explicit-only; gates are ledger-first — is the correct boundary, and this design keeps it.
- What the hosted engine *adds* is the ability to finish that fix. Today membership inference
  still runs backwards through the display layer: `announceNewMemberships`
  (`server-delivery.ts:387-414`) onboards a join by *observing snapshot diffs*, because a
  human-drawn alt-drag join is a local tab commit the server otherwise never sees. Once tab
  commits flow through the server (stage 3), every join/leave is an explicit act the server
  mediates: it writes the ledger (the fact) and commits the edge (the view) itself — **one owner
  per fact, one writer for both representations** (the §3.4 defence, structurally enforced). The
  snapshot-diff onboarding path, the `durableMembers`/`emittedMembers` in-memory mirrors, and the
  reconciler's grace-window heuristics then retire in stage 4.
- Interim (stages 1–2): the BUG-5 gates and unions stay exactly as landed. The live store makes
  the *edge view* fresh (no 400ms lag on `/join`-then-`/message`), which shrinks — but does not
  yet remove — the windows the mirrors cover.

## 7. Does id-echo already cover the headless case? (design question 4)

Partially, and only for *addressing*. `ensureCommandId` (`server-delivery.ts:301-312`) means a
headless caller learns the id of the node it just created and can name it in follow-up commands —
that closed the worst UX hole (Bug B). But the node still isn't *readable or gate-visible* until a
tab echoes it durable: `GET /api/canvas` won't return it, `threadNode`-gated endpoints 404, and
with no tab the command's only home is the volatile in-memory buffer (server restart loses it;
`MAX_PENDING_BUS_REPLAY=500` caps it; only `addNode`/`addEdge` are buffered at all). The BUG-5
ledger-first gates patched this for *threads specifically* (existence/membership checks now
consult the marker), which is why the current system mostly works — but generic nodes, edges, and
anything gating on canvas state remain in the orphan window.

So: **id-echo is the UX bridge, this design is the correctness layer** — the brief's framing is
confirmed. Id-echo stays (it's also how the server mints ids in the end-state commit path).

## 8. Channel discipline: the model does not fork

CLAUDE.md's constraint — three channels, one `IntentEvent` per gesture — is preserved by making
the server *the* host of the one store rather than a second one:

- **Channel 1 (pull handles):** unchanged for renderers; each tab's local store mirror serves its
  own signals. The server's resolvers become channel-1 consumers of the server store (they may use
  plain `get` — signia reactivity is available but not obligatory server-side).
- **Channel 2 (diff stream):** the server store's `listen` drives persistence (snapshot debounce)
  and the *new* WS diff push to tabs; a tab applies inbound diffs with
  `applyDiffAsChange(diff, "remote")` — entering the tab's channel 2 as a remote change, exactly
  as the channel model intends (`ChangeSource` exists for this).
- **Channel 3 (intent log):** still exactly one `IntentEvent` per command/gesture, still
  attributed by actor, still append-only. What changes is *where* the append happens (at the
  server commit) and who mints `seq` (the single sequencer). A bus command stops producing its
  event via a tab's re-commit — same one event, minted at the authority instead of echoed.

The renderer never learns anything new; the engines never learn "server". The interaction layer is
untouched until stage 3, and even then only in how a finished gesture's commit travels.

## 9. Migration: four stages, three implementation threads

Prereqs already landed: Wave 1 bug fixes (esp. BUG-5/6/7 contracts), Wave 2 shared schema.

- **Stage 1 — server-materialized store (read authority).** Per board on first touch: hydrate a
  core `Store` from `snapshot.json` + `events.jsonl` (the `hydrate` path), then fold each event
  arriving at `POST /api/board/persist/event` into it (`applyDiff`). Switch `handleCanvasGet` and
  every `server-snapshot.ts` resolver from `readBoardSnapshot` to the live store. Pin the store
  map on `fsState` (the established hot-reload survival pattern); any doubt → rehydrate from
  files. *Delivers:* gap (a) shrinks to the event-echo hop, gap (b) closed, all BUG-5-adjacent
  read races shrink. Low risk; no write-path change; ~a day-scale worktree task.
- **Stage 2 — command authority server-side (write authority).** `/api/command` →
  `serverEditor.commit(cmd)`: validate via `defaultCommands`, append the event durably at commit
  (server-side `Persistence` over the same files, server-minted `seq`), fold into the live store,
  **broadcast the resulting diff** (not the command) to the board's tabs over the existing
  `/api/ws`; `agentBus.ts`'s consumer changes from `editor.commit(cmd)` to
  `applyDiffAsChange(diff, "remote")`. Retire `pendingBusReplay`, the 503-on-no-tab, and the
  `tabs>0` requirement for mutations. *Delivers this thread's headline:* headless-created
  nodes/threads durable + usable before the command's HTTP response returns. Requires stage 1.
  This is also where `canvas-mutations-need-live-tab` and
  `headless-created-nodes-invisible-to-server-snapshot` become deletable memory entries.
- **Stage 3 — tabs commit over the wire (single sequencer, separable, later).** Human gesture
  commits post to the server (gesture-end granularity — one wire message per intent event, not
  per frame; channel-1 locality keeps drags at 60fps regardless of the wire), server sequences +
  persists + rebroadcasts diffs to *other* tabs; tab-side `RemoteEventStore`/snapshot echo and
  the per-tab debounced save retire; snapshot writing + compaction become the server's job;
  multi-tab live convergence for human edits arrives as a side effect. This stage changes offline
  semantics (an unreachable server means a queued commit, mirroring today's `requestRetry`
  behaviour) and deserves its own design pass on the queue/retry UX before staffing.
- **Stage 4 — retire the scaffolding.** Delete `emittedMembers` front-running, the snapshot-diff
  membership onboarding (`announceNewMemberships` inference), `snapshotCache` as a read path, the
  reconciler grace heuristics that exist to tolerate stale reads; move join/leave edge-writing
  into the server engine per §6; prune the board-memory entries the fixes obsolete; update the
  F-W1 persistence census.

Thread mapping: **stage 1 and stage 2 are one implementation thread each** (stage 2's worktree cut
after stage 1 merges — same files, sequencing not parallelism); **stage 3+4 are a third thread**
opened only after 1–2 have soaked. Stages 1–2 are what this design asks to build now; they are
independent of the Wave-3 hygiene batch except for file overlap in `server-snapshot.ts` /
`server-delivery.ts` (sequence at staffing, as usual).

## 10. Risks and open items

- **Vite plugin-graph reloads** re-evaluate server modules with the same process: the store map
  must live on the pinned `globalThis` state like everything else cross-request ("THE RULE",
  `vite-fs-plugin.ts:551`), and module-identity drift after a reload is neutralized by
  rehydrating from files (cheap, and bit-identical by §5). A behavioural probe belongs in the
  stage-1 gate (the `dev-server-serves-stale-plugin-code` lesson).
- **Memory:** one parsed board in RAM per active board — the server already holds exactly this in
  `snapshotCache`; the delta is atoms-per-record overhead. Boards are single-JSON-file scale;
  not a concern at this app's size, revisit only if boards grow orders of magnitude.
- **Seq handover (stage 2→3 window):** tab-minted seqs (human events) and server-minted seqs
  (bus events) coexist until stage 3. Mitigation: the server, as the single *append point*,
  assigns the authoritative seq on every append regardless of origin and returns it; the tab's
  in-memory mirror adopts it. This closes the tripwire's hazard one stage early and is the one
  place stage 2 touches the tab echo path.
- **Two authorities remain by design** (board log for document facts, thread ledger for
  orchestration facts, §6). The cost — two persistence grades to reason about — is real but
  already paid; the alternative (folding membership into the board store) re-opens BUG-5's class.
- **Deliberately out of scope:** CRDT/OT multi-writer merge (the server-sequencer model makes
  last-writer-wins-at-commit explicit and sufficient for a local-first single-human board);
  shared/persistent undo; sync to a second machine (the intent log is the substrate for it, but
  it's not this project).
