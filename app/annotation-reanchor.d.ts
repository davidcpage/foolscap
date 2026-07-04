// Types for annotation-reanchor.js (the server-side anchor-maintenance loop) — see the .js for the
// convergence + safety invariants; docs/doc-annotations.md §4 is the spec.

import type { QuoteAnchor } from "./anchors.js";
import type { Annotation } from "./annotations.js";

export interface ReanchorPlanEntry {
  id: string;
  anchor: QuoteAnchor;
  from: "exact" | "fuzzy"; // the resolution pass that proved the stored anchor had drifted
}

export interface ReanchorResult {
  checked: number; // open annotations examined
  reanchored: string[]; // ids whose anchor was re-minted and logged
  orphaned: string[]; // ids that no longer resolve (left for a human to re-attach)
}

export declare function planReanchors(
  src: string | null | undefined,
  annos: Annotation[] | null | undefined,
): ReanchorPlanEntry[];

export declare function reanchorFile(
  repoPath: string,
  src: string | null | undefined,
  filePath: string,
  opts?: { by?: string; now?: number },
): ReanchorResult;
