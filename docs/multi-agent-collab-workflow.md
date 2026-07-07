# Worktree-based multi-agent collaboration workflow

*Thread `node:thread:e1784729`. This supersedes the 2026-07-05 discussion capture — the open questions it
raised are now decided and the mechanism is built. Stages 1 and 3 have shipped; Stage 2 is a Coordinator
discipline, not code. Design context still lives in the commit history (Stage 1 = `ad305e2`).*

## The problem (observed in batch 1)

Several builder sessions ran in parallel in **one shared working tree on `main`**. The recurring pain:

- Agents noticed files they were editing had changed under them → **reread mid-edit**.
- `git add -A` **swept other agents' in-flight work** into one commit (four items collapsed into `addaf14`),
  forcing git-log archaeology to see what actually landed where.
- Tests **failed under concurrent runs** — both file state changing under a run, and several agents hammering
  the single dev server on the fixed port `:5173`.

The old coping mechanism was the **"bundled-commits-OK" policy** (`git add -A`, never disentangle). It worked
but produced messy history and was a symptom, not a fix. Worktrees replace it.

## The shape (three stages)

Each agent works in its **own git worktree** — an isolated checkout on its own branch — instead of the shared
board root. Files no longer collide; each work item gets **clean, per-item history** (one branch, one merge
commit). What worktrees do NOT do is make *shared-file* changes free: they **defer and batch** those
collisions to merge time. So the win is not the mechanism alone — it is the mechanism plus **Coordinator-side,
overlap-aware scheduling** and a **merge-on-green** gate. Three stages:

### Stage 1 — the worktree spawn primitive (SHIPPED, `ad305e2`)

`scripts/canvas spawn --worktree [--base REF] [--worktree-key KEY]` runs a server-spawned session in its own
git worktree under the board's `.canvas/worktrees/` home (git-excluded, so it never pollutes the canonical
`git status`). Details that matter:

- **Keyed by WORK ITEM, not session.** Sessions are ephemeral (a fresh sid each respawn — see the
  never-resume-sessions norm), so a worktree belongs to the *work item* and whatever session is doing that
  work **attaches** to it. Key precedence: explicit `--worktree-key` → role seat (`role:<id>`) → the thread
  id. A respawn **re-attaches** to the same tree + branch (mid-flight work intact); it never cuts a fresh one.
- **The durable record lives on the thread marker** (`.canvas/threads/<id>.meta.json`, a `worktrees` map
  beside `seats`/`intents`/`pins`), so it survives the occupant's exit and a server restart.
- **`node_modules` is symlinked, never copied** — native deps are code-signed per host, and this is one
  machine — so an in-worktree `npm test` / `tsc` resolves deps against the single installed copy.
- Ledger: `app/worktrees.js` (`ensureWorktree` / `removeWorktree`, work-item-keyed). CLI: `worktree list`
  and `worktree rm` (guarded teardown — see below).

### Stage 2 — Coordinator file-overlap discipline (a scheduling norm, not code)

The Coordinator assesses **file overlap before fanning out**, because worktrees isolate files but do not
resolve overlapping edits — they turn them into merge-time conflicts:

- **File-disjoint items → parallel worktrees**, merged as they land. Near-zero conflicts; pure win.
- **Overlapping items → serialize them, or re-cut the split into vertical slices** so each agent *owns* a
  file/module rather than co-editing it. For heavily-overlapping work, parallelism itself is the cost — pay
  it deliberately or restructure the split to avoid it.

Concretely: before spawning a fan-out, list each item's likely file set and flag intersections; only fan out
the disjoint set in parallel, and hold or re-slice the rest. A builder posts the files it will claim in the
thread **before** editing (the claim step), so an overlap the Coordinator missed still surfaces early.

### Stage 3 — merge-on-green (SHIPPED)

`scripts/canvas worktree merge <THREAD> [--key K | --role R] [--base main] [--no-verify] [--force]` merges a
work item's branch into `main` and tears its worktree down in **one command**. It is an **explicit act** the
builder (or Coordinator) fires when work is complete — like teardown, and deliberately **not** auto-fired on
`/done` (a `done` intent still carries proof; the merge stays a separate, reviewable step). The op, in order:

1. **Preconditions** (all hard refusals, with actionable messages):
   - the **worktree must be clean** — a merge only carries *committed* work, so the builder commits first;
   - the **canonical checkout must be on the target branch** (`base`, default `main`) and **clean** — never
     merge into a dirty or wrong-branch tree.
2. **Green gate** (skip with `--no-verify`): run `npm test` + `npm run typecheck` **in the worktree** for the
   packages the branch touched — always `app` (the integration surface), plus `core`/`interaction` when the
   branch diff touched them, deps-first. **Any non-zero aborts the whole op** — nothing is merged.
3. **Merge**: `git merge --no-ff` into `base` from the canonical checkout (a legible merge commit per item).
   On **conflict**, `git merge --abort` so the canonical index is **never left conflicted** — the builder
   rebases/resolves on the branch and re-merges.
4. **Teardown**: reuse `removeWorktree` (its dirty/unmerged guard is a no-op now the branch is in `HEAD`) to
   remove the worktree, delete the branch, and drop the record.

Ledger: `mergeWorktree` in `app/worktrees.js`; server op `merge` in `handleThreadWorktree`
(`vite-fs-plugin.ts`); tests in `app/test/worktrees.test.mjs`.

## What we deliberately did NOT build

- **No serial live-board integration gate.** The 2026-07-05 capture proposed serializing the live-board
  (`:5173`) integration tests behind one lock or a single post-merge pass. We rejected that: the green gate is
  **unit tests + typecheck run in-worktree**, which need no shared server. We accept that **brief `main`
  breakage is possible** (a clean-merging-but-semantically-incompatible pair of edits can slip past
  per-branch unit gates) and rely on **bisect across the per-item merge commits** to localize it — the clean
  per-item history the worktree model buys us is exactly what makes that cheap. A serial integration gate
  would reintroduce the `:5173` contention we set out to remove and serialize the whole fan-out on its
  slowest member. Not worth it.
- **No auto-merge-on-`/done`.** Merge stays an explicit act (see Stage 3). Coupling it to session exit would
  merge unreviewed work the moment a process ends.

## The integrator question (resolved)

Sessions are ephemeral: by merge time the authoring agent may be gone. The 2026-07-05 capture left open
whether a dedicated *integrator role* should own merge + fix. **Resolved: no separate role.** Merge-on-green
folds the gate into the merge command itself, so the merger is simply whoever runs `worktree merge` — the
builder at completion, or the Coordinator sweeping finished items. If a merge later proves to have broken
`main`, the fix is a **fresh spawn** for the affected item (the ephemeral-session model — never a resume),
with the **commit history + thread replies** as the durable context that spawn reads. The Coordinator owns
that sweep; no new seat is needed.

## Still open (parked, not blocking)

- **Lost in-session codebase knowledge.** When work spreads across many ephemeral agents, each re-derives
  shared understanding of the codebase. This is a **separate, recurring problem** (not specific to
  worktrees) — the oracle role, board memory, and per-doc watchers each nibble at it, but it wants its own
  treatment. Pointer, not solved here.
