import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { contentVersion } from "./cas-guard.js";
import { MAX_BYTES } from "./server-http.js";

// The card-type definitions folder (app/card-types/*/). A stateless filesystem location, so it lives here
// with the other fs primitives rather than in a route module: both the card-types route (routes/card-types.ts,
// which reads the type.yaml + render.js under it) and the card-types WATCH feed (server-orchestration.ts, an
// engine) need it, and an engine importing it from a route was the wrong-direction edge the split removed.
// `here` resolves relative to THIS module (app/), so the folder is one level down — the same app/card-types
// the god-file's `path.resolve(here, "card-types")` named from app/.
const here = path.dirname(fileURLToPath(import.meta.url));
export const CARD_TYPES_DIR = path.resolve(here, "card-types");

// ── the filesystem-serving / confinement helpers ────────────────────────────────────────────────
// The third stateless seam of the god-file split (after server-http.ts's HTTP plumbing and
// server-context.ts's stateful accessors). Where server-http.ts holds the transport-level helpers, this
// module holds the PURE filesystem primitives the file/asset/watch/annotation route handlers share: path
// confinement (safeResolve), the browse/serve visibility rules (EXCLUDE_DIRS + isInternalPath), the text /
// image extension gates, the content-version stamp, and the root watcher. Everything here touches only its
// arguments and the filesystem — no cross-request state — so it lives outside ServerContext, exactly like
// server-http.ts. It is a SIBLING of server-http.ts, not part of it: these are fs-serving rules (and pull
// chokidar), not HTTP plumbing, so keeping them apart preserves each module's single identity. The god-file
// still imports isInternalPath (its shadow-git ignore predicate) and openRootWatcher (the WS file-watch)
// from here — the same one-definition-shared-both-ways discipline the split exists to establish.

// The directory basenames the browse listing and the watchers skip. `.canvas` is DELIBERATELY NOT here: the
// canvas's own filesystem (docs/canvas-home.md — memory, roles, threads, annotations, images) is BROWSABLE
// so a human can navigate to a file (e.g. `.canvas/memory/`) and drag it onto the board as an
// editable/annotatable card. The browse listing (handleLs / Rule A) is kept in lock-step with servability
// by ALSO filtering on isInternalPath (Rule B) — so it shows exactly what the content endpoint will serve,
// hiding only the two off-limits `.canvas` subtrees (`board`, the churny record store; `roots`, the shadow
// git-dirs / feedback-loop hazard). No dead rows that 404 on open.
// `.venv`/`venv`: Python virtualenvs run to ~10k files each, and chokidar v4 (no fsevents) holds one open
// kqueue fd PER WATCHED FILE — an external repo mounted as a board with a `.venv` blew past macOS OPEN_MAX
// and every posix_spawn failed EBADF (2026-07-15; same failure mode as the `.canvas/worktrees` fix,
// 2026-07-11). Name-match like the rest of this set — no pyvenv.cfg stat — because isInternalPath is a pure
// string predicate over (possibly relative) paths; the cost is hiding a source dir literally named `venv`,
// which convention reserves for virtualenvs anyway.
export const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".vite", ".cache", "coverage", ".venv", "venv",
]);

// Rule B (docs/canvas-home.md §3/§5): is this path INTERNAL to the watchers + content endpoints? Excluded if
// any segment is a generated/internal dir — EXCEPT `.canvas`, whose CONTENT must be reachable; under `.canvas`
// only the shadow git-dirs (`.canvas/roots/<id>/git`) are internal (a commit writes objects there, so a
// watcher seeing them would re-commit forever — the feedback loop). Path-aware: the `.canvas/roots` boundary
// is two adjacent segments, which a bare basename Set can't express. Accepts absolute or root-relative paths.
export function isInternalPath(p: string): boolean {
  const segs = p.split(/[\\/]/);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === ".canvas") {
      if (segs[i + 1] === "roots") return true; // the shadow object store — never watched/served
      // The board record store (board-persist.js): an event append per GESTURE + a snapshot rewrite
      // per edit burst. No card reads these via the file endpoints (they have their own
      // /api/board/persist API), so watching them would only spam every tab with watch events and
      // TRIGGER a shadow commit per gesture. They still ride ALONG in shadow commits fired by real
      // content edits (commitRoot force-adds `.canvas` minus only `roots`) — versioned, not churning.
      if (segs[i + 1] === "board") return true;
      // Agent worktrees (`spawn --worktree`) are full nested checkouts — hundreds of files each, plus any
      // node_modules/.venv a worker installs. They are NOT board roots (listWorktrees excludes them) and the
      // shadow floor never stages them (shadow-git.js), so the canonical watchers descending into them bought
      // nothing — and on chokidar v4 (no fsevents) every watched file holds an open kqueue fd, which is what
      // exhausted the process fd table and crashed the dev server (spawn EBADF, 2026-07-10). Never watch or
      // serve them from the canonical root; a worktree session addresses its own tree by cwd, not these paths.
      if (segs[i + 1] === "worktrees") return true;
      continue; // every other `.canvas/<content>` is reachable
    }
    if (EXCLUDE_DIRS.has(s)) return true;
  }
  return false;
}

// Text files only — the cards render content inline, so binaries are skipped at the listing.
export const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".css", ".html", ".py", ".yaml", ".yml", ".toml", ".sh",
  ".ipynb", // Jupyter notebooks are JSON; the ipynb card renders them from fileContent.
]);

// IMAGE assets (the image card, image-cards-on-canvas). Binaries can't ride the text file endpoints
// (TEXT_EXT-gated, utf8) so they get their OWN /api/asset read/write, with a parallel extension gate and
// a mime map for the read's Content-Type. Drag-and-drop lands a screenshot/photo as a repo file here, then
// the image card views it by (root, path) — same addressing as a file card, different transport.
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"]);
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
export const MAX_ASSET_BYTES = 12 * 1024 * 1024; // images are heavier than source — a generous cap (a high-res
// screenshot or photo fits comfortably); the byte read is the one bound, per CLAUDE.md's size-cap rule.

// Resolve a caller-supplied relative path against a root and refuse anything that escapes it.
export function safeResolve(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

// W12 — the doc's optimistic-concurrency version: a content hash of its FULL on-disk bytes (not the
// MAX_BYTES preview), so the CAS detects a change anywhere in the file, and `null` for a file that doesn't
// exist yet. A read stamps this alongside the content; a write echoes it as `baseVersion` (handleFileWrite).
export function fileVersion(abs: string): string | null {
  try {
    return contentVersion(fs.readFileSync(abs));
  } catch {
    return null; // no such file — the version of "absent" (a create passes baseVersion:null)
  }
}

// The /api/file read used to read the whole file TWICE per request — once for the preview (readText)
// and again for the version hash (fileVersion) — N cards ⇒ 2N sync reads queued on the event loop. This
// reads ONCE and derives both from the same buffer: the head-clipped `maxBytes` preview (with the
// `truncated` flag) AND the content version, which is the hash of the FULL bytes (`buf` is the whole file
// regardless of `maxBytes`, so the version stays identical to fileVersion's). Null when the file can't be
// read (same contract as readText). The two-read pattern stays only where a SECOND read is genuinely a
// re-read of changed bytes (handleFileWrite's post-write version stamp).
export function readFileWithVersion(
  abs: string,
  maxBytes: number = MAX_BYTES,
): { content: string; truncated: boolean; version: string } | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  return {
    content: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: buf.length > maxBytes,
    version: contentVersion(buf)!, // a real Buffer (the read succeeded) always hashes to a string, never null
  };
}

// The chokidar watcher one watch subscription rides — shared by the SSE endpoint (handleWatch, the /api/watch
// compat path) and the WS file-watch (one per open root). Forward file add/change/unlink plus DIR add/remove
// (mapped to the generic add/unlink), so a directory card whose folder is deleted on disk gets tombstoned
// rather than hanging on "loading…" (worktree-activity slice D). The client gates every event to a card that
// actually exists, so forwarding dir events is harmless noise otherwise. Returns the close handle.
export function openRootWatcher(root: string, send: (ev: { type: string; path: string }) => void): () => void {
  const emit = (type: string) => (abs: string) => send({ type, path: path.relative(root, abs) });
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // Rule B (docs/canvas-home.md §5): watch `.canvas/` CONTENT (so a dropped image / file-backed body
    // refreshes its card) but never the shadow git-dirs under `.canvas/roots/` (the feedback loop).
    ignored: (p: string) => isInternalPath(p),
  });
  watcher
    .on("add", emit("add"))
    .on("addDir", emit("add"))
    .on("change", emit("change"))
    .on("unlink", emit("unlink"))
    .on("unlinkDir", emit("unlink"));
  return () => void watcher.close();
}
