// The channel ledger (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// A CHANNEL's message log used to live ONLY in server memory (fsState.channelLogs) — pinned across a hot
// re-eval, but lost on a COLD restart, which silently emptied every channel card's conversation. This is
// the durable home: each channel keeps an append-only `<enc>.jsonl` (one ChannelMsg per line, the same
// shape the in-memory log holds) plus a small `<enc>.meta.json` marker (title/description + last activity),
// both under the board's `.canvas/` home (git-ignored, shadow-versioned like images/sessions). The .jsonl
// is the source seedChannelLogs replays at boot; the .meta.json is what the channels-list rail reads — the
// channel's identity survives even when its card is removed from the canvas.
//
// `enc` is encodeURIComponent(chanId): a channel id is a node id carrying a colon (`node:chan:<short>`),
// which isn't a safe filename, so we percent-encode it for the on-disk name and store the real id INSIDE
// the marker (so listing never has to decode a name). Every write is best-effort: a ledger failure must
// NEVER take down a post — worst case a message isn't durable past the live process, exactly today's behaviour.

import fs from "node:fs";
import path from "node:path";

// Bound the seed READ at the byte (the truncation doctrine: cap once, at the read, keep the TAIL — the most
// recent messages are what a scroll-to-bottom conversation wants). Generous: a channel log is small text.
const MAX_CHANNEL_LOG_BYTES = 256 * 1024;

/** The directory holding one .jsonl + one .meta.json per channel, under the board repo's `.canvas/` home. */
export function canvasChannelsDir(repoPath) {
  return path.join(repoPath, ".canvas", "channels");
}

function logPath(repoPath, chanId) {
  return path.join(canvasChannelsDir(repoPath), encodeURIComponent(chanId) + ".jsonl");
}
function metaPath(repoPath, chanId) {
  return path.join(canvasChannelsDir(repoPath), encodeURIComponent(chanId) + ".meta.json");
}

/**
 * Append one message to a channel's durable log. Best-effort: a failed write never blocks the fan-out, it
 * just means that message isn't restored after a cold restart (the in-memory log still served it live).
 */
export function appendChannelLine(repoPath, chanId, msg) {
  try {
    fs.mkdirSync(canvasChannelsDir(repoPath), { recursive: true });
    fs.appendFileSync(logPath(repoPath, chanId), JSON.stringify(msg) + "\n");
  } catch {
    /* not fatal — the log is a durability index, not the live source */
  }
}

/**
 * Read a channel's durable log back (newest tail, byte-bounded), parsed to a ChannelMsg[]. A tail read can
 * chop the first line mid-record; we skip any line that won't parse (the same ragged-first-line tolerance
 * the session codec has). Returns [] for a missing/unreadable file — never throws.
 */
export function readChannelLog(repoPath, chanId) {
  let buf;
  try {
    buf = fs.readFileSync(logPath(repoPath, chanId));
  } catch {
    return [];
  }
  const over = buf.length > MAX_CHANNEL_LOG_BYTES;
  const text = (over ? buf.subarray(buf.length - MAX_CHANNEL_LOG_BYTES) : buf).toString("utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a chopped first line (tail cut) or a torn mid-write append — skip it, keep the rest */
    }
  }
  return out;
}

/** Read a channel's marker, or null if there is none / it's unreadable. Best-effort, never throws. */
export function readChannelMeta(repoPath, chanId) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(repoPath, chanId), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Record (or update) a channel's marker. Merges onto the prior marker so `createdAt` is written once and the
 * latest title/description/activity win — a channel ENTERS the ledger the first time anything is posted to it
 * (appendChannelMsg upserts here), and its title/description stay fresh as the human edits the card. Best-effort.
 */
export function upsertChannelMeta(repoPath, chanId, data) {
  try {
    const prior = readChannelMeta(repoPath, chanId) ?? {};
    const next = { chanId, ...prior, ...data };
    if (!next.createdAt) next.createdAt = data.lastTs ?? Date.now();
    fs.mkdirSync(canvasChannelsDir(repoPath), { recursive: true });
    fs.writeFileSync(metaPath(repoPath, chanId), JSON.stringify(next));
  } catch {
    /* not fatal — the marker is the rail's index, not the conversation */
  }
}

/**
 * List the channels this board has on disk (every one with a marker), newest activity first — the source for
 * the channels-list rail. The id comes from the marker's `chanId`, not the filename, so no decode is needed.
 */
export function listChannels(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(canvasChannelsDir(repoPath));
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".meta.json"))
    .map((n) => readChannelMeta(repoPath, decodeURIComponent(n.slice(0, -".meta.json".length))))
    .filter((m) => m && typeof m.chanId === "string")
    .sort((a, b) => (b.lastTs ?? b.createdAt ?? 0) - (a.lastTs ?? a.createdAt ?? 0));
}
