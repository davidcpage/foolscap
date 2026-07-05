# Multi-agent parallel-collaboration workflow (discussion capture)

*Discussion note, 2026-07-05. Captured from the "wakeable substrate" build thread
(`node:thread:b8ec7f42`) at the human's request, to be taken into a **dedicated thread** and turned into a
real design/decision once the current primitive chain (W4→W5→W6) lands. This is a capture of a
conversation, **not a committed decision** — the open questions at the end are genuinely open.*

## The problem (observed in batch 1)

Batch 1 ran ~5 builder sessions in parallel (W1/W2/W3/W7/W9) in **one shared working tree on `main`**. The
recurring pain:

- Agents noticed files/docs they were editing had been changed under them → **reread mid-edit**.
- `git add -A` **swept other agents' in-flight work** into one commit (W2/W3/W7/W9 all collapsed into
  `addaf14`), forcing git-log archaeology to understand what actually landed where.
- Tests **failed because of concurrent runs** — both file-state changing under a run and, especially, several
  agents hammering the single dev server on the fixed port `:5173` (the "permission-mcp / ECONNREFUSED"
  flake we kept hand-waving).

The repo's current coping mechanism is the **"bundled-commits-OK" policy** (`git add -A`, never
disentangle). It works but produces messy history and is a symptom, not a fix.

## What worktrees fix — and what they don't

**Worktrees cleanly fix the file half.** Each agent gets an isolated working copy → no mid-edit reread
churn, no cross-agent `git add -A` contamination, and **clean per-item history** (one commit/branch per
item). That last point lets us *drop* the bundled-commits policy. The platform already endorses this shape —
the Agent/Workflow `isolation:"worktree"` mode exists for exactly "agents mutate files in parallel and would
otherwise conflict."

**Two things worktrees do NOT fix:**

1. **Shared `:5173` server contention.** The flake came from concurrent test runs hitting the *same* dev
   server on the fixed port (strictPort; one server; per-origin IndexedDB — we can't just spin per-worktree
   servers on different ports without fighting that). Integration tests that touch the live board are an
   inherently **shared resource**; worktrees isolate files, not the running server. This needs a
   **serialized integration-test gate** regardless of worktrees.
2. **Shared-file merges don't vanish — they move to merge time.** Batch-1's items genuinely overlapped
   (`NodeView.tsx`, `vite-fs-plugin.ts`, `style.css` touched by 3–4 items each). In separate worktrees those
   become real git conflicts (or, worse, clean-merging-but-semantically-incompatible edits) at merge.
   Worktrees **defer and batch** that collision; they don't remove it. For heavily-overlapping items,
   parallelism itself is the cost.

## The recommended shape

Worktrees are the *mechanism*; the win is **Coordinator-side, dependency-aware scheduling**:

- **Assess file-overlap before fanning out.** File-**disjoint** items → parallel worktrees + merge-as-they-
  land (near-zero conflicts, pure win). Heavily-**overlapping** items → serialize them, or **re-cut the
  split into vertical slices** so each agent *owns* a file/module rather than co-editing it.
- **Serialize the live-board integration tests** behind one gate (a lock, or a single post-merge pass), not
  run concurrently per agent. This alone kills the `:5173` flake.
- **Two-phase** (work-in-worktrees → merge → integration-test-once-all-complete) is the right shape for the
  disjoint-parallel case.

## The integrator (the structural caveat)

Sessions are **ephemeral**: by merge time the authoring agents are **gone**. If A's merge breaks B's
already-landed work, nobody's home to fix it. So two-phase needs a **designated integrator** that owns
merge + integration-test + fix. Human's framing (seq 60), carried here:

- A dedicated **integrator role** makes sense — could be the Coordinator, or a separate role. **Open which.**
- **Builders pass back merge + test instructions** as part of their handoff.
- **On failure, wake/respawn a builder** for the affected item — the ephemeral-session model means fixing a
  merge break is a fresh spawn, not a resume.
- **Commit logs + diffs + replies to the main thread should hold the context** the integrator needs — the
  durable trace, not the dead process.

## Open questions (for the dedicated thread)

- **Integrator = Coordinator or a separate role?** (Coordinator already owns commit-authority + thread
  legibility; a separate role keeps merge/integration a distinct, staffable seat. Unresolved.)
- **`scripts/canvas spawn` has no `--worktree` yet** — it drops agents into the shared board cwd. A
  worktree-per-builder workflow needs that option (git worktree add + per-worktree `node_modules` handling —
  symlink vs install; native deps are code-signed per host, so shared symlink is likely right on one
  machine).
- **Serialized-integration-test gate mechanism** — a simple lock on `:5173`, or an ephemeral per-run server,
  or just "only the integrator runs the live-board tests." Cheapest that works.
- **Lost in-session codebase knowledge** (human, seq 60): when work spreads across many ephemeral agents,
  each re-derives shared understanding of the codebase. This is a **separate, recurring problem** (not
  specific to worktrees) — the oracle role, board memory, and per-doc watchers all nibble at it, but it
  wants its own treatment. Parked here as a pointer, not solved.
