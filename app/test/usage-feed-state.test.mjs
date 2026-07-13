import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeRateLimitDelay,
  mergeUsageProvider,
  readUsageCache,
  retryAfterMs,
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
