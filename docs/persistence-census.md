# Persistence census (F-W1)

Every persistence store in the app, its durability grade, its GC/compaction story, and its writers/readers
— in one place. The review (`docs/architecture-review-2026-07-11.md` §5, F-W1) asked for this because the
stores accreted at *different* consistency grades with the enumeration living nowhere: the worktree
fd-exhaustion crash (`recall canvas-memory: dev-server-ebadf-crash-fd-exhaustion`) is what un-enumerated
accretion costs. This reflects **post-board-engine-stage-2** reality — the server now hosts a live core
`Store` per board that is both the read and the write authority (`f0f05c9` + `76d7d4e`; design in
`docs/board-engine-server-side.md` §4–5).

## Durability grades

| Grade | Meaning |
|-------|---------|
| **fsync** | `fs.writeSync` + `fs.fsyncSync` under one fd, **throws** on failure. Survives a power cut mid-write. The strongest grade; only the thread `.jsonl` uses it. |
| **sync / throw-on-fail** | synchronous `writeFileSync`/`appendFileSync` (often atomic tmp+`rename`), **no fsync**; the error propagates so the caller/endpoint fails loudly (a 500 the client retries). Authoritative modulo an OS crash between write and disk flush. |
| **best-effort** | synchronous write wrapped in `try/catch` that **swallows** the error. The write is an index/cache, not the authority; a lost write self-heals on the next upsert. |
| **debounced** | write is delayed/coalesced (a timer) before it lands. Durable once it lands, but a crash inside the window loses the tail. |
| **in-memory** | a `globalThis`-pinned Map. Survives a Vite hot re-eval, lost on a real process restart. Every one has a durable twin it rehydrates from. |
| **external** | written by a process the app doesn't control (Claude Code, git, the Jupyter host). |

## The census

| # | Store | Location | Grade | GC / compaction | Writers → Readers |
|---|-------|----------|-------|-----------------|-------------------|
| 1 | **Board event log** `events.jsonl` | `.canvas/board/` | sync append, throw-on-fail, no fsync (`board-persist.js:156`) | **compacts** — drops `seq ≤ watermark − keepTail`, atomic tmp+rename (`compactBoardEvents` `board-persist.js:215`; `COMPACT_KEEP_TAIL=2000`, `COMPACT_MIN_DROP=500` `:203`,`:206`); triggered on board GET (`routes/board-persist.ts:130`) | server commit/append (store 3) + tab echo → board-engine fold, `RemoteEventStore` |
| 2 | **Board snapshot** `snapshot.json` | `.canvas/board/` | **debounced** (~400ms, `core/src/persist.ts`), atomic tmp+`rename`, no fsync (`writeBoardSnapshot` `board-persist.js:160-164`) | single-file overwrite (bounded); stale-`seq` write refused 409 (`routes/board-persist.ts:71`) | tab Persistence / server compaction → board-engine hydrate |
| 3 | **Board live Store** (per board) | in-memory (`fsState.boardEngines` `board-engine.ts:100`) | in-memory — **read+write authority (stage 2)** | rehydrates from files 1+2 on demand | `commitBoardCommand` (`:214`), `appendTabEvent` (`:241`) → every server read (`/api/canvas`, thread/sid resolvers) |
| 4 | **Thread log** `<enc>.jsonl` | `.canvas/threads/` | **fsync**, throw-on-fail (`appendThreadLine` `thread-ledger.js:75-76`) | read tail-bounded 256KB (`MAX_THREAD_LOG_BYTES` `:27`, tail `:95`); disk grows unbounded | `server-delivery.ts` (`appendThreadMsg`), `routes/threads.ts` → `seedThreadLogs`, rail |
| 5 | **Thread marker** `<enc>.meta.json` | `.canvas/threads/` | best-effort (`upsertThreadMeta` `thread-ledger.js:127-137`) | fixed-shape upsert; `seats`/`pins`/`seenMentions`/`intents`/`members`/`worktrees`/`jobs` grow only on new entries | seat/member/pin/level/job helpers → ledger reads, `server-snapshot.ts` |
| 6 | **Annotations** `<enc>.jsonl` | `.canvas/annotations/` | sync, throw-on-fail (500), no fsync (`annotations.js:52`) | read tail-bounded 256KB (`MAX_ANNOTATION_LOG_BYTES` `:33`); **no compaction** | `routes/annotations.ts`, `annotation-reanchor.js` → `src/annotations.ts` |
| 7 | **Standing jobs** | rides thread/doc markers (5, 6) | best-effort (inherited) | upsert/remove by id; `MIN_INTERVAL_MS=60_000` floor, fire-next-due (no catch-up) | `standing-jobs.js`/`doc-jobs.js` → `standingJobsTick` (`vite-fs-plugin.ts`) |
| 8 | **Role charters** `role.md` | `.canvas/roles/` (override) + `app/default-roles/` (bundled) | sync, throw-on-fail (`createRole` `role-ledger.js`) | 1 file/role, overwritten on edit | `routes/roles.ts` → `server-sessions.ts` (charter→prompt), role card |
| 9 | **Memory** `*.md` | `.canvas/memory/` | **external** (Claude Code built-in file memory; wired via spawn settings override `server-sessions.ts`) | none (accumulates) | spawned sessions → `memory-search.js` (`scripts/canvas memory search`) |
| 10 | **Session markers** `<sid>.json` | `.canvas/sessions/` | best-effort (`markCanvasSession` `session-ledger.js:47-48`) | **accumulate unbounded**, no compaction | `server-sessions.ts` (spawn/adopt/end) → `listSessions`, `usage-rollup.js` |
| 11 | **Session transcripts** `<sid>.jsonl` | `~/.claude/projects/<cwd-slug>/` (external, per-cwd) | **external** (Claude Code) | external | Claude Code → session codec, adoption |
| 12 | **Shadow git** | `.canvas/roots/<id>/git` | git commit (**debounced**, `settleMs=800` `shadow-git.js:154`,`:176`) | unbounded history *by design* (the provenance timeline); app never `gc`s; `SHADOW_EXCLUDES` (`:38`) | watcher + attributed `commitClaimed` → provenance surfaces |
| 13 | **Worktrees** | `.canvas/worktrees/<slug>` (checkouts) + record on marker (5) | git checkout (durable) + best-effort record (`worktrees.js`) | on-demand teardown; **fd-leak risk if un-GC'd** (the EBADF crash) | `worktrees.js`, `server-orchestration.ts` (merge-on-green) |
| 14 | **Board registry** `boards.json` | `.canvas/` of the **dev-server repo** | best-effort sync (`recordBoardOpened` `vite-fs-plugin.ts`) | whole-array rewrite, bounded by #boards | `recordBoardOpened`, `routes/boards.ts` → boot mount loop |
| 15 | **Images / assets** | `.canvas/images/` | sync, no fsync (`routes/files.ts`) | accumulate; shadow-versioned | POST `/api/asset` → image cards |
| 16 | **Artefacts / docs** (card bodies) | `.canvas/artefacts/`, `.canvas/docs/` | sync, no fsync (`routes/files.ts`) | accumulate; shadow-versioned | generic file-write endpoint → file cards |
| 17 | **Kernel state** | in-memory (`fsState.liveKernels` `server-kernel.ts`) | in-memory | idle-reap 30min (`IDLE_TIMEOUT_MS`) | `routes/kernel.ts` → the ipynb card status feed |
| 18 | **Notebook cell outputs** | the `.ipynb` **file** | sync, no fsync (`server-kernel.ts:162`) | overwrite (id-keyed CAS via `mode:"full"`) | kernel broker → ipynb codec / card |
| 19 | **IndexedDB** | browser (per-origin) | **adoption-only** — read **once** to import a pre-stage-4 board, refused if server state exists (`board-persist.js:60`; `import` route) | n/a (not a durable tier — `remote-store.ts:3-8`) | App.tsx one-time → `POST /api/board/persist/import` |
| 20 | **`fsState` coordination Maps** | in-memory (globalThis-pinned) | in-memory | `threadLogs` tail-capped at `MAX_THREAD_MSGS=200`; `liveSessions`/SSE clients/`emittedMembers`/`pendingAsks`/`pendingPermissions` ephemeral | server modules; durable twins are the markers above |

## Notes on the non-obvious

- **Board store, stage 2 (rows 1–3).** `events.jsonl` is read-authoritative; `snapshot.json` is a
  fast-load cache / compaction output — the documented contract that the server now finally honours as the
  **sole commit writer** (`board-engine.ts:214`), minting the authoritative `seq` at one append point. The
  `POST /api/board/persist/event|snapshot` tab-echo routes still carry tab-originated (human) gestures
  through stage 2 (`appendTabEvent`); they retire in **stage 3**. A stale/racing snapshot save can no longer
  make a read wrong (the live store is the read authority; the 409 watermark guard is belt-and-braces).
- **One store is fsync'd (row 4).** Only the thread `.jsonl` — the 2026-07-12 lost merge-confirmation drove
  it; a durable orchestration record must survive a crash between write and flush. Every other durable store
  is sync-but-not-fsync'd: authoritative modulo an OS-level crash in the flush window, an accepted tradeoff.
- **Document vs orchestration authority.** The board engine owns *document* facts (nodes/edges/layout); the
  thread ledger owns *orchestration* facts (thread existence, membership, seats, intents, pins). The
  `member:open` edge is a **derived view** of a ledger fact, permanently — BUG-5's root cause was letting a
  view artifact (a vanishing edge in a racing snapshot save) mutate the durable member (see
  `board-engine-server-side.md` §6).

## Scheduled follow-ups (grade/GC gaps, not bugs)

- **Board-log compaction trigger (row 1).** Compaction is *implemented* (contra the stale
  `board-persist.js:19-20` comment) but still fires **once per board GET / page load** — a browser-coupled
  clock, unbounded between loads on a long-lived headless board. Stage 4 moves the trigger to a server-side
  job after each snapshot write (`board-engine-server-side.md` §5). Same algebra, better clock.
- **Session markers grow unbounded (row 10).** One `<sid>.json` per session, never compacted. Low per-item
  cost, but no ceiling; a periodic prune of long-ended markers is the eventual answer.
- **Worktree GC (row 13).** Un-GC'd worktrees were the fd-exhaustion crash. Teardown exists but is
  event-driven; a boot-time reconcile of orphaned worktree dirs would close the accretion channel.
