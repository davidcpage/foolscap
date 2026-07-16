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

// Privacy (finding 4): the usage envelope must never carry an account email onto the shared usage feed or
// into this cache — the cache is shadow-git-versioned, so a persisted email travels with the repo. Strip
// `account.email` from every provider, keeping the rest (planType included). Returns the SAME reference
// when nothing changed, so callers can cheaply detect "no email present". The runtime already omits email
// at the source; this is the belt-and-suspenders guard plus the migration path for caches an older build
// already wrote.
export function scrubUsageEmail(value) {
  if (!value?.providers || typeof value.providers !== "object") return value;
  let changed = false;
  const providers = {};
  for (const [name, p] of Object.entries(value.providers)) {
    if (p && typeof p === "object" && p.account && typeof p.account === "object" && "email" in p.account) {
      const { email, ...account } = p.account;
      providers[name] = { ...p, account };
      changed = true;
    } else {
      providers[name] = p;
    }
  }
  return changed ? { ...value, providers } : value;
}

export function readUsageCache(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!(value?.schema === 2 && value.providers && typeof value.providers === "object")) return null;
    return scrubUsageEmail(value); // never republish a persisted email onto the feed
  } catch {
    return null;
  }
}

export function writeUsageCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(scrubUsageEmail(value)) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// One-shot migration: clear an email a prior build persisted into the on-disk cache. Reads RAW (bypassing
// readUsageCache's scrub) so it can tell whether a rewrite is actually needed and leave a clean file (and
// its mtime — no spurious shadow-git commit) untouched. Returns true only when it rewrote.
export function purgeCachedEmail(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false; // absent/unreadable — nothing to purge
  }
  const scrubbed = scrubUsageEmail(raw);
  if (scrubbed === raw) return false; // no email present — leave the file untouched
  return writeUsageCache(file, scrubbed);
}
