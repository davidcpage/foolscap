import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_USAGE_MAX_BACKOFF_MS,
  CLAUDE_USAGE_POLL_ACTIVE_MS,
  CLAUDE_USAGE_POLL_MS,
  claudeRateLimitDelay,
  claudeUsagePollDelay,
  makeReschedulingPoller,
  mergeUsageProvider,
  purgeCachedEmail,
  readUsageCache,
  retryAfterMs,
  scrubUsageEmail,
  shouldSkipUsagePoll,
  tokenFingerprint,
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

test("claudeUsagePollDelay is adaptive: 60s while any session is live, 180s when the board is quiet", () => {
  assert.equal(claudeUsagePollDelay(0), CLAUDE_USAGE_POLL_MS, "idle board → base 180s cadence");
  assert.equal(claudeUsagePollDelay(1), CLAUDE_USAGE_POLL_ACTIVE_MS, "one live session → 60s cadence");
  assert.equal(claudeUsagePollDelay(9), CLAUDE_USAGE_POLL_ACTIVE_MS, "many live sessions → still 60s");
  assert.equal(CLAUDE_USAGE_POLL_ACTIVE_MS, 60_000);
  assert.equal(CLAUDE_USAGE_POLL_MS, 180_000);
});

test("an abusive Retry-After is capped at the 15-min max backoff (no hour-long freeze)", () => {
  // Anthropic hands out Retry-After: 3600 after a hammering loop — must NOT be honored verbatim.
  const capped = claudeRateLimitDelay(0, 3_600_000);
  assert.equal(capped.delay, CLAUDE_USAGE_MAX_BACKOFF_MS, "honored Retry-After clamped to 15 min");
  // The exponential floor (base + backoff) still wins when it exceeds the capped Retry-After.
  const floored = claudeRateLimitDelay(CLAUDE_USAGE_MAX_BACKOFF_MS, 3_600_000);
  assert.equal(floored.delay, CLAUDE_USAGE_POLL_MS + CLAUDE_USAGE_MAX_BACKOFF_MS, "base+backoff floor honored");
});

test("tokenFingerprint is stable, distinguishing, and never echoes the token", () => {
  assert.equal(tokenFingerprint(null), null);
  assert.equal(tokenFingerprint(""), null);
  const a = tokenFingerprint("sk-ant-oauth-abc");
  assert.equal(a, tokenFingerprint("sk-ant-oauth-abc"), "same token → same fingerprint");
  assert.notEqual(a, tokenFingerprint("sk-ant-oauth-xyz"), "different token → different fingerprint");
  assert.equal(a.length, 64, "sha-256 hex");
  assert.ok(!a.includes("abc"), "fingerprint does not contain the token");
});

test("shouldSkipUsagePoll: hold a failing token, retry on rotation or deadline", () => {
  const dead = tokenFingerprint("dead-token");
  const fresh = tokenFingerprint("fresh-token");

  // No gate → always fetch.
  assert.equal(shouldSkipUsagePoll(null, dead), false);

  // 401 hold (until: Infinity): skip while the SAME token is presented, fetch the instant it rotates.
  const gate401 = { hash: dead, until: Number.POSITIVE_INFINITY };
  assert.equal(shouldSkipUsagePoll(gate401, dead, 1_000), true, "same dead token → skip");
  assert.equal(shouldSkipUsagePoll(gate401, fresh, 1_000), false, "token rotated → retry immediately");

  // 429 hold: skip until the retry deadline, then fetch — and a rotation still cuts it short early.
  const gate429 = { hash: dead, until: 10_000 };
  assert.equal(shouldSkipUsagePoll(gate429, dead, 5_000), true, "before deadline → skip");
  assert.equal(shouldSkipUsagePoll(gate429, dead, 10_000), false, "at deadline → fetch");
  assert.equal(shouldSkipUsagePoll(gate429, dead, 20_000), false, "past deadline → fetch");
  assert.equal(shouldSkipUsagePoll(gate429, fresh, 5_000), false, "rotation before deadline → fetch");
});

// ── makeReschedulingPoller — the single-chain force/reschedule mechanics behind /api/usage/refresh ──
// A deterministic fake-timer harness so the poller's timer bookkeeping is testable with no real clock:
// records armed timers by id, lets us count them and fire them by hand.
function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    set: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clear: (id) => void timers.delete(id),
    pending: () => timers.size,
    delays: () => [...timers.values()].map((t) => t.delay),
    fireAll: () => {
      for (const [id, t] of [...timers.entries()]) {
        timers.delete(id);
        t.fn();
      }
    },
  };
}
// Drain the microtask queue (the poller's cycle is async — one `await runOnce()` per tick). A real
// macrotask hop flushes pending microtasks regardless of the INJECTED fake timers above.
const flush = () => new Promise((r) => setImmediate(r));

test("makeReschedulingPoller runs one cycle on start and arms exactly one timer with the returned delay", async () => {
  const ft = fakeTimers();
  let runs = 0;
  const p = makeReschedulingPoller(async () => (runs++, 180_000), { setTimeoutFn: ft.set, clearTimeoutFn: ft.clear });
  p.start();
  await flush();
  assert.equal(runs, 1, "start fires one cycle immediately (mirrors the old `void poll()`)");
  assert.equal(ft.pending(), 1, "one timer armed for the next tick");
  assert.deepEqual(ft.delays(), [180_000], "the cycle's returned delay drives the next tick");
  ft.fireAll();
  await flush();
  assert.equal(runs, 2, "the scheduled tick ran the next cycle");
  assert.equal(ft.pending(), 1, "still exactly one timer — the chain never doubles");
});

test("a forced poll runs now and does NOT fork a second self-perpetuating chain (the central race)", async () => {
  const ft = fakeTimers();
  let runs = 0;
  const p = makeReschedulingPoller(async () => (runs++, 60_000), { setTimeoutFn: ft.set, clearTimeoutFn: ft.clear });
  p.start();
  await flush();
  assert.equal(runs, 1);
  assert.equal(ft.pending(), 1);
  p.force(); // the /api/usage/refresh path
  await flush();
  assert.equal(runs, 2, "force runs a cycle now");
  assert.equal(ft.pending(), 1, "the prior timer was CLEARED before rescheduling — not stacked into a second chain");
  // Fire the one armed timer a few rounds: a forked chain would show pending() > 1 or runs jumping by >1.
  ft.fireAll();
  await flush();
  ft.fireAll();
  await flush();
  assert.equal(runs, 4, "one cycle per tick — no double-polling");
  assert.equal(ft.pending(), 1, "invariant across ticks: exactly one armed timer");
});

test("a force during an in-flight cycle is COALESCED into a single re-run, never a concurrent run", async () => {
  const ft = fakeTimers();
  let runs = 0;
  let release = null;
  const p = makeReschedulingPoller(
    async () => {
      runs++;
      await new Promise((r) => (release = r)); // hold the cycle open until we let it finish
      return 90_000;
    },
    { setTimeoutFn: ft.set, clearTimeoutFn: ft.clear },
  );
  p.start();
  await flush();
  assert.equal(runs, 1, "first cycle started and is awaiting");
  const finishFirst = release;
  p.force();
  p.force(); // two forces mid-flight — both must coalesce onto ONE re-run
  await flush();
  assert.equal(runs, 1, "no concurrent cycle starts while one is in flight");
  finishFirst();
  await flush();
  assert.equal(runs, 2, "exactly ONE re-run after the in-flight cycle completes (the two forces coalesced)");
  release(); // let the coalesced re-run finish
  await flush();
  assert.equal(ft.pending(), 1, "settles to a single armed timer");
});

test("cancel drops the pending timer (hot re-eval / teardown leaves no orphan chain)", async () => {
  const ft = fakeTimers();
  const p = makeReschedulingPoller(async () => 180_000, { setTimeoutFn: ft.set, clearTimeoutFn: ft.clear });
  p.start();
  await flush();
  assert.equal(ft.pending(), 1);
  p.cancel();
  assert.equal(ft.pending(), 0, "no armed timer after cancel");
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
