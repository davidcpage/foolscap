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
  | "answer";

/** A question's kind of annotation (docs/anchored-async-ask.md §4); a plain comment is a "note". */
export type AnnotationKind = "note" | "question";

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
  kind?: AnnotationKind; // create: "question" arms the anchored async-ask (default "note")
  options?: AnnotationOption[]; // create: a multiple-choice question's options
  blocking?: boolean; // create: the asker is waiting (arms the ask-armed doc seat — W5)
  choice?: string; // answer: the selected option label
}

/** The derived state of a `kind:"question"` — computed at read, never stored (the `orphaned` rule). */
export type QuestionState = "awaiting" | "answered" | "resolved";

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
export declare function listAnnotatedPaths(repoPath: string): string[];
