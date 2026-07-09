// Types for session-band-republish.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts
// can import it without allowJs. Keep in sync with the exports in session-band-republish.js.

/** The whole-session status band both surfaces render (mirror of vite-fs-plugin's SessionBand). */
export type Band = "working" | "waiting" | "waiting-agent" | "scheduled" | "done" | "crashed" | "ended";

/**
 * Should the loopTick safety net republish this session's feed? True iff the session has been published
 * before (`lastBand` is not `undefined`) AND the freshly computed band differs from it. `null` is a real
 * published value (a bandless never-run session), distinct from `undefined` (never published).
 */
export function shouldRepublishBand(lastBand: Band | null | undefined, current: Band | null): boolean;
