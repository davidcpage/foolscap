import type { Subscribable } from "./lib";
import { activeBoardId } from "./board";
import { resolveAnchor, type QuoteAnchor } from "../anchors.js";

// The client side of doc annotations (docs/doc-annotations.md §6, build-order step 2): the off-log
// projection of one file's annotations (content.ts's lazy-fetch + notify seam applied to
// GET /api/annotations), the POST helper the card chrome writes through, and the DOM machinery the
// highlight painting needs — rendered-text offset ↔ Range mapping and a global CSS Custom Highlight
// registry. The card-facing UI itself lives in NodeView.tsx (AnnotationsLayer, host chrome over the
// file card); this module keeps everything that isn't React.
//
// Two resolutions, one anchor: the SERVER resolves each anchor against the markdown SOURCE (the
// durable coordinate system — its verdict is `orphaned`); the CLIENT re-resolves the same quote
// against the card's RENDERED text (element.textContent) to place highlights, because the rendered
// prose differs from the source by exactly the markdown syntax (`**`, link targets, heading marks).
// resolveAnchor's fuzzy pass absorbs that delta, so one selector serves both coordinate systems.

export interface AnnotationReply {
  from: string;
  text: string;
  ts: number;
  choice?: string; // an `answer` reply carries the chosen option label (docs/anchored-async-ask.md §4)
}

/** A multiple-choice question's choices (anchored async-ask §4). */
export interface AnnotationOption {
  label: string;
  description?: string;
}

/** One folded annotation as GET /api/annotations serves it — including the read-time verdicts. */
export interface AnnotationInfo {
  id: string;
  path: string;
  anchor: QuoteAnchor;
  text: string;
  author: string;
  ts: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedTs?: number;
  replies: AnnotationReply[];
  thread?: string;
  orphaned: boolean; // the SERVER's source-based verdict — drives the orphan strip
  range: { start: number; end: number; method: string } | null; // source offsets (informational here)
  // Anchored async-ask (docs/anchored-async-ask.md §4/§6, W2): a `kind:"question"` create carries
  // `options`/`blocking`; the human's decision rides `answer`; `state` is the read-time question state.
  kind?: "note" | "question";
  options?: AnnotationOption[];
  blocking?: boolean;
  answered?: boolean;
  answer?: { by: string; choice?: string; text: string; ts: number };
  state?: "awaiting" | "answered" | "resolved"; // present only for a kind:"question"
}

/** A doc's watcher (P1/W4, docs/anchored-async-ask.md §4) — a role armed to be woken by a comment. */
export interface WatchRecord {
  role: string;
  level: "all" | "mentions" | "paused";
  state: "active" | "paused";
  by: string;
  createdAt: number;
}

// ── the off-log projection (the fileContentSignal pattern, keyed by path) ────────────────────────
// Annotations are CANONICAL-ROOT only (the ledger is keyed by repo-relative path — the server refuses
// ?root=), so unlike file content the key is just the path.

const values = new Map<string, AnnotationInfo[]>();
const watchValues = new Map<string, WatchRecord[]>(); // the doc's watcher roster, rides the same GET
const subs = new Map<string, Set<() => void>>();
const watchSubs = new Map<string, Set<() => void>>();
const inflight = new Set<string>();
const sigs = new Map<string, Subscribable<AnnotationInfo[] | undefined>>();
const watchSigs = new Map<string, Subscribable<WatchRecord[] | undefined>>();

async function fetchAnnotations(path: string): Promise<void> {
  if (inflight.has(path)) return;
  inflight.add(path);
  try {
    const r = await fetch(`/api/annotations?board=${activeBoardId()}&path=${encodeURIComponent(path)}`);
    if (r.ok) {
      const d = (await r.json()) as { annotations?: AnnotationInfo[]; watchers?: WatchRecord[] };
      values.set(path, d.annotations ?? []);
      watchValues.set(path, d.watchers ?? []);
      for (const fn of subs.get(path) ?? []) fn();
      for (const fn of watchSubs.get(path) ?? []) fn();
    }
  } catch {
    // offline — leave unset; a later subscribe (or a watch-driven refresh) retries
  } finally {
    inflight.delete(path);
  }
}

/** Channel-1 handle for one doc's watcher roster (P1/W4). Shares fetchAnnotations' GET, so subscribing to
 *  either lazily loads both. */
export function docWatchersSignal(path: string): Subscribable<WatchRecord[] | undefined> {
  let s = watchSigs.get(path);
  if (!s) {
    s = {
      get: () => watchValues.get(path),
      subscribe(onChange) {
        let set = watchSubs.get(path);
        if (!set) watchSubs.set(path, (set = new Set()));
        set.add(onChange);
        if (!watchValues.has(path)) void fetchAnnotations(path);
        return () => set!.delete(onChange);
      },
    };
    watchSigs.set(path, s);
  }
  return s;
}

/** Channel-1 handle for one file's annotations. First subscribe lazily fetches. */
export function annotationsSignal(path: string): Subscribable<AnnotationInfo[] | undefined> {
  let s = sigs.get(path);
  if (!s) {
    s = {
      get: () => values.get(path),
      subscribe(onChange) {
        let set = subs.get(path);
        if (!set) subs.set(path, (set = new Set()));
        set.add(onChange);
        if (!values.has(path)) void fetchAnnotations(path);
        return () => set!.delete(onChange);
      },
    };
    sigs.set(path, s);
  }
  return s;
}

// Re-pull one file's annotations if anyone has ever loaded them — the refreshListing shape: a no-op
// for paths never subscribed, so a watch event over an un-carded file costs nothing.
export function refreshAnnotations(path: string): void {
  if (values.has(path) || (subs.get(path)?.size ?? 0) > 0) void fetchAnnotations(path);
}

/**
 * POST one annotation op ({op:"create"|"reply"|"resolve"|"reopen"|"reanchor"|"thread", …}) and, on
 * success, re-pull the projection so every card viewing this path re-renders with the fold the
 * server actually has (the ledger is the truth, not an optimistic patch).
 */
export async function postAnnotationOp(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await fetch(`/api/annotations?board=${activeBoardId()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...body }),
    });
    const d = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
    if (r.ok) refreshAnnotations(path);
    return r.ok ? { ok: true, id: d.id } : { ok: false, error: d.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: "offline" };
  }
}

const LEDGER_DIR = ".canvas/annotations/";

/**
 * Route one repo-watch event into this projection (called from loader.onWatchEvent, before its
 * card gate — the ledger files have no cards). Two triggers re-pull a loaded path:
 *  - its LEDGER file changed (someone commented/replied/resolved — possibly an agent, server-side);
 *    the on-disk name is the encoded path, so decode it back;
 *  - the ANNOTATED FILE ITSELF changed (an edit moves anchors: ranges shift, orphans appear/heal —
 *    the server re-derives both on the next GET).
 */
export function annotationsWatchEvent(root: string, relPath: string): void {
  if (root !== "repo") return; // annotations live on the canonical root only
  if (relPath.startsWith(LEDGER_DIR)) {
    const name = relPath.slice(LEDGER_DIR.length);
    if (!name.endsWith(".jsonl") || name.includes("/")) return;
    try {
      refreshAnnotations(decodeURIComponent(name.slice(0, -".jsonl".length)));
    } catch {
      /* a stray non-encoded file in the dir — not ours */
    }
    return;
  }
  refreshAnnotations(relPath);
}

// ── rendered-text ⇄ DOM Range mapping ─────────────────────────────────────────────────────────────
// The card's prose is a DOM tree; anchors live in flat text offsets. Both directions walk the same
// coordinate: the concatenated text-node content of the [data-text] element (=== textContent).

/** The flat text offset of a DOM boundary point inside `el` — selection → offsets, at creation. */
export function textOffsetOf(el: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0; // a boundary outside el (shouldn't happen — callers check containment first)
  }
  return r.toString().length;
}

/** A DOM Range spanning flat text offsets [start, end) of `el` — offsets → highlight, at paint. */
export function rangeFromTextOffsets(el: Node, start: number, end: number): Range | null {
  if (end <= start) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Node | null = null;
  let startOff = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n.nodeValue ?? "").length;
    if (!startNode && pos + len > start) {
      startNode = n;
      startOff = start - pos;
    }
    if (pos + len >= end) {
      if (!startNode) return null;
      const r = document.createRange();
      r.setStart(startNode, startOff);
      r.setEnd(n, end - pos);
      return r;
    }
    pos += len;
  }
  return null; // offsets past the text (content changed under us) — skip, the next paint re-resolves
}

/** Resolve an anchor against an element's RENDERED text and return a paintable Range. */
export function anchorRangeIn(el: Element, anchor: QuoteAnchor): Range | null {
  const hit = resolveAnchor(el.textContent ?? "", anchor);
  return hit ? rangeFromTextOffsets(el, hit.start, hit.end) : null;
}

/** The caret boundary point under a pointer event, for hit-testing highlights. Chrome-shaped. */
export function caretPointAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

// ── the global highlight registry (CSS Custom Highlight API) ──────────────────────────────────────
// Highlights are registered by NAME on CSS.highlights, painted by ::highlight(name) in style.css —
// no DOM mutation, so lit's interior render is never disturbed and re-renders can't strand marker
// spans. The registry is page-global while cards are many, so each card contributes its ranges under
// its node id and the union is rebuilt per change. Three names: open comments, resolved (shown only
// when toggled), and the one whose popover is open.

export interface CardHighlightRanges {
  open: Range[];
  question: Range[]; // an anchored question (kind:"question") — painted distinctly from a comment (W2)
  resolved: Range[];
  active: Range[];
}

const HIGHLIGHT_NAMES: Record<keyof CardHighlightRanges, string> = {
  open: "anno-open",
  question: "anno-question",
  resolved: "anno-resolved",
  active: "anno-active",
};

const cardRanges = new Map<string, CardHighlightRanges>();

function rebuildHighlights(): void {
  // Highlight API is Chrome 105+/modern-only; without it the strip, badge and popovers still work —
  // only the in-text paint is missing. No fallback marker spans: mutating lit's DOM is the hazard.
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) return;
  for (const k of Object.keys(HIGHLIGHT_NAMES) as (keyof CardHighlightRanges)[]) {
    const all: Range[] = [];
    for (const cr of cardRanges.values()) all.push(...cr[k]);
    if (all.length) CSS.highlights.set(HIGHLIGHT_NAMES[k], new Highlight(...all));
    else CSS.highlights.delete(HIGHLIGHT_NAMES[k]);
  }
}

/** Publish (or, with null, retract) one card's highlight ranges into the global registry. */
export function setCardHighlights(cardKey: string, ranges: CardHighlightRanges | null): void {
  if (ranges) cardRanges.set(cardKey, ranges);
  else cardRanges.delete(cardKey);
  rebuildHighlights();
}
