import fs from "node:fs";
import path from "node:path";

export const CLAUDE_USAGE_POLL_MS = 180_000;
export const CLAUDE_USAGE_MAX_BACKOFF_MS = 15 * 60_000;

/** Retry-After accepts either delay-seconds or an HTTP date. Return a non-negative delay in ms. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Exponential 429 backoff, never polling before a valid Retry-After deadline. */
export function claudeRateLimitDelay(previousBackoff, retryAfter, base = CLAUDE_USAGE_POLL_MS) {
  const backoff = Math.min(previousBackoff ? previousBackoff * 2 : base, CLAUDE_USAGE_MAX_BACKOFF_MS);
  return { backoff, delay: Math.max(base + backoff, retryAfter ?? 0) };
}

export function mergeUsageProvider(envelope, provider, value) {
  return {
    schema: 2,
    providers: { ...(envelope?.providers ?? {}), [provider]: value },
  };
}

export function usageCachePath(repoPath) {
  return path.join(repoPath, ".canvas", "cache", "plan-usage.json");
}

export function readUsageCache(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.schema === 2 && value.providers && typeof value.providers === "object" ? value : null;
  } catch {
    return null;
  }
}

export function writeUsageCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
