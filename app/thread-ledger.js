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
 * Append one message to a thread's durable log, DURABLY — write + fsync under one fd, so a line that returns
 * from here is on stable storage before the caller returns its HTTP 200 (BUG-6). This is NO LONGER
 * best-effort: a failure THROWS so the accept path can surface it (return 500) instead of the former silent
 * swallow, which returned 200 with the message alive only in the bounded in-memory tail — it then vanished on
 * the next cold restart (the 2026-07-12 lost Coordinator merge-confirmation). The fsync matters: without it a
 * crash between the append and the OS's own flush would lose a post we already told the caller we accepted.
 * The caller (appendThreadMsg) persists via this BEFORE publishing the live feed, so the feed never shows a
 * message that isn't on disk.
 */
export function appendThreadLine(repoPath, threadId, msg) {
  fs.mkdirSync(canvasThreadsDir(repoPath), { recursive: true });
  const fd = fs.openSync(logPath(repoPath, threadId), "a");
  try {
    fs.writeSync(fd, JSON.stringify(msg) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
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

/**
 * The intent-slot keys on a marker that hold a `blocked:*` THIS session itself declared — the detection
 * half of the work-intent self-freshen (vite-fs-plugin.ts clearBlockedIntents, part 2): when a session
 * resumes running, these are the slots to auto-transition back to `working`.
 *
 * "Its own" is matched by the record's `sid` stamp (which covers a sid-keyed AND a seat-keyed
 * self-declaration — recordThreadIntent always stamps the declarer) or a bare sid key. DELIBERATELY not a
 * `key === seatForSid(sid)` match: a `blocked:*` a DIFFERENT (now-exited) occupant left on a seat this
 * session later re-filled is the sacred waiting state that must survive its asker's crash (thread-state.js
 * §5) — a fresh occupant resuming must never silently retire another agent's unanswered question. Pure;
 * callers pass `meta.intents`.
 *
 * @param {Record<string, {intent?: string, sid?: string}>|undefined} intents
 * @param {string} sid
 * @returns {string[]} the keys whose intent should be freshened to `working`
 */
export function ownBlockedIntentKeys(intents, sid) {
  const keys = [];
  for (const [key, rec] of Object.entries(intents ?? {})) {
    const mine = key === sid || rec?.sid === sid;
    if (mine && typeof rec?.intent === "string" && rec.intent.startsWith("blocked")) keys.push(key);
  }
  return keys;
}

/**
 * Has this session FINISHED — i.e. declared `done` and holds no still-active intent anywhere? The reaper's
 * read under REAP-ONLY-ON-DONE (thread mrcauz0v-f): true only when the session owns at least one `done` intent
 * across `metas` (the thread markers from listThreads) AND owns NO `working`/`blocked:*` intent (so a session
 * done on one thread but still active on another is NOT reaped). Every non-done stance parks (never idle-
 * reaped), so the reaper only needs this one bit — a blocked/working/undeclared session is kept alive
 * regardless. "Its own" mirrors ownBlockedIntentKeys — a sid-stamped record (covers a seat-keyed OR bare-sid
 * self-declaration), never another occupant's seat-inherited intent. Pure;
 * short-circuits to false on the first active intent.
 *
 * @param {Array<{ intents?: Record<string, {intent?: string, sid?: string}> }>|undefined} metas
 * @param {string} sid
 * @returns {boolean} true iff the session has declared done and is active nowhere
 */
export function sessionDeclaredDone(metas, sid) {
  let sawDone = false;
  for (const meta of metas ?? []) {
    for (const [key, rec] of Object.entries(meta?.intents ?? {})) {
      if (key !== sid && rec?.sid !== sid) continue;
      const it = rec?.intent;
      if (it === "working" || it === "blocked:human" || it === "blocked:peer") return false; // still active somewhere
      if (it === "done") sawDone = true;
    }
  }
  return sawDone;
}

/**
 * The declared-intent refinement for a session's IDLE status band, aggregated WHOLE-SESSION across every
 * thread it participates in (single-source unification, thread mrcmofwf-10). The server's process-observed
 * band is authoritative for running/scheduled/exited; only the *idle* band takes an intent refinement, and
 * only these two intents paint (v2 precedence): `blocked:human` (→ the loud orange "your turn") outranks
 * `blocked:peer` (→ blue "waiting on an agent"), whole-session. `working` and `done` are deliberately NOT
 * returned — an idle `working` is the same orange as an undeclared idle, and `done` must NEVER colour a
 * still-live session (it only shows once the PROCESS exits, via endReason grey); folding done here would
 * reintroduce the "grey pill on a live card" contradiction this unification exists to kill.
 *
 * "Its own" mirrors sessionDeclaredDone / ownBlockedIntentKeys: a sid-stamped record (covers a seat-keyed
 * OR bare-sid self-declaration), never another (now-exited) occupant's seat-inherited intent — a fresh
 * occupant wears only what IT declared, not the block its predecessor left on the seat. Pure; short-circuits
 * to `blocked:human` on the first one seen (it can't be outranked).
 *
 * @param {Array<{ intents?: Record<string, {intent?: string, sid?: string}> }>|undefined} metas  listThreads markers
 * @param {string} sid
 * @returns {"blocked:human"|"blocked:peer"|null}
 */
export function sessionIdleIntent(metas, sid) {
  let peer = false;
  for (const meta of metas ?? []) {
    for (const [key, rec] of Object.entries(meta?.intents ?? {})) {
      if (key !== sid && rec?.sid !== sid) continue;
      const it = rec?.intent;
      if (it === "blocked:human") return "blocked:human"; // highest — can't be outranked, stop
      if (it === "blocked:peer") peer = true;
    }
  }
  return peer ? "blocked:peer" : null;
}

/**
 * The latest work-intent record `sid` itself declared on ONE thread (`meta.intents`), or null when it has
 * declared none. "Its own" mirrors ownBlockedIntentKeys / sessionIdleIntent: a record is this session's when
 * its `sid` stamp matches (which covers a SEAT-keyed declaration — recordThreadIntent stamps the declarer even
 * when the key is the seat handle) or the key is the bare sid. DELIBERATELY not a `key === seatForSid(sid)`
 * match: a `done` a DIFFERENT (now-exited) occupant left on a seat this session later re-filled is not this
 * session's stance — so a fresh occupant is never detached on its predecessor's declaration. Freshest by `ts`
 * when more than one record matches (a bare-sid AND a seat-keyed self-declaration). Pure — the done-detach
 * sweep (server-orchestration.detachDoneMembersTick) passes each thread member's own record to
 * shouldDetachDoneIntent (auto-wake.js). `ts` is the clock: a later non-`done` declaration OVERWRITES the
 * `done` at the same key, so a re-declared `working` cancels a pending detach for free.
 *
 * @param {Record<string, {intent?: string, sid?: string, ts?: number}>|undefined} intents
 * @param {string} sid
 * @returns {{intent?: string, sid?: string, ts?: number}|null} the freshest matching record, or null
 */
export function threadIntentForSid(intents, sid) {
  let best = null;
  for (const [key, rec] of Object.entries(intents ?? {})) {
    if (key !== sid && rec?.sid !== sid) continue;
    if (!best || (typeof rec?.ts === "number" ? rec.ts : 0) > (typeof best.ts === "number" ? best.ts : 0)) best = rec;
  }
  return best;
}

/**
 * The occupant sid of a thread's `role` seat that an UNTAGGED post should NUDGE, or null (untagged→Coordinator,
 * Option B). An untagged post (neither a room `broadcast` nor an @-`mentioned` post) wakes no member by the
 * normal seat-level fan-out — the ambient case principle 3 keeps quiet. But a role like the Coordinator is the
 * thread's STEWARD and is expected to sweep its state, so it should learn of ambient activity on a thread it
 * owns without waiting for the next heartbeat. This returns the seat occupant to nudge when ALL hold: the post
 * is untagged, the thread HAS that role's seat, its occupant is not the sender (`exceptSid`), and — per the
 * caller's `isLive` predicate — the occupant is LIVE. A DORMANT occupant is deliberately NOT returned: no
 * per-post respawn (the exact cost principle 3 guards against), and it is unnecessary — the occupant is
 * already a member, so the message is logged to its inbox and it catches it on its next heartbeat sweep. Pure:
 * `isLive: sid => bool` supplies process liveness (mirrors fillSeat's guard); `meta` is readThreadMeta's marker.
 */
export function untaggedSeatNudgeTarget(meta, role, { broadcast, mentioned, exceptSid, isLive } = {}) {
  if (broadcast) return null; // a room broadcast is not untagged — the normal fan-out already covers it
  if (mentioned && mentioned.size) return null; // an @-mention is not untagged — handled by the mention path
  const sid = meta?.seats?.[role]?.sid;
  if (!sid || sid === exceptSid) return null; // no such seat, or the steward is the poster (don't self-nudge)
  if (typeof isLive === "function" && !isLive(sid)) return null; // dormant seat: not respawned per untagged post
  return sid;
}

/**
 * Route an UNKNOWN @Role mention (one classifyMentionSpawn recognised as a known role) against the thread's
 * DURABLE seat map, so the cold-spawn path can never race a seat that already exists (thread "Accidental
 * thread respawn"): the durable marker outlives the occupant's session CARD, so a mention that failed
 * member-resolution off a card-less snapshot — e.g. a departing Coordinator's own wind-down post naming
 * "@Coordinator" — must still find the seat here rather than summoning a duplicate. Returns one of:
 *   • { action: "spawn" }                — no such seat: genuine first contact, the caller cold-spawns.
 *   • { action: "skip",   occupant }    — the AUTHOR holds the seat (the wind-down self-mention): no
 *     self-nudge and NEVER a spawn/revive, regardless of liveness — a stale `from` naming its own seat
 *     must not resurrect it.
 *   • { action: "nudge",  occupant }    — the seat's occupant is LIVE: the mention is a wake, not a summons.
 *   • { action: "revive", occupant }    — the seat exists but its occupant has exited: reconstitute the
 *     seat (maybeRespawnDormantSeat), the same @-mention override the stale-sid fallback applies.
 * Handle matching is case-insensitive (seats are keyed by the bare role name; classifyMentionSpawn hands
 * back the roster's display name — same source today, but drift must degrade to a wake, not a duplicate).
 * Pure: `isLive: sid => bool` supplies process liveness (mirrors untaggedSeatNudgeTarget); omitting it
 * treats the occupant as live (the caller has vetted liveness itself, fillSeat's convention).
 */
export function roleMentionRoute(meta, role, { authorSid, isLive } = {}) {
  const want = String(role).toLowerCase();
  let occupant = null;
  for (const [handle, s] of Object.entries(meta?.seats ?? {})) {
    if (handle.toLowerCase() === want && s?.sid) { occupant = s.sid; break; }
  }
  if (!occupant) return { action: "spawn" };
  if (occupant === authorSid) return { action: "skip", occupant };
  if (typeof isLive === "function" && !isLive(occupant)) return { action: "revive", occupant };
  return { action: "nudge", occupant };
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

// ── relative-offset layout (P2) ─────────────────────────────────────────────────────────────────────
// A session card's on-canvas position is stored RELATIVE to its PRIMARY thread card, so (a) moving the
// thread moves its open member cards preserving the layout, and (b) a closed session reopens at its stored
// relative offset (not a fresh cascade spot). The offset lives on the membership record beside `joinedAt`
// (`members[sid] = { joinedAt, dx, dy }`) — the human's explicit call to store it on the thread — and is
// written ONLY on the session's PRIMARY membership (its earliest-joined thread; see primaryThreadForSession).
// dx,dy are the session card's layout (x,y) MINUS the primary thread card's layout (x,y). Written on the
// debounced snapshot save (captureMemberOffsets), never the per-frame drag — the offset is a settled fact,
// not a hot value.

/**
 * Set the relative offset {dx,dy} on `sid`'s membership of a thread — idempotent: a no-op (returns false)
 * when `sid` isn't a member, or when the stored offset already equals dx,dy (so a snapshot save that moved
 * nothing, or a move-with-thread that preserved the offset, never churns the marker). Returns true iff it
 * wrote. Best-effort (upsertThreadMeta swallows write errors). dx,dy are rounded to whole pixels — sub-pixel
 * offsets are noise that would defeat the unchanged-guard.
 */
export function setMemberOffset(repoPath, threadId, sid, dx, dy) {
  const members = readThreadMeta(repoPath, threadId)?.members ?? {};
  const rec = members[sid];
  if (!rec) return false; // not a member — nothing to anchor
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  if (rec.dx === rx && rec.dy === ry) return false; // unchanged — don't churn the marker
  const next = { ...members, [sid]: { ...rec, dx: rx, dy: ry } };
  upsertThreadMeta(repoPath, threadId, { members: next });
  return true;
}

/**
 * The stored offset {dx,dy} for `sid`'s membership of a thread, or null when there is no membership or no
 * offset recorded yet. Pure — callers pass `meta` (readThreadMeta).
 */
export function memberOffsetFromMeta(meta, sid) {
  const rec = meta && meta.members && typeof meta.members === "object" ? meta.members[sid] : undefined;
  return rec && typeof rec.dx === "number" && typeof rec.dy === "number" ? { dx: rec.dx, dy: rec.dy } : null;
}

// ── reopen-set (P4) ─────────────────────────────────────────────────────────────────────────────────
// The set of member SIDs whose session card was OPEN the last time this thread's card was on the canvas.
// Reopening the thread card restores exactly that set (each at its P2 offset, edges redrawn) — so a
// select-deleted cluster comes back as it was, not as a lone thread card. Captured the SAME way P2 offsets
// are: on the debounced board-persist snapshot save (captureReopenSets), for threads whose card is present.
// It is therefore FROZEN when the thread card closes (the capture pass skips an absent thread), leaving the
// last-open set = exactly the set open at close. A thread with no recorded set (never had a member card
// open, e.g. a first-ever open) restores to the thread card alone. Lives on the meta marker beside
// `members`, display-only (a VIEW fact — durable membership is untouched by open/close).

/**
 * Set the reopen-set (member sids open now) on a thread — idempotent: a no-op (returns false) when the
 * stored set already equals `sids` (order-insensitive), so a snapshot save where the open-set didn't change
 * never churns the marker. `sids` is deduped + sorted before storing so the unchanged-guard is stable.
 * Returns true iff it wrote. Best-effort (upsertThreadMeta swallows write errors).
 */
export function setReopenSet(repoPath, threadId, sids) {
  const next = [...new Set(sids)].filter((s) => typeof s === "string" && s).sort();
  const prior = readReopenSet(readThreadMeta(repoPath, threadId));
  if (prior.length === next.length && prior.every((s, i) => s === next[i])) return false; // unchanged
  upsertThreadMeta(repoPath, threadId, { reopenSet: next });
  return true;
}

/**
 * The recorded reopen-set (member sids) for a thread, or [] when none recorded. Pure — callers pass `meta`
 * (readThreadMeta). [] covers both "never recorded" and "recorded empty" — both restore to the thread card
 * alone, so the two need no distinguishing.
 */
export function readReopenSet(meta) {
  const set = meta && Array.isArray(meta.reopenSet) ? meta.reopenSet : null;
  return set ? set.filter((s) => typeof s === "string" && s) : [];
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
 * Refresh a pin's snapshot TEXT for one seq — the amendment companion to pinMessage. Pins snapshot the
 * message text BY COPY (so a pin survives the log's bounded tail), so an accepted edit/delete of a pinned
 * message must update the snapshot or the head-context tray would keep showing the stale original. A no-op
 * (returns the prior set unchanged) when that seq isn't pinned, or when the text already matches. `newText`
 * is the amended text (or the `[deleted]` stub for a tombstone). Returns the updated (or unchanged) pins.
 */
export function refreshPinSnapshot(repoPath, threadId, seq, newText) {
  const prior = readPins(repoPath, threadId);
  const idx = prior.findIndex((p) => p.seq === seq);
  if (idx < 0 || prior[idx].text === newText) return prior; // not pinned, or nothing to change
  const pins = prior.map((p) => (p.seq === seq ? { ...p, text: newText } : p));
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

// ── seen mentions (user waiting-state + you-pill, thread node:mrbz24qp-h) ────────────────────────────
// The board owner's PER-VIEWED-MESSAGE clearing state: the set of @human/@user MENTION seqs the human has
// actually VIEWED (scrolled into the thread-log viewport while the card is focused). It is the exact PIN-store
// shape one surface over — a per-seq collection on the marker with a union add — except it stores bare seqs
// (mentions are few; no snapshot is needed, since a seen mention is derived against the live log, not
// re-rendered from the marker). thread-waiting.js reads it to decide which mentions are still unseen; a client
// viewport observer POSTs newly-viewed seqs (POST /api/thread/:id/seen → markSeenMentions). Bounded to
// mention-seqs, so it stays tiny and only grows when a NEW mention is viewed — the one real cost the scope
// flagged (an unbounded per-scroll rewrite) is neutralised by tracking mentions only. `seenMentions` lives on
// the meta marker beside `pins`/`seats`/`intents`.

/**
 * The seqs the human has VIEWED on this thread (sorted), or [] if none / no marker. Best-effort, never throws.
 */
export function readSeenMentions(repoPath, threadId) {
  const seen = readThreadMeta(repoPath, threadId)?.seenMentions;
  return Array.isArray(seen) ? seen : [];
}

/**
 * Mark mention seqs as VIEWED — union `seqs` (positive integers) into the marker's `seenMentions`, sorted.
 * Idempotent: re-marking an already-seen seq (or passing nothing new) is a no-op that returns the existing set
 * unchanged (never a duplicate, never a churned marker write). Returns the updated (or unchanged) array.
 */
export function markSeenMentions(repoPath, threadId, seqs) {
  const prior = readSeenMentions(repoPath, threadId);
  const set = new Set(prior);
  let changed = false;
  for (const s of seqs ?? []) {
    if (Number.isInteger(s) && s >= 1 && !set.has(s)) { set.add(s); changed = true; }
  }
  if (!changed) return prior; // nothing new viewed — don't churn the marker
  const next = [...set].sort((a, b) => a - b);
  upsertThreadMeta(repoPath, threadId, { seenMentions: next });
  return next;
}
