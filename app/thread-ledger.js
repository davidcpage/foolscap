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
import { normLevel } from "./notification-levels.js";

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
 *
 * LIVE-OCCUPANCY GUARD (seat-displacement fix): a seat must never DISPLACE a LIVE occupant. A fresh joiner
 * takes an existing seat only when the prior occupant has EXITED — the legitimate respawn re-fill (§5: a
 * fresh session of the same role re-fills the seat AFTER the prior one is gone). When the seat is still held
 * by a live session of the role, the joiner must NOT steal it: pass `isLive` (a `sid => bool` liveness
 * predicate) and the call returns WITHOUT writing, signalled by `blocked:true` + `heldBy:<the live sid>` so
 * the caller onboards the joiner SEATLESS. Omitting `isLive` keeps the old unconditional re-fill (the ledger
 * unit tests that don't model liveness, and any caller that has already vetted liveness itself).
 */
export function fillSeat(repoPath, threadId, role, sid, ts, isLive) {
  const prior = readThreadMeta(repoPath, threadId)?.seats ?? {};
  const existing = prior[role];
  if (existing && existing.sid === sid) return { seat: existing, refilled: false };
  if (existing && existing.sid !== sid && typeof isLive === "function" && isLive(existing.sid))
    return { seat: existing, refilled: false, blocked: true, heldBy: existing.sid };
  const seat = {
    role,
    sid,
    createdAt: existing?.createdAt ?? ts,
    filledAt: ts,
    fills: (existing?.fills ?? 0) + 1,
    // The seat's notification level (P1/W4) is durable across respawn: a fresh occupant of the same role
    // inherits the prior seat's wake preference rather than resetting to the default.
    ...(existing?.level ? { level: existing.level } : {}),
  };
  upsertThreadMeta(repoPath, threadId, { seats: { ...prior, [role]: seat } });
  return { seat, refilled: !!existing };
}

/**
 * Release (remove) the seat `sid` currently occupies on a thread, if any — the `leave` companion to
 * fillSeat. A seat SURVIVES its occupant's process EXIT (so a respawn re-fills it), but an explicit thread
 * LEAVE is a deliberate departure: the leaver gives the seat back so the next same-role join fills a fresh
 * seat rather than inheriting a stuck one. Also self-heals a seat left stuck to a departed sid. Idempotent:
 * returns the freed handle, or null when `sid` held no seat (nothing to release). Best-effort.
 */
export function releaseSeat(repoPath, threadId, sid) {
  const meta = readThreadMeta(repoPath, threadId);
  const seats = meta?.seats ?? {};
  const handle = seatForSid(seats, sid);
  if (!handle) return null;
  const { [handle]: _removed, ...rest } = seats;
  upsertThreadMeta(repoPath, threadId, { seats: rest });
  return handle;
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

// ── durable membership (delete-card-keep-session) ──────────────────────────────────────────────────
// A thread's DURABLE member set: the sids that JOINED (a `member:open` edge) and have not explicitly LEFT.
// The member:open EDGE is the canvas VIEW of a membership and dies with the session's card (removeNode
// cascades its wires; the engine is deliberately blind to member semantics, records.ts). This set is the
// membership ITSELF, kept on the marker beside `seats` — so deleting a session card removes the VIEW, not
// the membership: the session stays logged, still wakeable by @-tag, still in the roster, just cardless.
// A SEAT is a role's durable identity on the thread; this is the plain-sid analogue that also covers an
// UNSEATED member (a seated member is recorded here too, harmlessly). Stored as `members: { [sid]: { joinedAt } }`.

/**
 * Record `sid` as a durable member of a thread (idempotent — an already-recorded member is a no-op that
 * returns the unchanged map). Called wherever a `member:open` is observed (join/spawn/accept). Best-effort.
 */
export function addThreadMember(repoPath, threadId, sid, ts) {
  const members = readThreadMeta(repoPath, threadId)?.members ?? {};
  if (members[sid]) return members; // already a member — don't churn the marker
  const next = { ...members, [sid]: { joinedAt: ts } };
  upsertThreadMeta(repoPath, threadId, { members: next });
  return next;
}

/**
 * Drop `sid` from a thread's durable member set — the companion to addThreadMember, called on a REAL leave
 * (an explicit /leave, or a human disconnecting the edge while the card stays). NOT called on a card delete:
 * that removes the view, not the membership. A no-op (returns the prior map) when `sid` held no membership.
 */
export function removeThreadMember(repoPath, threadId, sid) {
  const members = readThreadMeta(repoPath, threadId)?.members ?? {};
  if (!members[sid]) return members; // not a member — nothing to remove
  const { [sid]: _gone, ...rest } = members;
  upsertThreadMeta(repoPath, threadId, { members: rest });
  return rest;
}

/**
 * The durable member sids on a thread's marker, or [] if none. Pure — callers pass `meta` (readThreadMeta).
 */
export function threadMembersFromMeta(meta) {
  return meta && meta.members && typeof meta.members === "object" ? Object.keys(meta.members) : [];
}

// ── notification levels (P1, wakeable-substrate-plan W4; claude-tag R2 recast) ──────────────────────
// A thread member's SEAT carries a notification LEVEL — the same wake preference a doc watcher carries
// (notification-levels.js), one surface up. Default `all` (any room broadcast wakes it, the R2 default);
// a member opts DOWN to `mentions`/`paused` to turn its own traffic down without leaving. The level lives
// ON THE SEAT (`seats[handle].level`) so it survives an occupant respawn — a fresh session of the same role
// re-fills the seat and inherits the level. A plain sid-only member (no seat) can still set a level; it's
// stored on a `levels` map keyed by sid (ephemeral like the member). The wake fan-out reads it via
// threadLevelForSid; only the nudge CONDITION changes — the message record and content path are untouched.

/**
 * Set the notification level for the participant `sid` on a thread. If it occupies a seat, the level rides
 * the SEAT (durable across respawn); otherwise it rides a sid-keyed `levels` fallback map. `level` is
 * normalized (unknown ⇒ `all`). Returns { seat, level } — `seat` is the handle it landed on, or null for
 * the sid fallback. Best-effort (upsertThreadMeta swallows write errors).
 */
export function setThreadLevel(repoPath, threadId, sid, level) {
  const lvl = normLevel(level);
  const meta = readThreadMeta(repoPath, threadId) ?? {};
  const seats = meta.seats ?? {};
  const handle = seatForSid(seats, sid);
  if (handle) {
    upsertThreadMeta(repoPath, threadId, {
      seats: { ...seats, [handle]: { ...seats[handle], level: lvl } },
    });
    return { seat: handle, level: lvl };
  }
  const levels = meta.levels ?? {};
  upsertThreadMeta(repoPath, threadId, { levels: { ...levels, [sid]: lvl } });
  return { seat: null, level: lvl };
}

/**
 * The notification level `sid` has on a thread: its seat's level if it occupies one, else its sid-keyed
 * fallback, else the default `all`. Pure — callers pass the thread's meta marker. This is how the nudge
 * fan-out resolves a wake preference from the only identity a live session knows: its own sid.
 */
export function threadLevelForSid(meta, sid) {
  const seats = meta?.seats ?? {};
  const handle = seatForSid(seats, sid);
  const raw = handle ? seats[handle]?.level : meta?.levels?.[sid];
  return normLevel(raw);
}

// ── pins (R-PIN, wakeable-substrate-plan W7) ────────────────────────────────────────────────────────
// A PIN is the thread's HEAD CONTEXT: a message flagged to be re-read on every wake, ahead of the recent
// tail (claude-tag-lessons R-PIN). The task statement, the `Done when:` condition (R5), and any framing a
// long thread must keep in view become pinned posts, so they stay present however far the log grows — the
// canvas-native answer to Tag's head-window problem, without a hard-coded head bias. Pinning must NOT
// reorder the log: a pin is a SNAPSHOT of the message (`{seq, from, text, ts, pinnedBy, pinnedAt}`) kept on
// the marker, in CHRONOLOGICAL (seq) order, and the card renders a collapsible tray that references it.
// We snapshot rather than store a bare seq because the live log is a bounded tail (MAX_THREAD_MSGS) and the
// ledger read is byte-bounded — a pin older than either would otherwise vanish from view, exactly the
// content-loss the head context is meant to prevent. `pins` lives on the meta marker beside `seats`/`intents`.

/**
 * The thread's pins (chronological snapshots), or [] if none / no marker. Best-effort, never throws.
 */
export function readPins(repoPath, threadId) {
  const pins = readThreadMeta(repoPath, threadId)?.pins;
  return Array.isArray(pins) ? pins : [];
}

/**
 * Pin a message (idempotent by seq): add its snapshot to the marker's `pins`, sorted by seq. Re-pinning an
 * already-pinned seq is a no-op that returns the existing set (never a duplicate). `msg` is the stored
 * ThreadMsg; we keep only the fields the tray/head-context need. Returns the updated pins array.
 */
export function pinMessage(repoPath, threadId, msg, by, ts) {
  const prior = readPins(repoPath, threadId);
  if (prior.some((p) => p.seq === msg.seq)) return prior; // already pinned — idempotent
  const snapshot = { seq: msg.seq, from: msg.from, text: msg.text, ts: msg.ts, pinnedBy: by, pinnedAt: ts };
  const pins = [...prior, snapshot].sort((a, b) => a.seq - b.seq);
  upsertThreadMeta(repoPath, threadId, { pins });
  return pins;
}

/**
 * Unpin a message by seq. A no-op (returns the prior set) if that seq wasn't pinned. Returns updated pins.
 */
export function unpinMessage(repoPath, threadId, seq) {
  const prior = readPins(repoPath, threadId);
  const pins = prior.filter((p) => p.seq !== seq);
  if (pins.length === prior.length) return prior; // nothing pinned at that seq
  upsertThreadMeta(repoPath, threadId, { pins });
  return pins;
}
