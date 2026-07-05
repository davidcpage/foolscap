// Types for notification-levels.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts
// and the card chrome can import it without allowJs. Keep in sync with the exports in notification-levels.js.

/** A seat's wake preference on a wakeable surface (P1 / R2 recast). */
export type NotificationLevel = "all" | "mentions" | "paused";

export const NOTIFICATION_LEVELS: readonly NotificationLevel[];
export function isNotificationLevel(v: unknown): v is NotificationLevel;
export function normLevel(v: unknown): NotificationLevel;
export function wakesSeat(
  level: unknown,
  opts?: { mentioned?: boolean; broadcast?: boolean },
): boolean;
