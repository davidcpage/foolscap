// The annotation ledger (docs/doc-annotations.md §5; plain ESM, runs under node --test; imported by
// vite-fs-plugin.ts). The thread ledger's sibling: one append-only `<enc>.jsonl` per ANNOTATED FILE
// under the board repo's `.canvas/annotations/` — standoff comments travel with the repo they
// annotate, shadow-versioned for free under the canvas-home force-add (nothing new to exclude).
//
// `enc` is encodeURIComponent(filePath): the annotated file's root-relative path carries slashes,
// which aren't safe filenames, so it's percent-encoded on disk and recoverable by decode (the
// thread-ledger convention — though unlike threads there is no meta marker: an annotation log is
// small and few, so the listing just folds each log). Every write is best-effort in shape but the
// POST handler checks the append's return — a comment the server couldn't persist must 500, not
// vanish (unlike a thread message, the ledger IS the only home; there's no in-memory live source).
//
// Events (one JSON object per line): create / reply / resolve / reopen / reanchor / thread / answer /
// accept / reject. `foldAnnotations` reduces a log to current state; `orphaned` is NOT an event and never
// stored — it's derived at read time by resolving each anchor against the file's current bytes (anchors.js),
// the thread-state.js principle. A `create` may carry `kind:"question"` (with `options`/`blocking`)
// for the anchored async-ask (docs/anchored-async-ask.md §4); the `answer` event records a human's
// (or peer's) choice/prose on such a question. The awaiting/answered/resolved question STATE is
// likewise derived at read (`questionState`), never stored — same principle as `orphaned`.
//
// A `create` may also carry `kind:"suggestion"` with a `replacement` string (a track-changes proposal:
// replace the anchored span with `replacement`, accepted or rejected AS A UNIT). `accept` records that the
// replacement was applied to the file's bytes (the endpoint splices them); `reject` records a decline —
// both are TERMINAL (they stamp `decision` accepted/rejected and resolve). `suggestionState` derives
// pending/accepted/rejected at read, the `questionState` sibling.

import fs from "node:fs";
import path from "node:path";

// Bound the read at the byte (the truncation doctrine: cap once, at the read, keep the TAIL — the
// newest events are the live conversation; a chopped `create` at the cut just drops that one
// annotation's whole record, see foldAnnotations). Generous: annotation logs are small text.
const MAX_ANNOTATION_LOG_BYTES = 256 * 1024;

/** The directory holding one .jsonl per annotated file, under the board repo's `.canvas/` home. */
export function canvasAnnotationsDir(repoPath) {
  return path.join(repoPath, ".canvas", "annotations");
}

function logPath(repoPath, filePath) {
  return path.join(canvasAnnotationsDir(repoPath), encodeURIComponent(filePath) + ".jsonl");
}

/**
 * Append one event to a file's annotation log. Returns whether the write landed — the caller (the
 * POST handler) turns false into a 500: there is no second home for a comment, so a failed append
 * must be loud.
 */
export function appendAnnotationEvent(repoPath, filePath, ev) {
  try {
    fs.mkdirSync(canvasAnnotationsDir(repoPath), { recursive: true });
    fs.appendFileSync(logPath(repoPath, filePath), JSON.stringify(ev) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file's annotation log back (newest tail, byte-bounded), parsed to an event[]. A tail read
 * can chop the first line mid-record; any line that won't parse is skipped (the ragged-first-line
 * tolerance every ledger here has). Returns [] for a missing/unreadable file — never throws.
 */
export function readAnnotationLog(repoPath, filePath) {
  let buf;
  try {
    buf = fs.readFileSync(logPath(repoPath, filePath));
  } catch {
    return [];
  }
  const over = buf.length > MAX_ANNOTATION_LOG_BYTES;
  const text = (over ? buf.subarray(buf.length - MAX_ANNOTATION_LOG_BYTES) : buf).toString("utf8");
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
 * Fold an event log to current state: one record per annotation, in creation order. Pure.
 *
 * - `create` births the record (a replayed duplicate create for a known id is ignored — first wins).
 * - `reply` appends to `replies`; `resolve`/`reopen` flip `resolved` (latest wins, `resolvedBy`
 *   kept); `reanchor` replaces `anchor` (provenance stays in the log); `thread` links the
 *   escalation target (replies live there from then on — enforced socially, not here).
 * - An event for an id with no seen `create` is dropped: the only way that happens is the byte-cap
 *   tail chopping a very old create, and a reply without its anchor/text is unrenderable anyway.
 *
 * `orphaned` is deliberately absent — derive it at read time against the file's current bytes.
 */
export function foldAnnotations(events) {
  const byId = new Map();
  for (const ev of events ?? []) {
    if (!ev || typeof ev.id !== "string") continue;
    const a = byId.get(ev.id);
    switch (ev.ev) {
      case "create":
        if (!a)
          byId.set(ev.id, {
            id: ev.id,
            path: ev.path,
            anchor: ev.anchor,
            text: ev.text,
            author: ev.author,
            ts: ev.ts,
            kind:
              ev.kind === "question"
                ? "question"
                : ev.kind === "suggestion"
                  ? "suggestion"
                  : "note",
            ...(Array.isArray(ev.options) ? { options: ev.options } : {}),
            ...(ev.blocking ? { blocking: true } : {}),
            ...(typeof ev.replacement === "string" ? { replacement: ev.replacement } : {}),
            resolved: false,
            replies: [],
          });
        break;
      case "reply":
        if (a) a.replies.push({ from: ev.from, text: ev.text, ts: ev.ts });
        break;
      case "answer":
        // A distinguished reply that records the human's/peer's selection and/or prose, AND marks the
        // question answered (docs/anchored-async-ask.md §4). It rides `replies` (so the conversation
        // view shows it) and stamps `answer` (the latest one wins, mirroring resolve's `resolvedBy`);
        // the awaiting→answered transition is then derived by `questionState`, never stored.
        if (a) {
          a.answered = true;
          a.answer = {
            by: ev.by,
            ...(ev.choice != null ? { choice: ev.choice } : {}),
            text: ev.text ?? "",
            ts: ev.ts,
          };
          a.replies.push({
            from: ev.by,
            text: ev.text ?? "",
            ts: ev.ts,
            ...(ev.choice != null ? { choice: ev.choice } : {}),
          });
        }
        break;
      case "resolve":
        if (a) {
          a.resolved = true;
          a.resolvedBy = ev.by;
          a.resolvedTs = ev.ts;
        }
        break;
      case "reopen":
        if (a) {
          a.resolved = false;
          delete a.resolvedBy;
          delete a.resolvedTs;
        }
        break;
      case "accept":
        // A suggestion's replacement was applied to the file (the endpoint splices the bytes); the record
        // is stamped accepted and resolved. `decision` is terminal — a second accept/reject is refused
        // upstream, so reopen (which un-resolves) leaves `decision` alone: an applied edit can't un-happen.
        if (a) {
          a.resolved = true;
          a.resolvedBy = ev.by;
          a.resolvedTs = ev.ts;
          a.decision = "accepted";
        }
        break;
      case "reject":
        // A suggestion declined: resolved, bytes untouched. Terminal like accept (stamps `decision`).
        if (a) {
          a.resolved = true;
          a.resolvedBy = ev.by;
          a.resolvedTs = ev.ts;
          a.decision = "rejected";
        }
        break;
      case "reanchor":
        if (a) a.anchor = ev.anchor;
        break;
      case "thread":
        if (a) a.thread = ev.thread;
        break;
      default:
        break; // an event kind from the future — old readers keep folding what they know
    }
  }
  return [...byId.values()];
}

/**
 * Derived question state for a folded annotation (docs/anchored-async-ask.md §4), computed at read
 * and NEVER stored — the `orphaned` principle. Returns null for a plain note; for a `kind:"question"`:
 *   - "resolved" — the asker has resolved it (resolution belongs to the asker; supersedes the rest).
 *   - "answered" — an `answer` event has landed but it's not yet resolved (needs an agent to apply).
 *   - "awaiting" — no answer yet (needs a human/peer to decide).
 * The wake-back (W5) triggers on the awaiting→answered transition of a `blocking` question.
 */
export function questionState(a) {
  if (!a || a.kind !== "question") return null;
  if (a.resolved) return "resolved";
  if (a.answered) return "answered";
  return "awaiting";
}

/**
 * Derived suggestion state (track-changes), computed at read and NEVER stored — the `orphaned`/`questionState`
 * principle. Returns null for anything but a `kind:"suggestion"`; otherwise:
 *   - "accepted" — the replacement was applied to the file's bytes (an `accept` event landed).
 *   - "rejected" — the suggestion was declined (a `reject` event landed); bytes untouched.
 *   - "pending"  — no decision yet (awaits an accept/reject).
 * Derived from `decision` (terminal), not `resolved`, so a reopen of a decided suggestion — an applied edit
 * that can't un-happen — still reads as its decision. The doc-wake (W5) triggers on the suggestion `create`.
 */
export function suggestionState(a) {
  if (!a || a.kind !== "suggestion") return null;
  if (a.decision === "accepted") return "accepted";
  if (a.decision === "rejected") return "rejected";
  return "pending";
}

/**
 * The file paths this board has annotation logs for (decoded from the on-disk names), for the
 * no-path GET — the "what's awaiting an answer" sweep. Missing dir → [], never throws.
 */
export function listAnnotatedPaths(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(canvasAnnotationsDir(repoPath));
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => {
      try {
        return decodeURIComponent(n.slice(0, -".jsonl".length));
      } catch {
        return null; // a hand-made file whose name doesn't decode — not ours, skip it
      }
    })
    .filter((p) => typeof p === "string" && p.length > 0)
    .sort();
}
