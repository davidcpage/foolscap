# Implementation plan: the wakeable substrate & background sessions

*Plan, 2026-07-04. The execution roadmap for the cluster of work that emerged from the doc-annotations
build and the Claude Tag review. This doc is the **program of work** — what to build, in what order, with
what dependencies and done-criteria. It references the design docs for the *why/how* and does not repeat
them: `claude-tag-lessons.md` (R1–R6 rationale + decisions), `anchored-async-ask.md` (the ask feature + the
wake model), `doc-annotations.md` (the annotation substrate), `threads-as-cards.md` (threads, seats),
`agent-roles.md` (roles). Meant to be picked up and executed by a fresh session (or several); keep the
**Status** column current as the source of truth.*

---

## The through-line

**Make sessions genuinely background: the durable substrate — docs, threads, memory — becomes *wakeable*,
and the server spawns compute from it on demand.** A session stops being a thing you manage and becomes
interchangeable compute summoned by activity on a durable record, doing its work and winding down. Every
item below is an instance of that.

Two **foundational primitives** carry most of the recommendations; factor them out and build them once:

- **P1 — seats with notification levels on wakeable surfaces.** A seat (durable participant slot,
  `threads-as-cards.md` §5) generalizes off the thread onto any surface that emits activity — a thread, a
  **doc**, a timer. Each seat has a level: `all` / `mentions` / `paused` (the Slack-channel choice), with an
  `@`-mention always overriding. This is R2 (recast) and `anchored-async-ask.md` §2.
- **P2 — server-spawn-from-a-durable-record.** The server fires compute from a durable trigger: it
  reconstitutes a session seeded from a thread's history or a doc's annotations when a qualifying wake lands,
  runs a single-flight loop-until-dry worker, and applies the idle lifecycle (keep-alive grace → exit →
  respawn). This is R1's reconstitution, `anchored-async-ask.md`'s push wake-back, doc-wake, and the base for
  R6 — one mechanism.

Almost everything else sits on P1 and P2.

## Already shipped (baseline)

- **Doc-annotations substrate** — ledger, anchors, endpoints, card UI, conventions. `doc-annotations.md`
  steps 1–3 (commits `5429c29`, `da5de34`, `0c45b78`).
- **Auto-reanchor + `canvas anno` CLI** — server re-anchors moved-but-resolvable comments on read/write;
  `list`/`reply`/`batch`/`resolve`/`reopen`. `doc-annotations.md` §4 step 5 (commit `32e51e7`).
- **Threads as cards** — thread nodes/ledger, seats, work-intent, derived state. `threads-as-cards.md`
  steps 1–3 (per memory; `5c51c84`, `71bc447`, `1a61a4e`).

## Work items

Effort: S(mall) ≈ hours, M(edium) ≈ a session, L(arge) ≈ multiple sessions. Independent items (no unmet
dep) can run in parallel sessions.

| # | Item | Implements | Depends | Effort | Status |
|---|---|---|---|---|---|
| W1 | anchored-async-ask **record layer** | async-ask §4/§6 steps 1–2 | — | M | DONE `9e6988a` |
| W2 | anchored-async-ask **card affordance** | async-ask §6 step 3 | W1 | M | DONE `addaf14` |
| W3 | **R4 board `memory.md`** card + linked role memory | claude-tag R4 | — | S | DONE `addaf14` |
| W4 | **P1: seats + notification levels** | R2 recast, async-ask §2 | threads (built) | M | DONE `b5af3a0` |
| W5 | **P2: server-spawn-from-record + wake trigger** | R1, async-ask §8 step 5, doc-wake | W4 (+W1) | L | DONE `4c749f5` |
| W6 | **R6 standing jobs** (server-fired watches) | claude-tag R6 | W5 | M | DONE `55dc302` |
| W7 | **R-PIN + R5** (pinnable posts, done-condition, proof) | claude-tag R-PIN/R5 | threads (built) | M | DONE `3f556d9` (ledger in `addaf14`) |
| W8 | **R3 per-thread spend** accounting | claude-tag R3 | W5 marker | S | LATER |
| W9 | **PM → Coordinator** repo-wide rename | claude-tag review loose end | — | S | DONE `addaf14` |
| W10 | **proactive mid-turn board-check** norm | workflow review 2026-07-05 | W4 committed | S | DONE `2b2d85f` |

### W1 — anchored-async-ask record layer (pull-mode)
- `create` gains `kind:"note"|"question"`, `options:[{label,description?}]`, `blocking:true`; new `answer`
  event `{ev,id,by,choice?,text,ts}` (forward-compatible — `foldAnnotations` ignores unknown kinds); derived
  question state `awaiting`/`answered`/`resolved` at read (never stored).
- `canvas anno ask` / `canvas anno answer` verbs; `anno list` shows question states (awaiting vs answered vs
  plain comment) in the per-file listing and the board sweep.
- Collab-brief + CLAUDE.md norm: *for a real decision, ask on the doc (an anchored question), not the
  in-session `AskUserQuestion` block.*
- **Done when:** an agent raises an anchored question (with options); a human answers on the doc or via CLI;
  the sweep distinguishes awaiting/answered; a fresh session can sweep `answered` questions and apply them.
  Continuation is **pull** (no auto-wake yet) — this alone retires the in-session ask-block anti-pattern.
- **Shipped** (commit `9e6988a`): `create` gains `kind:"note"|"question"` + `options` + `blocking`;
  new `answer` event (`{ev,id,by,choice?,text}`) rides `replies` and marks the question answered; derived
  `questionState` = awaiting/answered/resolved, read-time only (`annotations.js` + `.d.ts`). The
  `/api/annotations` write handler takes the `answer` op (400 on a note) and the question create fields; the
  read adds per-question `state` and the sweep adds `awaiting`/`answered` counts. `scripts/canvas anno ask`
  / `answer` verbs; `anno list` shows Q-wait/Q-answ + option labels per file and awaiting/answered in the
  sweep (awaiting floats to the top). Norm added to the collab brief + `CLAUDE.md`: *for a real decision,
  ask on the doc, not the in-session block.* Tests: `annotations.test.mjs` (fold + state) +
  `http-contract.test.mjs` (live question round-trip). **W2 note:** the read already emits `kind`,
  `options`, `blocking`, `answer`, and `state` per annotation — the card affordance is a pure render over
  that; `answer` events carry an optional `choice` on their `replies` entry.

### W2 — anchored-async-ask card affordance
- Question paints distinctly from a comment (a "?" on the highlight); popover shows the question, option
  buttons + a reply box, and an awaiting/answered badge (host chrome, `NodeView.tsx` + `src/annotations.ts`).
- **Done when:** a human can ask and answer a question entirely from the doc card.
- **Shipped** (commit `addaf14`, bundled with W3's `git add -A`): `AnnotationInfo` in `src/annotations.ts` gains the W1 read-fields
  (`kind`/`options`/`blocking`/`answer`/`state`, and `choice` on an answer reply); a new `anno-question`
  highlight bucket paints anchored questions in a distinct blue. In `NodeView.tsx`: the draft popover gains
  a **Comment | Ask** toggle + an optional one-per-line choices field, so a question is asked from the card;
  the exchange popover shows an awaiting/answered/resolved **state pill**, clickable **option buttons** (one
  click answers with that `choice`), a prose **Answer** row (the reply row becomes Answer on an open
  question), and renders each answer reply's `choice`; the badge carries a `❓N` awaiting-question count.
  Styling in `style.css`. Typecheck clean; `annotations.test.mjs` + `http-contract.test.mjs` green; live-board
  smoke test drove the create-question → GET (the exact fields the card reads) → answer-by-choice →
  awaiting→answered flip → reply-carries-choice round-trip against the running board. The card interaction
  (clicks) is a pure render over that verified data path.

### W3 — R4 board memory.md + linked role memory
- `.canvas/memory.md` rendered as an ordinary markdown file card, included in every spawned session's brief;
  structure ("one fact per line, newest-first, links to per-topic markdown, lazy-loaded") is a **convention**
  the brief states. Role memory = markdown leaves **linked from `memory.md`**, loaded on demand; `role.md`
  stays the shared charter. No separate role-notes store.
- **Done when:** a `memory.md` card exists, rides the spawn brief, and links at least one role-memory file
  pulled into context on demand.
- **Shipped:** `.canvas/memory.md` exists (a curated index — one fact per line, newest-first — of this
  board's settled norms) and renders as an ordinary file card (`node:repo:.canvas/memory.md`, dropped on the
  board). It's **embedded in every spawned session's brief**: `board-memory.js` (`boardMemoryBrief(repoPath)`,
  read fresh at spawn, HEAD-capped 32KB, `truncated` flag) → `ensureLiveSession` in `vite-fs-plugin.ts`.
  Role memory hangs off the index as linked leaves under `.canvas/memory/` loaded **on demand**:
  `.canvas/memory/pm.md` (PM/Coordinator role memory) + `.canvas/memory/board-memory.md` (how it's wired).
  Convention (one fact/line, newest-first, links to lazy leaves, `role.md` stays the charter) stated in the
  brief block, not enforced code. Tests: `test/board-memory.test.mjs` (null/embed/HEAD-cap/truncation). The
  brief wiring is server code — it reaches sessions on the next dev-server restart; verified now by unit
  tests + an integration check of the real `memory.md`. **Note:** `.canvas/` is git-ignored (shadow-
  versioned), so the memory files persist on disk/board but aren't in the git commit — only the code is.

### W4 — P1: seats + notification levels
- Generalize the seat onto any surface; each seat carries `level ∈ {all, mentions, paused}`. The **watch
  record** (per-doc marker beside the annotation ledger): `{role, level, state:"active"|"paused", by,
  createdAt}`.
- `canvas anno watch <doc> [--role --level] [--pause|--resume]` + the doc card's right-click **"watch for
  comments"** affordance; a watched doc shows a watcher chip.
- Thread wake adopts the same levels (R2): default `all`, per-seat opt-down to `mentions`/`paused`,
  `@`-mention override. The change is the nudge fan-out condition only.
- **Done when:** a thread or doc seat carries a level; the wake fan-out respects it; an `@`-mention reaches a
  `mentions`/`paused` seat; a doc can be watched/paused from CLI and card.
- **Shipped** (commit `b5af3a0`): the reusable core is `app/notification-levels.js` — the level enum
  (`all`/`mentions`/`paused`) + one `wakesSeat(level, {mentioned, broadcast})` predicate every wakeable
  surface routes through (mention always wakes — the `@`-mention override, even at `paused`; a broadcast
  wakes only `all`; ambient wakes no one). **Doc side:** `app/doc-watch.js` — a per-doc watch marker
  (`<enc>.watch.json`) beside the annotation ledger holding `{role, level, state:"active"|"paused", by,
  createdAt}` watchers (a doc's seat roster, one surface up from a thread). New `/api/annotations` ops
  `watch`/`pause`/`resume`/`unwatch` (keyed by role, not an annotation id); the per-file read returns
  `watchers`, the sweep adds a `watched` count + `watchers`. `scripts/canvas anno watch <doc> [--role
  --level] [--pause|--resume|--unwatch]`; `anno list` shows `👁 role:level` per doc. The doc card grows a
  **watch chip** (`NodeView.tsx`, top-left of the anno layer) that cycles all→mentions→paused→off over
  `docWatchersSignal`. **Thread side:** the level rides the SEAT (`seats[handle].level`, durable across
  respawn — `fillSeat` now carries it) with a sid-keyed `levels` fallback for seatless members;
  `setThreadLevel`/`threadLevelForSid` in `thread-ledger.js`; new `POST /api/thread/<id>/level {from,
  level}`. `wakeThreadMembers` now gates each member on `wakesSeat(threadLevelForSid(meta, sid), …)` —
  `@all` is a broadcast (wakes level-`all` seats), a member tag is a mention (wakes it regardless of level),
  an untagged post is ambient (wakes no one); **the message record is unchanged — only the nudge condition.**
  This is PULL-mode plumbing (the watch record + level + fan-out condition); the server-spawn-on-a-qualifying-
  comment is W5, which consumes this watch record. **Tests:** `notification-levels.test.mjs` (the predicate,
  every level×event), `doc-watch.test.mjs` (marker CRUD, pause preserves level, last-watcher deletes marker),
  `thread-ledger.test.mjs` (seat vs sid-fallback level, survives respawn), `http-contract.test.mjs` (live
  watch round-trip watch→re-level→pause/resume→unwatch surfaced in read+sweep; live thread-level set + 400 +
  seatless fallback). All 277 app tests + typecheck green. **Live-board smoke** (foolscap-a9921027, throwaway
  doc + thread cleaned up): the `canvas anno watch` CLI loop arm→re-level→pause→sweep→unwatch, and a thread
  `/level` set landing `levels:{human:"mentions"}` on the durable marker.

### W5 — P2: server-spawn-from-record + wake trigger
- **Idle lifecycle (R1):** a session is kept alive ~5 min (server-side idle timer) then exits; default
  reconstitution is a **fresh spawn seeded from thread history + memory**; `--resume` is an explicit,
  assumed-expensive escalation only.
- **Reconstitution:** on a qualifying wake (an addressed thread message to a dormant seat; annotation
  activity a watcher's level covers), the server spawns a session seeded from the durable record.
- **Wake trigger:** reads the watch marker + **derived** annotation/thread state (never raw appends), so it
  only fires on activity that (a) clears a watcher's level and (b) isn't already being serviced. **Single-
  flight per doc**; the worker **loops until the queue is dry**, then winds down (batch within a wake, never
  resident across).
- Closes: R1 dormant-seat respawn, `anchored-async-ask.md` push wake-back (an `answer` wakes the ask-armed
  seat), doc-wake (a comment wakes the doc's watcher), and is the base for R6.
- **Done when:** an answer/comment on a watched doc auto-spawns a per-doc worker that services the whole open
  queue and winds down; an addressed message to a dormant thread seat respawns it; the idle keep-alive→exit
  timer runs.
- **Shipped** (commit `4c749f5`): the reusable core is `app/auto-wake.js` — an in-memory **single-flight
  claim registry** (`docSurfaceKey`/`seatSurfaceKey` → the servicing sid; `claim`/`release`(sid-guarded)/
  `isSurfaceClaimed`) so one worker services a surface's whole queue, plus PURE qualification predicates:
  `qualifyingWatchers` reuses W4's `wakesSeat`/`watcherEffectiveLevel` (an `answer` is *addressed*/mention, a
  `note` comment is a *broadcast* → `all` only; a fresh awaiting `question` wakes no agent — no-op-spawn
  avoidance), and `shouldReapIdle` is the R1 keep-alive decision. All spawning stays in `vite-fs-plugin.ts`
  (`serverSpawnWorker` — the one primitive W6 rides): mint a fresh session via `ensureLiveSession` (**never
  `--resume`** — R1 fresh-seed), claim the surface, drop a server-placed card, seed the worker brief. **Trigger
  1 (doc-wake)** hooks `handleAnnotationsWrite` after a `note`/`answer` append: a live worker in its keep-alive
  window is NUDGED (not duplicated); else a per-doc worker spawns, loops-until-dry, self-`done`s. A
  `--blocking` question auto-arms an **ask-armed watcher** (reserved `ask` role, `mentions`), cleared once no
  unresolved blocking question remains — so the `answer` wakes a continuation with no human pre-watch (async-
  ask push loop closed). **Trigger 2 (dormant-seat respawn, R1)** hooks the `wakeThreadMembers` nudge-drop:
  an @-addressed message to a dormant seat reconstitutes a fresh session (roleId read from the dormant
  occupant's marker, seeded `history:"full"`) that re-fills the SAME seat (`fills++`); a bare broadcast never
  respawns. **Idle lifecycle:** auto-wake workers carry `autoWake`/`idleSince`; `autoWakeReapTick` (on the
  loop heartbeat) winds one down after `IDLE_KEEPALIVE_MS` (5 min) — never a human card or the looping
  Coordinator; the claim releases on exit. **Cap-safe:** a server-fired spawn re-checks `MAX_LIVE_SESSIONS`
  and LOGS the skip (no silent drop) rather than a wake storm. **Tests:** `auto-wake.test.mjs` (13 — keys,
  claim sid-guard/supersede, wake-class × every level/event, the ask-armed pattern, reap decision × window/
  mid-turn/no-stamp/non-worker); full app suite + typecheck green (concurrent-:5173 permission-mcp flake
  aside). **Live acceptance smoke** (foolscap-a9921027, throwaway doc + thread, cleaned up): (1) a
  `--blocking` question armed the `ask` watcher; the human's `answer` auto-spawned a bare doc worker that
  resolved the question (`resolvedBy` = the worker), cleared the ask watcher, and self-wound-down; (2) a
  Generalist seat, terminated to dormancy, was reconstituted by an `@Generalist` message into a fresh sid
  re-filling the seat (`fills:2`, original `createdAt` kept). The 5-min reaper backstop is covered by
  `shouldReapIdle` unit tests (both live workers self-`done`d before the window, so it wasn't exercised
  live). **Known limitation** (per Coordinator, acceptable): in-memory claims mean a server restart mid-
  service can spawn a duplicate worker on the next activity — fine, since single-flight is best-effort dedup
  and the queue ops (apply/answer/resolve) are idempotent.

### W6 — R6 standing jobs
- A `watch` entry with an interval + instruction on a thread/doc marker, server-fired (rides P2's spawn):
  on fire, wake/reconstitute the named seat with the instruction. Norms: **"skip days with nothing"** (a
  firing that finds nothing posts nothing) and **jobs survive their creator** (owned by the place).
- **Done when:** a scheduled instruction fires a worker on its interval and no-ops silently when there's
  nothing to do.
- **Shipped** (commit `55dc302`): the ledger is `app/standing-jobs.js` (+ `.d.ts`) — a standing job
  `{id, role, intervalMs, instruction, by, createdAt, lastFiredAt}` lives on the **thread meta marker**
  (beside seats/intents/pins, via `upsertThreadMeta`), so it survives its creator AND a restart. Pure
  due-logic: `jobDue`/`dueJobs` are **fire-next-due** (a boot-time overdue job — server was down — fires
  ONCE and `stampFired` re-bases the schedule to now; it never replays the fires it missed, the wake-storm
  "skip days with nothing" forbids); `normInterval` clamps to a **60s floor** (the loop tick is ~15s, real
  jobs are minutes+); `jobClaimKey` keys a role job by its **seat** (`seatSurfaceKey` — so a timer fire and
  a dormant-seat respawn mutually exclude on the seat) and a bare job by its own id. **Firing** is
  `standingJobsTick()` in `vite-fs-plugin.ts`, hung on the existing loop heartbeat (`loopTick`, beside
  `autoWakeReapTick`): for each due job it fires via the one W5 `serverSpawnWorker` primitive. **Wake-live-
  else-respawn** (human's efficiency concern, thread seq 104): a role-seat job whose seat is still occupied
  by a **live** session NUDGES that session (cheap — assembled context intact; skipped if it's mid-turn,
  never interrupted), and only a **dormant** target pays a fresh respawn — so the "<5min ⇒ wake existing /
  >5min ⇒ full respawn" split falls out of the 5-min keep-alive window automatically (Coordinator-approved,
  seq 109; also the clean seam for the future looping-Coordinator migration). **Single-flight** (a claimed
  surface isn't double-fired); **fire-next-due** only stamps on a REAL fire (a cap-skipped fire retries next
  tick — no silent drop). The **worker brief** (`standingJobBrief`/`standingJobNudge`) INSTRUCTS the silence
  ("if there's nothing to do, post NOTHING and wind down" — loop-until-dry alone isn't enough; the "all
  clear" noise has to be told-not-to). Surfaces: `POST /api/thread/<id>/job` (create/update by `jobId`, or
  `{remove:true}`) + `GET .../jobs`; `scripts/canvas job add|list|rm`; CLAUDE.md documents both.
  **Tests:** `standing-jobs.test.mjs` (12 — floor clamp, CRUD, first-fire-one-interval-out,
  fire-next-due-not-catch-up, claim keys, coexist-with-seats/intents/pins) + a live `http-contract` job
  round-trip (create → GET → update-in-place → remove, 400/404). Typecheck + full app suite green (bar the
  known permission-mcp :5173 flake). **Verification status — READ THIS:** the ledger, due-logic, and both
  HTTP surfaces are verified live (unit + a read-path replica against the real board marker confirming
  `listThreads`→`readJobs`→`dueJobs` sees a created job as due exactly one interval out). The end-to-end
  **live fire** (tick → spawn a worker) is **pending a dev-server restart**: `standingJobsTick` is installed
  by `startLoopHeartbeat` at board boot, and the long-lived dev process is still running the pre-edit
  `loopTick` (the request handler hot-reloaded — `/job`/`/jobs` are live — but the `setInterval(loopTick)`
  timer is the old closure). This is the same "server code reaches the running server only on the next
  dev-server restart" property W3/W4/W5's server code had; it is NOT a code bug (a bug would still have
  *attempted* a spawn — none was logged). A 160s live watch confirmed no fire on the un-restarted process;
  the fire will activate on the next restart, at which point the throwaway-job smoke should be re-run to
  close the Done-when's "fires a worker" clause. I did not restart the shared, actively-used dev server
  unilaterally (peers mid-work + session budget wind-down) — flagged to the Coordinator.

### W7 — R-PIN + R5
- **R-PIN:** any thread message is pinnable; the pinned set is the head-context tray, re-read on every wake,
  kept in chronological place, rendered as a collapsible tray on the card.
- **R5:** the thread's `Done when:` condition is a pinned post; a `done` intent must be accompanied by a
  thread message with proof against it; the Coordinator's review = checking proof against condition.
- **Done when:** a message can be pinned and shows in a tray; a Done-when + proof-at-done norm is in the
  briefs.
- **Shipped** (`3f556d9`; ledger helpers bundled in `addaf14`): pins are SNAPSHOTS on the thread marker
  (`pins: [{seq, from, text, ts, pinnedBy, pinnedAt}]`, chronological), so a pin survives the log's bounded
  tail — `readPins`/`pinMessage` (idempotent by seq)/`unpinMessage` in `thread-ledger.js` (+ `.d.ts`).
  New endpoint `POST /api/thread/<id>/pin {from, seq, pinned?}` (default pins; 400 bad seq, 404 no message,
  403 non-member). Pins ride the `thread:<id>` feed via `publishThreadFeed`, and `/api/inbox` returns a
  channel's `pinned` array on every wake (re-served, never consumed — the head-context re-read), attached to
  any thread with fresh messages. Card UI (`NodeView.tsx` + `style.css`): a collapsible amber pinned tray
  above the log, plus a per-message 📌 toggle (`setThreadPin` in `threads.ts`); a pinned message keeps its
  place in the log, lit. **R5 norm** added to the collab brief + the thread-join brief: a `Done when:`
  condition should be pinned, and a `done` intent must carry a thread message with PROOF against it. Tests:
  `thread-ledger.test.mjs` (pin snapshot/idempotence/chronology/coexists-with-seats+intents) +
  `http-contract.test.mjs` (live pin→unpin round-trip, 400/404). Live-board smoke: pinned the W7 assignment
  on this thread, confirmed the durable marker + `/inbox` `pinned`, unpinned. CLAUDE.md updated (the
  agent-coordination § now documents `/pin` + the R5 done-discipline norm).

### W9 — PM → Coordinator rename
- Repo-wide mechanical rename (currently doc-only in `claude-tag-lessons.md`): `docs/agent-roles.md`, the
  PM-named memories, the role definition, the briefs. Independent, do anytime.

### W10 — proactive mid-turn board-check norm
- **Briefs/norms only, no mechanism.** The *live-agent* half of non-interrupting comms (W4/W5 are the
  *dormant-agent* half): during a **long** turn, an agent proactively `GET /api/inbox` at **natural
  checkpoints** — after finishing a sub-task, before an expensive or irreversible step — not between every
  tool call, so peers/humans can redirect it without a hard `/input` interrupt.
- **Bake in the gotcha:** reading `/api/inbox` **advances the read cursor**, so a mid-turn peek *consumes*
  the nudge; the norm is **peek-and-act** (or explicitly note what you saw), never peek-and-defer, or a
  message is silently dropped.
- Land in the collab brief (`app/vite-fs-plugin.ts`) + `CLAUDE.md`. Depends on **W4 committed** only so it
  doesn't churn the shared brief file mid-flight; sequence *before* W5 (which also edits `vite-fs-plugin.ts`).
- **Done when:** the collab brief + `CLAUDE.md` state the checkpoint-poll norm and the peek-and-act cursor
  gotcha; no code/mechanism change.
- **Shipped:** the norm is stated in both places, no mechanism change. **Collab brief**
  (`app/vite-fs-plugin.ts`, a new `CHECKPOINT-POLL` paragraph after the `RECEIVING` block): during a LONG
  turn, proactively `GET /api/inbox` at natural checkpoints — after a sub-task, before an expensive/
  irreversible step — not between every tool call; it's the live-agent half of non-interrupting comms
  (lets a peer/human redirect a heads-down agent without a hard `/input` interrupt). Plus the **peek-and-act**
  rule: an inbox read advances the cursor, so a mid-turn peek *consumes* the nudge — act on what you saw this
  turn (or note what you saw and will do), never peek-and-defer, or the message is silently dropped.
  **`CLAUDE.md`** (the "Read (the wake model)" bullet, expanded from "Call it when nudged or proactively"):
  the same two parts in that file's prose voice. `cd app && npm run typecheck` clean (text-only change).

## Suggested sequence

`W1` first (retires the ask-block anti-pattern, ships on today's substrate) — with `W3`, `W7`, `W9` runnable
in parallel sessions (no unmet deps). Then `W2` (rides W1). Then the primitives in order: `W4` (P1), then
`W5` (P2) — the structural core that unlocks the push half of async-ask, R1, doc-wake, and R6 at once. Then
`W6` (rides P2). `W8` is ambient/later.

## How to drive this (the carry-forward mechanism)

- **This doc is the durable source of truth** — the ordered checklist, kept current in the Status column. A
  fresh session's first move is to read this doc + the referenced design sections for its item.
- **A driving thread** (`type:"thread"`, referencing this doc as its brief link) is the coordination home:
  handoffs, status, who's on which item, and blocking questions live there — one task with a conversation,
  per our own model. The thread's `Done when:` is "all non-LATER items shipped & verified."
- **Increments are kicked as fresh sessions**, one per item (or a small parallel set for the independent
  W1/W3/W7/W9). Each session: reads this doc, does its item, runs the package's tests + typecheck,
  smoke-tests against the live board, commits, updates the Status column and posts a handoff to the thread.
- **Not a fully-autonomous Coordinator — yet.** The self-driving version (a Coordinator that wakes builders
  via standing jobs) depends on exactly the machinery this plan builds (P2 + R6 + the self-wake heartbeat,
  which is only partial — see `canvas-session-self-wake`). Bootstrapping the build with its own unbuilt
  output is fragile. So: **before W5, drive manually** (human- or thin-Coordinator-kicked sessions + this
  doc + the thread). **After W5+W6 land, the project can graduate to being driven by its own machinery** —
  a nice dogfood milestone, and a real acceptance test of P2.

## Open questions (carried, not blocking)

- **R1 cache empirical** — whether process-exit evicts the prompt cache / `--resume` reuses it. The 5-min
  keep-alive design *sidesteps* this (never depends on resume reusing a cache), so it's **not on the
  critical path**; worth a one-off measurement if we ever want explicit-resume to be cheap.
- **R3 spend accounting** — deferred; cheap to record on the thread marker once P2's marker exists.
- **Multiplicity of seats** — labelled multiple seats of one role on a surface (`threads-as-cards.md` §5)
  is still 1:1; not needed until a real case appears.
