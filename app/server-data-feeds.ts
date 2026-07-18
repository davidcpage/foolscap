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
  try {
    const abs = path.join(repo, feedMirrorRelPath(name));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(value, null, 2) + "\n");
  } catch (err) {
    console.warn(`[data-feed] mirror write failed for ${name}: ${String(err)}`);
  }
}
