#!/usr/bin/env node
// usage-rollup.js — roll up the Claude transcript usage records for this board's canvas-owned sessions.
// Backs `scripts/canvas usage` (docs/token-efficiency-review-2026-07-11.md §6.6). Read-only and
// dependency-free: it never posts to the bus, never writes a file — it exists so token regressions are
// VISIBLE (a heartbeat-gate change, a harness edit that breaks prefix-cache stability) instead of anecdotal.
//
// Sources, all under the board's `.canvas/` home + ~/.claude/projects:
//   • .canvas/sessions/<sid>.json — the ownership markers (session-ledger.js). The marker's `cwd` resolves
//     the transcript dir per session (worktree sessions live in per-cwd projects dirs — projectsDirForCwd
//     slugs BOTH "/" and "."); its `read` cursor keys back-fill thread membership.
//   • ~/.claude/projects/<slug>/<sid>.jsonl — the transcript. One API call writes ONE usage record but
//     often SEVERAL lines (one per content block, same message.id), so we dedupe by message id — summing
//     raw lines would overcount roughly 2×.
//   • .canvas/threads/<enc>.meta.json — thread rosters (thread-ledger.js), for the per-thread aggregation.
//
// A session can be a member of several threads; its usage counts ONCE in the corpus total but appears in
// EACH of its threads' rows (splitting it would invent precision the data doesn't have).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canvasSessionsDir, readCanvasSession, projectsDirForCwd } from "./session-ledger.js";
import { listThreads, threadMembersFromMeta } from "./thread-ledger.js";

/**
 * Sum one transcript's usage records. A "turn" here is one API call (one unique assistant message id) —
 * the unit a usage record describes. Tolerates a ragged/mid-write tail (unparseable lines are skipped, the
 * live-tail rule from CLAUDE.md), lines without usage, and synthetic assistant lines without a message id
 * (keyed by their line uuid instead so they can't collapse into each other).
 */
export function parseTranscriptUsage(text) {
  const totals = { turns: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  const models = {};
  const seen = new Set();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // ragged first line of a tail-truncated read, or a mid-write last line
    }
    if (d?.type !== "assistant") continue;
    const m = d.message;
    const u = m?.usage;
    if (!u || typeof u !== "object") continue;
    const key = m.id || d.requestId || d.uuid;
    if (key) {
      if (seen.has(key)) continue; // another content-block line of the same API call
      seen.add(key);
    }
    totals.turns += 1;
    totals.input += u.input_tokens || 0;
    totals.cacheCreation += u.cache_creation_input_tokens || 0;
    totals.cacheRead += u.cache_read_input_tokens || 0;
    totals.output += u.output_tokens || 0;
    if (m.model) models[m.model] = (models[m.model] || 0) + 1;
  }
  return { ...totals, models };
}

const zeroTotals = () => ({ sessions: 0, turns: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0 });

function addInto(agg, s) {
  agg.sessions += 1;
  agg.turns += s.turns;
  agg.input += s.input;
  agg.cacheCreation += s.cacheCreation;
  agg.cacheRead += s.cacheRead;
  agg.output += s.output;
}

/**
 * The full roll-up: every canvas-owned session (marker-driven, like listSessions — a terminal external has
 * no marker and is never counted; a marker whose transcript is gone is skipped, not zero-rowed), aggregated
 * per thread and over the whole corpus. `dirForCwd` is the same test seam session-ledger's listSessions
 * exposes (tests can't seed the real ~/.claude/projects).
 */
export function rollupUsage(repoPath, { dirForCwd = projectsDirForCwd } = {}) {
  // Thread rosters first: meta members are the authoritative sid→thread mapping; a marker's read-cursor
  // keys back-fill a membership the meta no longer lists (e.g. a member removed after the fact).
  const threadsById = new Map();
  for (const meta of listThreads(repoPath)) {
    const t = { id: meta.threadId, title: meta.title || "", lastTs: meta.lastTs ?? meta.createdAt ?? 0, ...zeroTotals() };
    threadsById.set(meta.threadId, { row: t, sids: new Set(threadMembersFromMeta(meta)) });
  }

  let names = [];
  try {
    names = fs.readdirSync(canvasSessionsDir(repoPath)).filter((n) => n.endsWith(".json"));
  } catch {
    /* no marker dir → nothing canvas-owned */
  }

  const sessions = [];
  for (const n of names) {
    const id = n.slice(0, -".json".length);
    const marker = readCanvasSession(repoPath, id) ?? {};
    const tdir = marker.cwd ? dirForCwd(marker.cwd) : dirForCwd(repoPath);
    const file = path.join(tdir, id + ".jsonl");
    let text, st;
    try {
      st = fs.statSync(file);
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // owned but no transcript on disk — nothing to roll up
    }
    const threads = new Set();
    for (const [tid, entry] of threadsById) if (entry.sids.has(id)) threads.add(tid);
    for (const tid of Object.keys(marker.read ?? {})) if (threadsById.has(tid)) threads.add(tid);
    sessions.push({
      id,
      cwd: marker.cwd || repoPath,
      threads: [...threads],
      mtime: st.mtimeMs,
      bytes: st.size,
      ...parseTranscriptUsage(text),
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);

  const total = zeroTotals();
  const totalModels = {};
  const unmapped = zeroTotals();
  for (const s of sessions) {
    addInto(total, s); // each session counts ONCE here, however many threads it's in
    for (const [model, turns] of Object.entries(s.models)) totalModels[model] = (totalModels[model] || 0) + turns;
    if (s.threads.length === 0) addInto(unmapped, s);
    for (const tid of s.threads) addInto(threadsById.get(tid).row, s);
  }

  const threads = [...threadsById.values()]
    .map((e) => e.row)
    .filter((t) => t.sessions > 0)
    .sort((a, b) => b.cacheCreation + b.cacheRead + b.output - (a.cacheCreation + a.cacheRead + a.output));

  return { sessions, threads, total: { ...total, models: totalModels }, unmapped };
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function trunc(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// The dominant model of a session, short form ("claude-opus-4-8" → "opus-4-8") — surfaced because a
// silent Fable→Opus fallback is exactly the kind of regression this roll-up exists to catch.
function shortModel(models) {
  const top = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
  if (!top) return "-";
  return top[0].replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

const line = (cols) => cols.join("  ");
const num = (n, w = 9) => fmt(n).padStart(w);

/** Render the roll-up as the human-readable report `scripts/canvas usage` prints. */
export function formatRollup(r, { limit = 30 } = {}) {
  const out = [];
  const t = r.total;
  out.push(
    `corpus: ${t.sessions} sessions, ${t.turns} turns — ` +
      `cache-write ${fmt(t.cacheCreation)}, cache-read ${fmt(t.cacheRead)}, output ${fmt(t.output)}, input ${fmt(t.input)}`
  );
  const models = Object.entries(t.models).sort((a, b) => b[1] - a[1]);
  if (models.length) out.push(`  by model: ${models.map(([m, n]) => `${m} ${n} turns`).join(" · ")}`);

  if (r.threads.length) {
    out.push("");
    out.push("per thread (a session in N threads counts in each row; the corpus line counts it once):");
    out.push(line(["  sess".padStart(6), "turns".padStart(6), "cache-wr".padStart(9), "cache-rd".padStart(9), "output".padStart(9), "thread"]));
    for (const th of r.threads) {
      out.push(
        line([
          String(th.sessions).padStart(6),
          String(th.turns).padStart(6),
          num(th.cacheCreation),
          num(th.cacheRead),
          num(th.output),
          `${th.id}  ${trunc(th.title, 48)}`,
        ])
      );
    }
    if (r.unmapped.sessions) {
      out.push(
        line([
          String(r.unmapped.sessions).padStart(6),
          String(r.unmapped.turns).padStart(6),
          num(r.unmapped.cacheCreation),
          num(r.unmapped.cacheRead),
          num(r.unmapped.output),
          "(no thread mapping)",
        ])
      );
    }
  }

  const shown = limit > 0 ? r.sessions.slice(0, limit) : r.sessions;
  out.push("");
  out.push(
    `per session (newest first${shown.length < r.sessions.length ? `; showing ${shown.length} of ${r.sessions.length} — pass --limit 0 for all` : ""}):`
  );
  out.push(line(["turns".padStart(5), "cache-wr".padStart(9), "cache-rd".padStart(9), "output".padStart(9), "model".padEnd(14), "session / threads"]));
  for (const s of shown) {
    const threads = s.threads.length ? s.threads.map((tid) => tid.split(":").pop()).join(",") : "-";
    out.push(
      line([
        String(s.turns).padStart(5),
        num(s.cacheCreation),
        num(s.cacheRead),
        num(s.output),
        shortModel(s.models).padEnd(14),
        `${s.id.slice(0, 8)}  [${threads}]`,
      ])
    );
  }
  return out.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  let repo = null;
  let json = false;
  let limit = 30;
  let thread = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i];
    else if (a === "--json") json = true;
    else if (a === "--limit") limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--thread") thread = argv[++i];
    else {
      process.stderr.write(`usage-rollup: unknown arg "${a}" (--repo PATH [--thread ID] [--limit N] [--json])\n`);
      process.exit(2);
    }
  }
  if (!repo) {
    process.stderr.write("usage-rollup: --repo <boardRoot> required (the checkout holding .canvas/)\n");
    process.exit(2);
  }
  let r = rollupUsage(repo);
  if (thread) {
    // Narrow to one thread: its sessions only, its row only; the "corpus" line becomes that slice's total.
    const sessions = r.sessions.filter((s) => s.threads.includes(thread));
    const total = zeroTotals();
    const models = {};
    for (const s of sessions) {
      addInto(total, s);
      for (const [m, n] of Object.entries(s.models)) models[m] = (models[m] || 0) + n;
    }
    r = { sessions, threads: r.threads.filter((t) => t.id === thread), total: { ...total, models }, unmapped: zeroTotals() };
  }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else process.stdout.write(formatRollup(r, { limit }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
