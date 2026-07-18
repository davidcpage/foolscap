import fs from "node:fs";
import path from "node:path";

// ── the generic data-feed primitive (Github-feed thread, stage 2) ───────────────────────────────────
// A `data:*` feed is an off-log EVENT STREAM any producer can publish to — the git-log source below, an
// agent's `POST /api/feed/data:<name>`, a script. It generalises the one-off githead/hn feeds into a
// namespaced primitive so a NEW source needs no per-source client plumbing: it publishes here, a card
// reads it through the ONE generic `dataFeed` capability (templates.ts), and an optional file mirror lets a
// reactive-notebook cell consume it over the existing file-watch path. The `data:` prefix is the security
// boundary — the capability refuses any other name, so a template still can't reach session:/thread:/kernel:
// feeds.
//
// This module is PURE (no publishFeed / no server context): it owns the feed VALUE shape, the byte-bounded
// tail buffer, and the disk mirror. server-orchestration.ts wraps these with publishFeed + the route wires
// the POST, so there's no import cycle back into the bus.

// The per-feed tail bound (CLAUDE.md size-cap rule: bound bytes in ONE place, keep the TAIL). Generous —
// a one-time byte-bounded render is cheaper than a stingy cap's debugging — but the live feed republishes
// its whole buffer per frame, so not unbounded. Older events fall off the HEAD; `truncated` records it.
export const MAX_DATA_FEED_BYTES = 64 * 1024;

// One event in a data feed: a timestamp (epoch ms) + an arbitrary producer payload. The git-log source
// puts a commit in `data`; a demo/agent producer puts whatever it POSTed.
export interface DataFeedEvent {
  ts: number;
  data: unknown;
}

// The published feed VALUE — the shape a `dataFeed` card reads. `events` is the byte-bounded TAIL in
// chronological order (oldest → newest); `truncated` is true once any older event was dropped (by the byte
// cap here, or by a snapshot source that had more rows than it published). `name` is the base `data:*`
// name (no board suffix), so a mirror/card can label itself without re-deriving it.
export interface DataFeedValue {
  name: string;
  events: DataFeedEvent[];
  truncated: boolean;
  updatedAt: number;
}

// Keep the most-recent events that fit in `maxBytes` — the TAIL (CLAUDE.md: keep the tail for an append-only
// / scroll-to-bottom log; the bytes you want are the most recent). Drops from the HEAD (oldest) until the
// serialised tail is under budget, but never below one event (a single oversized event still renders — a
// second cap that dropped it would only re-lose content, the exact size-cap footgun). Pure.
export function keepTailByBytes(
  events: DataFeedEvent[],
  maxBytes: number = MAX_DATA_FEED_BYTES,
): { kept: DataFeedEvent[]; truncated: boolean } {
  let kept = events;
  let truncated = false;
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > maxBytes) {
    kept = kept.slice(1);
    truncated = true;
  }
  return { kept, truncated };
}

// The server-side per-feed buffers, keyed by the FULL feed key (`data:<name>:<boardId>`) so two boards'
// same-named feeds stay disjoint. In-memory only — a feed is derived/off-log by definition (like every
// feedValue), rebuilt by its source on restart; the git-log source re-reads git, a demo producer re-POSTs.
const buffers = new Map<string, DataFeedEvent[]>();
// Whether a feed's head has EVER been dropped — the tail can't un-truncate, so once true it stays true for
// this buffer's life (a later small append that itself drops nothing must still report the missing history).
const truncatedFlags = new Map<string, boolean>();

// APPEND one event to a feed's tail buffer and return the new byte-bounded value (the producer path — a
// `POST /api/feed/<name>` or any accumulating source). `feedKey` is the full board-suffixed key; `name` the
// base `data:*` name carried into the value.
export function foldDataFeedEvent(
  feedKey: string,
  name: string,
  event: DataFeedEvent,
  maxBytes: number = MAX_DATA_FEED_BYTES,
): DataFeedValue {
  const buf = buffers.get(feedKey) ?? [];
  buf.push(event);
  const { kept, truncated: dropped } = keepTailByBytes(buf, maxBytes);
  buffers.set(feedKey, kept);
  const truncated = truncatedFlags.get(feedKey) || dropped;
  truncatedFlags.set(feedKey, truncated);
  return { name, events: kept, truncated, updatedAt: event.ts };
}

// REPLACE a feed's buffer with a fresh snapshot (the git-log source: each HEAD change re-reads the whole
// window, it isn't incremental). `extraTruncated` lets the source flag "the window itself is shorter than
// history" (e.g. the repo has more commits than we asked git for) on top of any byte-cap drop.
export function foldDataFeedSnapshot(
  feedKey: string,
  name: string,
  events: DataFeedEvent[],
  extraTruncated: boolean,
  updatedAt: number,
  maxBytes: number = MAX_DATA_FEED_BYTES,
): DataFeedValue {
  const { kept, truncated } = keepTailByBytes(events, maxBytes);
  buffers.set(feedKey, kept);
  return { name, events: kept, truncated: truncated || extraTruncated, updatedAt };
}

// A `data:*` name → a safe, flat filename for the disk mirror. The name carries a colon (and may carry
// slashes), neither of which we want in a path segment, so collapse everything outside a conservative set
// to `-`. Lossy but adequate — the mirror is a convenience view, keyed by the card's own path, not an
// authoritative store.
export function sanitizeFeedName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

// The mirror's repo-relative path: `.canvas/feeds/<sanitized>.json`. Under `.canvas` (the canvas home) so
// it's SERVED + WATCHED by the file endpoints (a notebook cell reads it live), but see the shadow-git
// exclude — `.canvas/feeds/` is pruned from the shadow ledger so a publish never churns commit history.
export function feedMirrorRelPath(name: string): string {
  return path.join(".canvas", "feeds", sanitizeFeedName(name) + ".json");
}

// Mirror a feed value to disk so a reactive-notebook cell (or any file card) can consume it over the
// existing file-watch path — the write pings the WS watch, which re-renders the consuming card. Best-effort
// and NOISY on failure, never throwing into the publish path (a lost mirror is cosmetic; a thrown feed
// once crashed the whole dev server). `repo` is the board's canonical checkout (BoardInfo.repoPath).
export function writeFeedMirror(repo: string, name: string, value: DataFeedValue): void {
  writeFeedMirrorObject(repo, name, value);
}

// Mirror an ARBITRARY object to a feed's disk mirror. The generic tail feed writes a DataFeedValue here
// (writeFeedMirror above); a derived producer whose mirror is a FULL-history carrier (the git-stats source,
// Github-feed thread work item 2) writes its own richer shape to the SAME `.canvas/feeds/<name>.json` path —
// so the `dataFeedHistory` capability, which reads that mirror, hands the card whatever the producer chose
// to persist there (a bounded tail for the generic feeds, a full series for git-stats). Same best-effort +
// noisy + never-throw discipline: a lost mirror is cosmetic, a thrown feed once crashed the dev server.
export function writeFeedMirrorObject(repo: string, name: string, obj: unknown, pretty: boolean = true): void {
  try {
    const abs = path.join(repo, feedMirrorRelPath(name));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Generic tail mirrors are small + human-inspectable → pretty. A derived FULL-history series (git-stats)
    // passes pretty=false: it's machine-read, and 2-space indent over arrays-of-numbers ~doubles the bytes —
    // compact keeps the mirror comfortably under the /api/file byte cap (so the card's read never truncates).
    fs.writeFileSync(abs, JSON.stringify(obj, null, pretty ? 2 : undefined) + "\n");
  } catch (err) {
    console.warn(`[data-feed] mirror write failed for ${name}: ${String(err)}`);
  }
}

// ── the git-stats derived series (Github-feed thread work item 2) ────────────────────────────────────
// A PURE derivation of per-file/per-commit git stats from a `git log --reverse --numstat` dump — no fs, no
// git, no server context, so it's unit-testable against a fixed dump. The server producer (startGitStatsFeed
// in server-orchestration.ts) runs the git command and hands the raw stdout here; the result is written to
// the feed mirror (the FULL-history carrier a `git-stats` card reads via `dataFeedHistory`) plus a bounded
// recent tail published on the bus. Designed to DEGRADE on much larger repos: top-level-dir rollup, top-N
// dirs collapsed into `other`, top-N churn files, and growth/commit series downsampled to a point budget —
// each bound raises `truncated`/`downsampled` so the card can say so (CLAUDE.md: never hide a cap that bit).

// The compact, columnar full-history series. Kept comfortably under the /api/file byte cap (128KB) so the
// mirror is never head-truncated (which would break the card's JSON.parse) — hence short keys + downsampling.
export interface GitStatsSeries {
  name: string; // the base `data:*` feed name (e.g. "data:git-stats")
  updatedAt: number;
  totals: { commits: number; adds: number; dels: number; net: number; files: number };
  // Top-level directories kept, ordered by final cumulative net LOC (desc). A trailing "other" bucket holds
  // every dir past the top-N (so the stacked areas still sum to the true total).
  dirs: string[];
  // Cumulative NET LOC (adds−dels) by kept dir over time. `t[i]` is a commit timestamp (ms), `cum[i]` the
  // per-dir cumulative snapshot at that commit, index-aligned to `dirs`. Oldest→newest; downsampled to a
  // point budget on huge repos.
  growth: { t: number[]; cum: number[][] };
  // Per-commit diff sizes (adds/dels), oldest→newest, bounded to a recent window on huge repos. `s` short sha.
  commits: { s: string; a: number; d: number; t: number }[];
  // Top-N files by total churn (adds+dels) across all history. `p` path, `c` churn.
  churn: { p: string; a: number; d: number; c: number }[];
  downsampled: boolean; // the growth/commit series was thinned to fit the point budget
  truncated: boolean; // dirs collapsed into "other", or the file list capped past top-N
}

export interface GitStatsOpts {
  maxDirs?: number; // top-level dirs kept before the rest roll into "other"
  topFiles?: number; // churn table length
  maxPoints?: number; // growth-sample budget (downsample past this)
  maxCommits?: number; // per-commit diff-size window (keep the most recent this many)
}

// git numstat renders a rename as `old => new` (whole-path) or `pre/{old => new}/post` (partial). We only
// want the NEW path (for the dir bucket + churn key), so collapse both forms. Non-rename paths pass through.
function normalizeNumstatPath(p: string): string {
  let s = p;
  s = s.replace(/\{[^{}]*=>\s*([^{}]*)\}/g, "$1"); // pre/{old => new}/post → pre/new/post
  if (s.includes(" => ")) s = s.slice(s.indexOf(" => ") + 4); // bare old => new → new
  return s.replace(/\/{2,}/g, "/").trim();
}

// Keep at most `budget` items from an array, ALWAYS including the first and last, evenly spaced. Returns the
// array unchanged (same reference) when it already fits — the caller uses that to leave `downsampled` false.
function downsampleIndices(len: number, budget: number): number[] | null {
  if (len <= budget || budget < 2) return null;
  const idx: number[] = [];
  for (let i = 0; i < budget; i++) idx.push(Math.round((i * (len - 1)) / (budget - 1)));
  return [...new Set(idx)]; // de-dupe any rounding collisions (keeps order)
}

// Derive the full series from a `git log --reverse --numstat` dump whose commits are separated by an RS
// (\x1e) prefix and whose header line is `sha\x1f author \x1f unix-seconds \x1f subject`. Pure.
export function deriveGitStats(raw: string, name: string, updatedAt: number, opts: GitStatsOpts = {}): GitStatsSeries {
  const maxDirs = opts.maxDirs ?? 8;
  const topFiles = opts.topFiles ?? 30;
  const maxPoints = opts.maxPoints ?? 500;
  const maxCommits = opts.maxCommits ?? 600;

  interface Parsed { short: string; ts: number; adds: number; dels: number; delta: Map<string, number> }
  const parsed: Parsed[] = [];
  const churn = new Map<string, { a: number; d: number }>();
  const dirFinal = new Map<string, number>();
  let totalAdds = 0;
  let totalDels = 0;

  for (const block of raw.split("\x1e")) {
    if (!block.trim()) continue;
    const nl = block.indexOf("\n");
    const header = (nl === -1 ? block : block.slice(0, nl)).trim();
    const [sha = "", , ct = ""] = header.split("\x1f");
    if (!sha) continue;
    const ts = Number(ct) * 1000;
    let adds = 0;
    let dels = 0;
    const delta = new Map<string, number>();
    const rows = nl === -1 ? [] : block.slice(nl + 1).split("\n");
    for (const row of rows) {
      if (!row.trim()) continue;
      const parts = row.split("\t");
      if (parts.length < 3) continue;
      const a = parts[0] === "-" ? 0 : Number(parts[0]) || 0; // "-" ⇒ binary file
      const d = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
      const p = normalizeNumstatPath(parts.slice(2).join("\t"));
      if (!p) continue;
      adds += a;
      dels += d;
      const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)";
      delta.set(top, (delta.get(top) ?? 0) + a - d);
      dirFinal.set(top, (dirFinal.get(top) ?? 0) + a - d);
      const c = churn.get(p) ?? { a: 0, d: 0 };
      c.a += a;
      c.d += d;
      churn.set(p, c);
    }
    totalAdds += adds;
    totalDels += dels;
    parsed.push({ short: sha.slice(0, 7), ts, adds, dels, delta });
  }

  // Kept dirs: top-N by final cumulative net LOC; the rest fold into "other" (so stacks still total truthfully).
  const ranked = [...dirFinal.entries()].sort((x, y) => y[1] - x[1]).map(([d]) => d);
  const kept = ranked.slice(0, maxDirs);
  const collapsed = ranked.length > kept.length;
  const dirs = collapsed ? [...kept, "other"] : kept;
  const keptIndex = new Map(kept.map((d, i) => [d, i]));
  const otherIdx = collapsed ? kept.length : -1;

  // Growth: replay commits accumulating cumulative net LOC per kept dir (+ other), one sample per commit.
  const run = new Array(dirs.length).fill(0);
  const tAll: number[] = [];
  const cumAll: number[][] = [];
  for (const c of parsed) {
    for (const [dir, net] of c.delta) {
      const i = keptIndex.has(dir) ? keptIndex.get(dir)! : otherIdx;
      if (i >= 0) run[i] += net;
    }
    tAll.push(c.ts);
    cumAll.push([...run]);
  }

  // Downsample growth + commit series to the point budget (always keep first + last).
  const gIdx = downsampleIndices(tAll.length, maxPoints);
  const t = gIdx ? gIdx.map((i) => tAll[i]!) : tAll;
  const cum = gIdx ? gIdx.map((i) => cumAll[i]!) : cumAll;

  // Per-commit diff sizes: keep the most-recent window (the diff-size strip reads newest history).
  const commitsWindowed = parsed.length > maxCommits ? parsed.slice(parsed.length - maxCommits) : parsed;
  const commits = commitsWindowed.map((c) => ({ s: c.short, a: c.adds, d: c.dels, t: c.ts }));

  const churnArr = [...churn.entries()]
    .map(([p, v]) => ({ p, a: v.a, d: v.d, c: v.a + v.d }))
    .sort((x, y) => y.c - x.c)
    .slice(0, topFiles);

  return {
    name,
    updatedAt,
    totals: { commits: parsed.length, adds: totalAdds, dels: totalDels, net: totalAdds - totalDels, files: churn.size },
    dirs,
    growth: { t, cum },
    commits,
    churn: churnArr,
    downsampled: Boolean(gIdx) || parsed.length > maxCommits,
    truncated: collapsed || churn.size > churnArr.length,
  };
}

// The bounded recent tail published on the bus for the git-stats feed — the "byte-bounded recent-events feed
// under data:*" the primitive expects, alongside the full mirror. One event per recent commit: its diff size.
export function gitStatsRecentTail(series: GitStatsSeries, n: number = 50): DataFeedEvent[] {
  return series.commits
    .slice(Math.max(0, series.commits.length - n))
    .map((c) => ({ ts: c.t, data: { shortSha: c.s, adds: c.a, dels: c.d } }));
}
