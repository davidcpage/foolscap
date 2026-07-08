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

// The pill-state vocabulary: the `.chan-member.i-<state>` class suffix a participant pill wears, shared with
// the session card's own band so the two surfaces can never disagree on which state a session is in.
export type PillState = "working" | "blocked-human" | "blocked-peer" | "scheduled" | "crashed" | "done";
export declare const PILL_STATES: readonly PillState[];

/** The pill slot a raw declared work-intent maps to (or null if it names nothing paintable). */
export declare function intentPillState(intent: string | null | undefined): PillState | null;

// The per-participant, per-thread pill fusion: the whole-session server band (SessionMeta.status) fused with
// THIS thread's declared intent. Process-observed bands drive the pill exactly as they drive the card;
// done-on-live (not over a running turn) and an untagged blocked:peer are folded on top. null → neutral pill.
export declare function memberPillState(
  band: string | null | undefined,
  declaredIntent: string | null | undefined,
): PillState | null;
