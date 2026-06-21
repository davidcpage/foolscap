# Architecture & Direction Review — findings and open items

*Prepared 2026-06-09, from a review of the core/interaction/app packages. One finding is already
fixed (§1); the rest are recorded here to return to. Companion to the direction notes and
`tldraw-architecture-and-feasibility.md`. Undo and history are taken further in
`undo-scrubbing-and-history.md`.*

---

## 1. FIXED — seq vs parent: the log now has its own clock

**Finding.** Three orderings were conflated in one field. `parent` (the store.version an event was
*based on* — its causal basis) was doubling as a sequence number: `IntentLog.since()` and
`Persistence.hydrate` filtered the replay tail with `parent >= snapshotVersion`. That coincidence
holds only while history is strictly linear (single writer, hard `tryCommit` reject). Every future
the docs defer-but-protect — optimistic commits accepted with a stale base (§10.2), git-ingested
external events, log-as-commit-graph — breaks it, and the failure was silent data loss: an event
committed *after* the snapshot but *based on* an older version would be dropped on reload.

**Fix (landed on `app`).** Events carry a `seq` assigned by the log at append — the master
timeline's own total order. `since()`, the hydration tail, and the snapshot watermark
(`PersistedSnapshot.seq`) key off `seq` alone; `parent` is now purely the conflict-policy /
causality token. Backward compatible: pre-seq durable events get seqs in load order; pre-watermark
snapshots fall back to the old linear filter. Regression tests cover the stale-parent scenario and
the legacy fallback (`core/test/persist.test.ts`).

**Residual (minor).** `hydrate` still reconstructs `store.version` by counting non-empty tail
diffs — an approximation under non-linear history. Fine while version is only a local optimistic
token; revisit if version ever travels between peers.

## 2. OPEN — content bytes are in the log (the spike shortcut that can't survive)

app funnels whole file contents through `setText`, so every external file save lands full
bytes in the channel-3 event's diff and in every snapshot. As a spike shortcut (zero engine
changes) this was right; as a design it violates the note's invariant #2 (content lives in
files/git, never overlapping bytes). **First change for the real version:** a content entry
carries `{ fileRef, shaBefore → shaAfter }`, never bytes; `node.text` stays a cached projection,
re-fetched on ingest.

**Consequence understood and accepted: git becomes the undo substrate for content.** Today undo of
a content edit works by accident — the bytes are in the diff, so `UndoManager` inverts it like any
record change. With SHA-entries the log still records an invertible *fact*, but executing the
inverse requires git (the per-entry-type undo dispatch the direction note calls its one piece of
load-bearing complexity). The undo's visible effect then arrives via the watcher/ingest path.

- **Use revert, not restore.** Checking out `shaBefore` clobbers intervening edits (LWW over
  history). Apply the *inverse patch* (`git revert` semantics, scoped to the file); it composes
  with intervening edits and surfaces a conflict — escalation being correct — when it can't.
- **Accept the asymmetry.** Record-diff inverts always succeed; content reverts can conflict.
  Inherent to the split: content admits concurrent external writers, space doesn't.

## 3. OPEN — the write-back echo loop (the real hard part of phase 3)

When the app writes a file and commits, chokidar fires and the watcher re-ingests the app's own
edit as a `remote` event — a feedback loop. The spike's one-directional flow hides this; write-back
hits it immediately. Needs self-origin suppression: compare content SHA before applying, and/or tag
in-flight self-writes. Note §2 makes the ingest path *also* the undo-apply path, so this must be
solved before undo-of-content works at all. Budget this as the bulk of the §7 round-trip
experiment.

## 4. OPEN — git is a second timeline; boot reconcile is a permanent component

"The log is the master timeline; git is referenced, not parallel" holds only while the watcher is
live. Commits happen while the app is closed, and history can be rewritten (amend/rebase/pull). So
boot must reconcile: scan `git log` since the last-known SHA and synthesize ingest events. The
honest invariant is "the log is the master timeline *of what the canvas has seen*." Design the
catch-up scan as the **primary** ingest path — live watching is catch-up with zero latency — and
this stays clean.

## 5. OPEN — commit granularity and authorship

- **One commit per content gesture = hundreds of commits per session.** Hostile history if the
  folder is a repo humans also use (the research-notebook appeal). Options: canvas commits on a
  dedicated branch periodically squashed; or accept machine-granularity git history and treat the
  intent log as the human-readable timeline (it already is one).
- **Two attribution fields.** The log has `actor`; git has author/committer, and out-of-band agents
  set their own. Decide which is authoritative for provenance display before they disagree.

## 6. OPEN — pin/freeze: the third category between authored and derived

The authored/derived dichotomy (wiring authored; flowing values never in log/git) is missing the
case where someone wants to *keep* a derived value — an agent's computed table quoted in a note.
Define an explicit **pin/freeze gesture**: copies a derived value into authored content as one log
entry (+ one commit if file-backed), preserving derivation provenance. Naming this keeps the
"derived never enters the log" rule absolute instead of accumulating exceptions.

## 7. FIXED — selective undo (policy, not structure)

`UndoManager` consumes channel 2 into a local linear stack — correct under everything above, no
tree-awareness needed. But in a multi-writer session, Ctrl-Z popping an agent's or remote ingest's
work is wrong. Wanted: "undo *my* last act" — filter the stack by the `ChangeSource` tag channel 2
already carries. A filtering decision over a linear stream; the only world where undo becomes
tree-aware is the full git-style branching UX, which stays deferred.

**Fix (landed on `app`, with the demo).** The stack now accepts only diffs whose source matches
the manager's own (`core/src/undo.ts`); inverses still apply record-wise, so they compose with
interleaved foreign changes — unless a foreign writer removed the record, where the inverse update
is a no-op rather than a resurrection. Regression test interleaves human/claude/remote
(`core/test/editor.test.ts`). Undo's fuller semantics — conflict detection, scrubbing, git
interaction, and the jujutsu model — are in `undo-scrubbing-and-history.md`.

## 8. Minor code notes

- `Store.getSignal()` builds a fresh computed per call, no dedup — harmless (signia computeds are
  cheap and collectable), but callers must not treat handles as identity-stable.
- `Store.query()` recomputes O(N) per change — documented decision; swap per-query for incremental
  if a profile ever demands it.
- Undo writes (`applyDiffAsChange`) bump the version and emit channel 2 but append **no** intent
  event — the log doesn't record undos. Snapshot debounce papers over it; a crash between an undo
  and its snapshot resurrects the undone change on replay. Fine solo; becomes a real gap when the
  log is shared with agents (an undo *is* an authored act). Consider logging undo/redo as events.

## 9. External-functionality avenues (ranked by leverage)

1. **MCP/HTTP server over the Editor.** `Editor.commit` is the single validated mutation surface;
   `store.query`/`getSnapshot` is introspection; `log.describe()` is the agent-facing history.
   A thin server exposing query / commit / recent-intent makes any Claude session an in-band,
   provenance-stamped collaborator. Few hundred lines; pressure-tests agent legibility early.
2. **Generalize the clock → off-log signal cards for live external feeds.** A card whose *config*
   is authored (URL, repo, query) and whose *value* is channel-1 only, fed by poll/SSE/webhook:
   GitHub PR status, CI state, RSS, prices, weather. Each is "the clock with a fetch in it."
3. **Adopt research-notebook's `template.yaml` conventions** as the card-type extensibility
   mechanism (bookmark/paper/code cards); conventions, not its app.js.
4. **Embed cards** (iframes) — the DOM-per-shape renderer's whole trade-off was buying these free.
5. **`observablehq/runtime`** when computed cells grow up — for async-by-default evaluation,
   generators-as-streams, error propagation; not day one. Wiring should be `EdgeRecord`s either
   way (dependency graph gets provenance + undo for free).

## 10. BUILT — demo: "the canvas watching this repo" (feeds × computed × agent)

*Landed on `app` in four commits matching the build order below — feed registry + git HEAD/HN
cards, computed card over edges, provenance card, agent bus — plus the §7 selective-undo fix in
core (the one engine change; everything else is plugin + client). The storyboard below works as
written; see `app/README.md` for run + curl instructions. One scripted caveat: per §8, an undo
appends no intent event, so the undo beat doesn't add a provenance line.*

A concrete demo to refine the vision: extend app into a **live dev dashboard for this repo**,
exercising all three new axes with zero engine changes.

**Cast of cards:**

- **Source cards (off-log feeds, generalizing the clock):** the existing clock; a **git HEAD card**
  (vite plugin watches `.git/HEAD`, emits `{sha, author, message, ts}` over the existing SSE
  channel); one true-internet feed for flavour — HN top story or open-meteo weather (both keyless),
  polled server-side in the plugin and multiplexed onto the same SSE.
- **A computed card:** "**time since last commit**" — depends on *two* live sources (clock tick ×
  git HEAD ts), counts up every second, snaps to zero when you commit. Deps are `EdgeRecord`s
  (authored, logged, undoable wiring); the value is a derived signal (channel 1 only). A tiny
  evaluator over named inputs is enough — no formula language yet.
- **The provenance card — the money shot:** render `log.describe()` live on the canvas. Feeds
  churn, clock ticks, derived card counts — and the intent log *visibly does not move*. Drag a
  card or let the agent act, and it does. The channel discipline demos itself.
- **Agent interaction, both modes:**
  - *Out-of-band (already works):* Claude Code edits a notebook `.md` in its own session → card
    updates live with `remote` attribution.
  - *In-band (new, small):* plugin gains `POST /api/command` → forwarded over SSE → browser runs
    `editor.commit({..., actor: "claude"})`; browser pushes snapshot + log tail back to
    `GET /api/canvas` (debounced). Claude Code can then *read* the board and *act* on it via curl —
    the MCP server's dress rehearsal. Cards show live who-touched-this badges off the log.

**Demo storyboard (≈90 seconds):** open canvas — clock ticking, HN/weather updating, "23m since
last commit" counting, provenance card still. Make a git commit — HEAD card flips, computed card
snaps to 0s, one ingest event appears in provenance. Ask Claude Code to "read the board and lay
out a summary card next to the three newest notes" — it queries `/api/canvas`, commits with
`actor: "claude"`, the card lands with claude attribution. Hit undo — your last drag reverts, the
agent's card stays (selective undo, §7).

**Build order:** (1) feed registry + git HEAD card, (2) computed card over edges, (3) provenance
card, (4) agent bus. Each step is independently demoable; stop anywhere and it's still a demo.
