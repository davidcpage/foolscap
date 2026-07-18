// Pure derivation of the board's file-watch dependency set — no store, no DOM, no fetch, so it unit-tests
// hermetically (loader.ts's watchBoardDependencies wires the live signals into it). The board scopes its
// file watch to the DIRECTORIES that hold a live dependency (docs/root-watcher-fd-scaling.md), never the
// whole mounted tree, so the watched-directory count tracks BOARD CONTENT, not repo size. This module owns
// the derivation; keeping it dependency-free (no imports at all) also keeps hermetic consumers — like the
// scaling/refcount test — free of the loader's editor/DOM graph.

// File-backed card types: their node id is `node:<root>:<path>` and they mirror a real file/dir on disk.
// Everything else on the board (clock, session, thread, sticky, feed widgets) reads no file, so contributes
// no watch. Kept in sync with materializeAt / materializeImageAt (loader.ts), the only minters of these.
export const FILE_BACKED_TYPES: ReadonlySet<string> = new Set([
  "file",
  "directory",
  "notebook",
  "ipynb",
  "image",
]);

// The annotation ledger directory as a watch dir (no trailing slash — the parentDir/(root, dir) convention).
// Watched on the canonical root whenever ANY annotation is loaded, so a ledger append (an agent commenting
// server-side) re-pulls the affected doc's projection through the same watch the file content rides.
export const ANNOTATION_LEDGER_DIR = ".canvas/annotations";

// Parent folder of a root-relative POSIX path ("a/b/c" → "a/b", "a" → "" = the root's own top-level listing).
// The server emits path.relative joined with "/", and a root's directory is keyed by "".
export function parentDirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

// (root, dir) → one key. NUL can't occur in a path or a root slug (same convention as feeds.ts / content.ts
// and the server's watchKey), so it's an unambiguous separator.
export function watchDirKey(root: string, dir: string): string {
  return root + "\0" + dir;
}

// Split a watch key back into its (root, dir) — the reconciler's subscribe step needs the pair.
export function splitWatchKey(k: string): { root: string; dir: string } {
  const sep = k.indexOf("\0");
  return { root: k.slice(0, sep), dir: k.slice(sep + 1) };
}

/** A file-backed card node, reduced to the two fields the derivation needs. */
export interface WatchNode {
  id: string;
  type: string;
}

// The distinct (root, dir) directories the board must watch, as a Set of watchDirKey strings, from:
//  (a) each file-backed card's PARENT dir — for content `change` + `unlink`/tombstone, and (for a directory
//      card) to notice the folder itself being deleted;
//  (b) each directory with a live listing subscriber — for add/unlink of its children (listing refresh);
//  (c) annotations (canonical "repo" root): each annotated file's PARENT dir + the shared ledger dir.
// The Set collapses shared directories to ONE entry — two file cards in the same folder ⇒ one watch — which
// IS the refcount at the derivation layer: a directory stays in the set while ANY dependency needs it and
// drops out only when the last one goes, so the reconciler opens exactly one watcher per live directory.
export function desiredWatchDirs(
  nodes: readonly WatchNode[],
  listingDirs: readonly { root: string; path: string }[],
  annotationPaths: readonly string[],
): Set<string> {
  const set = new Set<string>();
  // (a) file-backed nodes → parent dir. The id encodes (root, path): node:<root>:<path> (root is colon-free).
  for (const n of nodes) {
    if (!FILE_BACKED_TYPES.has(n.type)) continue;
    const m = /^node:([^:]+):(.*)$/.exec(n.id);
    if (!m) continue;
    set.add(watchDirKey(m[1], parentDirOf(m[2])));
  }
  // (b) live directory listings → the dir itself (its children are the dependency).
  for (const d of listingDirs) set.add(watchDirKey(d.root, d.path));
  // (c) annotations live on the canonical root only: the ledger dir (once, if any are loaded) + each
  //     annotated file's parent dir (an edit there shifts anchors; the server re-derives on the next GET).
  if (annotationPaths.length) set.add(watchDirKey("repo", ANNOTATION_LEDGER_DIR));
  for (const p of annotationPaths) set.add(watchDirKey("repo", parentDirOf(p)));
  return set;
}
