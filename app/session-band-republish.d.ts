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

/**
 * The idle-band precedence (thread mrcmofwf-10 Done-when v3), factored out of sessionStatus so the reorder
 * is unit-pinnable. Called once a session is known idle-with-output. Highest wins: declared blocked:human →
 * "waiting" > declared blocked:peer → "waiting-agent" > `scheduled` → "scheduled" > `hasWaitingOn` (@-tag
 * inference) → "waiting-agent" > default → "waiting". A declared intent outranks a wake timer; the @-tag
 * inference does not.
 */
export function idleBand(
  idleIntent: "blocked:human" | "blocked:peer" | null | undefined,
  scheduled: boolean,
  hasWaitingOn: boolean,
): "waiting" | "waiting-agent" | "scheduled";
