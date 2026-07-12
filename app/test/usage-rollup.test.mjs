// The usage roll-up behind `scripts/canvas usage`: transcript usage records deduped per API call,
// aggregated per session / per thread / corpus-wide off the .canvas markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTranscriptUsage, rollupUsage, formatRollup } from "../usage-rollup.js";
import { markCanvasSession } from "../session-ledger.js";

// One transcript line for an assistant API call: `id` is the message id shared by every content-block
// line of the same call; `u` is the usage payload.
function aline(id, u, extra = {}) {
  return JSON.stringify({ type: "assistant", message: { id, usage: u, model: extra.model }, ...extra });
}
const usage = (cc, cr, out, inp = 1) => ({
  input_tokens: inp,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr,
  output_tokens: out,
});

test("parseTranscriptUsage dedupes the per-content-block lines of one API call", () => {
  // One call written as three lines (same message id, identical usage) + a second distinct call.
  const text = [
    aline("msg_1", usage(100, 200, 10)),
    aline("msg_1", usage(100, 200, 10)),
    aline("msg_1", usage(100, 200, 10)),
    aline("msg_2", usage(5, 300, 20)),
  ].join("\n");
  const r = parseTranscriptUsage(text);
  assert.equal(r.turns, 2, "two API calls, not four lines");
  assert.equal(r.cacheCreation, 105);
  assert.equal(r.cacheRead, 500);
  assert.equal(r.output, 30);
  assert.equal(r.input, 2);
});

test("parseTranscriptUsage skips non-assistant lines, malformed tails, and usage-less records", () => {
  const text = [
    '{"type":"user","message":{"role":"user"}}',
    '{"type":"queue-operation"}',
    "not json at all — the ragged first line of a tail read",
    '{"type":"assistant","message":{"id":"m_no_usage"}}',
    aline("m_ok", usage(7, 8, 9)),
    '{"type":"assistant","mid-write trunca', // a live transcript's last line
  ].join("\n");
  const r = parseTranscriptUsage(text);
  assert.equal(r.turns, 1);
  assert.deepEqual([r.cacheCreation, r.cacheRead, r.output], [7, 8, 9]);
});

test("parseTranscriptUsage counts per-model turns", () => {
  const text = [
    aline("m1", usage(1, 1, 1), { model: "claude-fable-5" }),
    aline("m2", usage(1, 1, 1), { model: "claude-opus-4-8" }),
    aline("m3", usage(1, 1, 1), { model: "claude-opus-4-8" }),
  ].join("\n");
  assert.deepEqual(parseTranscriptUsage(text).models, { "claude-fable-5": 1, "claude-opus-4-8": 2 });
});

// ── the full roll-up over a fixture board ──────────────────────────────────────────────────────────

const THREAD = "node:thread:aaaa1111";
const OTHER = "node:thread:bbbb2222";

// A fixture board: two thread metas, three owned sessions (one worktree-cwd'd, one mapped only via its
// marker's read cursor, one unmapped), one marker without a transcript, one external transcript.
function fixtureBoard() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-txn-root-"));
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-txn-wt-"));
  const wtCwd = path.join(repo, ".canvas", "worktrees", "w1");

  const threadsDir = path.join(repo, ".canvas", "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(threadsDir, encodeURIComponent(THREAD) + ".meta.json"),
    JSON.stringify({ threadId: THREAD, title: "Fixture thread", lastTs: 2, members: { "sess-a": { joinedAt: 1 }, "sess-b": { joinedAt: 2 } } })
  );
  fs.writeFileSync(
    path.join(threadsDir, encodeURIComponent(OTHER) + ".meta.json"),
    JSON.stringify({ threadId: OTHER, title: "Other thread", lastTs: 1, members: {} })
  );

  // sess-a: board-root session (no cwd on the marker), member of THREAD. Two API calls.
  markCanvasSession(repo, "sess-a", { spawnedAt: 1 });
  fs.writeFileSync(path.join(rootDir, "sess-a.jsonl"), [aline("a1", usage(10, 100, 1)), aline("a2", usage(20, 200, 2))].join("\n"));
  // sess-b: worktree session (marker cwd → a DIFFERENT projects dir), member of THREAD.
  markCanvasSession(repo, "sess-b", { spawnedAt: 2, cwd: wtCwd });
  fs.writeFileSync(path.join(wtDir, "sess-b.jsonl"), aline("b1", usage(1000, 5000, 50)));
  // sess-c: not on any meta roster, but its read cursor names OTHER — the back-fill mapping.
  markCanvasSession(repo, "sess-c", { spawnedAt: 3, read: { [OTHER]: 7 } });
  fs.writeFileSync(path.join(rootDir, "sess-c.jsonl"), aline("c1", usage(5, 5, 5)));
  // sess-d: unmapped (no roster entry, no read cursor).
  markCanvasSession(repo, "sess-d", { spawnedAt: 4 });
  fs.writeFileSync(path.join(rootDir, "sess-d.jsonl"), aline("d1", usage(3, 3, 3)));
  // sess-gone: owned but its transcript was deleted — skipped, not zero-rowed.
  markCanvasSession(repo, "sess-gone", { spawnedAt: 5 });
  // external.jsonl: a terminal session with no marker — never counted.
  fs.writeFileSync(path.join(rootDir, "external.jsonl"), aline("x1", usage(9999, 9999, 9999)));

  const dirForCwd = (cwd) => (cwd === wtCwd ? wtDir : rootDir);
  return { repo, dirForCwd };
}

test("rollupUsage: marker-driven corpus, per-cwd transcript dirs, thread + read-cursor mapping", () => {
  const { repo, dirForCwd } = fixtureBoard();
  const r = rollupUsage(repo, { dirForCwd });

  assert.deepEqual(new Set(r.sessions.map((s) => s.id)), new Set(["sess-a", "sess-b", "sess-c", "sess-d"]));

  const byId = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
  assert.equal(byId["sess-a"].turns, 2);
  assert.deepEqual(byId["sess-a"].threads, [THREAD], "roster membership maps the session to its thread");
  assert.deepEqual(byId["sess-b"].threads, [THREAD], "worktree session found via its marker cwd");
  assert.equal(byId["sess-b"].cacheCreation, 1000);
  assert.deepEqual(byId["sess-c"].threads, [OTHER], "read-cursor keys back-fill a missing roster entry");
  assert.deepEqual(byId["sess-d"].threads, [], "no mapping recoverable");

  // Corpus total: every owned+present session once; the external and the transcript-less marker never appear.
  assert.equal(r.total.sessions, 4);
  assert.equal(r.total.turns, 5);
  assert.equal(r.total.cacheCreation, 10 + 20 + 1000 + 5 + 3);
  assert.equal(r.total.cacheRead, 100 + 200 + 5000 + 5 + 3);
  assert.equal(r.total.output, 1 + 2 + 50 + 5 + 3);

  // Per-thread rows aggregate their member sessions; unmapped is its own bucket.
  const threads = Object.fromEntries(r.threads.map((t) => [t.id, t]));
  assert.equal(threads[THREAD].sessions, 2);
  assert.equal(threads[THREAD].turns, 3);
  assert.equal(threads[THREAD].cacheCreation, 1030);
  assert.equal(threads[OTHER].sessions, 1);
  assert.equal(r.unmapped.sessions, 1);
  assert.equal(r.unmapped.cacheCreation, 3);
});

test("rollupUsage on an empty repo returns an empty roll-up (no marker dir yet)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-empty-"));
  const r = rollupUsage(repo, { dirForCwd: () => repo });
  assert.deepEqual(r.sessions, []);
  assert.equal(r.total.sessions, 0);
});

test("formatRollup renders totals, thread rows, and an explicit shown-of-total cap line", () => {
  const { repo, dirForCwd } = fixtureBoard();
  const r = rollupUsage(repo, { dirForCwd });
  const text = formatRollup(r, { limit: 2 });
  assert.match(text, /corpus: 4 sessions, 5 turns/);
  assert.match(text, /Fixture thread/);
  assert.match(text, /\(no thread mapping\)/, "the unmapped bucket is surfaced, not dropped");
  assert.match(text, /showing 2 of 4 — pass --limit 0 for all/, "a cap always announces itself");
  assert.doesNotMatch(text, /sess-gone/);
  const full = formatRollup(r, { limit: 0 });
  assert.match(full, /sess-d/, "--limit 0 renders every session");
});
