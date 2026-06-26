# The shadow git ledger: a high-resolution, canvas-owned file timeline

*Prepared 2026-06-23. Companion to `undo-scrubbing-and-history.md` (§2 content lives in files/git, §4
driver-axis scrubbing, §7 the boot-reconcile path), `file-trees-on-canvas.md` (§8 git is the file-activity
clock projected onto the tree, §9 derived-by-default), `session-timelines.md` (one source per timeline),
`architecture-review-2026-06-09.md` (§2 content/git, §4 git as a second timeline) and
`agent-sessions-on-canvas.md` (the live-vs-historical duality). Decides how Claude-produced file artefacts
gain a durable, reactive, scrub-able history on the canvas. The headline: **file content is the one live
stream with no durable ledger; the shadow git supplies it — a canvas-owned, higher-resolution, per-root
commit DAG over the same working tree, written by the engine and invisible to agents.** It is the concrete
realization of "git is the file timeline" the other docs already decided, and it stays **off the intent
log** per "one source per timeline."*

---

## 1. The reframe: the missing ledger, not a new log

Every live stream in the app already has **two tiers** — an off-log "current" signal plus a durable,
replayable ledger sized to its payload. File content is the only one missing its ledger:

| Stream | Live tier (off-log) | Durable ledger | Source-of-truth doc |
|---|---|---|---|
| Session feed | `session:<id>` SSE feed | `.jsonl` transcript | `agent-sessions-on-canvas.md` |
| Canvas structure | signia store / channel 1 | intent log (channel 3) | `undo-scrubbing-and-history.md` |
| **File content** | `setFileContent` / `fileContentSignal` | **— nothing —** | *this doc* |

The shadow git is that missing ledger. It is **not** a new channel and **not** an extension of the intent
log: "content lives in files/git" (`undo-scrubbing` §2) has always placed file content *outside* the three
store channels. The shadow ledger simply gives that content tier the **resolution** it lacked — a dense,
canvas-owned commit stream instead of only the human's sparse curated commits.

The artefact question that motivated this ("how do Claude-produced artefacts live reactively on the
canvas?") resolves into the file path: an artefact *is* a file; reactivity is the existing watch →
`fileContentSignal` → re-render path; **history** is what was missing, and that is what this adds.

## 2. What this is NOT (the corrected position)

A dialogue while designing this briefly concluded that file edits should earn **lightweight pointer events
on the intent log** (`write`/`observed` kinds) to make the intent log a single complete scrub spine. **That
was wrong** — it contradicts two decided docs, and it is recorded here so the detour is not re-walked:

- `undo-scrubbing` §4 explicitly *rejects* a single merged timeline: *"They do not merge into one ordered
  sequence: their orders differ, and `seq` is not wall-clock time. So: pick a driver axis; project
  everything else onto time."* Git content history is its **own** timeline, navigated natively.
- `file-trees-on-canvas` §9/§11: *"the only thing that earns a channel-3 event is committing a file,
  directory, or claim to the board — once. Browsing, expanding, heat, and the scrub are all channel-1
  projection; they never touch the log."* File content changes are channel-1 derived, never persisted.

The concern behind the detour — *rewind breaks if the log is incomplete* — is real but mis-aimed.
Completeness belongs to the **file timeline (this ledger)**, not the intent log. Provenance of *who edited
what* rides git's own **author** and **commit message** fields (the pointer payload already exists on the
commit). The intent-log pointer was redundant with git's own attribution. So:

- **The intent log stays gesture-only.** Untouched by this work.
- **The shadow git is a separate, complete file timeline.** It is *not* a mirror of the project git's
  branches — it is an independent, ~linear per-save snapshot stream over the same files (an agent's
  `checkout`/`rebase` shows up as a bulk content snapshot, not as branch topology).

## 3. The mechanism: `--git-dir` over a shared work-tree

Git tracks two independent locations: the **work-tree** (the files) and the **git dir** (the object
database, refs, index). Normally colocated as `.git`; they can be split:

```
git --git-dir=/proj/.canvas/git --work-tree=/proj add -A
git --git-dir=/proj/.canvas/git --work-tree=/proj commit -m "session X · turn 7 · edit loader.ts"
```

The **same files** are tracked by **two independent repositories** — the human's `/proj/.git` and the
canvas's `/proj/.canvas/git` — each with its own index, HEAD, branches, and history. They never see each
other's commits. **Files shared, commits distinct.** This is the classic "dotfiles bare repo" pattern
(`git --git-dir=~/.dotfiles --work-tree=~`), battle-tested.

Why it is safe — but note these are **preconditions to establish, not facts that hold today** (an
independent review, 2026-06-23, found the codebase satisfies none of them yet):

- **Separate index** → the shadow `git add` never touches the human's staging area or `git status`.
- **Independent excludes** → the shadow repo's `info/exclude` must be *generated* at provision time from
  the union (`EXCLUDE_DIRS` ∪ the project `.gitignore` ∪ `.git` ∪ `.canvas/git`) — and **only `.canvas/git`,
  not all of `.canvas`**, so `.canvas/artefacts/` stays tracked for history (§8). Without this the boot
  `add -A` (§5) stages `node_modules`/`dist`/the human's `.git` into the per-save DAG. A fresh `--git-dir`
  repo does *not* read the project `.gitignore` automatically; the engine must mirror it, and re-mirror
  when the human edits `.gitignore` (the watcher sees that change — close the loop).
- **The human's `.gitignore` must gain `.canvas/`** — it does **not** today (`/.gitignore` ignores
  `node_modules`/`dist`/logs/editor dirs only). Until added, the human's `git add -A` swallows the shadow
  object DB. This is a *step-0 task*, not a standing fact.
- **The watcher feedback loop must be closed first.** The recursive file watcher (`vite-fs-plugin.ts:476`,
  ignore set `EXCLUDE_DIRS:230`) does not exclude `.canvas`, so a shadow commit writing objects into
  `.canvas/git/` would re-fire the watcher → another commit → unbounded loop. This is exactly the
  "write-back echo loop" `architecture-review` §3 named as *the* hard part for content ingest. The watcher
  must ignore **`.canvas/git`** (a path-prefix, since the current ignore is segment-based and can't express
  a sub-path) while still seeing `.canvas/artefacts/` for live artefact rendering. Committing does not
  rewrite an artefact file, only the DB, so watching artefacts cannot loop.

Contrast with worktrees (which the app already discovers, commit `b3545ca`): `git worktree` is the opposite
move — many work-trees *sharing one* history. The shadow ledger wants the reverse — one work-tree,
*separate* history — so `--git-dir`, not a worktree, is the right primitive.

## 4. Layout: one `.canvas`, central databases, work-trees pointing out

Because `--git-dir` and `--work-tree` are independent, **all shadow databases live in one place while their
work-trees point at scattered directories.** This is what keeps the board *one board* across worktrees:

```
/proj/.canvas/                     ← ONE .canvas, anchored at the primary root
├── board/                         ← the ONE board snapshot (deferred, §8) — not per-root
├── artefacts/                     ← non-file artefacts (default home, §8)
└── roots/
    ├── main/git/                  ← shadow git-dir,  --work-tree=/proj
    └── wt-foo/git/                ← shadow git-dir,  --work-tree=/proj-worktrees/wt-foo
```

- **The board is one** — board structure + intent log live once, not per-root. No fragmentation.
- **File histories are per-root, correctly** — each worktree is a different branch with genuinely different
  file contents; a merged file-history across them would be incoherent.
- **Histories survive worktree removal** — the database lives centrally under `.canvas/`, so
  `git worktree remove` deletes the files but the ledger of what happened there persists (the engine
  tombstones the root, per `84c4b4d`, without losing its shadow history).

Cross-root unification happens at the board layer (the file-tree projection and activity overlay,
`file-trees` §8/§10), never by merging the per-root git DAGs.

## 5. The committer: watcher floor + optional enrichment + boot reconcile

One committer, server-side, layered for **completeness first, richness when available**:

- **The watcher is the committer and the completeness floor.** The existing `/api/watch` chokidar watcher
  (already per-root) sees *every* change — agent, human, external tool, git operation. Debounce to a
  "settle" window, then commit the batch. Nothing is silently missed.
- **The session feed is enrichment, not a second committer (per-edit-tool-call, *not* turn-boundary).** The
  engine parses each session's stdout: an `assistant` `tool_use` of `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
  **claims** its target path, and the matching `user` `tool_result` **commits that one path** attributed
  `session:<8hex>`. The watcher floor defers — its settle `add -A` *excludes* claimed paths — so the
  attributed commit, not the floor, owns the edit. Anything the floor can't name (Bash `>>`/heredoc writes,
  human saves, external tools, git operations) it commits as `external`. Attribution is path-scoped and
  per-edit, so concurrent sessions touching one root never cross-contaminate; it is read from the agent's own
  declared tool target, never inferred from feed *timing*.
- **Per-edit, never per-delta.** Content streams token-by-token off-log (the existing live tier); the
  *commit* is the durable checkpoint at each editor tool call's `tool_result` (or, for out-of-band writes,
  at watcher settle). Two tiers, same as session feed vs `.jsonl`.

**Boot reconcile (downtime).** When the server is down, no watcher runs and changes are unobserved
(chokidar starts with `ignoreInitial`). On committer startup, before arming the live watcher, each root
runs a reconciliation commit:

```
git --git-dir=…/roots/<r>/git --work-tree=<path> add -A && commit -m "external: changes while offline"
```

`add -A` diffs the **current tree against the last shadow HEAD**, so *all* offline changes — however many
processes, however many edits — collapse into **one bundled `external` commit** per root. This is the
honest representation: offline, you have no information about intermediate states, so a single "moved A→B
externally" commit is the only truthful record. This is the `undo-scrubbing` §7 "boot-reconcile path" made
concrete. Properties: **graceful degradation** (dense + attributed while live, coarse while offline, never
a gap), and **crash-safety** (a debounced batch lost to a crash is swept up by the next boot's reconcile).

**Serialization, attribution, and a size guard** (review hardening):

- **One commit at a time per shadow repo.** Each `--git-dir` repo has a single index and `index.lock`; a
  watcher-settle racing a per-edit attributed commit, or two saves in flight, hit `fatal: Unable to create
  index.lock`. All commits to a root go through a **per-root async mutex** (one `add`+`commit` in flight),
  and the attributed commit and the floor stage **disjoint** path sets (the floor `reset`s claimed paths so
  they stay dirty for their attributed commit) — so they cannot race for the same edit.
- **Attribution is honest, not guessed.** It comes from the agent's own declared tool target — the path in
  an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` `tool_use` — committed path-scoped on the matching
  `tool_result` as `session:<8hex>`. The watcher floor still carries only `{type, path}` (`:473`) with no
  actor, so anything it can't tie to a claimed editor tool call (concurrent or out-of-band writes) it labels
  **`external`** — never inferring a session from settle timing. *Turn boundary was tried and rejected*: a
  turn spans many edits over minutes, so the 800ms debounce committed the edit `external` long before the
  turn ended, and a turn-end whole-tree `add -A` misattributed concurrent agents' in-flight files. Per-edit
  is both the right granularity and the right attribution unit.
- **Refuse pathological blobs.** A single file over a size cap is not bundled into the ledger (it would live
  in the DAG forever, GC deferred); surface a `truncated`-style flag, per the repo's own cap discipline
  (CLAUDE.md). The reconcile uses the *same* exclude set as live commits, so a `.gitignore` edit made while
  offline can't turn the catch-up into a giant spurious add/delete.

## 6. Engine-owned, agent-invisible

The whole mechanism is **observational**: the engine records what happened to the files; agents are
unaware and use the normal `.git` exactly as usual.

- **No API to call.** "Free to ignore" is automatic — the ledger is an observation, not an opt-in.
- **No agent hooks; attribution is observed, not cooperated.** There is no Claude Code Stop hook or sentinel
  the agent writes. The engine reads attribution straight out of the session's own stdout (the editor
  `tool_use`/`tool_result` pair it already emits), and the watcher floor catches everything else as
  `external`. An agent does nothing differently — and could not opt out if it tried.
- **Agent git operations are faithful content snapshots, not branch mirrors** (§2). `checkout`/`rebase`
  appear as bulk shadow commits — correct, and independent of project branch topology.
- **The only optional agent awareness is the artefacts *destination*** — the `.canvas/artefacts/` path
  convention (learned from the collab brief), for deliberately-produced canvas artefacts. Editing existing
  code needs zero knowledge; an agent that ignores the convention still gets its files versioned.

## 7. How it serves scrubbing, undo, and provenance — without touching the intent log

All three are already specified to ride git, so the shadow ledger drops in:

- **Scrubbing** = drive the shadow-git DAG, project the board as-of-T (`undo-scrubbing` §4, §7). The
  shadow ledger is the higher-resolution DAG the §7 git-repo scrubber wants. The `session-timelines`
  "one source per timeline" rule holds: the file timeline is git, the board timeline is the intent log.
- **Provenance** ("who touched what, when") = the commit **author** (= session id, or `external`) and
  **message**, surfaced by the activity overlay (`file-trees` §8/§10) as a derived view parameterized by
  `t`. No stored board state, no intent event.
- **Content undo** = `git revert` semantics, selective by the commit's author/source (`undo-scrubbing`
  §3). Filtering shadow commits by author gives per-actor selective undo of file edits with no intent-log
  pointer.

## 8. Artefacts and the publish boundary

Artefacts are file-native; the only question is *which path*, and that is a per-root, per-layer choice:

- **Default: `.canvas/artefacts/`** — hidden, tidy, the ephemeral personal home. This is the **clean
  "tracked here, ignored there"** case, and it works precisely because the two repos have *independent*
  excludes: the main `.gitignore` ignores all of `.canvas/` (artefacts never reach the human's PRs), while
  the shadow excludes ignore only `.canvas/git`, so `.canvas/artefacts/` **is** tracked and scrub-able.
  Live re-render of artefact cards needs the watcher to see `.canvas/artefacts/` (it ignores only
  `.canvas/git`); even if it didn't, the commit's full-tree `add -A` captures artefacts regardless.
- **Promote into the repo** (e.g. `outputs/`, `notebooks/`) when artefacts are deliverables — common in
  data-exploration repos. The rule: **shadow repo = history the human's repo shouldn't carry; main repo =
  deliverables; the boundary is which path an artefact is written to.**

A turn that edits `src/foo.ts` *and* emits `artefacts/chart.svg` lands both as **per-edit commits in the
same shadow DAG, attributed to that session** — code and artefacts share one coherent, attributed timeline
(impossible with two repos), even though each editor tool call is its own commit.

**Rendering** reuses the runtime card-type templates (`card-types-as-data.md`): render-by-type
(`.md`→rendered, `.html`→iframe, `.mermaid`→diagram, `.svg`→image). A **diff/commit card** — the diff as a
first-class, attributed, reactive artefact — is the natural richer view, deferred.

**Board persistence** (where the board snapshot + intent log themselves live, and whether the board is an
opaque blob or an exploded directory of card-files) is a *separate* decision, deferred. The shadow-git work
does not depend on it; the `.canvas/board/` slot above is a placeholder.

## 9. Channel-discipline check

- **Channel 1 (renderer / feeds):** file content (`fileContentSignal`), the activity overlay and scrub
  at time `t`, the diff render. Derived, never persisted. *Unchanged.*
- **Channel 2 (persistence / index / undo):** arrangement diffs for promoted nodes; content undo executes
  as `git revert` against the shadow ledger (§7). *Unchanged in shape.*
- **Channel 3 (intent log):** pin / claim / annotate / arrange — gesture-only. **Zero new event kinds; the
  shadow ledger adds nothing here.** The rejected `write`/`observed` pointers (§2) stay rejected.
- **The shadow git is the content tier** ("content lives in files/git", `undo-scrubbing` §2) — outside the
  three store channels, given resolution. It is a fourth durable store, peer to the `.jsonl` transcript.

## 10. What already exists vs what is new

**Free inventory:**

- `/api/watch` — chokidar SSE add/change/unlink, already per-root (`vite-fs-plugin.ts`).
- `startGitHeadFeed` + commit-watcher (commit `5bc3583`, `vite-fs-plugin.ts:608`) — re-renders attributed
  cards live on commit. *But it watches the **human's** `.git/HEAD` + `.git/logs/HEAD` only;* reusing it for
  the shadow DAG is net-new wiring (a second feed over each shadow git-dir), not free — listed under New.
- `fileContentSignal(root, path)` (`content.ts`) — off-log content as a channel-1 signal; the live tier.
- `fileNodeId(root, path)` (`loader.ts`) — deterministic ids; a card can reference a path's history
  whether or not the node is materialized.
- Worktree discovery + tombstones (`b3545ca`, `84c4b4d`, `d317d3b`) — multi-root provisioning to hang
  per-root shadow ledgers on.
- The live-vs-historical session duality — one card type, two clocks; the file timeline reuses it.

**New:**

- The **shadow committer** — per-root `--git-dir` provisioning, settle-debounced commits, per-edit session
  attribution (path-scoped, from the editor `tool_use`/`tool_result` pair), ignore rules. *Done + verified.*
- **Boot reconcile** — the offline catch-up commit (§5). *Done.*
- The **git-log middleware feed** — commits with author/timestamp/changed-paths up to a given time
  (`file-trees` §8 "the one substantial new endpoint"), now over the shadow DAG.
- **Render-by-type card templates** + (deferred) the diff/commit card.

## 11. Staged path

Each step is independently useful; the ledger (step 1) is the anchor.

0. **Prove non-interference *both directions* before committing anything** (revised after review — the
   naive "commit on watch-settle" spike would ship the feedback loop and silently pollute `git status`):
   - **0a** — add `.canvas/git` to the watcher ignore (path-prefix) *and* `.canvas/` to the project
     `.gitignore`.
   - **0b** — assert a shadow commit emits **zero** watcher events and leaves the human's `git status` clean.
   - **0c** — generate the shadow `info/exclude` from the engine exclude set so `add -A` cannot stage
     `node_modules`/`dist`/`.git`, while `.canvas/artefacts/` *is* tracked.
   - **0d** — *then* the `--git-dir` committer for the primary root, serialized through a per-root lock,
     labelling commits `external` (honest floor). No UI.
1. **Boot reconcile + per-root + attribution** *(done + live-verified)* — the offline catch-up commit;
   provision/retire shadow ledgers as worktrees appear/vanish; per-edit `session:<8hex>` attribution read
   from each editor tool call (claim on `tool_use`, commit path-scoped on `tool_result`), watcher floor
   labelling everything else `external`.
2. **Git-log feed + scrubber** — expose the shadow DAG as a log feed; drive it as the scrub axis, project
   the board as-of-T (reuse the session live-vs-historical duality). Realizes `undo-scrubbing` §7.
3. **Artefact rendering** — render-by-type templates; the `.canvas/artefacts/` convention; later, the
   diff/commit card.

## 12. Pin vs defer

**Protect now:**

1. **The shadow git is a separate file timeline, not an intent-log extension** (§2). Gesture-only intent
   log; "one source per timeline" holds.
2. **`--git-dir` over a shared work-tree** (§3) — files shared, commits distinct; never per-save commits
   to the human's `.git`.
3. **One `.canvas`, central databases, work-trees pointing out** (§4) — one board across worktrees;
   histories survive worktree removal.
4. **Watcher is the completeness floor; hooks enrich, never gate** (§5) — and the boot-reconcile bundles
   offline edits into one honest `external` commit.
5. **Engine-owned and agent-invisible** (§6) — no API to call; agents use normal `.git`.
6. **Commit per save/turn, never per delta** (§5) — stream live off-log, checkpoint on settle.

**Defer:**

- Board persistence representation (blob vs exploded card-files) and where the board snapshot + intent log
  live (§8) — independent decision.
- The diff/commit card and richer render-by-type polish (§8).
- First-class conflicts / multi-writer per-actor content undo (`undo-scrubbing` §6/§8) — inherited, not
  new here.
- Shadow-history GC / depth caps — only once density is proven to bite.
