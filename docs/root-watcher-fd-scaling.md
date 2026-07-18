# Root watcher: scope the watch to board content

**Status:** planned — not yet implemented. A name-based stopgap is in place (see the end).

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
filter (still skip `.canvas/roots`, etc.) but stops being load-bearing for fd safety, and the `data` stopgap
(below) can be removed.

Touchpoints: `openRootWatcher` (server-fs.ts) becomes per-directory rather than per-root; `subscribeWatch` /
`watchSubs` (feeds.ts) and the WS `sub/unsub:"watch"` protocol (vite-fs-plugin.ts) key on `(root, dir)` and
maintain refcounts; the client derives the dependency-directory set from live cards + loaded listings +
loaded annotations and drives subscriptions from it. Worth a test that mounts a scratch tree, opens/moves/
deletes cards, and asserts the watched-directory set (and fd count) tracks board content, not tree size.

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