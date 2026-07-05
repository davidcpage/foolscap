// Types for doc-watch.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import
// the ledger without allowJs. Keep in sync with the exports in doc-watch.js.

import type { NotificationLevel } from "./notification-levels.js";

// A doc's watcher (docs/anchored-async-ask.md §4) — a role bound to a doc at a notification level, the
// durable "who to wake when a comment lands". `level` is the standing preference; `state` the pause toggle.
export interface WatchRecord {
  role: string;
  level: NotificationLevel;
  state: "active" | "paused";
  by: string;
  createdAt: number;
}

export function canvasAnnotationsDir(repoPath: string): string;
export function readWatchers(repoPath: string, filePath: string): WatchRecord[];
export function setWatcher(
  repoPath: string,
  filePath: string,
  opts: { role: string; level?: unknown; state?: "active" | "paused"; by?: string; ts?: number },
): WatchRecord;
export function setWatcherState(
  repoPath: string,
  filePath: string,
  role: string,
  state: "active" | "paused",
): WatchRecord | null;
export function removeWatcher(repoPath: string, filePath: string, role: string): boolean;
export function watcherEffectiveLevel(watcher: WatchRecord | undefined | null): NotificationLevel;
export function listWatchedPaths(repoPath: string): string[];
