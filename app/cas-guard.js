// Compare-and-swap guards (docs/wakeable-substrate-plan.md W11 + W12). Two applications of ONE pattern —
// Claude Code's stale-file guard ("the thing changed since you read it → re-read before you write") lifted
// onto the canvas: a writer declares the state it based its change on, and the server rejects the change if
// that state has since moved. The conflict IS the coordination (docs/simple-markdown-editor-lessons.md
// Idea 2) — no external lock, no claim ceremony.
//
//   • W11 — mention-gated THREAD POST: the "read cursor" is the compared state. A live session may not post
//     over a message that @-mentions it and sits unread past its cursor (`unreadMentions` below). It upgrades
//     W10's soft peek-and-act norm into a hard guard: you structurally can't talk over a message that named
//     you and you haven't seen. Gated on @-mentions OF YOU (not any ambient unread, not @all broadcasts) so
//     independent status chatter never blocks a post — only the message you must not step on does.
//   • W12 — doc-edit optimistic concurrency: the file's CONTENT VERSION is the compared state. A write may
//     carry a `baseVersion` (the version it read); `isStaleWrite` rejects it when the file's current version
//     no longer matches, i.e. a concurrent writer got there first.
//
// Pure logic in one module (like thread-tags.js / work-intent.js) so the server wires thin and the guard is
// unit-testable without a live server; the HTTP shape (403/409, the returned unread / conflict payload) lives
// in vite-fs-plugin.ts's handlers.

import { createHash } from "node:crypto";
import { resolveTags } from "./thread-tags.js";

// ── W11 — mention-gated thread-post guard ────────────────────────────────────────────────────────

/**
 * The messages that BLOCK `from` from posting to a thread right now: unread (seq past its read cursor),
 * real (not a card-only intent/ask/pin echo — those wake no one, so they never gate), from someone else,
 * and @-mentioning `from` (resolveTags — the same tag grammar the wake path uses, so "mention" means
 * exactly what "would have woken you" means). Empty ⇒ the post is clear.
 *
 * @param {object}   a
 * @param {Array}    a.log      the thread's message log ({seq, from, text, kind?} entries)
 * @param {number}   a.cursor   `from`'s read cursor on this thread (last seq it pulled)
 * @param {string}   a.from     the posting session's sid
 * @param {Array}    a.members  member entries ({sid, name} — or bare sid strings), for tag resolution
 * @returns {Array}  the blocking messages, in log order (empty when the post is allowed)
 */
export function unreadMentions({ log, cursor, from, members }) {
  const entries = (members ?? []).map((m) => (typeof m === "string" ? { sid: m, name: null } : m));
  const at = typeof cursor === "number" ? cursor : 0;
  return (log ?? []).filter(
    (m) =>
      m.seq > at &&
      m.kind == null && // card-only entries (intent/ask/pin) wake no one → never gate a post
      m.from !== from && // your own posts don't mention-block you (and are already read)
      resolveTags(m.text, entries).members.includes(from),
  );
}

/**
 * Where a SESSION sender's read cursor lands AFTER it posts its own message — the write half of the same
 * read-cursor invariant W11 guards on the read half. A post appends the sender's own message at `ownSeq`
 * (always the log's new max, seq = prevMax + 1). Marking the sender as having "seen its own message" must
 * NOT silently mark as read anything that arrived from OTHERS between the sender's last read and this post
 * (a live repro: an untagged interleaved message, durably appended, was swallowed because the cursor jumped
 * straight to the sender's own seq). So advance to `ownSeq` ONLY when the sender was fully caught up — its
 * cursor sat at `ownSeq - 1`, i.e. nothing unread preceded its post. Otherwise HOLD the cursor: the
 * interleaved unread (and the sender's own post) are served on its next read. Structural, not norm-enforced —
 * the cursor can never leap past an unread from another, by construction.
 *
 * Tradeoff (deliberate, simple > clever): when the sender was NOT caught up, its own just-posted message is
 * re-served to it once on the next read (harmless echo) — far cheaper than silently dropping a peer's message.
 *
 * @param {number} currentCursor  the sender's read cursor before the post (last seq it pulled; 0 if none)
 * @param {number} ownSeq         the seq assigned to the sender's just-appended message
 * @returns {number}  the cursor to store: `ownSeq` if caught up, else `currentCursor` unchanged
 */
export function senderCursorAfterPost(currentCursor, ownSeq) {
  const at = typeof currentCursor === "number" ? currentCursor : 0;
  return at === ownSeq - 1 ? ownSeq : at;
}

// ── W12 — doc-edit optimistic-concurrency guard ──────────────────────────────────────────────────

/**
 * The version stamp for a doc's current bytes — a short content hash. A READ hands this back with the
 * content; a WRITE echoes it as `baseVersion`. Content hash (not mtime / a counter) so it needs no stored
 * state, is deterministic across restarts, and two identical bytes always version the same. `null` for a
 * missing file — the version of "no file yet", so a create passes `baseVersion: null`.
 *
 * @param {string|Buffer|null} content  the file's bytes (string or Buffer), or null/undefined for absent
 * @returns {string|null}  a 16-hex-char version, or null when there is no content
 */
export function contentVersion(content) {
  if (content == null) return null;
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Whether a write based on `baseVersion` is stale against the file's `currentVersion` — the compare half of
 * the CAS. A strict !== so it also handles the two null cases correctly: create-when-absent
 * (null vs null → fresh) and someone-deleted-it (a hash vs null → stale).
 *
 * @param {string|null} baseVersion     the version the writer read (its `baseVersion`)
 * @param {string|null} currentVersion  the file's version now (contentVersion of its current bytes)
 * @returns {boolean}  true ⇒ reject with 409; false ⇒ the write may proceed
 */
export function isStaleWrite(baseVersion, currentVersion) {
  return baseVersion !== currentVersion;
}
