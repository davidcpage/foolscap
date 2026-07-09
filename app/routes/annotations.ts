import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody, readText } from "../server-http.js";
import { safeResolve, isInternalPath, fileVersion, TEXT_EXT } from "../server-fs.js";
import { getServerContext } from "../server-context.js";
import { resolveAnchor, type QuoteAnchor } from "../anchors.js";
import {
  appendAnnotationEvent,
  foldAnnotations,
  listAnnotatedPaths,
  questionState,
  suggestionState,
  readAnnotationLog,
  type AnnotationEvent,
  type AnnotationOption,
} from "../annotations.js";
import { listWatchedPaths, readWatchers, removeWatcher, setWatcher, setWatcherState } from "../doc-watch.js";
import { readDocJobs, removeDocJob, upsertDocJob } from "../doc-jobs.js";
import { reanchorFile } from "../annotation-reanchor.js";
import { isNotificationLevel } from "../notification-levels.js";
import { exact, type BoardRoute } from "./router.js";

// ── doc annotations (docs/doc-annotations.md; god-file split, Phase 2) ──────────────────────────────
// Standoff highlight-and-comment on file-backed cards: the annotated file's bytes never change;
// comments are quote-anchored records in the board repo's `.canvas/annotations/` ledger
// (annotations.js), anchored by TextQuoteSelector and resolved by anchors.js. READS derive
// `orphaned` per annotation against the file's CURRENT bytes (derived at read time, never stored —
// the thread-state principle); WRITES are server-side appends, so commenting/replying needs no live
// tab (an agent can answer annotations on a board nobody has open). Appends land under
// `.canvas/annotations/`, which the root watcher already forwards (isInternalPath lets `.canvas/`
// content through), so a viewing card gets its invalidation ride-along for free — no new feed.
//
// This BOARD-stage route (CANONICAL-root only, no ?root=) reaches its cross-cutting effect —
// maybeWakeDocWorker, the auto-wake that spawns/nudges a doc worker on a qualifying comment — through
// ServerContext, since that effect closes over the live-session registry + the spawn subsystem. The
// annotation ledger / anchor / doc-watch / doc-job helpers are standalone modules, imported directly.

// The annotated file's content, behind the SAME gates as the file read (handleFile): inside the
// root, not internal, a known text extension — so an annotation op can never probe a path the
// listing wouldn't show. The MAX_BYTES head-truncation is shared with the card's read on purpose:
// anchors resolve against exactly what a card can display, and an anchor beyond the preview cap
// reads as orphaned rather than pointing at text nobody can see.
function readAnnotatedSource(root: string, rel: string): string | null {
  const abs = safeResolve(root, rel);
  const allowed = !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  return allowed ? (readText(abs!)?.content ?? null) : null;
}

// GET /api/annotations?board=<id>&path=<path> → one file's folded annotations, each with `orphaned`
// and its resolved source `range` (null when orphaned). No ledger → { annotations: [] }, 200 — "no
// comments" isn't an error. Omitting `path` lists every annotated file with open/orphan counts —
// the sweep surface ("what's awaiting an answer", doc §7).
function handleAnnotationsRead(res: ServerResponse, root: string, repoPath: string, rel: string | null): void {
  if (!rel) {
    // The sweep spans every doc that has annotations OR a watcher (P1/W4) — so "what's watched" shows up
    // even on a doc no one has commented on yet.
    const paths = [...new Set([...listAnnotatedPaths(repoPath), ...listWatchedPaths(repoPath)])].sort();
    const files = paths
      .map((p) => {
        const annos = foldAnnotations(readAnnotationLog(repoPath, p));
        const src = readAnnotatedSource(root, p);
        const open = annos.filter((a) => !a.resolved);
        const watchers = readWatchers(repoPath, p);
        // Question roll-up (docs/anchored-async-ask.md §6): `awaiting` needs a HUMAN to decide,
        // `answered` needs an AGENT to apply — surfaced separately from plain open comments so the
        // sweep answers "what's waiting on me" (awaiting) and "what's ready to apply" (answered).
        return {
          path: p,
          total: annos.length,
          open: open.length,
          orphaned: open.filter((a) => src == null || !resolveAnchor(src, a.anchor)).length,
          awaiting: annos.filter((a) => questionState(a) === "awaiting").length,
          answered: annos.filter((a) => questionState(a) === "answered").length,
          // "what's watched" (P1/W4): the count of active (non-paused) watchers arming this doc.
          watched: watchers.filter((w) => w.state !== "paused").length,
          watchers,
        };
      })
      .filter((f) => f.total > 0 || f.watchers.length > 0);
    return sendJson(res, 200, { files });
  }
  const src = readAnnotatedSource(root, rel); // a deleted/blocked file ⇒ every anchor orphans (quotes intact — the payload)
  // Self-heal (§4): re-mint anchors an intervening edit moved BEFORE we fold, so the read reflects the
  // fresh selectors and future reads hit the offset fast path. Best-effort, converges in one pass, and
  // covers every edit path (the Edit tool, /api/file, an external editor, git) — this read is the one
  // place that sees the current bytes and the ledger together, so no watcher is needed.
  reanchorFile(repoPath, src ?? null, rel);
  const annos = foldAnnotations(readAnnotationLog(repoPath, rel));
  const annotations = annos.map((a) => {
    const range = src == null ? null : resolveAnchor(src, a.anchor);
    // `state` is the read-time derived status: awaiting/answered/resolved for a question,
    // pending/accepted/rejected for a suggestion, absent for a plain note (the `orphaned` principle).
    const state = questionState(a) ?? suggestionState(a);
    return { ...a, orphaned: !range, range, ...(state ? { state } : {}) };
  });
  // A doc's SEAT roster (P1/W4) — who's armed to be woken by a comment, at what level — plus its standing
  // JOBS (doc-jobs.js), the server-fired timers on this doc's marker. Both ride the per-file read so the card
  // can paint a watcher chip / job list alongside the annotations, and the CLI `job list --doc` reads it.
  sendJson(res, 200, { path: rel, annotations, watchers: readWatchers(repoPath, rel), jobs: readDocJobs(repoPath, rel) });
}

// POST /api/annotations?board=<id> { path, op, … } → append one §5 event. Ops and their fields:
//   create   { path, anchor:{exact, prefix?, suffix?, offset?}, text, author,
//              kind?:"note"|"question"|"suggestion", options?:[{label,description?}], blocking?, replacement? } → { ok, id, ts, orphaned, state? }
//   reply    { path, id, from, text }
//   answer   { path, id, by, choice?, text? }   (the target must be a kind:"question")
//   accept   { path, id, by }   reject { path, id, by }   (the target must be a kind:"suggestion")
//   resolve  { path, id, by }        reopen { path, id, by }
//   reanchor { path, id, anchor, by }
//   thread   { path, id, thread }
//   watch    { path, role, level?, state?, by }   (arm/re-level a doc watcher — P1/W4)
//   pause    { path, role }   resume { path, role }   unwatch { path, role }   (a watcher's state)
//   job      { path, instruction, intervalMs?, role?, jobId?, by }   (create/update a doc standing job — doc-jobs.js)
//   unjob    { path, jobId, by }   (remove a doc standing job)
// `kind:"question"` (with optional `options`/`blocking`) turns a create into an anchored async-ask
// (docs/anchored-async-ask.md §4); `answer` records a human's/peer's decision on it. options/blocking
// are ignored on a note. The awaiting/answered/resolved state is derived at read (never stored).
// 400 on a bad op / missing field; 404 on a blocked/absent target file (create — never confirms a
// blocked path, like the file read) or an unknown annotation id (every other op); 500 when the
// append fails (the ledger is a comment's ONLY home — unlike a thread message there is no live
// in-memory source, so a lost write must be loud). `author`/`from`/`by` is "human" or a session
// sid — the thread-message attribution convention. A create whose anchor doesn't resolve is still
// accepted but reported `orphaned:true`, so a curl'd selector with a typo'd quote isn't born a
// silent orphan.
// The reserved watcher handle an ask-armed doc seat holds (P2/W5, anchored-async-ask §4): a `--blocking`
// question auto-arms it at `mentions` level so the later `answer` wakes a continuation with no human having
// pre-watched the doc. Cleared once no unresolved blocking question remains. Not a real role, so an
// answer-driven wake spawns a plain (bare) doc worker.
const ASK_WATCH_ROLE = "ask";

async function handleAnnotationsWrite(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  repoPath: string,
  boardId: string,
  origin: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  const str = (k: string): string | null =>
    typeof body[k] === "string" && (body[k] as string).length > 0 ? (body[k] as string) : null;
  const anchorOf = (v: unknown): QuoteAnchor | null => {
    if (!v || typeof v !== "object") return null;
    const a = v as Record<string, unknown>;
    if (typeof a.exact !== "string" || a.exact.length === 0) return null;
    return {
      exact: a.exact,
      ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}),
      ...(typeof a.suffix === "string" ? { suffix: a.suffix } : {}),
      ...(typeof a.offset === "number" ? { offset: a.offset } : {}),
    };
  };
  // Parse `options` (a multiple-choice question's choices) into [{label, description?}] — tolerant of
  // both a bare string array (["A","B"]) and the object form ([{label,description}]); a malformed/empty
  // list yields null (no options). docs/anchored-async-ask.md §4.
  const optionsOf = (v: unknown): AnnotationOption[] | null => {
    if (!Array.isArray(v)) return null;
    const out: AnnotationOption[] = [];
    for (const o of v) {
      if (typeof o === "string" && o.length > 0) out.push({ label: o });
      else if (o && typeof o === "object") {
        const r = o as Record<string, unknown>;
        if (typeof r.label === "string" && r.label.length > 0)
          out.push({
            label: r.label,
            ...(typeof r.description === "string" ? { description: r.description } : {}),
          });
      }
    }
    return out.length > 0 ? out : null;
  };
  const rel = str("path");
  const op = str("op");
  if (!rel) return sendJson(res, 400, { error: "path required" });
  const ts = Date.now();

  if (op === "create") {
    const anchor = anchorOf(body.anchor);
    const text = str("text");
    const author = str("author");
    if (!anchor || !text || !author)
      return sendJson(res, 400, { error: "create needs anchor.exact, text, author" });
    const src = readAnnotatedSource(root, rel);
    if (src == null) return sendJson(res, 404, { error: "not found" });
    // kind defaults to "note" (stored implicitly — a create with no kind folds to note, so existing
    // callers are unchanged); question fields ride only on a question, `replacement` only on a suggestion.
    const isQuestion = body.kind === "question";
    const isSuggestion = body.kind === "suggestion";
    const options = isQuestion ? optionsOf(body.options) : null;
    const blocking = isQuestion && body.blocking === true;
    // A suggestion is a span REPLACEMENT — the proposed new text is required (an empty string is a valid
    // deletion, so the guard is "is it a string", not "is it truthy").
    const replacement = isSuggestion ? (typeof body.replacement === "string" ? body.replacement : null) : null;
    if (isSuggestion && replacement == null)
      return sendJson(res, 400, { error: "a suggestion needs a replacement string" });
    const id = "anno:" + crypto.randomUUID();
    const ev: AnnotationEvent = {
      ev: "create",
      id,
      path: rel,
      anchor,
      text,
      author,
      ts,
      ...(isQuestion ? { kind: "question" } : isSuggestion ? { kind: "suggestion" } : {}),
      ...(options ? { options } : {}),
      ...(blocking ? { blocking: true } : {}),
      ...(replacement != null ? { replacement } : {}),
    };
    if (!appendAnnotationEvent(repoPath, rel, ev)) return sendJson(res, 500, { error: "append failed" });
    if (isQuestion) {
      // A blocking question arms an ask-armed doc seat (mentions) so the ANSWER wakes a continuation (§4).
      // The question itself awaits a HUMAN — it wakes no agent (no-op-spawn avoidance), so no doc-wake here.
      if (blocking) setWatcher(repoPath, rel, { role: ASK_WATCH_ROLE, level: "mentions", by: author, ts });
    } else {
      // A note OR a suggestion is room-wide activity a reviewer should service → wake an `all` watcher.
      getServerContext().maybeWakeDocWorker(boardId, repoPath, origin, rel, isSuggestion ? "suggestion" : "note");
    }
    return sendJson(res, 200, {
      ok: true,
      id,
      ts,
      orphaned: !resolveAnchor(src, anchor),
      ...(isQuestion ? { kind: "question", state: "awaiting" } : {}),
      ...(isSuggestion ? { kind: "suggestion", state: "pending" } : {}),
    });
  }

  // Doc-WATCH ops (P1/W4, doc-watch.js) — a doc's SEAT roster, not an annotation. They key on `role`, not
  // an annotation id, so they're handled before the id-gated block below. `watch` binds/re-levels a role as
  // a watcher (arm the "watch for comments" affordance); `pause`/`resume` toggle its state; `unwatch` drops
  // it. The doc must exist (like `create`). W4 is pull-mode plumbing: this records who to wake — the actual
  // server-spawn on a qualifying comment is W5.
  if (op === "watch" || op === "unwatch" || op === "pause" || op === "resume") {
    const role = str("role");
    const by = str("by") ?? "human";
    if (!role) return sendJson(res, 400, { error: `${op} needs role` });
    if (readAnnotatedSource(root, rel) == null) return sendJson(res, 404, { error: "not found" });
    if (op === "unwatch") {
      const removed = removeWatcher(repoPath, rel, role);
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true, removed: true } : { error: "no such watcher" });
    }
    if (op === "pause" || op === "resume") {
      const w = setWatcherState(repoPath, rel, role, op === "pause" ? "paused" : "active");
      return w ? sendJson(res, 200, { ok: true, watcher: w }) : sendJson(res, 404, { error: "no such watcher" });
    }
    // op === "watch": bind or re-level (level defaults to `all` on a fresh bind; state via optional field).
    const level = isNotificationLevel(body.level) ? body.level : undefined;
    const state = body.state === "paused" ? "paused" : body.state === "active" ? "active" : undefined;
    const w = setWatcher(repoPath, rel, { role, level, state, by, ts });
    return sendJson(res, 200, { ok: true, watcher: w });
  }

  // Doc-JOB ops (doc-jobs.js) — a STANDING JOB on the doc's marker, the W6 thread-job drop-in generalized
  // onto a doc (the `/api/thread/<id>/job` shape, doc-scoped). `job` creates/updates (jobId edits in place;
  // a named `role` fires into that role's seat, else a bare doc worker; intervalMs clamps up to the 60s
  // floor); `unjob` removes by jobId. Keyed on job fields, not an annotation id, so handled before the
  // id-gated block. The doc must exist (like `create`/`watch`). The server-fired half is standingJobsTick.
  if (op === "job" || op === "unjob") {
    const by = str("by") ?? "human";
    if (readAnnotatedSource(root, rel) == null) return sendJson(res, 404, { error: "not found" });
    if (op === "unjob") {
      const jobId = str("jobId");
      if (!jobId) return sendJson(res, 400, { error: "unjob needs jobId" });
      const { removed, jobs } = removeDocJob(repoPath, rel, jobId);
      return sendJson(res, removed ? 200 : 404, { ok: removed, path: rel, removed, jobs });
    }
    const instruction = str("instruction");
    const jobId = str("jobId");
    if (!instruction && !jobId) return sendJson(res, 400, { error: "job needs instruction" });
    if (body.intervalMs != null && !Number.isFinite(Number(body.intervalMs)))
      return sendJson(res, 400, { error: "intervalMs must be a number of milliseconds" });
    if (body.role != null && typeof body.role !== "string")
      return sendJson(res, 400, { error: "role must be a string (a role id) or omitted" });
    const { job, jobs } = upsertDocJob(repoPath, rel, {
      id: jobId ?? undefined,
      role: typeof body.role === "string" ? body.role : null,
      intervalMs: body.intervalMs as number | undefined,
      instruction: instruction ?? undefined,
      by,
      ts,
    });
    return sendJson(res, 200, { ok: true, path: rel, job, jobs });
  }

  // Every other op targets an existing annotation on an existing ledger.
  const id = str("id");
  if (!id) return sendJson(res, 400, { error: "id required" });
  const target = foldAnnotations(readAnnotationLog(repoPath, rel)).find((a) => a.id === id);
  if (!target) return sendJson(res, 404, { error: "unknown annotation" });

  // Suggestion ACCEPT/REJECT (track-changes) — a terminal decision on a `kind:"suggestion"`. Accept APPLIES
  // the replacement to the file's bytes (splice the anchored span → replacement) and resolves; reject just
  // resolves, bytes untouched. Both are one-shot: a suggestion already decided is refused (409). Handled
  // here — ahead of the shared `ev` assembly below — because accept mutates the file, not just the ledger.
  if (op === "accept" || op === "reject") {
    if (target.kind !== "suggestion") return sendJson(res, 400, { error: "not a suggestion" });
    const by = str("by");
    if (!by) return sendJson(res, 400, { error: `${op} needs by` });
    if (target.decision) return sendJson(res, 409, { error: `suggestion already ${target.decision}` });
    if (op === "accept") {
      // Resolve the span against the SAME preview the card sees (readAnnotatedSource) to get [start,end);
      // an orphan can't be applied (its span is gone) → 409, the writer must re-anchor or reject.
      const src = readAnnotatedSource(root, rel);
      if (src == null) return sendJson(res, 404, { error: "not found" });
      const range = resolveAnchor(src, target.anchor);
      if (!range) return sendJson(res, 409, { error: "orphaned suggestion — its span is gone; re-anchor or reject" });
      // Splice into the FULL on-disk bytes, not the MAX_BYTES preview: a truncated splice would silently drop
      // the file's tail. The head is byte-identical up to the cut, so the preview-derived [start,end) — which
      // can only resolve within the preview — are valid offsets into the full text too (CLAUDE.md size-cap rule).
      const abs = safeResolve(root, rel);
      let full: string;
      try {
        full = fs.readFileSync(abs!, "utf8");
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
      const next = full.slice(0, range.start) + (target.replacement ?? "") + full.slice(range.end);
      try {
        fs.writeFileSync(abs!, next, "utf8");
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
      // Record the accept only AFTER the bytes landed: on the rare append failure the file is edited but the
      // suggestion stays pending (visible, not silently diverged) and the 500 tells the caller.
      if (!appendAnnotationEvent(repoPath, rel, { ev: "accept", id, by, ts }))
        return sendJson(res, 500, { error: "append failed" });
      // Self-heal the sibling anchors the splice moved (the /api/file write path's move), best-effort.
      try {
        reanchorFile(repoPath, next, rel);
      } catch {
        /* reanchor is best-effort; the edit already landed */
      }
      return sendJson(res, 200, { ok: true, id, ts, state: "accepted", applied: true, version: fileVersion(abs!) });
    }
    // reject — resolve without touching the bytes.
    if (!appendAnnotationEvent(repoPath, rel, { ev: "reject", id, by, ts }))
      return sendJson(res, 500, { error: "append failed" });
    return sendJson(res, 200, { ok: true, id, ts, state: "rejected", applied: false });
  }

  let ev: AnnotationEvent;
  if (op === "reply") {
    const from = str("from");
    const text = str("text");
    if (!from || !text) return sendJson(res, 400, { error: "reply needs from, text" });
    ev = { ev: "reply", id, from, text, ts };
  } else if (op === "answer") {
    // Record a decision on a question (§4): a choice (an option label) and/or free prose; at least one
    // is required. Answering a plain note is a category error (400) — there's nothing to answer.
    if (target.kind !== "question") return sendJson(res, 400, { error: "not a question" });
    const by = str("by");
    const choice = str("choice");
    const text = str("text");
    if (!by) return sendJson(res, 400, { error: "answer needs by" });
    if (!choice && !text) return sendJson(res, 400, { error: "answer needs choice and/or text" });
    ev = { ev: "answer", id, by, ts, ...(choice ? { choice } : {}), ...(text ? { text } : {}) };
  } else if (op === "resolve" || op === "reopen") {
    const by = str("by");
    if (!by) return sendJson(res, 400, { error: `${op} needs by` });
    ev = { ev: op, id, by, ts };
  } else if (op === "reanchor") {
    const anchor = anchorOf(body.anchor);
    const by = str("by");
    if (!anchor || !by) return sendJson(res, 400, { error: "reanchor needs anchor.exact, by" });
    ev = { ev: "reanchor", id, anchor, by, ts };
  } else if (op === "thread") {
    const thread = str("thread");
    if (!thread) return sendJson(res, 400, { error: "thread needs thread" });
    ev = { ev: "thread", id, thread, ts };
  } else {
    return sendJson(res, 400, { error: "unknown op" });
  }
  if (!appendAnnotationEvent(repoPath, rel, ev)) return sendJson(res, 500, { error: "append failed" });
  // Post-write wake (P2/W5): an ANSWER is activity addressed to the ask-armed seat → wake a continuation.
  if (op === "answer") getServerContext().maybeWakeDocWorker(boardId, repoPath, origin, rel, "answer");
  // Clearing the ask-armed seat: once NO unresolved blocking question remains on the doc, drop it (§4 — the
  // `resolve` clears the watcher the `--blocking` create armed). Re-derived from state, so it survives
  // multiple concurrent blocking asks (only the last resolve removes it).
  if (op === "resolve") {
    const stillBlocking = foldAnnotations(readAnnotationLog(repoPath, rel)).some(
      (a) => a.kind === "question" && a.blocking && questionState(a) !== "resolved",
    );
    if (!stillBlocking) removeWatcher(repoPath, rel, ASK_WATCH_ROLE);
  }
  sendJson(res, 200, { ok: true, id, ts });
}

// Doc annotations (docs/doc-annotations.md): quote-anchored standoff comments on this board's files.
// Deliberately CANONICAL-root only (no ?root=): the ledger is keyed by repo-relative path, and a
// worktree's copy of a doc is the same doc — annotations shouldn't fork per tree.
export const annotationBoardRoutes: BoardRoute[] = [
  {
    match: exact("/api/annotations"),
    run: (req, res, url, _g, boardId, board) => {
      const ctx = getServerContext();
      const canonical = ctx.rootDir(boardId, null);
      if (!canonical) return sendJson(res, 400, { error: "unknown root" });
      if (req.method === "POST") return void handleAnnotationsWrite(req, res, canonical, board.repoPath, boardId, ctx.originOf(req));
      return handleAnnotationsRead(res, canonical, board.repoPath, url.searchParams.get("path"));
    },
  },
];
