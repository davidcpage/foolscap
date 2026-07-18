export const CLAUDE_USAGE_POLL_MS: number;
export const CLAUDE_USAGE_POLL_ACTIVE_MS: number;
export const CLAUDE_USAGE_MAX_BACKOFF_MS: number;

export function claudeUsagePollDelay(liveSessionCount: number): number;

export function retryAfterMs(value: string | null | undefined, now?: number): number | null;
export function claudeRateLimitDelay(
  previousBackoff: number,
  retryAfter: number | null,
  base?: number,
): { backoff: number; delay: number };
export function tokenFingerprint(token: string | null | undefined): string | null;
export function shouldSkipUsagePoll(
  gate: { hash: string | null; until: number } | null,
  currentHash: string | null,
  now?: number,
): boolean;
export function mergeUsageProvider(
  envelope: { schema?: number; providers?: Record<string, unknown> } | null | undefined,
  provider: string,
  value: unknown,
): { schema: 2; providers: Record<string, unknown> };
export function usageCachePath(repoPath: string): string;
export function scrubUsageEmail<T>(value: T): T;
export function readUsageCache(file: string): { schema: 2; providers: Record<string, unknown> } | null;
export function writeUsageCache(file: string, value: unknown): boolean;
export function purgeCachedEmail(file: string): boolean;
