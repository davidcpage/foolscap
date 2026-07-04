// Types for annotations.js (the doc-annotations ledger) — see the .js for the fold semantics;
// docs/doc-annotations.md §5 is the spec.

import type { QuoteAnchor } from "./anchors.js";

export type AnnotationEventKind = "create" | "reply" | "resolve" | "reopen" | "reanchor" | "thread";

/** One jsonl line. Fields beyond `ev`/`id` vary by kind — see the doc's §5 event table. */
export interface AnnotationEvent {
  ev: AnnotationEventKind;
  id: string; // "anno:<uuid>"
  ts: number;
  path?: string;
  anchor?: QuoteAnchor;
  text?: string;
  author?: string; // create: "human" or a session sid
  from?: string; // reply
  by?: string; // resolve / reopen / reanchor
  thread?: string; // thread: the escalation target node id
}

/** The folded current state of one annotation. `orphaned` is derived at read time, never here. */
export interface Annotation {
  id: string;
  path: string;
  anchor: QuoteAnchor;
  text: string;
  author: string;
  ts: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedTs?: number;
  replies: Array<{ from: string; text: string; ts: number }>;
  thread?: string;
}

export declare function canvasAnnotationsDir(repoPath: string): string;
export declare function appendAnnotationEvent(
  repoPath: string,
  filePath: string,
  ev: AnnotationEvent,
): boolean;
export declare function readAnnotationLog(repoPath: string, filePath: string): AnnotationEvent[];
export declare function foldAnnotations(events: AnnotationEvent[] | null | undefined): Annotation[];
export declare function listAnnotatedPaths(repoPath: string): string[];
