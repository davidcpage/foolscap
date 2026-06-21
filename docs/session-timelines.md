# Session timelines and the intent log

*Prepared 2026-06-20. Companion to `agent-sessions-on-canvas.md` (the three session forms),
`undo-scrubbing-and-history.md` (§4 several timelines, §1/§3 undo, §5 ambient inputs) and
`architecture-review-2026-06-09.md` (§4 git as a second timeline, §6 pin/freeze). Decides where a
live agent session's history lives — and corrects `agent-sessions-on-canvas.md` §3/§7, which routed
session input onto the canvas intent log. It does not. The decisive rule is one source of truth per
timeline; the canvas log records only board crossings; everything internal to a session lives in a
file the canvas references but does not absorb.*

---

## 1. The invariant: one timeline, one source

A history is recorded in exactly one authoritative place. Two copies of the same timeline — the
session's own log and the canvas intent log, say — is the failure to avoid: they drift, undo has two
masters, and provenance forks. This is `undo-scrubbing-and-history.md` §4 made into a rule:
timelines **do not merge into one ordered sequence**, and equally **are not duplicated across two**.

Where the single source lives may differ by session type. What never differs is that there is one.

## 2. The timelines

A live session touches four, each navigated by its own structure (undo-doc §4):

- **Canvas intent log** (channel 3) — one event per *board* act, attributed, ordered board-wide.
- **Git content DAG** — file content and its history; its own branching timeline (review §4).
- **The session file** — the session's internal record: every prompt, turn, tool call. A
  `.jsonl` for a Claude session; a registry-written transcript for a bare terminal (§5 below).
- **The live feed** (channel 1) — the in-flight tail: streaming output, running/idle status. Derived,
  pull-only, never persisted.

The session file and git are **referenced external timelines**: the canvas points at them and
projects them onto T when scrubbing (undo-doc §4), exactly as the git-repo scrubber drives the git
DAG (undo-doc §7). It never copies their entries into its own log.

Grounding fact: a real Claude Code `.jsonl` from this project is already a timestamped DAG —
`timestamp`, `uuid`, `parentUuid` on every conversation entry, plus `file-history-snapshot` records.
**Session-internal undo, branch, and (via timestamps) scrub already exist, owned by the session
tool.** The canvas must not reimplement them on the intent log; there is nothing to add.

## 3. The split: board acts vs session internals

The project's one dividing line decides every case — does an act change **canvas structure**
(existence, position, wiring across cards), or is it **internal to one card's content/process**?

| Act | Lives in | On the canvas intent log? |
|---|---|---|
| Session card created / moved / deleted / forked onto the board | record + log | **yes** — board structure |
| Output wired from session A into another card | edge | **yes** — inter-session crossing |
| Artefact placed on the board at (x,y) | edge + position | **yes** — board structure |
| A prompt sent in; a turn; a tool call | session file | **no** — session-internal |
| A file the session edits | git | **no** — git's own timeline |

So the canvas log is the **coordination and ordering layer across cards and sessions**. It records
the *crossings* — a session appearing, forking, dropping an artefact, wiring its output to a
neighbour — and nothing inside a session. A prompt typed into a session is a session act the canvas
**points at**, never one it absorbs (agent-sessions §7).

## 4. Correction: session input is not a canvas-log act

`agent-sessions-on-canvas.md` §3/§7 modelled session **input** as a `sessionInput` gesture through
`editor.commit`, giving it a canvas-log entry "validated, attributed, diffed and undoable," with
canvas-undo truncating the session at that turn. That is wrong on the rule in §1.

The session file already records the prompt, already attributes it, and already supports rewinding to
it (the DAG of §2). A second copy on the canvas log is the duplication §1 forbids — the same
replication §7 itself warns against, moved from the output side to the input side. By the project's
own consistency test a prompt is *internal to the session card's process*, exactly as text typed into
a note is internal to that note (note content is git, not a fine-grained log entry).

So: **a prompt to a session gets no canvas-log entry, and canvas-undo never reaches in to truncate
it.** Rewinding a session is a *session* operation, triggered on the card, served by the file's own
DAG. This is symmetric with the clock rule (§9 cost 1): output never touches the log — and neither
does input. The canvas log sees only the board acts of §3.

(The agent **bus** is unaffected. There an agent posts a `Command` that makes a *board* act —
`addNode` and the like — which is a real crossing and correctly logged. A session prompting *itself*
is not a board act. Do not conflate them.)

## 5. The pure terminal: the registry writes the transcript

A Claude session keeps its own `.jsonl`. A bare shell keeps nothing. The tempting fix — record the
terminal's input/output on the canvas log because it has no log of its own — is the wrong one, for
two independent reasons:

1. **Duplication waiting to happen / wrong home.** The canvas log is the board's structural timeline.
   Session internals are not board structure (§3).
2. **The clock-rule flood.** A `for`-loop spewing stdout, or fast typing, would bury the board's
   structural history under keystroke-granularity events — the exact failure §9 cost 1 exists to
   prevent.

The right fix: **the registry writes the terminal's transcript.** The session registry is already the
load-bearing new piece (agent-sessions §8) — it owns the process and sees both halves of the duplex.
So it materialises a transcript file, stamped with actor + timestamp per line, the same shape as a
`.jsonl`. Then the two session types are **identical from the canvas's view**:

- **Claude session** — transcript authored by the agent.
- **Bare terminal** — transcript authored by the registry on the process's behalf.

The only asymmetry — *who* writes the file — is hidden behind the registry and never reaches the
channels. Channel discipline is uniform: a referenced external file-timeline plus a channel-1 feed
for the live tail, for both. This is "content lives in files, not the log" applied once more, and the
continuous form of pin/freeze (§5 of agent-sessions, review §6): the registry pins the live stream to
content as it runs.

## 6. Multi-agent unwind is already source-scoped

Unwinding one session must not revert another's progress. This needs no new machinery. undo-doc §3's
undo stack is **selective by source** — it skips interleaved agent and remote changes. Generalise the
selection key from "the user" to "the session/actor" and each session is its own undo lane: unwinding
session A reverses A's *board* acts only.

The one case that can conflict is undo-doc §1's only dangerous operation — A created something B then
built on (B wired A's output into a chart). The v1 answer is unchanged: attempt it; if a touched
record or file has diverged, **refuse with a specific error** (undo-doc §3). Because sessions are
separate timelines (§2), scrubbing A renders A's file as-of-T and leaves B untouched by construction;
cross-session reversion is only possible if the timelines were wrongly flattened into one.

## 7. Files and artefacts: mediate through git

A session's effect on content rides the second timeline that already exists (review §4, undo-doc §7):

- The session edits a file → a **git commit authored by the session** → the commit-watcher ingests it
  → the file card re-renders, attributed. Multi-author tracking is **git authorship** — the correct
  substrate, because git is its own history and needs no recording to scrub (undo-doc §5).
- Scrubbing files is then undo-doc §7 verbatim: drive the git DAG; files appear, change, and vanish
  as-of-T.
- The session→artefact **causal link is an edge** (a board act, logged); the artefact **content is
  git**; the artefact **appearing at (x,y) is a board act**. Three-way split, no new mechanism.

A file shares the session's **live↔historical boundary**, drawn by git instead of by turns: the
working-tree edit is the live/derived value (a raw fs write the watcher shows at once); the commit is
the materialised, scrubbable point (review §6). For a session it is in-flight turn (live) vs appended
turn (materialised). Same boundary; neither half needs the intent log.

## 8. Scrubbing across the four timelines

undo-doc §4 unchanged: pick a **driver axis**, project the rest onto T.

- Driver = canvas log → board structure moves natively; each session renders its file up to the turn
  nearest T; git shows the commit at T; feeds show their nearest recorded sample or recompute from T.
- Driver = one session's DAG → that conversation moves natively (rewind/branch); the board and other
  sessions render as-of-T. This is "rewind and try again" as a branch you can see (agent-sessions §10)
  — scrubbing applied to a transcript, with no canvas-log involvement.

No merge, ever. The session file is one more driver candidate beside git.

## 9. Pin vs defer

**Protect now:**

1. **One timeline, one source.** A session's internal history is recorded exactly once, in an external
   file — agent-written (Claude → jsonl) or registry-written (bare terminal). Never duplicated onto
   the canvas log.
2. **The canvas log records only board and inter-session crossings** — card lifecycle, fork, artefact
   edge, output wiring. Never a prompt, turn, tool call, or keystroke, for any session type. This
   supersedes agent-sessions §3/§7.
3. **Session-internal undo/branch/scrub is local and file-owned**, served by the session file's own
   DAG, not by canvas undo.
4. **Files mediate through git**; multi-author tracking is git authorship; scrubbing is git-DAG
   navigation (undo-doc §7).
5. **The registry owns the transcript and the process** (agent-sessions §8), decoupled from card
   lifecycle. The card is a view.

**Defer:**

- Per-session undo lanes as a built feature (the selective-undo key generalised — small when wanted).
- Spatial session forking and the reactive-session-node (agent-sessions §10) — both ride these seams.
- A canvas-visible scrubber that switches driver between the log, git, and a session DAG.
- Conflict-as-data for the build-on case (undo-doc §6, the jj model).
