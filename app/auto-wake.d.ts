// Types for auto-wake.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import
// the single-flight core without allowJs. Keep in sync with the exports in auto-wake.js.

import type { WatchRecord } from "./doc-watch.js";

export function docSurfaceKey(filePath: string): string;
export function seatSurfaceKey(threadId: string, handle: string): string;

export function claimSurface(key: string, sid: string): void;
export function releaseSurface(key: string, sid: string): boolean;
export function surfaceClaimant(key: string): string | null;
export function isSurfaceClaimed(key: string): boolean;
export function clearAllClaims(): void;

export function shouldReapIdle(
  session: { autoWake?: boolean; status?: string; idleSince?: number } | null | undefined,
  now: number,
  keepAliveMs: number,
): boolean;
export function annotationWakeClass(eventKind: string): { mentioned: boolean; broadcast: boolean };
export function qualifyingWatchers(watchers: WatchRecord[] | null | undefined, eventKind: string): WatchRecord[];
