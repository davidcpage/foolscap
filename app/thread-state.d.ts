// Types for thread-state.js (the §8 step-3 derived thread-state projection) — see the .js for the
// state machine's rationale; session-thread-lifecycle.md §4/§6 is the spec.

export type ThreadState = "active" | "waiting" | "dormant";

export interface ThreadParticipant {
  processState: "running" | "idle" | "exited";
  intent?: string | null; // a work-intent.js WorkIntent, or null/absent when never declared
}

export declare const THREAD_STATES: readonly ThreadState[];
export declare function isThreadState(s: unknown): s is ThreadState;
export declare function deriveThreadState(participants: ThreadParticipant[]): ThreadState;
