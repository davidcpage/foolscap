import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeRateLimitDelay,
  mergeUsageProvider,
  purgeCachedEmail,
  readUsageCache,
  retryAfterMs,
  scrubUsageEmail,
  usageCachePath,
  writeUsageCache,
} from "../usage-feed-state.js";

test("Claude usage honors Retry-After while retaining exponential backoff", () => {
  assert.equal(retryAfterMs("120", 0), 120_000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:03:00 GMT", 60_000), 120_000);
  assert.equal(retryAfterMs("nonsense", 0), null);
  const first = claudeRateLimitDelay(0, 900_000);
  assert.equal(first.backoff, 180_000);
  assert.equal(first.delay, 900_000, "a longer Retry-After deadline wins");
  const second = claudeRateLimitDelay(first.backoff, null);
  assert.equal(second.backoff, 360_000);
  assert.equal(second.delay, 540_000);
});

test("provider-explicit last-good usage survives a dev-server process restart cache", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
  const file = usageCachePath(repo);
  let value = mergeUsageProvider(null, "claude", {
    provider: "claude", billing: "anthropic-plan", five_hour: { utilization: 14 }, error: null,
  });
  value = mergeUsageProvider(value, "codex", {
    provider: "codex", billing: "chatgpt-plan", account: { planType: "business" },
    rateLimits: { primary: { usedPercent: 8 } }, error: null,
  });
  assert.equal(writeUsageCache(file, value), true);
  assert.deepEqual(readUsageCache(file), value);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("account email never persists to (or republishes from) the usage cache; planType is kept (finding 4)", () => {
  const withEmail = mergeUsageProvider(null, "codex", {
    provider: "codex", billing: "chatgpt-plan",
    account: { type: "chatgpt", email: "person@example.test", planType: "team" },
    rateLimits: { primary: { usedPercent: 8 } }, error: null,
  });
  // scrubUsageEmail drops only the email, keeps the rest, and returns the SAME ref when nothing changed.
  const scrubbed = scrubUsageEmail(withEmail);
  assert.deepEqual(scrubbed.providers.codex.account, { type: "chatgpt", planType: "team" });
  assert.equal(scrubbed.providers.codex.rateLimits.primary.usedPercent, 8, "non-account fields untouched");
  assert.equal(scrubUsageEmail(scrubbed), scrubbed, "no email present → same reference (cheap no-op)");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-scrub-"));
  const file = usageCachePath(repo);
  // writeUsageCache strips email on the way to disk; readUsageCache never republishes one.
  assert.equal(writeUsageCache(file, withEmail), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).providers.codex.account.email, undefined);
  assert.equal(readUsageCache(file).providers.codex.account.planType, "team");
});

test("purgeCachedEmail clears an email a prior build persisted, and no-ops a clean file (finding 4)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-purge-"));
  const file = usageCachePath(repo);
  // Simulate a cache an OLD build wrote WITH an email (bypass writeUsageCache's scrub with a raw write).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dirty = mergeUsageProvider(null, "codex", {
    provider: "codex", account: { type: "chatgpt", email: "leak@example.test", planType: "pro" },
  });
  fs.writeFileSync(file, JSON.stringify(dirty) + "\n");

  assert.equal(purgeCachedEmail(file), true, "rewrote because an email was present");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.providers.codex.account.email, undefined, "email gone from the versioned file");
  assert.equal(onDisk.providers.codex.account.planType, "pro", "planType retained");

  const mtimeBefore = fs.statSync(file).mtimeMs;
  assert.equal(purgeCachedEmail(file), false, "second call is a no-op — nothing to purge");
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore, "clean file left untouched (no spurious rewrite)");
  assert.equal(purgeCachedEmail(usageCachePath(fs.mkdtempSync(path.join(os.tmpdir(), "u-")))), false, "absent file → false");
});
