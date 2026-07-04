// Auto-reanchor (docs/doc-annotations.md §4): the server half of the anchor-maintenance loop that used
// to be the agent's manual chore. After a file's bytes change, an open annotation whose quoted text
// MOVED still resolves — anchors.js falls the stale offset through to exact/fuzzy — but its stored
// anchor is now stale (wrong offset, drifted context, or an edited quote). Left alone it re-resolves
// via the slower pass on every read and, as edits accumulate, eventually orphans. This module re-mints
// those anchors against the new bytes and appends a `reanchor` event authored by "system", so the next
// read hits the offset fast path and the comment keeps tracking the text it was about — exactly what a
// human doing the revision rule did by hand (re-read, find the moved span, POST reanchor), now free.
//
// Two invariants keep it safe:
//   • It only re-mints anchors that STILL RESOLVE (offset/exact/fuzzy). A true orphan (resolution
//     fails) is never touched — it stays loud on read for a human/agent to re-attach from the quote.
//   • It converges in one pass: a re-minted anchor has offset = its new start, so the very next resolve
//     hits "offset" and no further reanchor fires. Idempotent — re-running finds nothing to do.
//
// Pure `planReanchors` (string-in, plan-out — the tested core) + `reanchorFile` (reads the ledger,
// appends the plan). Plain ESM at the app root, the anchors.js/annotations.js convention, so it runs
// under node --test and the server imports it for the read-time + write-time self-heal.

import { makeAnchor, resolveAnchor } from "./anchors.js";
import { appendAnnotationEvent, foldAnnotations, readAnnotationLog } from "./annotations.js";

/**
 * Given a file's CURRENT source and its folded annotations, return the fresh anchors for the open
 * ones whose stored anchor has drifted. Pure — no IO, no clock. An entry is `{id, anchor, from}` where
 * `from` is the resolution method that proved the drift ("exact" | "fuzzy"); "offset" hits are already
 * optimal and produce no entry, and unresolvable (orphan) annotations produce none either.
 */
export function planReanchors(src, annos) {
  const plan = [];
  if (typeof src !== "string") return plan; // deleted/blocked file: open annos orphan, nothing to re-mint
  for (const a of annos ?? []) {
    if (!a || a.resolved) continue;
    const range = resolveAnchor(src, a.anchor);
    if (!range) continue; // true orphan — can't auto-fix; surfaced loud on read
    if (range.method === "offset") continue; // anchor still sits where it claims — nothing to do
    const fresh = makeAnchor(src, range.start, range.end);
    const cur = a.anchor || {};
    if (
      fresh.exact === cur.exact &&
      fresh.prefix === cur.prefix &&
      fresh.suffix === cur.suffix &&
      fresh.offset === cur.offset
    )
      continue; // resolved by a slow pass but the selector is byte-identical — don't log a no-op event
    plan.push({ id: a.id, anchor: fresh, from: range.method });
  }
  return plan;
}

/**
 * Self-heal one file's annotations against its current `src`: plan the drifted anchors and append a
 * `reanchor` event for each. Best-effort — a failed append is skipped, never thrown (reanchor must
 * never block the write/read it rides on). Returns a summary for logging/telemetry:
 *   { checked, reanchored:[ids re-minted], orphaned:[ids that don't resolve] }.
 * `opts.by` attributes the events (default "system"); `opts.now` injects the timestamp (tests).
 */
export function reanchorFile(repoPath, src, filePath, opts = {}) {
  const by = typeof opts.by === "string" && opts.by ? opts.by : "system";
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const annos = foldAnnotations(readAnnotationLog(repoPath, filePath));
  const open = annos.filter((a) => a && !a.resolved);
  const plan = planReanchors(src, annos);
  const reanchored = [];
  for (const p of plan) {
    if (appendAnnotationEvent(repoPath, filePath, { ev: "reanchor", id: p.id, anchor: p.anchor, by, ts: now }))
      reanchored.push(p.id);
  }
  const orphaned =
    typeof src !== "string"
      ? open.map((a) => a.id)
      : open.filter((a) => !resolveAnchor(src, a.anchor)).map((a) => a.id);
  return { checked: open.length, reanchored, orphaned };
}
