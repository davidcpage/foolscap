// deriveGitStats unit tests (Github-feed thread work item 2) — the PURE per-file/per-commit derivation the
// git-stats producer (server-orchestration.ts startGitStatsFeed) runs over a `git log --reverse --numstat`
// dump. Kept pure (no fs/git/server-context) exactly so it can be exercised here against a FIXED dump: the
// totals/growth/churn are asserted to the number, and the degradation knobs (top-N dirs, downsampling, churn
// cap) are proven to raise their flags. Imports the .ts source under the app's tsx-less runner via the
// resolve hook (the board-engine.test.mjs pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { deriveGitStats, gitStatsRecentTail, writeFeedMirrorObject, feedMirrorRelPath } = await import(
  "../server-data-feeds.ts"
);

const RS = "\x1e";
const US = "\x1f";
// Build one commit block the way `git log --reverse --numstat --format=%x1e%H%x1f%an%x1f%ct%x1f%s` emits it:
// an RS-prefixed header line, git's blank line, then tab-separated `adds\tdels\tpath` numstat rows.
function commit(sha, author, sec, subject, rows) {
  return RS + [sha, author, String(sec), subject].join(US) + "\n\n" + rows.map((r) => r.join("\t")).join("\n") + "\n";
}

// Three commits: app grows then a rename; docs grows then is deleted back to net 0; a binary file ("-"/"-")
// and a rename (`app/{a.ts => b.ts}`) exercise the parse edges.
const DUMP =
  commit("aaaaaaa1000000000000000000000000000000a1", "Ada", 1000, "init", [
    ["10", "0", "app/a.ts"],
    ["5", "0", "docs/x.md"],
  ]) +
  commit("bbbbbbb2000000000000000000000000000000b2", "Grace", 2000, "work", [
    ["20", "3", "app/a.ts"],
    ["0", "5", "docs/x.md"],
    ["-", "-", "app/img.png"],
  ]) +
  commit("ccccccc3000000000000000000000000000000c3", "Lin", 3000, "rename", [
    ["4", "1", "app/{a.ts => b.ts}"],
  ]);

test("deriveGitStats: totals, dirs, cumulative growth, churn ordering — to the number", () => {
  const s = deriveGitStats(DUMP, "data:git-stats", 42);

  assert.equal(s.name, "data:git-stats");
  assert.equal(s.updatedAt, 42);

  // Totals: adds 10+5 + 20+0+0 + 4 = 39; dels 0 + 3+5+0 + 1 = 9; net 30; files {app/a.ts,docs/x.md,app/img.png,app/b.ts}=4.
  assert.deepEqual(s.totals, { commits: 3, adds: 39, dels: 9, net: 30, files: 4 });

  // Dirs ranked by final net LOC desc: app (net 30) before docs (net 0). No collapse (only 2 ≤ maxDirs).
  assert.deepEqual(s.dirs, ["app", "docs"]);
  assert.equal(s.truncated, false);
  assert.equal(s.downsampled, false);

  // Growth cumulative net LOC, index-aligned to dirs [app, docs], one sample per commit:
  //   after c1: app 10, docs 5 → after c2: app 27, docs 0 → after c3: app 30, docs 0
  assert.deepEqual(s.growth.t, [1000 * 1000, 2000 * 1000, 3000 * 1000]);
  assert.deepEqual(s.growth.cum, [
    [10, 5],
    [27, 0],
    [30, 0],
  ]);

  // Per-commit diff sizes, oldest→newest, short sha = first 7 chars.
  assert.deepEqual(s.commits, [
    { s: "aaaaaaa", a: 15, d: 0, t: 1000 * 1000 },
    { s: "bbbbbbb", a: 20, d: 8, t: 2000 * 1000 },
    { s: "ccccccc", a: 4, d: 1, t: 3000 * 1000 },
  ]);

  // Churn top files by adds+dels: app/a.ts 33, docs/x.md 10, app/b.ts 5 (the rename's NEW path), app/img.png 0.
  assert.deepEqual(
    s.churn.map((f) => [f.p, f.c]),
    [
      ["app/a.ts", 33],
      ["docs/x.md", 10],
      ["app/b.ts", 5],
      ["app/img.png", 0],
    ],
  );
});

test("deriveGitStats: degrades — top-N dirs roll into 'other', churn caps, growth downsamples (flags raised)", () => {
  // maxDirs 1 → keep app, fold docs into "other"; the "other" band still carries docs' cumulative net LOC.
  const rolled = deriveGitStats(DUMP, "data:git-stats", 0, { maxDirs: 1 });
  assert.deepEqual(rolled.dirs, ["app", "other"]);
  assert.equal(rolled.truncated, true);
  assert.deepEqual(rolled.growth.cum, [
    [10, 5],
    [27, 0],
    [30, 0],
  ]);

  // topFiles 2 → churn list capped, truncated raised (4 files > 2).
  const capped = deriveGitStats(DUMP, "data:git-stats", 0, { topFiles: 2 });
  assert.equal(capped.churn.length, 2);
  assert.equal(capped.truncated, true);

  // maxPoints 2 → 3 samples downsample to first+last, downsampled raised.
  const thin = deriveGitStats(DUMP, "data:git-stats", 0, { maxPoints: 2 });
  assert.equal(thin.growth.t.length, 2);
  assert.deepEqual(thin.growth.t, [1000 * 1000, 3000 * 1000]);
  assert.equal(thin.downsampled, true);

  // maxCommits 2 → the per-commit strip keeps the most-recent window, downsampled raised.
  const win = deriveGitStats(DUMP, "data:git-stats", 0, { maxCommits: 2 });
  assert.deepEqual(win.commits.map((c) => c.s), ["bbbbbbb", "ccccccc"]);
  assert.equal(win.downsampled, true);
});

test("deriveGitStats: empty / no-commit dump is inert (no throw, zeroed totals)", () => {
  const empty = deriveGitStats("", "data:git-stats", 0);
  assert.deepEqual(empty.totals, { commits: 0, adds: 0, dels: 0, net: 0, files: 0 });
  assert.deepEqual(empty.growth.t, []);
  assert.deepEqual(empty.churn, []);
  assert.equal(empty.downsampled, false);
});

test("writeFeedMirrorObject: writes the exact on-disk artifact the card reads back (compact, JSON-parseable)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitstats-mirror-"));
  try {
    const series = deriveGitStats(DUMP, "data:git-stats", 7);
    // The git-stats producer writes compact (pretty=false) so the full series stays under the /api/file cap.
    writeFeedMirrorObject(repo, "data:git-stats", series, false);
    const abs = path.join(repo, feedMirrorRelPath("data:git-stats"));
    assert.ok(fs.existsSync(abs), "mirror lands at .canvas/feeds/data-git-stats.json");
    const text = fs.readFileSync(abs, "utf8");
    assert.ok(!text.includes("\n  "), "compact write: no 2-space pretty indentation");
    const round = JSON.parse(text); // the card's dataFeedHistory does exactly this
    assert.deepEqual(round.totals, series.totals, "round-trips the derived totals");
    assert.deepEqual(round.dirs, series.dirs, "round-trips the dir list");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("gitStatsRecentTail: the bounded recent-commit events for the bus feed", () => {
  const s = deriveGitStats(DUMP, "data:git-stats", 0);
  const tail = gitStatsRecentTail(s, 2);
  assert.equal(tail.length, 2);
  assert.deepEqual(tail[tail.length - 1], { ts: 3000 * 1000, data: { shortSha: "ccccccc", adds: 4, dels: 1 } });
});
