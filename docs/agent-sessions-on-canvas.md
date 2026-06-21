# Agent Sessions on the Canvas — live terminals, transcripts, and artefacts

*Prepared 2026-06-19. A direction note, companion to `card-types-as-data.md` (the rendering seam and
capability contract) and `undo-scrubbing-and-history.md` (per-entry-type undo dispatch). Covers
bringing agent sessions onto the canvas in three forms — live interactive terminals, historical
sessions as cards, and the code artefacts/outputs a session produces — and argues that almost all
of it falls out of seams that already exist (`feedSignal`, the agent bus, file-backed cards) rather
than extending the core. Ends with the one genuinely new piece of infrastructure, the costs we
accept, pin vs. defer, and the smallest experiment.*

---

## 1. The reframe

An agent session is the canvas's central question — **authored vs. derived, and who authored it** —
asked a fourth time (after space-in-log, content-in-files, interior-in-template). It splits the same
way the clock does:

- **A live session is a feed.** The streaming output of a PTY or an in-flight agent turn is
  *derived/ephemeral* — pull-only, channel 1. It is "the clock with a process in it." The hard rule
  from the collab note §4 applies verbatim: **a token streaming by must never touch the intent log
  or git.** If it does, machine output drowns the provenance log — the exact failure the clock was
  built to catch.
- **A historical session is a file.** A finished transcript is content — a `.jsonl` of turns. That
  is a file-backed card under `card-types-as-data` with no core change: a codec in `type.yaml`
  (`.jsonl` → `turns[]`) plus a `render.js` that lays out the conversation.

Headline: **bringing sessions in needs no new channel and no new substrate.** It needs the two seams
already built — `feedSignal` for the derived stream, the agent bus's `editor.commit` for authored
input — scoped to a per-card session id. The feature falls out of channel discipline rather than
extending it.

## 2. The mapping

Every concern lands on a seam that exists today:

| Concern | Authored / derived | Lives in | Existing mechanism |
|---|---|---|---|
| Session card exists, at (x,y), with config | authored | record + log | normal card creation |
| A prompt / command sent in | authored act | jsonl (referenced — §7) | agent-bus `commit`, attributed |
| Streaming output, running/idle status | derived | channel 1 feed | `feedSignal(name)` |
| Finished transcript | content | file / git | file card + codec |
| Code artefact produced | content | file / git | `file` card type (exists) |
| "session X produced artefact Y" | authored (wiring) | edge | computed-over-edges (demo §10) |
| Live command output | derived → pinnable | feed, then file | feed + pin/freeze (review §6) |

The only thing added across the whole table is *scoping a feed and a command stream to one card's
session id*.

## 3. The interactive terminal

> **Corrected by `session-timelines.md` (2026-06-20).** The input half below is wrong: session input
> does **not** ride `editor.commit` onto the canvas intent log. The session file already records the
> prompt (a timestamped DAG with file snapshots), so a canvas-log copy duplicates a timeline (the §1
> "one source" rule) and would flood the board log at keystroke granularity. Input stays
> session-internal; the canvas log records only board crossings. Keep the duplex *transport* (SSE out,
> POST in); drop the claim that input becomes a logged canvas act.

Model a live session as a duplex pair keyed by session id:

- `/api/session/{id}` SSE for output — reuses the feed seam exactly; the card subscribes through a
  `Subscribable<string[]>` it cannot distinguish from a node-field handle.
- `POST /api/session/{id}/input` for input — lands as a `sessionInput` gesture through
  `editor.commit`, so it is validated, attributed (`actor`), diffed and (selectively) undoable like
  any other act, by the same one-mutation-API the agent bus already uses.

The card type is `card-types/session/render.js`, mounting **xterm.js through the web-component /
custom-element import door** `card-types-as-data` §3 already designed ("a whole ecosystem of existing
rendered widgets becomes importable"). xterm is the poster child for that tier and bounds its own
scrollback internally — which matters, because a derived stream must stay bounded (ring buffer, never
unbounded growth). Styling is folder-level CSS keyed off the provenance `actor`, so a Claude session
card gets distinct chrome for free.

This one card type is a useful forcing function: it exercises **two deferred bets at once** — the
web-component tier, and a template that *both reads a feed and commits*. If the v1 capability
contract can express it cleanly, the contract is right.

## 4. Historical sessions

Pure existing architecture. `fileRef` → a transcript file; the codec parses turns; `render.js`
renders them with tool-call disclosure and per-turn actor chrome. No process, no duplex, no
registry. Because it is file-backed it is git-diffable and agent-legible — which extends
agent-legibility to **agent introspection**: one agent can read another's past session by reading
the file. Claude Code already writes session transcripts as JSONL on disk, so the input format
exists.

## 5. Artefacts and outputs

- **Artefacts** an agent writes are already file cards. The new element is the causal link
  session → artefact, which is an **edge** (authored wiring), and the log already carries
  parent-version, so it is "interpret the log," not "add a log."
- **Outputs** (a test run, a build, a command's stdout) are "the clock with `npm test` in it" — a
  feed while running, a file once **pinned**. The pin/freeze operation (review §6) *is* the act that
  materialises a derived value into authored content. Live → channel 1; pinned → a content commit.

## 6. The live → historical boundary

The one interesting design question: **when does the derived stream become authored content?**
Argue for **per-turn coalescing**, mirroring "one gesture = one event = one commit":

- The in-flight turn stays channel 1 (feed). A *completed* turn coalesces into one commit appended
  to the transcript file.
- The session card is then simultaneously a **growing file** (materialised turns) and a **live
  feed** (the current turn) — precisely the role the collab note hands the snapshot cache: *the
  materialised current state including derived values*.

Per-turn over per-session-end buys crash-safety and makes sessions **scrubbable**
(`undo-scrubbing-and-history.md`): the turn boundary is the natural coalescing unit, the exact
analogue of the gesture boundary.

## 7. Two timelines — do we replicate session acts onto the intent log?

> **Sharpened by `session-timelines.md` (2026-06-20).** This section's answer ("referenced, not
> replicated") is right and is generalised there into the decisive rule — *one source of truth per
> timeline*. But its closing claim that undoing a `sessionInput` "dispatches a session operation" via
> the canvas log is dropped: input is not a canvas-log act at all (see §3's correction), so there is
> no canvas entry to dispatch from. Session-internal undo/branch/scrub is local and file-owned.

The sharp question: *if the session `.jsonl` is already a complete log of the session, must its user
interactions be replicated onto the canvas intent log?* **No — and replicating them would be wrong.**

The two logs are different timelines at different granularities:

- The **session jsonl** is the complete record *of the session* — every prompt, turn, tool call. It
  is **content**: a file, channel 2, git-tracked. It is authoritative for *what was said inside the
  session*.
- The **canvas intent log** is the ordering record *of the board* — one entry per canvas-affecting
  act, across all cards and actors. It is authoritative for *what canvas-structural acts happened
  and in what order*.

The resolution is invariant 1 of the collab note generalised: **the session jsonl is referenced,
not paralleled — exactly as git is.** That invariant reads "content entries carry a commit SHA and
dispatch a git operation rather than a record-diff." Here a session entry carries a *session id +
turn pointer* and dispatches a *session operation*, rather than embedding the prompt. The jsonl is a
second referenced sub-timeline alongside git.

Concretely, which acts get a canvas log entry:

- **Yes (canvas-structural):** session card created / moved / deleted; session **forked**; artefact
  produced and positioned (the cross-domain causal entry §3 of the collab note already flags); output
  **wired** to another card. These change canvas structure and need board-wide ordering, attribution
  and undo.
- **No (session-internal):** individual prompts and turns. They live in the jsonl, re-render the
  card live via the feed/file, and stay *referenced* — never copied turn-by-turn onto the canvas log.
  Copying them is the clock-rule failure in another costume: machine-granularity events drowning the
  authored timeline. (It is also lossy both ways — the agent's internal turn schema is not the
  canvas `IntentEvent` schema, and forcing one into the other discards detail in both directions.)

This refines the framing from earlier discussion: it is not "turn content to files, turn acts to the
log." It is **content and acts both stay in the jsonl; the canvas log references the session.** A
prompt typed into an embedded terminal is a session act the canvas *points at*, not one it absorbs.

Undo composes cleanly because dispatch is already per-entry-type. A spatial entry inverts a
record-diff; a content entry dispatches a git restore; a **session entry dispatches a session
operation** — e.g. undoing a `sessionInput` truncates/forks the session at that turn. The session is
simply a third referenced timeline plugged into the dispatch the collab note already named as the
price of unification.

When the embedded session is an external Claude Code process, this is automatic: it writes its own
jsonl out-of-band, and the **commit-watcher ingests "session file changed" as one coalesced entry**
(the git-ingest path), not one entry per turn. The session file is treated exactly like an
externally-edited `.md`.

## 8. What is new vs. free

**Free** (reused, not built): the feed seam, the command seam, file-backed history, codecs,
provenance, undo dispatch, the web-component import door.

**Genuinely new — the load-bearing piece:** a **server-side session registry**, keyed by id and
**decoupled from card lifecycle**. A live session is a real process; the card is a *view* of it.
Closing the card must not necessarily kill the process (as the feed EventSource is page-lifetime, not
card-lifetime). This is the analogue of "per-entry-type undo dispatch was the price of the git
unification" — the one place new complexity concentrates.

**A payoff worth naming:** an embedded coding agent edits files → those edits are commits → the
commit-watcher ingests them as log entries → the affected file cards re-render live, attributed to
that session. The embedded session is not a bespoke integration; it is the existing git-ingest loop
with a **visible source on the canvas**. Session card and the file cards it touches light up
together — collab note §5 multi-agent collaboration made concrete.

## 9. Costs we are consciously accepting (the critical pass)

1. **No PTY bytes in log or git, ever.** The clock rule, non-negotiable. Live output is channel 1
   only; only completed turns / pinned outputs become content.
2. **No privileged terminal path.** The terminal renders through the card-type contract like
   everything else — `card-types-as-data` §6 explicitly refuses a privileged in-app route. A terminal
   is a template that reads a feed and holds a commit capability; nothing more.
3. **Security gets sharp.** "The folder becomes code" (card-types §5.3) becomes "the terminal *runs*
   code." Fine local-only solo; the iframe / capability-sandbox decision becomes urgent before shared
   canvases. The capability contract already anticipates it — untrusted session types graduate to
   sandboxes without changing the contract.
4. **Output volume vs. 60fps.** Host-owns-space + lit-html part-diffing means a busy terminal
   re-renders only its own interior, never the canvas — the clock stress test generalises. Requires a
   bounded scrollback buffer in the feed (xterm provides one).
5. **Process lifecycle is real state the canvas does not own.** The registry, reconnection after a
   dev restart, and orphaned-process cleanup are server concerns with no record/log analogue. Keep
   them out of the channels; the card observes process state through a status feed, never owns it.

## 10. Two generative ideas (not v1)

- **Spatial session forking.** Transcript is a file; the log is a commit graph (parent-version
  already carried). Forking at turn 5 = two session cards diverging spatially. "Rewind and try again"
  becomes a *branch you can see* — something a linear terminal structurally cannot show. Scrubbing
  applied to a transcript.
- **Session as a reactive node.** Wire a session's output into a computed card (the demo's
  computed-over-edges). An agent in the dataflow graph, not just a chat window — "run this agent, pipe
  its JSON into that chart." The spatial × reactive × file-backed × multi-agent intersection the
  collab note claims, made concrete: **an agent session as a first-class reactive source.**

## 11. Pin vs. defer

**Protect now:**

1. **Live = feed, historical = file.** Derived session output is channel 1 only; authored transcript
   is content. The clock rule covers sessions unchanged.
2. **The session jsonl is referenced, not replicated.** The canvas log records canvas-structural acts
   (card lifecycle, fork, artefact edge, wiring) and points at the session for the rest. One
   referenced sub-timeline beside git, served by the same per-entry-type undo dispatch.
3. **No privileged terminal path; capability-passing only.** A session card is a template reading a
   feed and holding a commit capability — never the store, never the shell.
4. **Process state lives server-side, decoupled from card lifecycle.** The card is a view; the
   registry owns the process.

**Defer:**

- Per-turn vs. per-session-end coalescing (lean per-turn; decide on evidence).
- Sandboxing untrusted session types (needed at shared canvases, not solo).
- Session forking and the reactive-session-node — both ride existing seams, neither is v1.
- The duplex input transport details (SSE + POST sketched here; a single WS may win later).
- Whether canvas turn-level undo is ever wanted (default: no — it drowns the log).

## 12. Smallest viable experiment

A **read-only historical-session card**: `card-types/session/` with a `.jsonl` codec + a `render.js`
that lays out turns with tool-call disclosure and actor chrome, pointed at a real Claude Code
transcript. No process, no duplex, no registry. It proves the content/codec path on real session
data and yields the rendering vocabulary (turns, disclosure, actor styling) the live card reuses.

*Then* the **live terminal card**, which adds exactly the session registry + the duplex feed/commit
pair and nothing else — the box stays on the host hot path, the interior re-renders only on feed
ticks, and input rides `editor.commit` like every other authored act.
