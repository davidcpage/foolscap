// Types for work-intent.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts and the
// channel card can import it without allowJs. Keep in sync with the exports in work-intent.js.

/** A session's declared stance toward its current work-unit (threads-as-cards §6). */
export type WorkIntent = "working" | "blocked:human" | "blocked:peer" | "done";

export const WORK_INTENTS: readonly WorkIntent[];
export function isWorkIntent(v: unknown): v is WorkIntent;
export function intentLine(intent: WorkIntent, note?: string): string;
export function intentGlyph(intent: string | undefined): string;
