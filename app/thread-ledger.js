// The thread ledger (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// Renamed from channel-ledger.js at threads-as-cards §8 step 2: the coordination container is now the
// per-task THREAD (a first-class card); the machinery is unchanged. Each thread keeps an append-only
// `<enc>.jsonl` (one ThreadMsg per line, the same shape the in-memory log holds) plus a small
// `<enc>.meta.json` marker (title/brief + last activity + the current-state indexes: declared work-intents
// and SEATS), both under the board's `.canvas/` home (git-ignored, shadow-versioned like images/sessions).
// The .jsonl is the source seedThreadLogs replays at boot; the .meta.json is what the rail reads — the
// thread's identity survives even when its card is removed from the canvas.
//
// `enc` is encodeURIComponent(threadId): a thread id is a node id carrying a colon (`node:thread:<short>`,
// or a carried-over `node:chan:<short>`), which isn't a safe filename, so we percent-encode it for the
// on-disk name and store the real id INSIDE the marker (so listing never has to decode a name). Every write
// is best-effort: a ledger failure must NEVER take down a post — worst case a message isn't durable past
// the live process, exactly the pre-ledger behaviour.
//
// LEGACY: markers written before the rename carry `chanId`, not `threadId`, and live under
// `.canvas/channels/`. migrateChannelLedger moves the directory once at boot; readThreadMeta/listThreads
// normalize `chanId` → `threadId` on read, so an old marker never needs rewriting to stay listable.

import fs from "node:fs";
import path from "node:path";

// Bound the seed READ at the byte (the truncation doctrine: cap once, at the read, keep the TAIL — the most
// recent messages are what a scroll-to-bottom conversation wants). Generous: a thread log is small text.
const MAX_THREAD_LOG_BYTES = 256 * 1024;

/** The directory holding one .jsonl + one .meta.json per thread, under the board repo's `.canvas/` home. */
export function canvasThreadsDir(repoPath) {
  return path.join(repoPath, ".canvas", "threads");
}

/**
 * One-time boot migration (§8 step 2): the pre-rename ledger lived under `.canvas/channels/`. If the
 * threads dir doesn't exist yet and the channels dir does, RENAME it in place — files, encoded names, and
 * marker contents all carry over verbatim (existing channels become long-lived threads, per the doc; the
 * `chanId` key inside old markers is normalized on read, never rewritten). If both dirs exist (a partial
 * state hand-made mid-transition), leave everything alone — threads wins. Best-effort, returns whether a
 * migration happened.
 */
export function migrateChannelLedger(repoPath) {
  const threads = canvasThreadsDir(repoPath);
  const channels = path.join(repoPath, ".canvas", "channels");
  try {
    if (fs.existsSync(threads) || !fs.existsSync(channels)) return false;
    fs.renameSync(channels, threads);
    return true;
  } catch {
    return false; // not fatal — worst case the old dir keeps serving nothing and threads start fresh
  }
}

function logPath(repoPath, threadId) {
  return path.join(canvasThreadsDir(repoPath), encodeURIComponent(threadId) + ".jsonl");
}
function metaPath(repoPath, threadId) {
  return path.join(canvasThreadsDir(repoPath), encodeURIComponent(threadId) + ".meta.json");
}

/**
 * Append one message to a thread's durable log. Best-effort: a failed write never blocks the fan-out, it
 * just means that message isn't restored after a cold restart (the in-memory log still served it live).
 */
export function appendThreadLine(repoPath, threadId, msg) {
  try {
    fs.mkdirSync(canvasThreadsDir(repoPath), { recursive: true });
    fs.appendFileSync(logPath(repoPath, threadId), JSON.stringify(msg) + "\n");
  } catch {
    /* not fatal — the log is a durability index, not the live source */
  }
}

/**
 * Read a thread's durable log back (newest tail, byte-bounded), parsed to a ThreadMsg[]. A tail read can
 * chop the first line mid-record; we skip any line that won't parse (the same ragged-first-line tolerance
 * the session codec has). Returns [] for a missing/unreadable file — never throws.
 */
export function readThreadLog(repoPath, threadId) {
  let buf;
  try {
    buf = fs.readFileSync(logPath(repoPath, threadId));
  } catch {
    return [];
  }
  const over = buf.length > MAX_THREAD_LOG_BYTES;
  const text = (over ? buf.subarray(buf.length - MAX_THREAD_LOG_BYTES) : buf).toString("utf8");
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

/**
 * Read a thread's marker, or null if there is none / it's unreadable. Normalizes the legacy `chanId` key
 * to `threadId` (carried-over channels keep their old markers verbatim on disk). Best-effort, never throws.
 */
export function readThreadMeta(repoPath, threadId) {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(repoPath, threadId), "utf8"));
    if (m && typeof m.threadId !== "string" && typeof m.chanId === "string") m.threadId = m.chanId;
    return m;
  } catch {
    return null;
  }
}

/**
 * Record (or update) a thread's marker. Merges onto the prior marker so `createdAt` is written once and the
 * latest title/brief/activity win — a thread ENTERS the ledger the first time anything is posted to it
 * (appendThreadMsg upserts here), and its title/brief stay fresh as the human edits the card. Best-effort.
 */
export function upsertThreadMeta(repoPath, threadId, data) {
  try {
    const prior = readThreadMeta(repoPath, threadId) ?? {};
    const next = { ...prior, ...data, threadId };
    if (!next.createdAt) next.createdAt = data.lastTs ?? Date.now();
    fs.mkdirSync(canvasThreadsDir(repoPath), { recursive: true });
    fs.writeFileSync(metaPath(repoPath, threadId), JSON.stringify(next));
  } catch {
    /* not fatal — the marker is the rail's index, not the conversation */
  }
}

/**
 * List the threads this board has on disk (every one with a marker), newest activity first — the source for
 * the list rail. The id comes from the marker's `threadId` (normalized from legacy `chanId`), not the
 * filename, so no decode is needed.
 */
export function listThreads(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(canvasThreadsDir(repoPath));
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".meta.json"))
    .map((n) => readThreadMeta(repoPath, decodeURIComponent(n.slice(0, -".meta.json".length))))
    .filter((m) => m && typeof m.threadId === "string")
    .sort((a, b) => (b.lastTs ?? b.createdAt ?? 0) - (a.lastTs ?? a.createdAt ?? 0));
}

// ── seats (threads-as-cards §5, shipped with the ledger per §8 step 2) ──────────────────────────────
// A SEAT is a role's post on one thread — the durable participant that survives its occupant's respawn
// (sessions die and respawn by design; "the Implementer here" must not change name with the sid). Stored
// on the marker as `seats: { [handle]: { role, sid, createdAt, filledAt, fills } }`. The handle is the
// bare role name — 1:1 with roles until labelled multiplicity ships (a second same-role seat is an
// explicit labelled act, deferred until first wanted). `sid` is the current occupant; `fills` counts
// occupancies so a re-fill is distinguishable from a first fill (the §4 "filled by" vs "re-filled" echo).

/**
 * Create or re-occupy the seat for `role` on a thread. Same occupant → no write (idempotent onboarding).
 * Returns { seat, refilled } — `refilled` true when an existing seat changed occupant.
 */
export function fillSeat(repoPath, threadId, role, sid, ts) {
  const prior = readThreadMeta(repoPath, threadId)?.seats ?? {};
  const existing = prior[role];
  if (existing && existing.sid === sid) return { seat: existing, refilled: false };
  const seat = {
    role,
    sid,
    createdAt: existing?.createdAt ?? ts,
    filledAt: ts,
    fills: (existing?.fills ?? 0) + 1,
  };
  upsertThreadMeta(repoPath, threadId, { seats: { ...prior, [role]: seat } });
  return { seat, refilled: !!existing };
}

/**
 * The seat handle `sid` currently occupies in a seats map, or null. Pure — callers pass `meta.seats`.
 * This is how a per-seat record (a work-intent) resolves from the only identity a live session knows:
 * its own sid.
 */
export function seatForSid(seats, sid) {
  for (const [handle, s] of Object.entries(seats ?? {})) if (s && s.sid === sid) return handle;
  return null;
}
