import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLAUDE_USAGE_POLL_MS = 180_000; // idle/base cadence — also the exponential-backoff base
export const CLAUDE_USAGE_POLL_ACTIVE_MS = 60_000; // faster cadence while any session is live
export const CLAUDE_USAGE_MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Pick the next Claude usage-poll delay by board activity: poll every 60s while any live session
 * exists (fresher plan-usage during multi-agent work), every 180s when the board is quiet (the
 * endpoint is free but rate-limited, so a flat 1-min poll 24/7 is wasteful). This is only the BASE
 * cadence — the 429/401 backoff gates in pollClaude() compute their own delays and take precedence.
 * @param {number} liveSessionCount  number of live (status !== "exited") sessions across all boards
 */
export function claudeUsagePollDelay(liveSessionCount) {
  return liveSessionCount > 0 ? CLAUDE_USAGE_POLL_ACTIVE_MS : CLAUDE_USAGE_POLL_MS;
}

/**
 * A stable, non-reversible fingerprint of the OAuth token — so the poller can tell "same failing
 * token as last time" from "the keychain rotated" WITHOUT ever holding or logging the token itself.
 * null in ⇒ null out (no token).
 */
export function tokenFingerprint(token) {
  if (token == null || token === "") return null;
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Should the Claude usage poll SKIP its upstream fetch this tick? A `gate` is set when the last poll
 * hit a blocking condition — a 401 (dead token; `until: Infinity`, held until the token changes) or a
 * 429 (rate-limited; `until` = the capped retry deadline). We skip while the SAME token is still within
 * the block window; the instant the keychain token changes (fingerprint differs) OR the deadline passes
 * we fetch again. This is what turns a designed-in sleep into an interruptible one: the caller re-checks
 * at base cadence, and a token refresh mid-401/mid-429 fires a prompt retry instead of waiting it out.
 * @param {{hash: (string|null), until: number}|null} gate
 * @param {string|null} currentHash  fingerprint of the token read this tick
 */
export function shouldSkipUsagePoll(gate, currentHash, now = Date.now()) {
  if (!gate) return false;
  if (gate.hash !== currentHash) return false; // token rotated → retry immediately
  return now < gate.until; // same token, still inside the hold window
}

/** Retry-After accepts either delay-seconds or an HTTP date. Return a non-negative delay in ms. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * Exponential 429 backoff, never polling before a valid Retry-After deadline — but a server can hand us
 * an abusive Retry-After (Anthropic returns 3600s after a hammering loop), which would freeze the card
 * for an hour. Cap the HONORED Retry-After at CLAUDE_USAGE_MAX_BACKOFF_MS so the total wait stays bounded;
 * pairing this with the interruptible poll (shouldSkipUsagePoll) means a token refresh still cuts it short.
 */
export function claudeRateLimitDelay(previousBackoff, retryAfter, base = CLAUDE_USAGE_POLL_MS) {
  const backoff = Math.min(previousBackoff ? previousBackoff * 2 : base, CLAUDE_USAGE_MAX_BACKOFF_MS);
  const honoredRetry = retryAfter == null ? 0 : Math.min(retryAfter, CLAUDE_USAGE_MAX_BACKOFF_MS);
  return { backoff, delay: Math.max(base + backoff, honoredRetry) };
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
