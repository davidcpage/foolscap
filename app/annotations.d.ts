// Types for annotations.js (the doc-annotations ledger) — see the .js for the fold semantics;
// docs/doc-annotations.md §5 is the spec.

import type { QuoteAnchor } from "./anchors.js";

export type AnnotationEventKind =
  | "create"
  | "reply"
  | "resolve"
  | "reopen"
  | "reanchor"
  | "thread"
  | "answer"
  | "accept"
  | "reject";

/**
 * The kind of an annotation: a plain comment ("note"), an anchored async-ask ("question",
 * docs/anchored-async-ask.md §4), or a track-changes proposal ("suggestion" — a span replacement
 * accepted/rejected as a unit).
 */
export type AnnotationKind = "note" | "question" | "suggestion";

/** A multiple-choice option on a `kind:"question"` annotation. */
export interface AnnotationOption {
  label: string;
  description?: string;
}

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
  by?: string; // resolve / reopen / reanchor / answer
  thread?: string; // thread: the escalation target node id
  kind?: AnnotationKind; // create: "question"/"suggestion" (default "note")
  options?: AnnotationOption[]; // create: a multiple-choice question's options
  blocking?: boolean; // create: the asker is waiting (arms the ask-armed doc seat — W5)
  replacement?: string; // create: a kind:"suggestion"'s proposed replacement for the anchored span
  choice?: string; // answer: the selected option label
}

/** The derived state of a `kind:"question"` — computed at read, never stored (the `orphaned` rule). */
export type QuestionState = "awaiting" | "answered" | "resolved";

/** The derived state of a `kind:"suggestion"` — computed at read, never stored (the `orphaned` rule). */
export type SuggestionState = "pending" | "accepted" | "rejected";

/** The folded current state of one annotation. `orphaned` is derived at read time, never here. */
export interface Annotation {
  id: string;
  path: string;
  anchor: QuoteAnchor;
  text: string;
  author: string;
  ts: number;
  kind: AnnotationKind;
  options?: AnnotationOption[];
  blocking?: boolean;
  replacement?: string; // a kind:"suggestion"'s proposed replacement for the anchored span
  decision?: "accepted" | "rejected"; // a suggestion's terminal decision (drives suggestionState)
  answered?: boolean;
  answer?: { by: string; choice?: string; text: string; ts: number };
  resolved: boolean;
  resolvedBy?: string;
  resolvedTs?: number;
  replies: Array<{ from: string; text: string; ts: number; choice?: string }>;
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
export declare function questionState(a: Annotation | null | undefined): QuestionState | null;
export declare function suggestionState(a: Annotation | null | undefined): SuggestionState | null;
export declare function listAnnotatedPaths(repoPath: string): string[];
