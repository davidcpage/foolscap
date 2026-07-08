// Types for thread-waiting.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the derivation without allowJs. Keep in sync with the exports in thread-waiting.js.

// The subset of a thread message the derivation reads (the feed's ThreadMsg is a superset).
export type WaitingMsg = { seq: number; from: string; text?: string; kind?: string | null };

// One waiting-message preview: the sender + a trimmed one-line snippet + the seq (for jump-to-message).
export type WaitingPreview = { seq: number; from: string; text: string };

export function humanWaiting(log: WaitingMsg[]): {
  waiting: boolean;
  count: number;
  preview: WaitingPreview[];
  more: number;
};
