# The `.canvas/` home: one dot-folder for everything canvas-owned

A single, git-ignored, shadow-versioned directory that is the home for **all canvas-owned state that should
not live in the human's git** — dropped images, file-backed card bodies, channel logs, agent roles and
memories, notebook artefacts, and the shadow ledger itself. The convention already exists in embryo (the
shadow git-dir and `.canvas/artefacts/` live here today, `docs/shadow-git-ledger.md` §4); this doc promotes
it from "where the shadow DB hides" to "the canvas's filesystem."

## 1. The reframe: a home, not an exclusion

Today `.canvas/` reads as a thing to *exclude* — the dir the human repo ignores and the dev-server watcher
skips. That framing produced `canvas-images/` at the repo root (`image-cards.md` rung 1): an asset routed
*around* `.canvas/` because `.canvas/` was treated as off-limits wholesale.

Invert it. `.canvas/` is the **canvas's own filesystem**: the place where everything the board owns but the
source tree shouldn't carry lives, with its own history (the shadow ledger) and its own visibility rules.
"Out of the human's git" is a *feature* of that home, not a reason to avoid it.

## 2. What this is NOT

- **Not a second source tree.** Nothing here is hand-authored project source; it's board-owned state
  (assets, card bodies, logs, memories). Your `git status` never shows it (Gate 2, §3) — that's intended.
- **Not a new persistence channel.** Durable card *arrangement* still lives on the intent log; `.canvas/`
  holds *content* (the file-backed disk-projection tier, the file card's pattern). Channel discipline is
  unchanged: the log keeps the (root, path) reference, the bytes live here.
- **Not versioned by the human repo.** History for `.canvas/` is the shadow ledger's job
  (`shadow-git-ledger.md`), independent of the user's commits.

## 3. The three gates (and why force-add is unavoidable)

The single most important clarification, because the coarse `.canvas` exclusion conflates three independent
mechanisms. They are *not* one switch:

| Gate | Lives in | Governs |
|---|---|---|
| **1. Watcher + fs endpoints** | `EXCLUDE_DIRS` (`vite-fs-plugin.ts`) | what chokidar watches; what `/api/ls`, `/api/file`, `/api/asset` list & serve |
| **2. Human `.gitignore`** | `.gitignore` (`.canvas/`) | what the **user's** git tracks |
| **3. Shadow repo's view** | `SHADOW_EXCLUDES` (`info/exclude`) **+ the in-tree `.gitignore` it inherits** | what **shadow** history tracks |

The shadow repo shares the work-tree (`--git-dir` over a shared `--work-tree`, `shadow-git-ledger.md` §3),
so it **reads the same in-tree `.gitignore`** the human repo does — which ignores `.canvas/` wholesale.

Git rule that makes this load-bearing: **you cannot re-include a child of an ignored parent via a negation
pattern** — *"it is not possible to re-include a file if a parent directory of that file is excluded."* So
`!.canvas/images/` in the shadow's `info/exclude` is inert while `.canvas/` is ignored. The robust escape is
`git add --force <path>`, which bypasses ignore rules for an exact path.

**Consequence:** narrowing Gate 1 (the watcher) to `.canvas/roots/` lets the dev server *see and serve*
`.canvas/images`, but `git add -A` in the shadow repo **still skips it** (Gate 2). Force-add is therefore
required regardless of Gate 1 — the two are unrelated. (This was the source of the confusion that prompted
this doc: the watcher exclusion and the gitignores are different gates.)

## 4. The shadow tracking rule: force-add `.canvas`, unstage `roots`

Today the floor commit force-adds exactly `.canvas/artefacts` (`shadow-git.js:112`). Generalize it so new
content subdirs need **zero** shadow-git changes:

```
git add -A                       # everything outside .canvas (Gates 2/3 skip .canvas/)
git add --force .canvas          # pull ALL canvas-owned content into the shadow index
git reset -q -- .canvas/roots    # …except the shadow object stores themselves
```

The shadow object store under `.canvas/roots/<id>/git` is the **only** thing under `.canvas/` we must keep
out of shadow history: self-tracking is churn, and it is the feedback-loop source (§5). Everything else —
images, stickies, channels, roles, memories, artefacts — is content we *want* versioned. One rule, future
content subdirs free.

(The per-tool-call `paths` staging mode already force-adds explicit paths, so it's unaffected.)

## 5. The one hard constraint: never watch the shadow git-dir

A shadow commit writes objects under `.canvas/roots/<id>/git`. If the watcher saw those writes it would
re-commit, forever (`vite-fs-plugin.ts:233`, `architecture-review §3`). This is the *entire* reason `.canvas`
is watcher-excluded — and it is **narrow**: only `.canvas/roots/` must stay unwatched.

So Gate 1 splits:

- **Watcher / shadow-watcher ignore** → `.canvas/roots/` only (path-prefix, not the basename `.canvas`
  anywhere). Both the dev-server content watcher (`vite-fs-plugin.ts:675`) and the shadow committer's own
  `shadowIgnored` (`:1698`) key off this.
- **Endpoint visibility** → serve `.canvas/<content>` subdirs (images via `/api/asset`, text bodies via
  `/api/file`, listings via `/api/ls`) while still refusing `.canvas/roots/`.

The matcher graduates from a **basename Set** (`EXCLUDE_DIRS.has(seg)`) to a **path-prefix test**, because
`.canvas/images` and `.canvas/roots/<id>/git` must now be distinguished — basename matching can't.

Loop check after narrowing: image dropped → watcher fires (allowed) → one floor commit (§4) → objects land
in `.canvas/roots/.../git` (still unwatched) → no re-fire. Single commit, no storm.

## 6. Layout

```
.canvas/                      git-ignored by the human repo (Gate 2); shadow-versioned (§4)
├── roots/<id>/git            shadow git-dir(s) — the ONLY watcher-excluded thing (§5)
├── board/                    the one board snapshot (deferred, shadow-git §8)
├── artefacts/                notebook outputs etc.            (exists)
├── images/                   dropped image assets             (rung 1 move)
├── stickies/                 file-backed sticky bodies        (later — storage-tier change)
├── channels/                 persisted channel logs           (later — durability win)
├── roles/                    agent role definitions           (when roles land)
└── memory/                   agent memories                   (via autoMemoryDirectory)
```

Addressing is unchanged: a content file under `.canvas/` is still a `(root, path)` pair → a `node:<root>:<path>`
card id, exactly like any file card. Only the *path prefix* is new.

## 7. Per-tenant plan (what's free, what's a step, what's blocked)

- **Images** — *free* once Gate 1 narrows. Move `IMAGE_DIR` to `.canvas/images`; `/api/asset` serves it; the
  §4 rule force-adds it. Strictly better than `canvas-images/`: out of the human git, shadow history for free.
- **Shadow-git subfolder** — *already done*: `.canvas/roots/<id>/git`. The §4/§5 rules just key on it.
- **Agent role definitions** — *easy*: new format we own; drop files under `.canvas/roles/`.
- **Agent memories** — *feasible* via the documented `autoMemoryDirectory` knob (`headless-session-memory`).
  Bonus: memory becomes board-shared **and** shadow-versioned — aligned with "the board is shared memory."
- **File-backed stickies** — *its own step.* Stickies store content **on the intent log** today
  (`setText`/`setTitle`); file-backing is a storage-*tier* change with undo/provenance implications. The
  sticky `type.yaml` already names it "a later codec." Worth doing deliberately, not as a side effect.
- **Channel cards** — *its own step, and a real win.* Channels are off-log server memory today (lost on a
  cold restart, `agent-to-agent-messaging.md` §15). Persisting the log to `.canvas/channels/<id>.jsonl` makes
  them durable across cold restarts.
- **Session transcripts** — *the one genuine caveat.* They live at `~/.claude/projects/<encoded-cwd>/*.jsonl`,
  **owned by the Claude Code CLI**, not our code. We can't relocate them into `.canvas/sessions/` unless the
  CLI grows a transcript-dir override; we could *mirror* them, but that's duplication. Aspirational, gated on
  the CLI — flagged here so the layout reserves the name without overpromising.

## 8. Staged path

0. **This doc** — settle the convention (gates, the §4 rule, the §5 narrowing, the layout). **DONE.**
1. **Narrow Gate 1** — `EXCLUDE_DIRS` basename `.canvas` → the `isInternalPath` (Rule B) `.canvas/roots/`
   path-prefix rule, applied to both watchers + the file/asset/mut endpoint gates; the browse listing stays
   Rule A. Feedback-loop test rewritten to assert both halves. **DONE — commit 56b6086.**
2. **Generalize the force-add** — `git add --force -- .canvas ':(exclude).canvas/roots'` in the floor commit
   (§4); drops the artefact-specific force-add (subsumed). The `:(exclude)` pathspec prunes roots from the
   add itself (no stage-then-reset). Non-interference + tracking tests green. **DONE — commit d3c9440.**
3. **Re-point images** — `IMAGE_DIR` → `.canvas/images`. Round-trip + live-watcher shadow-versioning covered
   by tests; human `git status` stays clean. **DONE — commit 62fd953.**
4. **Then, independently:** the content tenants (roles, memories, stickies, channels) — each its own
   design+build effort, **not** a path move. Design-readiness per tenant in §10.

## 9. Pin vs defer

1. **`.canvas/` is the canvas's filesystem** (§1) — one home for all board-owned, non-source state; "out of
   the human git" is the feature, not a reason to route around it.
2. **Three gates, not one** (§3) — watcher/endpoints, human gitignore, shadow view are independent; force-add
   is a Gate-2 consequence and is unavoidable while `.canvas/` is human-ignored.
3. **One shadow rule** (§4) — force-add `.canvas`, unstage `roots`; new content subdirs are free.
4. **The only hard constraint is the git-dir** (§5) — `.canvas/roots/` stays unwatched; everything else under
   `.canvas/` is watchable and servable.
5. **Storage-tier moves are their own steps** (§7) — stickies (log→file) and channels (off-log→durable) are
   deliberate codecs, not folded into the path move.

**Deferred:** session-transcript relocation (CLI-owned, §7); the `board/` snapshot home (shadow-git §8);
finer per-root metadata under `roots/` (reserved — keep `roots/` shadow-internal for now).

## 10. Step 4 — content tenants: design-readiness

The `.canvas/` infrastructure (gates, force-add, layout) is done; the *tenants* are not. Each below is a
separate design+build effort, **not** a migration — so this section records, per tenant, what exists today,
the open decisions, and rough effort, so a future session picks up with the questions *framed*. The grounded
status was verified 2026-06-26: **none of these is "move a folder."**

### Channels — `.canvas/channels/<id>.jsonl` (cleanest next; durability win)
- **Today:** the message log is an **in-memory** `channelLogs` Map (`vite-fs-plugin.ts`), republished to the
  `channel:<id>` feed and rendered by the card; **lost on a cold restart** (`agent-to-agent-messaging.md` §15).
  The channel NODE (card) and `member:open` edges are already on the intent log — only the *log* is ephemeral.
- **Open decisions:** (a) format — jsonl of the existing `ChannelMsg` shape `{seq,ts,from,text,kind?}`; (b)
  write cadence — append-per-message (natural for an append-only log; `MAX_CHANNEL_MSGS` tail already bounds
  it) vs debounced; (c) boot-load — read `.canvas/channels/*.jsonl` back into `channelLogs` + re-publish feeds
  on server start; (d) read-cursors — persist per-session unread state, or reset it on cold restart?
- **Effort:** low–medium. Self-contained, append-only, no UI/undo entanglement. Depends on nothing. The
  node-vs-log split stays as-is; this only persists the log.

### Stickies — `.canvas/stickies/` (the most entangled; decide undo first)
- **Today:** content is **on the intent log** — caps `[setTitle, setText, setColor]`, `setText`/`setTitle`
  write `node.text`/`node.title`, IndexedDB-persisted, **⌘Z-undoable + provenance-tagged**. No file-backing
  groundwork. Precedent: the **notebook** card is file-backed + editable (`writeFile` capability +
  `fileContent` signal projected from disk).
- **Open decisions:** (a) format + title home — markdown vs plain text; title as filename / frontmatter /
  first heading; (b) **the crux — edit semantics flip:** on-log `setText` is per-edit undoable; a file body is
  off-log + shadow-versioned and **not** in the user's ⌘Z. Choose: hybrid (title/arrangement on-log, body
  file-backed) or fully file-backed (shadow-git becomes the body's history, per-edit undo is lost — the
  notebook's stance); (c) existing-data migration — current stickies' content is on the log → one-time move or
  a dual-read window; (d) file identity — `.canvas/stickies/<nodeId>.md` (simple, not human-browsable) vs a
  human-chosen name.
- **Effort:** medium–high. The codec is routine (notebook shows how); the undo-semantics + migration decisions
  are the real work. Depends on nothing infra-wise.

### Memories — `.canvas/memory/` (partly gated on roles)
- **Today:** agent memories live in `~/.claude/projects/<encoded-cwd>/memory/` (the auto-memory store).
  `autoMemoryDirectory` is **not wired** in this repo. Per [[headless-session-memory]] the knob *can* relocate
  the store (replaces the projects base, keyed by encoded-cwd, works under `-p`), and the **write** side must
  be made explicit in the spawn's append-system-prompt.
- **Open decisions:** (a) **semantics** — board-SHARED memory (one `.canvas/memory/` all sessions read/write,
  aligned with "the board is shared memory") vs per-role/per-session stores; concurrency + ownership follow
  from this; (b) wire `autoMemoryDirectory` in `ensureLiveSession` to point at `.canvas/memory/` + make the
  write side explicit; (c) relationship to roles — a *role's* memory vs ambient session memory.
- **Effort:** medium — mostly spawn-config + one semantics call. Relocating into `.canvas/` makes memory
  shadow-versioned **and** board-shared: a real shift, decide deliberately. Somewhat entangled with roles.

### Roles — `.canvas/roles/` (a subsystem, not a move)
- **Today:** **doc-only** — `docs/agent-roles.md` (durable ROLES = charter+memory+presence vs ephemeral
  SESSIONS; "oracle is first role"). **No code.** So the file home is a *sub-decision of building roles at
  all*, not a standalone migration.
- **Open decisions:** owned by the roles design itself (agent-roles.md) — charter format, presence/liveness,
  the reflex/cortex lifecycle split. When built, role defs would live at `.canvas/roles/<role>.{yaml,md}`.
- **Effort:** high (a subsystem). Gated on committing to build roles. Do **not** fold into canvas-home.

### Suggested ordering
1. **Channels** — cleanest, self-contained, real durability win.
2. **Stickies** — independent, but settle the undo-semantics decision before coding.
3. **Memories** — partly waits on roles semantics (role memory vs ambient).
4. **Roles** — its own subsystem (agent-roles.md); the biggest, least a "move."

Transcripts stay deferred (CLI-owned, §7). Each tenant is independently shippable on the now-settled
`.canvas/` foundation — no tenant blocks another except the soft memory↔roles coupling above.
