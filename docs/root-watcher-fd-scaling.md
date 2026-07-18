# Root watcher: scope the watch to board content

**Status:** implemented (node:thread:9ed8a09a). The whole-tree WS watcher is replaced by a dynamic,
refcounted set of depth-0 directory watches derived from live board dependencies. `/api/watch` (the SSE
compat endpoint) stays whole-tree; the app no longer uses it. `EXCLUDE_DIRS` / `isInternalPath` remains as a
cheap event filter but is no longer load-bearing for fd safety.

## The problem is *what* we watch, not *how*

`openRootWatcher` (`app/server-fs.ts`) watches the **entire mounted tree** of every open board root with
chokidar — one recursive watcher per `(socket, root)`. chokidar v4 dropped fsevents, so on macOS it falls
back to `fs.watch` per path and holds **one kqueue file descriptor per watched file**. Mount a board root
that is a large external checkout and the initial scan opens tens of thousands of fds, blows past
`kern.maxfilesperproc` (61440), and the server dies at boot with `EMFILE: too many open files` (open boards
auto-remount, so the watcher fires before anything is served). The same exhaustion has surfaced as
`posix_spawn … EBADF`. The `EXCLUDE_DIRS` name blacklist (`node_modules`, `.git`, `.venv`, …) is a
patch-per-directory response that does not generalise: an arbitrarily large subtree can have any name and is
often untracked-but-not-gitignored, so neither the blacklist nor a `.gitignore` pass catches it.

But the fd cost is a *symptom*. The root cause is that **we watch the whole tree when the board only reacts
to a tiny, known subset of it.** The consumer proves this. `watchDataset` → `onWatchEvent` (`app/src/loader.ts`)
does exactly three things with a `(root, path)` event, each gated:

1. `refreshListing(root, parentDir(path))` — re-pull a directory listing, **no-op unless a directory card
   has loaded that folder**.
2. `annotationsWatchEvent(root, path)` — refresh an annotation projection, **no-op unless a card has loaded
   that path's annotations**.
3. Card content refresh + tombstone/re-add — **`if no card exists for (root, path) → return`**.

The loader comment says it outright: *"a single repo watch backs whatever folders the user has added, but a
content change / unlink to a path with NO card touches no card — we don't auto-spawn cards."* So watching a
100k-file tree means firing ~100k events that all hit a no-op gate, at the cost of ~100k fds. Nobody needs
live updates for a file that was never dropped onto the canvas.

## What the watch is actually for

To keep the canvas a **live mirror of the real folder on disk**, reacting to out-of-band edits (your editor,
an agent, `git pull`) with no polling. The dependencies that actually matter are:

- **Each `(root, path)` that backs a card** (file / notebook / image cards) — for content refresh, and for
  tombstone-on-delete / clear-on-recreate.
- **Each directory a directory card has loaded** — for add/unlink of its children (listing refresh). This is
  parent-directory granularity: to see a file appear or vanish you must watch its *directory*, not the file.
- **Loaded annotation ledgers** (`.canvas/annotations/…`) and annotated files — annotations ride the same
  stream.

(Separately, the shadow-git committer has its **own** coarse watcher — `watchRoot` in `shadow-git.js`, used
by `server-orchestration.ts` — which already uses native `fs.watch` as a one-fd "something changed" ping.
That is not affected by this and is not the fd problem.)

## Fix: watch the directories that contain live dependencies, depth 0

Replace the single whole-tree recursive watcher with a **dynamic set of shallow directory watches** derived
from board state:

- The unifying primitive is **watch a directory at depth 0** (`fs.watch(dir)` / chokidar `depth: 0`). A
  depth-0 dir watch reports `change` for files in it (card content) **and** add/unlink of its entries
  (listing refresh, create/delete of a card's file). Both dependency kinds — a file card's parent dir and a
  directory card's loaded folder — reduce to the same primitive.
- The watched set is **the distinct directories that contain at least one live dependency.** Its size is
  bounded by *board content* (dozens of directories), never by repo size — so no mounted checkout, however
  large, can exhaust fds.
- **Refcount per directory**: several cards can share one folder; the watch closes only when its last
  dependent goes away.
- The set is **reactive**: subscribe/unsubscribe as cards mount, unmount, or get retargeted (rename/move),
  and as directory cards load or collapse folders. This is the real cost of the approach — the watch set
  becomes derived, live board state instead of "watch the root once and forget."

This works on **stock chokidar v4, cross-platform**: watching a small set of known directories at depth 0 is
cheap on every backend (kqueue, inotify, FSEvents), with no recursive-watch portability cliff. It keeps all
of chokidar's value — clean add/change/unlink/dir classification, `awaitWriteFinish`, `ready` — that a raw
`fs.watch` rewrite would have to re-implement. `EXCLUDE_DIRS` / `isInternalPath` stays as a cheap event
filter (still skip `.canvas/roots`, etc.) but stops being load-bearing for fd safety.

## As built

The design above shipped as-is. The concrete pieces:

- **`app/server-fs.ts`** — `openDirWatcher(dir, relBase, send)` is the depth-0 primitive (chokidar
  `depth: 0`, `ignoreInitial`, `ignored: isInternalPath`), reporting paths relative to `relBase` (the root
  dir) so a card addresses the same `(root, path)` regardless of which directory watcher delivered the event.
  `openRootWatcher` is retained, whole-tree, **only** for the `/api/watch` SSE compat endpoint.
- **`app/vite-fs-plugin.ts`** — the WS protocol is `{sub|unsub:"watch", root, dir}`; `client.watches` is
  keyed `(root, dir)` (`watchKey`). `openClientWatch` / `closeClientWatch` hold the keying + `rootDir` /
  `safeResolve` confinement + the `.ipynb` kernel-reap on unlink, extracted so they unit-test without a live
  upgrade.
- **`app/src/feeds.ts`** — `subscribeWatch(root, dir, fn)` refcounts per `(root, dir)`: first-in sends the
  sub, last-out sends the unsub; `onopen` re-sends every live pair after a reconnect.
- **`app/src/watch-deps.ts`** — the **pure** `desiredWatchDirs(nodes, listingDirs, annotationPaths)`
  derivation: (a) each file-backed card's parent dir, (b) each live directory listing, (c) annotated files'
  parent dirs + the ledger dir. The `Set` collapses shared directories to one entry — that dedup *is* the
  refcount at the derivation layer.
- **`app/src/loader.ts`** — `watchBoardDependencies(m, onEvent)` wires the live signals (the store's
  file-backed nodes, `content.loadedListingDirs()`, `annotations.loadedAnnotationPaths()`, `rootsSignal`)
  into `desiredWatchDirs`, diffs the result against live subscriptions, subscribes newcomers, and closes
  departures after a short settle (so rename/move and expand/collapse don't thrash the server watcher). The
  set is gated to roots the server currently knows (`rootsSignal ∪ "repo"`) so a card hydrated before its
  worktree root is reported doesn't send a dead sub. It replaces the per-root watch effect in `App.tsx`.
- **Tests** — `app/test/middleware-hermetic.test.mjs`: `openDirWatcher` depth-0 scoping (fires for a dir's
  own children, never its subtree), `openClientWatch` `(root, dir)` keying / open-once / confinement /
  close, and the pure `desiredWatchDirs` derivation + dedup.

## Why not just change the watch backend

Two tempting fixes address the fd *symptom* without fixing the cause (still watch everything), so they are
**not** recommended:

- **Native `fs.watch(root, {recursive:true})`** — one FSEvents stream, O(1) fds on macOS. But recursive
  native watch is unsupported/flaky on Linux (needs a fallback), and it hands back only `rename`/`change`
  with a sometimes-null filename, forcing us to re-implement add/unlink/dir classification and debounce.
- **Pin chokidar to v3** (uses the already-installed fsevents) — restores one-stream macOS watching with
  zero code change and keeps chokidar's robustness. But it's the older major, and it still watches the whole
  tree wastefully; it only hides the cost behind FSEvents on macOS and does nothing for other backends.

Both are backend tweaks to a design that watches far more than it uses. Scoping the watch removes the whole
class of problem instead.
