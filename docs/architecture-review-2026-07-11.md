# Architecture & Direction Review — 2026-07-11

*Prepared 2026-07-11 from a five-track parallel review: (1) HUD + pinned cards, (2) thread cards +
linked sessions (the P1–P5 lifecycle series), (3) the two notebook tracks (reactive notebook vs
Jupyter `.ipynb`), (4) the vite-fs-plugin god-file refactor, (5) whole-system coherence against the
stated three-channel architecture. Companion to `architecture-review-2026-06-09.md`,
`tldraw-architecture-and-feasibility.md`, and `threads-as-cards.md`. The follow-through work is
driven from the board's meta-thread ("Architecture review follow-through 2026-07-11") and the wave
plan in §8.*

---

## 1. Verdict

The canvas architecture is holding. The three-channel discipline, the engine/renderer separation,
and the recent feature work are all in good shape, and churn was consistently resolved by
**deletion** (the HUD scaling experiments, the move-with-thread reactor) rather than accretion.

The drift is structural and singular: **the agent-orchestration server has become a second product
(~11.4k lines — larger than `app/src`, ~4× `core/`) whose relationship to the board is
architecturally backwards.** The board engine runs only in the browser, so the server — now the
system's most important actor — can neither read fresh board state (it reads the stale persisted
`snapshot.json`) nor write to the board without a live tab (commands are broadcast to tabs, and
buffered "possibly lost forever" when none is open). It also re-derives core's record schema by
duck-typing (`typeName === "node"`, `"member:open"` string matching over `Record<string, unknown>`)
with no shared contract. Every hard bug in the project memory — headless-created nodes invisible to
`/api/canvas`, live-tab 503s, thread endpoints 404ing off-canvas, wake-miss on stale sids — traces
to this one split-brain.

The recurring *process* pattern across all five tracks: features land clean; **the second half of
refactors slips** (lazy accessors done for 4 of ~13 maps, ctx ops moved but consumers never
repointed, P5 pill-clear shipped without the mirror write) and **comments/docs describing the
previous world linger**. Direction is coherent; follow-through discipline is the thing to fix.

## 2. What was verified healthy (not assumed — checked)

- **Channel discipline holds everywhere sampled.** Renderer reads only channel-1 pull handles
  (`CanvasView.tsx` signals; `reactive.ts` is the whole React bridge). Every mutation goes through
  `editor.commit`/`beginGesture`; the only direct `store.put` outside a gesture is inside a
  registered command handler (`app/src/loader.ts:100`), core's sanctioned extension point. One
  gesture = one IntentEvent holds for the new HUD drags too. Zero signia imports in `app/src`.
  Agents mutate through the same command vocabulary as humans (`agentBus.ts:26`).
- **Engines stable and in-charter.** core/ and interaction/ have ~5 commits each; recent
  interaction changes (cluster selection, peek lens) entered as renderer-blind host hooks
  (`expandSelection`, `interaction/src/tools/tool.ts:60`) — the engine never learned "thread".
- **HUD/pinned unification is genuinely one concept** — a node with `anchor:"screen"`, one
  `ScreenCardFrame`, one group fit-scale (`hudFitScale`), positions as real persisted store records
  seeded from one spec (`DEFAULT_HUD`). No dead paths from the superseded scaling approaches
  (grep-verified).
- **Thread cards as views matches the design doc.** Durable truth in the ledger marker; the card
  and its `member:open` edge are a view (P1 REOPEN GUARD correctly distinguishes redraw from
  re-join). The P3 reactor is fully deleted. Divergences from `threads-as-cards.md` are recorded
  decisions — except done-member auto-detach (§5, F-T6).
- **The two notebook tracks are cleanly separate and should stay so.** Reactive notebook = a JS
  dataflow engine (DAG, export atoms, two execution realms); ipynb = a sequential Python kernel
  driven server-side. Different computational models; ~60 lines of overlap today. Converge only at
  the rendering/codec seams, and only when P2 editable-ipynb starts.
- **Byte-cap discipline in the ipynb read path is exemplary** — one bound at the byte read
  (`MAX_NOTEBOOK_BYTES`), structure-level elision below it, honest `trimmed` flags end-to-end,
  head/tail kept per the CLAUDE.md rule. (The *write* side is not — see BUG-2/M3.)
- **The god-file refactor is real.** 15 route modules + 8 server engines; routes→engine dependency
  direction is clean (route runtime imports never touch the shell); the hermetic test proves
  engines run against a fake context. The `.js`+`.d.ts` convention is deliberate, not neglect
  (every root `.js` has a hand-written `.d.ts`).

## 3. The architectural findings (the "drift" list)

### 3.1 HIGH — the server split-brain

The board engine (store + commands + intent log) runs only in browser tabs.

- **Reads:** `server-snapshot.ts` reads `snapshot.json`, a file the *browser* writes on a ~400ms
  debounce — always stale, arbitrarily old with no tab open. Root cause of
  `headless-created-nodes-invisible-to-server-snapshot`.
- **Writes:** `server-delivery.ts:265-316` ("the board lives in the browser, so a mutation is an
  addEdge/... broadcast to tabs"); a creation command reaching no live tab is buffered with a
  comment saying it may be "lost forever". Root cause of `canvas-mutations-need-live-tab`.

**Correction (Wave 4):** run the engine in the server process — core is verified DOM-free and
renderer-free — make `/api/command` commit directly, tabs become subscribing clients over the
existing WS. Retires the buffering, the 503s, and the stale-snapshot reads in one move. Design doc
first; staged (server hosts live store hydrated from `events.jsonl` → tabs subscribe/commit over
WS → retire tab-broadcast buffering).

### 3.2 HIGH — untyped duplicate of core's record schema

`server-snapshot.ts:87,236,257,289,327-363` parses records as `Record<string, unknown>` with
hand-written string matches (`typeName === "node"/"edge"/"layout"`, edge type `"member:open"`,
node type `"session"`). Core and the server hold two independent copies of "what a record looks
like", connected by nothing; a core schema change breaks orchestration silently.

**Correction (Wave 2, prerequisite for Wave 4):** one shared record-schema module (types + the
magic-string constants) imported by both core and the server modules.

### 3.3 HIGH — `ServerContext` drifted from bridge to permanent service locator

`server-context.ts` is a ~60-member bag reached via `getServerContext()` (129 call sites). Its
comments are now false ("their DEFINITIONS stay in vite-fs-plugin.ts" — P5 moved every one into
engines; nobody repointed the consumers). Engines fetch *their own exports* through the global
(`server-sessions.ts:169,338`). Two engine→route runtime imports point the wrong way
(`server-sessions.ts:20` ← `routes/permissions.js`; `server-orchestration.ts:19` ←
`routes/card-types.js`), and `server-delivery` ↔ `server-snapshot` are mutually cyclic. The lazy-
accessor unification (489051a) covered 4 of ~13 fsState maps; the rest still scatter `??=` init
(worst: `durableMembers` at five sites), and one `!` assertion survives (BUG-4).

**Correction (Wave 3):** callers import the defining module; shrink the context to genuine shared
*state* (`boards`, `liveSessions`, `fsState`) plus the few shell-resident resolvers; finish the
accessors for all maps; move `settlePermission` into an engine; break the delivery↔snapshot cycle.

### 3.4 Recurring shape — dual-source state

Same fact, two stores, updated by code that must remember both. Live instance: thread membership in
the ledger marker *and* the in-memory `fsState.durableMembers` map — the P5 sweep updates only the
marker (BUG-1). Same shape at medium severity: pill status delivered at two cadences
(`publishThreadFeed` on message events vs `reconcileSessionBands` never touching thread feeds), and
the client reconciler's join window (BUG-4b). **Defence:** one owner per fact, or one function that
always writes both (`forgetDurableMember` already exists — use it).

## 4. Bugs (fix now, independent of any architecture work)

- **BUG-1 (HIGH, data-integrity): P5 detach desyncs the durable-member mirror.**
  `detachDoneMembersTick` (`server-orchestration.ts:328`) calls the ledger's `removeThreadMember`
  but not `forgetDurableMember`, so `fsState.durableMembers` keeps the stale sid until restart.
  Consequences (confirmed code paths): the open thread card's pill does **not** clear (feed roster
  unions the stale map via `threadMemberSids`) — contradicting 343065a's headline; reopening a
  detached session redraws an edge the client reconciler immediately deletes (flap); stale sids
  keep flowing into wake fan-out. The P5 test replays the sweep body by hand and cannot see the
  missing half — test the ctx-bound tick against a real fsState instead.
- **BUG-2 (HIGH, data-loss): `.ipynb` lossy agent read round-trips through the CAS.** A bare agent
  GET returns the transformed projection (images → elision markers, text clamped;
  `ipynb-codec.js:52-88`) but stamps `version` = hash of the **full on-disk bytes**
  (`routes/files.ts:62-72`). A well-behaved read-edit-write passes the CAS and replaces every real
  output with elision markers. Fix: omit/poison `version` on `trimmed` reads, and/or reject write
  bodies carrying elision markers, and/or route `.ipynb` POSTs through `transformNotebook`.
- **BUG-3 (HIGH, resource leak): Jupyter kernels are never reaped.** `shutdownKernel` exists
  (`server-kernel.ts:407-416`) but nothing calls it; the detached gateway survives dev-server
  restarts while `fsState.liveKernels` doesn't, so every restart with an open notebook orphans a
  Python process forever (`server-kernel.ts:268-272`). `ensureKernel` also has no in-flight guard —
  two fast Runs create two kernels. Fix: reconcile against `GET /api/kernels` on first
  `ensureGateway` per server lifetime; `launching`-style guard (mirror `jupyter-host.js:199-214`);
  `shutdownKernel` on file unlink; idle timeout.
- **BUG-4 (MEDIUM, crash-class + robustness):** (a) `fsState.busClients!` at
  `server-delivery.ts:276` — the exact crash the lazy accessors were built to remove, in the
  most-called delivery function; (b) the route dispatcher has no error boundary — async handler
  throws are unhandled rejections, not 500s (`vite-fs-plugin.ts:1318-1349`); one
  `Promise.resolve(r.run(...)).catch(→500)` wrapper retires the class.
- **BUG-4b (MEDIUM, silent undo of a human action): reconciler join window.** A human-drawn
  alt-drag join's edge exists client-side ~400-500ms before the marker write lands; any unrelated
  `threads:<board>` ping in that window makes `reconcileDetachedMemberCards` (`loader.ts:968-992`)
  delete the just-drawn card + edge. Fix: grace window for edges younger than the snapshot
  round-trip, or fold `emittedMembers` into the `/api/threads` members roster server-side.

Also notable (MEDIUM): kernel write-back failures and the missing-Python-env error are invisible in
the UI (`runAllCells` discards `mergeCellOutputs`' return, `server-kernel.ts:377`; the actionable
`uv venv…` message dies in a discarded HTTP body — publish an error feed frame from the route
catch, ~20 lines); `.ipynb` reads capped at 32 MiB but writes at 128 KiB
(`routes/files.ts:128`) — the documented two-caps-one-artifact footgun, key the write cap on
extension; kernel outputs unbounded at collection with total-loss on oversize (coalesce consecutive
same-name streams + clamp instead of failing, `server-kernel.ts:239-254`).

## 5. Tech-debt ledger (by track)

**HUD (all small):**
- F-H1: `loader.ts` ~554-620 comments describe the retired pre-P1 model (stored values
  "overridden by the derived placement" — now the opposite; `HudFrame`/`.minimap-hud`/`USAGE_WIDTH`
  no longer exist). Rewrite to state the current invariant: stored layout is authoritative,
  `seedHud` only seeds/migrates.
- F-H2: HUD sizes hand-duplicated (`loader.ts:557-621` `*_HUD_W/H` vs `hud-layout.js:30-35`);
  fresh HUD cards log two intent events (addNode at fallback, then reseat). Import the spec sizes;
  seed in one commit.
- F-H3: two intent vocabularies for one action — engine `"moveNodes"/"resizeNodes"` actor
  `"human"` vs NodeView `"moveNode"/"resizeNode"` actor `"user"`. Unify on the engine's spelling.
- F-H4: orphaned `refW`/`refH` fields (the reverted d6ba679 experiment) still on 6 layout records
  in `.canvas/board/snapshot.json` + events. One-time strip/normalize.
- F-H5: no tests at the seams that actually regressed — `seatHudCard`'s three-way branch,
  pin↔unpin round-trip (factor `togglePin` math pure, beside `pinPlacement`), freeze-during-
  gesture. The pure-math suite (14 tests) is good but wasn't where the four regressions were.
- F-H6 (accepted, documented): viewport-relative placements resolve once at seed; a card
  Alt-dragged to negative x/y is unrecoverable except by right-click re-seed (`hudFitScale` only
  guards right/bottom). Optional clamp.

**Threads/sessions:**
- F-T1 = BUG-1. F-T2 = BUG-4b.
- F-T3: pill staleness for closed members — `rosterStatusBySid` is computed at publish time and
  republished only on message/pin/seen; `reconcileSessionBands` never republishes thread feeds. A
  working→waiting transition freezes until the next message. One call site fix.
- F-T4: P3 leftovers — stale "move-with-thread reactor" comments (`vite-fs-plugin.ts:438`,
  `server-snapshot.ts:201`); `allSessionAnchors` computed on every `/api/threads` (reads every
  marker) and shipped to a client cache whose only consumer `primaryThreadOf` has **no callers**
  (`content.ts:456-460`). Delete the dead path; keep server-side `sessionAnchor`.
- F-T5: `ThreadView` (~570 lines in `NodeView.tsx`) mixes feed plumbing, pill-union logic,
  composer, scroll; the pill union (lines ~730-755, 1068-1127) is pure, dense, and untested —
  extract + unit-test. The P5 client reconciler, `restoreReopenSet`, `redrawMemberEdges` also have
  zero tests.
- F-T6: done-member auto-detach changes the doc's implicit "membership is durable" contract —
  document in `threads-as-cards.md` (or lifecycle companion) so the next reader doesn't call it
  drift. Also still open from the doc, unbuilt (not drift): explicit `closed` thread state /
  `/close` verb; channel-era capability names (`ChanMeta.chanId`).

**Notebooks:**
- F-N1 = BUG-2, F-N2 = BUG-3, error surfacing + caps = §4 "also notable".
- F-N3: `server-kernel.ts` has zero tests — `ensureCellIds` (duplicate-id handling) and
  `mergeCellOutputs` (CAS retry loop) are pure-ish and eminently testable against a temp dir.
- F-N4: docs drift — `docs/ipynb-card.md:1-5` still opens "READ-ONLY … not a second notebook
  engine"; `card-types/ipynb/render.js:1-7` says "It never executes anything"; both predate
  950223a. The ipynb kernel design lives confusingly in `notebook-card.md §2 Path B`.
- F-N5: `joinMaybe`/`joinSource` ×3 (`ipynb-codec.js:39`, `server-kernel.ts:73`,
  `ipynb/render.js:20`) — fold when touching. Shared nbformat-output renderer: extract **when P2
  editable-ipynb starts**, not before (~60 lines of overlap today).
- F-N6 (noted, accepted under the local-trust model): `data-main-realm="allow"` consent lives in
  the notebook file, so any file writer grants main-realm execution; the gate defends against
  accidents, not hostile files.

**Server refactor:**
- F-S1 = §3.3 (ctx repoint + accessors + cycle). F-S2 = BUG-4a/b.
- F-S3: ~400 lines of real domain code still in the shell — the board registry/roots engine
  (`vite-fs-plugin.ts:75-306`, extract as `server-boards.ts`, ~230 lines, hermetically testable),
  the agent-bus handlers (`handleCommand`/`handleCanvasGet`/`cascadeNodeEdges`, 935-1016 →
  `routes/bus.ts`), `handleThreads`+`threadParticipants` (363-442 → `routes/threads.ts`, and it
  reads `liveSessions` directly at :370, bypassing ctx discipline).
- F-S4: the shell is the type home (`LiveSession`, `ThreadMsg`, `CanvasFsState`… at 472-790) —
  eight modules type-import the god-file. Move to `server-types.ts`.
- F-S5: route-table ordering is load-bearing and implicit (`vite-fs-plugin.ts:1186-1209`;
  `sessionLifecycleRoutes`/`sessionReadRoutes` split exists solely for spread position). Nothing
  enforces it.
- F-S6: hermetic tests cover server-fs/snapshot/context well but **zero** route modules,
  `server-http`, `server-kernel`, and the hot delivery/sessions paths (`dispatchBusCommand`,
  `wakeThreadMembers`, `appendThreadMsg`, spawn/fold/feed). The `.js`+`.d.ts` pattern's original
  reason (node --test can't load TS) is dissolved by the resolve hook — new server code should be
  `.ts`; consider `checkJs` or migrate-on-touch to close the declaration-drift channel. Note
  `tsconfig.json` includes only `src` + the shell — an engine the shell stops importing silently
  exits typecheck.
- F-S7: ~40 tombstone comments ("X moved to Y (P5 sub-step N)") ≈15% of the shell — prune once
  Wave 3 lands.

**Whole-system:**
- F-W1: persistence census — ~10 durable stores (.canvas/board, threads, annotations, memory,
  roles, sessions markers, roots + shadow-git, worktrees, images, boards.json; IndexedDB demoted to
  adoption-only; external per-cwd transcript dirs) at three consistency grades
  (authoritative/throw, best-effort marker, tail-trimmed cache), enumerated nowhere. One table:
  store / grade / GC story / readers. The worktree fd-exhaustion crash is what un-enumerated
  accretion costs. Include intent-log compaction (`board-persist.js:19-20`, unbounded, acknowledged
  follow-up) as a scheduled item.
- F-W2: HUD drag/resize is ~150 lines of parallel gesture mechanics in `NodeView.tsx` (lazy
  gesture open, live-layout-read-at-grab, resizeBox+aspectLock) that must match the engine's — all
  four HUD regression commits were in exactly this machinery. Channel discipline holds (sanctioned
  `beginGesture` API), so low urgency; fold through an anchor-aware interaction path if it bites
  again.

## 6. Explainer — the architectural terms, plainly

*(Kept here so thread briefs can point at one place.)*

- **The board engine**: the in-memory reactive store of records (node/edge/layout) plus the
  command system that mutates it (`core/`). Runs only in browser tabs today.
- **Split-brain**: two components each hold half the truth — tabs have the live board but aren't
  always open; the server is always on but sees only a stale photograph (`snapshot.json`) and
  writes by asking a tab.
- **Duck-typing**: inferring what an object is by poking at its fields (`typeName === "node"`)
  instead of using a declared type. Two copies of the schema knowledge, connected by nothing.
- **Service locator**: a global bag you fetch dependencies from at runtime
  (`getServerContext()`) instead of importing them where readers and tools can see. Tolerable as
  refactor scaffolding; the scaffolding was never removed.
- **Dual-source state**: the same fact stored twice (marker file + in-memory map), kept in sync
  only by every writer remembering both.

## 7. Decisions taken in this review

- **Keep the two notebook execution substrates separate**; converge rendering/codec seams only,
  at P2-editable-ipynb time.
- **The board-engine-server-side move is the endorsed direction** for the split-brain (not more
  snapshot/buffering patches). Design doc before code.
- **Test investment goes to integration seams**, not more pure-function coverage — every
  historical regression reviewed was at a seam the pure tests couldn't see.

## 8. Wave plan (driven from the meta-thread)

- **Wave 1 — bugs (now, parallelizable):** BUG-1, BUG-2, BUG-3, BUG-4(+4b). Independent worktree
  tasks, merge-on-green.
- **Wave 2 — shared record-schema module (small, single task):** types + magic-string constants,
  imported by core and server-snapshot/delivery. Prerequisite for Wave 4.
- **Wave 3 — refactor follow-through + hygiene (batch of mechanical tasks):** finish accessors;
  repoint ctx consumers module-by-module and shrink the context to state; `server-types.ts`;
  extract `server-boards.ts` + inline bus/threads handlers; dispatcher error boundary (if not done
  in Wave 1); delivery-cadence fixes (F-T3); dead-path deletion (F-T4); comment/doc sweep (F-H1,
  F-N4, F-S7, F-T6); seam tests (F-H5, F-T5, F-N3, F-S6); persistence census (F-W1).
- **Wave 4 — board engine server-side (project; design doc first):** staged as §3.1. Don't invest
  in split-brain symptom patches Wave 4 deletes.
