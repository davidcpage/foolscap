// Types for anchors.js (the doc-annotations anchor module) — see the .js for the resolution
// strategy; docs/doc-annotations.md §3 is the spec.

/** A W3C TextQuoteSelector-shaped anchor: the quote, ~32 chars of context, offset as a hint. */
export interface QuoteAnchor {
  exact: string;
  prefix?: string;
  suffix?: string;
  offset?: number;
}

export interface AnchorRange {
  start: number;
  end: number;
  method: "offset" | "exact" | "fuzzy";
}

export declare function makeAnchor(source: string, start: number, end: number): QuoteAnchor;
export declare function resolveAnchor(
  source: string,
  anchor: QuoteAnchor | null | undefined,
): AnchorRange | null;
