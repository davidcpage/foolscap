# Undo, scrubbing, and history

*Prepared 2026-06-19. Companion to `architecture-review-2026-06-09.md` (§2 content/git, §4 git as a
second timeline, §6 pin/freeze, §7 selective undo) and `card-types-as-data.md`. Covers two separate
history features — undo and scrubbing — how each interacts with git, and the jujutsu model that fits
our diff-based core.*

Terms used below:

- **Authored state** — deliberate acts. Spatial state (position, size, wiring) lives in the store and
  the intent log; content lives in files/git.
- **Derived state** — values computed from authored state plus external inputs (a clock, a computed
  card). Never stored; recomputed on demand.
- **Channel 2** — the record-diff stream: one before/after diff per commit.
- **Channel 3 (intent log)** — the append-only, attributed log: one event per gesture, carrying its
  diff.

## 1. The principle: conflicts come only from constructing new states

A merge conflict can arise only when you build a *new* state that must be consistent with *divergent*
changes. This classifies every history operation:

- Read-only navigation to a past state: the state already existed and was consistent. No conflict is
  possible.
- Undo of the latest action: returns to a state that just existed. Safe.
- Undo of an earlier action while keeping later ones: constructs a history that never existed. This is
  the only operation that can conflict.

The two features below sit on opposite sides of this line.

## 2. Two features, kept separate

- **User-undo** — error correction. Reverse my last action(s). Narrow and simple.
- **Scrubbing** — navigation. Move a pointer through recorded history and watch the canvas change.
  Read-only, so never conflicts.

They have different guarantees. Keep them separate.

## 3. Undo

Undo is built on Channel 2 (`core/src/undo.ts`): a stack of inverse diffs, one applied per step.

- **One step = one commit = one Channel 2 diff.** No fusing across steps — each step must be redoable
  on its own. A gesture is already one diff, so undoing a 60-frame drag is one step.
- **Selective.** The stack holds only diffs whose source matches the user's, so undo skips interleaved
  agent or remote changes (review §7).
- **Conflict-detectable.** An inverse carries the expected post-state per record. A conflict = the
  current record diverged from it (changed or removed by someone else since the act). For content, a
  conflict = the git revert does not apply. Both are detectable as data, not text.

v1 semantics: **attempt the undo; if any touched record or file has diverged, refuse with a specific
error.** A conflict-resolution UI is deferred. In solo single-writer use nothing interleaves, so undo
always succeeds; conflicts appear only with concurrent agents or remotes.

Undo of content uses `git revert` semantics (apply the inverse patch), not checkout, so it composes
with intervening edits (review §2).

Open gap: undo appends no intent event today, so a crash between an undo and its snapshot resurrects
the undone change (review §8). Fix: log undo/redo as intent events. That also makes undo
provenance-stamped, which matters once agents share the log.

## 4. Scrubbing

History is several timelines, each with its own structure:

- the intent log (Channel 3) — near-linear now, a branching DAG once multi-writer;
- git content history — a branching DAG;
- per-feed sample series — continuous.

They do not merge into one ordered sequence: their orders differ, and `seq` (log order) is not
wall-clock time. So:

**Pick a driver axis; project everything else onto time.**

- Navigate one timeline (the driver) by its native structure.
- The driver point yields a timestamp T.
- Everything else renders "as of T": derived cards recompute; other feeds show their nearest recorded
  sample; non-driver authored/content state shows its state at T.
- You can switch which axis is the driver.

So you navigate one timeline natively and render all of them as of T. This respects that git is a
second timeline (review §4) rather than flattening it.

**Git-tree navigation.** The driver is the git commit DAG, restricted to a chosen subset of branches.
The scrubber snaps to the nearest commit on the current branch and offers a switch at branch/merge
points. Read-only, so conflict-free. The same UI serves a branched intent log later — both are branch
DAGs.

## 5. Replaying derived state: ambient inputs

Derived state is not stored, so scrubbing must reproduce it. Two cases:

- **Recomputable from inputs you hold.** A clock is a function of the current time; a computed card is
  a function of its wired inputs. Feed them historical inputs and they recompute. The clock's
  historical input is just T — free.
- **External samples with no derivation.** A live feed's past value (yesterday's top story) is
  unknowable unless recorded. To scrub it, record a time-series, or read it from a source that is its
  own history (git is). Otherwise it cannot be scrubbed.

The mechanism is the existing capability contract (card-types §3): a card receives its inputs —
including time and feeds — as host-supplied capabilities, never by reaching out directly. Because the
host owns these capabilities, scrubbing supplies historical values instead of live ones.

This needs one rule: **card logic never reads ambient state directly** (no raw `Date.now()`,
`Math.random()`, `fetch`); it receives them as capabilities. Time then fits the general model with no
special-casing — it is just another host-controlled capability. It looks distinguished only because
it is the one input every timeline can be indexed by, which is why it serves as the projection
coordinate. (Today `feeds.ts` calls `Date.now()` directly in a couple of places; the production rule
removes that.)

## 6. The jujutsu parallel

Jujutsu (jj) is a git-compatible version control system. Two of its ideas match this design:

- **Operation log.** jj records every state-changing operation in a separate append-only log, each
  entry storing the before/after state. `jj undo` moves back one operation; `jj op restore` jumps to
  any past state. This is Channel 3 used as the undo/scrub substrate.
- **First-class conflicts.** A conflict is stored as structured data in a commit, not as text markers,
  so operations never block.

The layers map directly:

| jj | here |
|----|------|
| operation log (meta-history; undo lives here) | intent log (Channel 3) |
| commit DAG (file content) | content in files/git |

jj undo restores a recorded state rather than content-merging, which is why it does not block —
matching the principle in §1. Honest caveat: jj makes conflicts *non-blocking* (stored as data), not
*impossible*; undoing a middle operation can still produce a conflict. Our diff model fits the same
approach — a diff that does not apply cleanly is already a detectable fact, so it can be stored as a
conflict rather than blocking. That is the deferred, richer version of §3's "refuse with an error."

## 7. Illustrative demo: the git-repo scrubber

A canvas that scrubs a repo's history. Buildable on the current spike; illustrative, not scheduled.

- Driver: the git commit DAG (a subset of branches).
- Cards: files, grouped by directory, sized by file size, placed by a force-directed layout. Spatial
  state is ours (Channels 1–3); file content and history come from git.
- Scrub the DAG; files appear, change, and vanish; diffs render against the previous commit; the clock
  and any time-derived card show the historical time via the `now` capability.

It exercises scrubbing and layout-over-external-history without touching the undo-conflict machinery
(it is read-only). It also exercises the boot-reconcile path (review §4): git history is the navigable
timeline.

## 8. Pin vs defer

**Protect now:**

- Undo and scrubbing are separate features. Undo mutates; scrubbing is read-only.
- Conflicts come only from constructing new states. Route history navigation through read-only
  scrubbing.
- Ambient inputs (time, randomness, feeds) reach cards only as host capabilities — no raw `Date.now()`
  / `Math.random()` / `fetch` in card logic.
- Scrubbing uses a driver axis + time projection, not a merged timeline.

**Defer:**

- Conflict-resolution UI (v1 refuses with an error).
- First-class conflicts stored as data (the jj model).
- Branched intent log and multi-writer per-actor undo.
- Feed time-series recording (needed only to scrub non-git feeds).
- Logging undo/redo as intent events (review §8) — small; do when undo provenance matters.
