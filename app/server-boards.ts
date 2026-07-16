import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorktreePorcelain } from "./worktrees.js";
import { getServerContext } from "./server-context.js";
import type { BoardInfo, BoardRegistryEntry, RootInfo } from "./server-types.js";

// ── the board registry / identity / ROOTS engine ────────────────────────────────────────────────────
// The board-scoped state + logic lifted out of the vite-fs-plugin.ts god-file (F-S3): board IDENTITY
// (repo → stable id), the in-memory `boards` map + its durable registry (`.canvas/boards.json`), the
// request→board resolver, and a board's ROOTS (canonical checkout + discovered git worktrees) with their
// short-TTL cache. Every external consumer reaches these through the ServerContext (reqBoard / boardRoots /
// rootDir / boardIdentity / readBoardRegistry / recordBoardOpened / ensureCanvasExcluded / boards), wired
// once by the shell at setServerContext — so this module has no importers to repoint; the shell imports the
// pieces it still needs directly (the route dispatcher's reqBoard, the WS-watch rootDir, boot wiring). The
// one cross-module effect (boardRoots pings `roots:<board>` on a worktree add/remove) reaches publishFeed
// through getServerContext(), the established engine idiom — no runtime import of the feed engine.

const here = path.dirname(fileURLToPath(import.meta.url));

// The one allow-listed root: the canvas repo itself, derived from the dev-server location so it tracks
// whatever machine this runs on (no hardcoded user path).
const ROOTS: Record<string, string> = {
  repo: path.resolve(here, ".."),
};

// Board identity (Phase 1 of multi-canvas). A board is a target repo plus a STABLE id derived from that
// repo's realpath — port-independent and restart-stable, so persistence keyed on it survives the dev
// server bouncing to a different port. `<slug(basename)>-<sha256(realpath)[:8]>` stays human-legible for
// debugging while the hash keeps two same-named repos apart.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "board";
}
export function boardIdentity(repoPath: string): { boardId: string; name: string; repoPath: string } {
  let real = repoPath;
  try {
    real = fs.realpathSync(repoPath);
  } catch {
    /* unresolvable (deleted/permission) — hash the path as given so the id is still stable */
  }
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  const name = path.basename(real);
  return { boardId: `${slug(name)}-${hash}`, name, repoPath: real };
}

// A scratch/test board's repo lives under the OS tmpdir — the http-contract suite mounts its board there,
// and such a tree is throwaway by construction. This is the ONE definition of that predicate (don't persist
// one, prune it at boot, refuse real sessions on it — sessionSpawnRefusal shares it). Match at ANY depth
// under tmpdir; NEVER a substring match (a sibling like `${tmp}-evil` is a different tree, so compare against
// `tmp + path.sep`), and realpath BOTH sides so a symlinked tmpdir (macOS `/tmp` → `/private/var/…`) matches.
// A path that can't be realpath'd (a scratch dir already deleted) falls back to its resolved form — the
// registry stores repoPaths already realpath'd, so a vanished tmpdir entry still matches and gets pruned.
export function isTmpdirRepo(repoPath: string): boolean {
  let tmp: string;
  try {
    tmp = fs.realpathSync(os.tmpdir());
  } catch {
    tmp = path.resolve(os.tmpdir());
  }
  let real: string;
  try {
    real = fs.realpathSync(repoPath);
  } catch {
    real = path.resolve(repoPath);
  }
  return real === tmp || real.startsWith(tmp + path.sep);
}

export const DEFAULT_BOARD = boardIdentity(ROOTS.repo!);
// boardId → its served root + metadata. Pinned on globalThis so mounts made through /api/boards SURVIVE a
// dev-server re-eval (a plugin edit re-runs this module in the same process) — an open non-default tab would
// otherwise 400 on its boardId until the browser re-mounted. The default board (the dev repo) is always present.
export const boards: Map<string, BoardInfo> = ((globalThis as { __canvasBoards?: Map<string, BoardInfo> })
  .__canvasBoards ??= new Map());
if (!boards.has(DEFAULT_BOARD.boardId))
  boards.set(DEFAULT_BOARD.boardId, { root: ROOTS.repo!, name: DEFAULT_BOARD.name, repoPath: DEFAULT_BOARD.repoPath });

// ── durable board registry (multi-canvas: mounted boards survive a server restart) ────────────────
// The in-memory `boards` map dies with the process, which used to mean every non-default board was
// forgotten on restart. The registry is the durable twin: one JSON file in the DEV repo's `.canvas/`
// recording every repo ever mounted, with a lastOpened stamp for the picker's recency sort. On boot each
// remembered path that still exists is re-registered — map entry only; the per-board feeds/watchers stay
// LAZY (started when a tab actually mounts). The default board is implicit and never recorded.
const BOARDS_FILE = path.join(ROOTS.repo!, ".canvas", "boards.json");
export function readBoardRegistry(): BoardRegistryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(BOARDS_FILE, "utf8")) as { boards?: BoardRegistryEntry[] };
    return Array.isArray(parsed.boards) ? parsed.boards : [];
  } catch {
    return []; // absent/corrupt → empty registry (the next mount rewrites it)
  }
}
// Upsert on every mount POST — read-modify-write against the FILE, not a cached copy (the module hot
// re-evals; cheap correctness beats a stale mirror at this call rate).
export function recordBoardOpened(boardId: string, name: string, repoPath: string, noSessions?: boolean): void {
  // Scratch/test boards (repo under the OS tmpdir) are NEVER persisted: boot would otherwise re-mount the
  // dead tmpdir forever and re-arm shadow/feed machinery on it (the http-contract suite's board did exactly
  // that). The mount still works in-memory for this process — it just isn't remembered across a restart.
  if (isTmpdirRepo(repoPath)) return;
  const all = readBoardRegistry();
  const prev = all.find((e) => e.boardId === boardId);
  const entries = all.filter((e) => e.boardId !== boardId);
  // noSessions is STICKY: once a board is flagged, a later mount POST without the flag must not quietly
  // re-arm real spawns on it (the flagging mount was the deliberate act; unflag by editing the registry).
  entries.push({ boardId, name, repoPath, lastOpened: Date.now(), ...(noSessions || prev?.noSessions ? { noSessions: true } : {}) });
  try {
    fs.mkdirSync(path.dirname(BOARDS_FILE), { recursive: true });
    fs.writeFileSync(BOARDS_FILE, JSON.stringify({ version: 1, boards: entries }, null, 2) + "\n");
  } catch (e) {
    console.error("[boards] registry write failed:", e instanceof Error ? e.message : e);
  }
}
// Boot prune of scratch residue + remount. A tmpdir board should never have been persisted
// (recordBoardOpened now refuses one), but existing installs carry one written before this fix — the
// http-contract suite's `canvas-contract-board-<hash>`. Drop every tmpdir entry from the durable registry
// ONCE at boot so the file self-heals with no hand-editing, then remount the survivors: re-register every
// remembered board whose repo still exists. Entries for vanished non-tmpdir paths are KEPT in the file (a
// repo on an unmounted volume isn't gone forever) but not served this run.
{
  const all = readBoardRegistry();
  const kept = all.filter((e) => !isTmpdirRepo(e.repoPath));
  if (kept.length !== all.length) {
    try {
      fs.mkdirSync(path.dirname(BOARDS_FILE), { recursive: true });
      fs.writeFileSync(BOARDS_FILE, JSON.stringify({ version: 1, boards: kept }, null, 2) + "\n");
      console.log(`[boards] pruned ${all.length - kept.length} scratch (tmpdir) board(s) from the registry`);
    } catch (e) {
      console.error("[boards] scratch-prune write failed:", e instanceof Error ? e.message : e);
    }
  }
  for (const e of kept) {
    if (boards.has(e.boardId)) continue;
    try {
      if (!fs.statSync(e.repoPath).isDirectory()) continue;
    } catch {
      continue;
    }
    boards.set(e.boardId, { root: e.repoPath, name: e.name, repoPath: e.repoPath, ...(e.noSessions ? { noSessions: true } : {}) });
  }
}
// …and the reverse: PRUNE pinned entries the registry no longer records (the file is the durable truth —
// deleting an entry there is how a scratch/test board is retired without bouncing the whole process; the
// pinned map otherwise outlives every re-eval by design). A pruned board's requests 400 until a tab
// re-mounts it via ?repo= (board.ts navigation self-heals exactly that way).
{
  const registered = new Set(readBoardRegistry().map((e) => e.boardId));
  for (const id of [...boards.keys()])
    if (id !== DEFAULT_BOARD.boardId && !registered.has(id)) {
      boards.delete(id);
      console.log(`[boards] pruned ${id} (no longer in the registry)`);
    }
}

// Resolve the board a request targets (?board=<id>, default board if omitted), or null if unknown.
export function reqBoard(url: URL): (BoardInfo & { boardId: string }) | null {
  const id = url.searchParams.get("board") ?? DEFAULT_BOARD.boardId;
  const b = boards.get(id);
  return b ? { boardId: id, ...b } : null;
}

// ── worktrees as ROOTS (worktree-activity slice B) ────────────────────────────────────────────────
// A board is a workspace that can serve MORE THAN ONE root: its canonical checkout (rootId "repo") plus
// every linked git worktree of that repo. Worktrees are DISCOVERED, never mounted: `git worktree list`
// sees whatever an agent or a human created via the CLI, so a new tree appears on its own.
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p; // unresolvable — compare/serve the path as given
  }
}
function listWorktrees(canonicalPath: string): RootInfo[] {
  let out: string;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: canonicalPath, encoding: "utf8" });
  } catch {
    return []; // not a git repo / git absent — no worktrees, just the canonical root
  }
  const raw = parseWorktreePorcelain(out); // shared with worktreeExists (worktrees.js) — one format parser
  // EXCLUDE this board's OWN checkout — it's already the canonical "repo" root (added by boardRoots). It
  // isn't necessarily the first entry: `git worktree list` always prints the MAIN checkout first, so a
  // board rooted at a LINKED worktree must drop the matching entry by realpath, not by position. Every
  // other entry (the main checkout included, seen from a worktree board) becomes a sibling root.
  const canon = realpath(canonicalPath);
  // Agent worktrees (`spawn --worktree`) live under the board's own `.canvas/worktrees/` home. They are
  // ISOLATED workspaces, not sibling checkouts to browse, so they must NOT become board roots (that would
  // flood the file tree with one full tree per live agent). Drop anything under this board's `.canvas/`.
  const canvasHome = realpath(path.join(canonicalPath, ".canvas")) + path.sep;
  return raw
    .map((r) => ({ real: realpath(r.path), branch: r.branch, head: r.head }))
    .filter((r) => r.real !== canon && !r.real.startsWith(canvasHome))
    .map((r) => {
      let id = slug(path.basename(r.real));
      if (id === "repo") id = "repo-wt"; // never shadow the canonical id (a worktree dir literally named "repo")
      return { id, name: path.basename(r.real), path: r.real, branch: r.branch, head: r.head };
    });
}

// Roots per board (canonical first). `git worktree list` is AUTHORITATIVE for both add and remove, so the
// cache is only a short-lived memo to avoid spawning git on every file read — it REVALIDATES past a small
// TTL and, when the set actually changed, pings `roots:<board>` so open boards refetch and their file-tree
// card drops/adds the root live. This self-heals even when the filesystem watcher misses an event. Pinned
// on globalThis like `boards`; a fresh global KEY so a server restart discards the old-shaped cache.
interface RootsCacheEntry {
  roots: RootInfo[];
  at: number;
}
const rootsCache: Map<string, RootsCacheEntry> = ((globalThis as { __canvasRootsCache?: Map<string, RootsCacheEntry> })
  .__canvasRootsCache ??= new Map());
const ROOTS_TTL_MS = 2000;
// Membership identity — id+path, NOT head/branch: a commit inside a worktree shouldn't force a refetch,
// only a worktree appearing or disappearing should.
function rootsChanged(a: RootInfo[], b: RootInfo[]): boolean {
  return a.length !== b.length || a.some((r, i) => r.id !== b[i].id || r.path !== b[i].path);
}
export function boardRoots(boardId: string): RootInfo[] {
  const cached = rootsCache.get(boardId);
  if (cached && Date.now() - cached.at < ROOTS_TTL_MS) return cached.roots;
  const b = boards.get(boardId);
  if (!b) return cached?.roots ?? [];
  const roots: RootInfo[] = [{ id: "repo", name: b.name, path: b.root, branch: "", head: "" }, ...listWorktrees(b.repoPath)];
  rootsCache.set(boardId, { roots, at: Date.now() });
  if (cached && rootsChanged(cached.roots, roots)) getServerContext().publishFeed("roots:" + boardId, { ts: Date.now() });
  return roots;
}
// Resolve a caller's rootId to its absolute dir, confined to this board's known roots — NEVER a
// caller-supplied path (same guarantee as the single `board.root` before). Missing/"" → canonical.
export function rootDir(boardId: string, rootId: string | null): string | null {
  const r = boardRoots(boardId).find((x) => x.id === (rootId || "repo"));
  return r ? r.path : null;
}
// Drop a board's cached roots so the next boardRoots() re-scans. The worktrees watcher
// (startWorktreesFeed) calls this on a `.git/worktrees/` change to make the common case instant;
// boardRoots' TTL revalidation is the actual correctness guarantee.
export function invalidateBoardRoots(boardId: string): void {
  rootsCache.delete(boardId);
}

// Mounting seeds `.canvas/` into the target repo (roles, threads, session markers — canvas-home), which an
// EXTERNAL repo's .gitignore won't cover: its `git status` gets noisy and the canvas-home force-add gates
// assume the dir is ignored. Fix it at the mount, in `.git/info/exclude` — the repo-local ignore file git
// keeps OUTSIDE the working tree, so the repo's tracked files are never touched. check-ignore first: exit 0
// = already ignored (the dev repo's own case) → no-op; exit 1 = not ignored → append; anything else (128 =
// not a git repo at all) → nothing to do. Best-effort throughout.
export function ensureCanvasExcluded(repoPath: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", ".canvas/"], { cwd: repoPath, stdio: "ignore" });
    return; // already ignored
  } catch (e) {
    if ((e as { status?: unknown }).status !== 1) return; // not "unignored" — not a git repo, or git absent
  }
  try {
    // --git-path resolves the right location even for a worktree checkout (info/ lives in the common dir).
    const rel = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoPath, encoding: "utf8" }).trim();
    const excludeFile = path.resolve(repoPath, rel);
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, "\n# foolscap: the canvas home (auto-added on board mount)\n.canvas/\n");
    console.log(`[boards] excluded .canvas/ via ${excludeFile}`);
  } catch (e) {
    console.error("[boards] could not exclude .canvas/:", e instanceof Error ? e.message : e);
  }
}
