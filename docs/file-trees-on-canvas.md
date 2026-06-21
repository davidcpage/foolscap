# File trees, directories, and the activity timeline on the canvas

*Prepared 2026-06-21. Companion to `agent-to-agent-messaging.md` (the typed attention-edge: `claimedBy`
§10, `watch:open` §9, edge as capability §4), `agent-sessions-on-canvas.md` (the live-vs-historical
session duality), `session-timelines.md` (one source per timeline), `card-types-as-data.md` (templates as
folders on disk) and `undo-scrubbing-and-history.md` (the intent log as the scrub spine). Decides how the
file system is represented, navigated, and animated over time on the canvas. The headline: **files and
directories are nodes, the file-tree is the substrate the attention-edge graph already wants to point at,
and the tree is *derived by default* — only claiming or pinning earns a channel-3 event.** This is the
other half of the messaging design, approached from the file end.*

---

> **Implemented so far (2026-06-21).** Step 0 (picker) and Step 1 (directory card + `chrome` flag +
> derived-by-default projection) shipped; then the modal picker was **retired** and the directory card
> became an **in-card tree browser** — the §5 Finder-pane. You drill down through sub-folders *inside one
> card* (expand/collapse is off-log view state, held in a per-card `treeState` capability, §9) and **drag
> any row — file or sub-folder, at any depth — out onto the canvas** to promote it to its own node (the one
> authored act, §9; `loader.materializeAt`). This deliberately chose §5's in-card tree over §3/§4's
> spatially-bounded child *cluster*: navigation happens in the card, and only the nodes you pin become
> spatial. **Layout-only nesting (§4) is therefore deferred — possibly moot**, since in-card drill-down +
> drag-out covers browsing without any containment machinery. The `dirListing` capability is now a callable
> keyed by path (one lazy `/api/ls` per expanded level), so each open folder is its own channel-1
> subscription kept live by the file watcher. The treemap repo-card (§6 tier 1) and the activity overlay /
> scrubber (steps 2–3) are still unbuilt.

## 1. The reframe

The instinct is "build a better file picker." That solves the entry gesture and misses the substrate.
Three wants are in play — navigate a large tree, watch multi-agent/multi-person activity over time, and
let agents claim files during refactors — and they look like three features. They collapse into one
substrate question:

**An edge endpoint must be a node with an id.** The messaging note already wants agents to `claimedBy` a
file and `watch:open` a directory (`agent-to-agent-messaging.md` §9/§10). A row inside a tree *widget*
cannot be an edge endpoint; only a first-class node can. So the moment you want agents wiring ownership or
watch edges to files and directories, you have decided that **files and directories are nodes** — and the
"canvas-native file tree" is just *giving the attention-edge graph something to point at.* The file-tree
work and the messaging work are the same graph from two ends.

The corollary the current code hasn't taken: the right primitive is not "file card" but the **directory as
a first-class node**. Today a directory is implicit spatial clustering inside `addFolder`
(`app/src/loader.ts:93`) — a dump of file cards grouped into columns, with no object representing the
folder itself. The directory node is what carries aggregate activity, what an agent claims, and what
expands and collapses. Files are its leaves.

## 2. What already exists (the "free" inventory)

- **`EdgeRecord`** (`core/src/records.ts:36`) with a `contains` type already in the vocabulary — directory→child
  containment is expressible today.
- **`addEdge` / `removeEdge`** (`core/src/commands.ts:91`) — validated, attributed, logged, undoable.
- **Deterministic file ids** — `fileNodeId(root, path)` (`loader.ts:50`). The id of a path is stable
  whether or not the node is currently materialized. This is load-bearing (§9): an edge can reference
  `fileNodeId(root, "src/loader.ts")` even when that file node is only a derived projection.
- **Off-log content** — `content.ts`'s `fileContentSignal(root, path)` already serves file bodies as a
  channel-1 signal keyed by `(root, path)`, lazily fetched, never logged. The model for "derived by
  default" is built.
- **The fs middleware** (`app/vite-fs-plugin.ts`) — `/api/dirs` (directory list for a picker), `/api/tree`
  (children + preview), `/api/file` (single body), `/api/watch` (SSE add/change/unlink). The navigation
  backend exists; the git-history backend (§8) does not yet.
- **The git HEAD feed + commit-watcher** (`startGitHeadFeed`, commit `5bc3583`) — re-renders attributed
  cards live on commit. The realtime half of the timeline (§8) is built; only HEAD is exposed, not log.
- **The session live-vs-historical duality** (`agent-sessions-on-canvas.md`) — one card type, two clocks
  (live tail vs file replay). The file-tree reuses this exact shape (§8).
- **Edge rendering** — `EdgeLayer` (`app/src/CanvasView.tsx:66`) draws center-to-center dashed lines today;
  it is where the typed-edge vocabulary (§10) lands.

What is **new**: a directory card type, a nesting/containment layout (§4), a treemap overview (§6), a
chrome-mode flag (§7), a git-log middleware feed (§8), and the derived/authored split for tree nodes (§9).

## 3. The directory as a first-class node

A new card type (`app/card-types/directory/`, per `card-types-as-data.md`). Two rendering states under
semantic zoom (§6):

- **Collapsed** — an aggregate: file count, churn sparkline, owner/claim badges, active-agent count. One
  card standing in for a whole subtree. This is what you add instead of 160 file cards.
- **Expanded** — an **in-card tree** (§5): drill down through sub-directories *inside the card*, each
  level's children fetched lazily (the `dirListing` callable, §9). Expansion is the navigation gesture and
  is off-log view state; **dragging a row out** promotes that one node to the canvas (§9). *(Built this way
  rather than materializing children as a spatially-bounded cluster — see the status note above and §4.)*

The picker (§5) and the bulk dump (§3 of the problem) both become special cases of *expand*: a picker is
"browse, then expand into the canvas the nodes you point at."

## 4. The representational fork: nesting vs edges

The key decision. Two kinds of relationship want two different visuals:

- **Containment (dir → children): hierarchy via nesting, not drawn edges.** A directory should visually
  *contain* its children — an expandable, collapsible region — not spray child cards joined by
  center-to-center lines. Nesting reads as a tree and collapses cleanly; N child edges per folder is
  spaghetti (the current `EdgeLayer` draws straight lines between centers — fine for a handful of semantic
  links, unreadable for a file tree). `contains` edges exist in the type vocabulary but would render as
  that spaghetti; nesting is the legible form.
- **Semantic relations (claim / watch / message / dependency): keep these as edges** — exactly the typed
  attention-edge of the messaging note, reusing `EdgeRecord` unchanged.

**Principle: tree structure = nesting; cross-cutting relationships = edges.** This stops the canvas from
drowning in lines and makes every edge that *does* exist meaningful — an edge means "someone claims /
watches / depends," never merely "this file is in this folder."

**Cost, stated honestly:** nesting/containers (frames a card can hold other cards inside) are new layout
machinery — the engine today has free-floating cards with AABB layout boxes and no parent/child spatial
nesting. This is the largest net-new piece. The cheaper fallback is `contains` edges (free, exist today)
accepting the spaghetti; I recommend against it for anything past a toy tree. A middle option: render the
expanded subtree as an auto-laid-out cluster *visually bounded* by the directory card (a frame that owns a
region) without full reparenting semantics in core — layout-only nesting, the engine still sees flat
nodes. That keeps core untouched and buys most of the legibility. **Lean: layout-only nesting first,
promote to real containment in core only if claims/undo need to operate on subtrees atomically.**

## 5. Navigation: the widget is the overview, the nodes are the substrate

A tree *widget* (a Finder-style pane, or a treemap, rendered inside one card) is excellent for browsing
and picking and useless as an edge substrate. Tree-as-nodes is the opposite. Use each for its job:

- The **widget / treemap is the overview and picker** — compact, familiar, shows a lot at once.
- **Pointing at a cell materializes** that directory or file as a real node you can then claim, watch, and
  wire.

So the picker is not a throwaway modal; it is the repo card's collapsed face. Browse inside it, and
drill-clicks promote cells to canvas nodes.

## 6. "Appropriate detail" = semantic zoom

The too-much/too-little problem is solved by letting detail follow attention, in three tiers:

1. **Repo card** (1 node) — the monorepo as a **treemap**: area = size or churn, color = recency or
   author. A monorepo has thousands of files but only tens of *hot* directories at any moment; a treemap
   shows the whole shape at a glance and is the natural overview. Click a cell → materialize that directory
   (§3).
2. **Directory card** — collapsed aggregate / expanded children (§3).
3. **File card** — collapsed (name + churn + claim badge) / expanded (today's content body, `content.ts`).

Lazy and collapsible is non-negotiable: an exploded monorepo is canvas death, so materialization is
on-demand and spatially bounded.

## 7. Chrome: rectangular box, card-type-chosen frame

Not every widget reads well as a framed rectangle (the clock; arguably the treemap). The resolution
separates two things the current code conflates:

- **The bounding box stays a rectangle.** It is infrastructure: the spatial index, hit-testing, selection,
  and edge anchoring (`CanvasView.tsx` edge math) all assume an AABB. True non-rectangular *geometry*
  (circular hit regions, edges anchoring to a perimeter) breaks the index and the edge math for a cosmetic
  win — out of scope.
- **The visible chrome is the card type's choice.** Outline, background, and padding are render decoration.
  A `chrome: bare` declaration in `type.yaml` (alongside `name`/`contract`/`capabilities`) lets the host
  skip the frame; the card paints into a transparent box. The clock renders a clock face on transparent
  ground; the box still exists for selection and edges. On select/hover, the host draws a rectangular
  selection ring regardless, so bare cards stay discoverable.

Cost: one declarative field plus one branch in the node host. Low. This is a clean, contained addition —
worth doing early because the clock and the treemap both want it.

## 8. The timeline: git is the clock, the tree is the projection

The compelling demo — multi-person, multi-agent activity on a monorepo, as motion on the canvas.

**Whose clock.** For *file* activity the source of truth is **git** (commits, authors, changed paths,
branch refs), which is external to the canvas intent log. So the scrubber is over git history, *projected
onto* the tree; the canvas intent log stays the board's own provenance (one source per timeline,
`session-timelines.md`). The heat-map and the claim edges at time T are a **derived view parameterized by
`t`** — no new stored state, which is what keeps it channel-legal (§11).

**Enabling backend work.** The middleware exposes only `githead` (HEAD). Add a **git-log feed**: commits
with author, timestamp, changed paths, and branch refs, queryable up to a given commit/time. This is the
one substantial new endpoint.

**Live vs historical is already a solved pattern.** The session work runs one card type on two clocks — a
live tail and a historical replay. The file-tree gets the same: realtime activity rides the existing watch
stream + commit-watcher; historical scrub replays the git-log; **same view, two clocks.** Lean on that
parallel — it de-risks the demo by reusing a shape that already shipped.

**The money shot:** scrub time, watch directory heat bloom across the treemap and claim edges from
person/agent cards appear and migrate — who touched what, when, and who owns it now.

## 9. Derived by default, authored on demand (the channel-3 question)

The crux for channel discipline. When you expand a directory and materialize a hundred child nodes, is
that a hundred channel-3 intent events? Today `addFolder` emits one `addNode` per file (`loader.ts:93`) —
all logged. For a browsed monorepo that is log spam and persistence bloat. Two stances:

- **Materialized = authored** (today): expanding adds real, logged, persisted, arranged nodes. Matches the
  current dump; does not scale to exploration.
- **Materialized = derived**: the tree is a channel-1 projection over the filesystem and git; expand /
  collapse is *view state*, not logged. Only durable acts hit the log. Matches the off-log-content ethos
  (`content.ts`) and the "derived by default, materialize on demand" seam the messaging note keeps
  returning to (`agent-to-agent-messaging.md` §10).

**Decision: derived by default, pinned to authored on demand.** The tree you browse is a derived
projection (channel 1) — the spatial index and renderer see it, the intent log does not. The moment you do
something durable — **draw a claim or watch edge, deliberately pin a file/dir to the board, annotate it** —
*that specific node* is promoted to an authored, logged, persisted record. Deterministic ids (§2) make this
seamless: a claim edge references `fileNodeId(root, path)` whether or not the node is currently a derived
projection, so promotion is "start logging this id," not "rewire the edge."

This gives the headline its file-side form. The messaging note: *the only thing that earns a channel-3
event is opening the wire, once.* Here: **the only thing that earns a channel-3 event is committing a
file, directory, or claim to the board — once.** Browsing, expanding, heat, and the scrub are all
channel-1 projection; they never touch the log.

## 10. Agent ownership edges

Directly the typed attention-edge of the messaging note, now with a concrete target:

- **Claim** — `claimedBy` during a refactor. Per messaging §10 this is the degenerate attention-edge: a
  soft claim plus an implied watch, expressible either as a field on the file/dir node or as an explicit
  edge from the agent's session card. The edge form is the more legible one here because it is what the
  human *sees* — a colored connector from agent to the subtree it owns.
- **Watch** — `watch:open` on a directory: wake me when anything under `src/loader` changes, coalesced to
  one wake per idle boundary (messaging §9, mandatory). The realtime backend (commit-watcher, `/api/watch`)
  already produces the events.
- **Etiquette with a backstop** — claims are convention, not locks (messaging §10); the intent log's
  divergence check is the safety net if two agents thrash. Consistent with local-solo ethos.

Because containment is nesting (§4) and not edges, every edge on the board is a *semantic* relationship —
so a claim edge to a directory is unambiguous: it means ownership, not membership.

## 11. Channel-discipline check

- **Channel 1 (renderer / feeds):** the tree projection, the treemap, expand/collapse view state, activity
  heat, the scrub at time `t`, watch wakeups (as synthetic input, off-log). Derived, never persisted.
- **Channel 2 (persistence / index / undo):** the `addNode` / `addEdge` / `removeEdge` diffs for *promoted*
  nodes and for arrangement — only what was authored (§9), not the browsed projection.
- **Channel 3 (intent log):** pin a file/dir to the board, draw or sever a claim/watch edge, annotate.
  Zero events for browsing, expanding, or scrubbing. The line that makes this legal: only committing a
  file/dir/claim to the board earns an `IntentEvent`.

## 12. Staged path

Each step subsumes the last; the picker ("at minimum") is the anchor.

0. **Picker** — replace the folder-dump with a tree-browser overlay (reuses `/api/dirs` + `/api/tree`) that
   materializes *selected* files/subtrees. Immediate UX win, low risk. *(Authored nodes, as today — the
   derived/authored split lands in step 1.)*
1. **Directory card type + chrome flag** — collapse/expand, layout-only nesting (§4), `chrome: bare` (§7),
   and the derived-by-default projection (§9). The picker becomes "expand into the canvas." *(Shipped —
   except expand is an **in-card tree** (§5), not layout-only nesting, and the modal picker was then retired
   into the card; drag-out is the promotion. See the status note.)*
2. **Activity overlay** — heat from the commit/watch feeds; claim/watch edges from agents — the
   attention-edge note landing on a concrete target (§10).
3. **Git-history scrubber** — the git-log middleware feed (§8); project tree + heat + claims at time T;
   live vs historical, one view (the session duality).

## 13. Pin vs. defer

**Protect now:**

1. **Files and directories are nodes; the directory is first-class** (§1/§3) — the substrate the
   attention-edge graph points at.
2. **Tree structure = nesting; relationships = edges** (§4) — so every edge is semantic.
3. **Derived by default, authored on promotion** (§9) — browsing is channel-1; only claim/pin earns
   channel 3. Deterministic ids make promotion seamless.
4. **Rectangular box, card-type-chosen chrome** (§7) — never non-AABB geometry.
5. **Git is the file-activity clock, projected onto the tree** (§8); live vs historical reuses the session
   duality.

**Defer:**

- Real containment semantics in core (subtree-atomic claims/undo) — start layout-only (§4), promote only if
  needed.
- Treemap polish and drill animation (§6) — the collapsed list is enough for steps 0–1.
- Git-log feed (§8) — needed at step 3, not before.
- Richer edge-type visual vocabulary (claim color-by-owner, animated message edges) — `EdgeLayer` grows
  with the messaging work; shared substrate.
- Branch comparison / diff-between-refs on the scrubber — a second clock on top of the first; later.
