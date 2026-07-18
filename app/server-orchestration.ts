import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import chokidar from "chokidar";
import { getServerContext, getShadowRoots, getWsClients } from "./server-context.js";
import { commitRoot, watchRoot } from "./shadow-git.js";
import { isInternalPath } from "./server-fs.js";
import { autoWakeReapTick, reconcileSessionBands, resolveClaudeCommand } from "./server-sessions.js";
import { canvasThreadsDir, fillSeat, listThreads, readThreadMeta, releaseSeat, seatForSid, threadIntentForSid, threadMembersFromMeta, type ThreadMetaMarker } from "./thread-ledger.js";
import { canvasRolesDir, readRole } from "./role-ledger.js";
import { dueJobs, jobClaimKey, jobDueWithInterval, planRoleJobFire, readJobs, removeJob, stampFired, upsertJob } from "./standing-jobs.js";
import { COORDINATOR_ROLE, coordinatorHeartbeatJobSpec, heartbeatEffectiveInterval, heartbeatSweepSignature } from "./coordinator-heartbeat.js";
import { docJobClaimKey, listDocsWithJobs, readDocJobs, stampDocFired } from "./doc-jobs.js";
import { readWatchers } from "./doc-watch.js";
import { listWorktrees, removeWorktree, realpath as wtRealpath } from "./worktrees.js";
import { docSurfaceKey, isSurfaceClaimed, qualifyingWatchers, releaseSurface, seatSurfaceKey, shouldDetachDoneIntent, shouldDetachDoneMember, surfaceClaimant } from "./auto-wake.js";
import { readCanvasSession } from "./session-ledger.js";
import { CARD_TYPES_DIR } from "./server-fs.js";
import type { LiveSession } from "./server-types.js";
import {
  foldDataFeedEvent,
  foldDataFeedSnapshot,
  writeFeedMirror,
  type DataFeedEvent,
  type DataFeedValue,
} from "./server-data-feeds.js";
import {
  CLAUDE_USAGE_MAX_BACKOFF_MS,
  CLAUDE_USAGE_POLL_MS,
  claudeRateLimitDelay,
  mergeUsageProvider,
  purgeCachedEmail,
  readUsageCache,
  retryAfterMs,
  shouldSkipUsagePoll,
  tokenFingerprint,
  usageCachePath,
  writeUsageCache,
} from "./usage-feed-state.js";

// ── the orchestration ENGINE: feeds + heartbeat/standing-jobs + shadow-git committer (P5 sub-step 3) ──
// The third ENGINE module of the P5 god-file split (after server-delivery.ts and server-sessions.ts). It
// owns the STATEFUL, timer-driven orchestration the shell used to define inline: the off-log feed bus
// (publishFeed + the per-board / global feed SOURCES that poll or watch and push onto it), the operating-
// loop heartbeat and standing-jobs firing loop (the server-fired half of the wakeable substrate), and the
// shadow-git committer (per-root work-tree watcher + editor-tool attribution fold). It reaches the shared
// cross-request state (the fsState feed/shadow maps, the board/live-session registries, the spawn/process
// ops) THROUGH getServerContext() — the same pinned singletons the shell holds, injected once via
// setServerContext at plugin load. server-context.ts stays type-imports only, so importing the accessor
// (a value) here is not a runtime cycle; only TYPES come from vite-fs-plugin. Each moved function is
// byte-identical to its former shell definition save for a getServerContext()/binding preamble at its top.
//
// Board IDENTITY/registry/ROOTS resolution (boardIdentity/reqBoard/rootDir/boardRoots + the boards map and
// its module-load boot side-effects), the feed STARTUP WIRING (startBoardFeeds/startFeeds/startWorktreesFeed),
// the WS transport, and the inline route handlers stay in the shell (routing/identity infra); they reach the
// feed SOURCES + shadow committer + heartbeat here by importing them, and reach board/root resolution back the
// other way via getServerContext() (all still ctx ops), so there is no runtime import cycle.

export function publishFeed(feed: string, value: unknown): void {
  const { fsState } = getServerContext();
  const { feedClients, feedValues } = fsState;
  const wsClients = getWsClients(fsState);
  feedValues.set(feed, value);
  const frame = `data: ${JSON.stringify({ feed, value })}\n\n`;
  for (const c of feedClients) c.res.write(frame);
  for (const c of wsClients) c.send({ ch: "feed", feed, value });
}

// A cheap "something in this directory changed" ping via NATIVE fs.watch — deliberately NOT chokidar.
// chokidar v4 (no fsevents) holds one kqueue fd per watched FILE on macOS, so pointing it at an ever-
// growing dir (`~/.claude/projects/<slug>/` gains a transcript per session ever run) held one fd per
// HISTORICAL file forever (~460 when fd exhaustion crashed the server, 2026-07-10). Native fs.watch is
// O(1) fds per dir (FSEvents on macOS, inotify on Linux), and its famously-unreliable event DETAIL (an
// append can report as "rename", filenames may be absent) is irrelevant here: every consumer below is a
// debounced refetch ping that ignores the arguments. Don't reach for this where a watcher must NAME the
// changed path or classify add/change/unlink — that's what chokidar's per-file fds buy (see CLAUDE.md's
// pointer at shadow-git.js / openRootWatcher).
// mkdir-first because fs.watch throws on a missing dir (markers/threads/roles are lazily created); the
// "error" listener is LOAD-BEARING — an FSWatcher error (e.g. the dir deleted under it) with no listener
// is an uncaught exception, and this process has already died once to an uncaught throw in a feed.
function watchDirPing(dir: string, onEvent: () => void, opts: { recursive?: boolean } = {}): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, { recursive: opts.recursive === true }, onEvent).on("error", (err) => {
      console.warn(`[feeds] dir watch lost on ${dir} (feed goes quiet until restart): ${String(err)}`);
    });
  } catch (err) {
    console.warn(`[feeds] dir watch failed for ${dir} (feed will not push): ${String(err)}`);
  }
}

// ── sessions-list feed (the sessions browser card's live push) — pings on transcript + marker churn ──
export function startSessionsFeed(boardId: string, dir: string, markersDir: string): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  const ping = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("sessions:" + boardId, { ts: Date.now() }), 200);
  };
  watchDirPing(dir, ping);
  watchDirPing(markersDir, ping);
}

// ── threads-list feed (the threads browser card's live push) ─────────────────────────────────────
export function startThreadsFeed(boardId: string, repoPath: string): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  watchDirPing(canvasThreadsDir(repoPath), () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("threads:" + boardId, { ts: Date.now() }), 200);
  });
}

// ── roles-list feed (the roles browser card's live push) ─────────────────────────────────────────
export function startRolesFeed(boardId: string, repoPath: string): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  // recursive: a role's charter lives one level down (`.canvas/roles/<id>/role.md`), and a charter edit
  // must ping the list (the old chokidar watch was depth: 1 for the same reason).
  watchDirPing(canvasRolesDir(repoPath), () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("roles:" + boardId, { ts: Date.now() }), 200);
  }, { recursive: true });
}

// Feed: the repo's HEAD commit. chokidar on .git/HEAD (branch switches) + .git/logs/HEAD (every
// commit/amend/pull — the reflog is the one file that always moves); on either, ask git for the
// tip. The walk/watch above EXCLUDE .git wholesale, so this is its own deliberate watch — the
// file-card pipeline and the commit feed stay separate ingest paths.
export function startGitHeadFeed(boardId: string, repo: string): void {
  const feed = "githead:" + boardId;
  const read = () => {
    try {
      execFile(
        "git",
        ["log", "-1", "--format=%H%x1f%an%x1f%ct%x1f%s"],
        { cwd: repo },
        (err, stdout) => {
          if (err) return; // e.g. empty repo — keep the previous value
          const [sha, author, ct, message] = stdout.trim().split("\x1f");
          if (sha) publishFeed(feed, { sha, author, message, ts: Number(ct) * 1000 });
        },
      );
    } catch (err) {
      // execFile throws SYNCHRONOUSLY (not via the callback) when the child can't even be forked — pipe
      // creation fails once the process fd table is full (EBADF/EMFILE). Uncaught in this timer it killed
      // the whole dev server (2026-07-10). This catch is deliberately NARROW and NOISY, not defensive
      // padding: the feed degrades to a stale HEAD chip, but a firing here means the process is almost
      // certainly leaking fds — the count below is the first diagnostic. Investigate; don't ignore.
      let fds = "?";
      try {
        fds = String(fs.readdirSync("/dev/fd").length); // itself needs an fd — may fail at true exhaustion
      } catch { /* leave "?" */ }
      console.error(
        `[githead] git spawn threw (${String(err)}) — likely fd exhaustion (process holds ${fds} fds); ` +
          `HEAD feed for ${repo} goes stale. This crashed the server once — find the leak.`,
      );
    }
  };

  let t: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (t) clearTimeout(t);
    t = setTimeout(read, 150); // a commit touches several .git files; coalesce to one read
  };
  chokidar
    .watch([path.join(repo, ".git/HEAD"), path.join(repo, ".git/logs/HEAD")], { ignoreInitial: true })
    .on("all", debounced);
  read();
}

// ── the generic `data:*` feed namespace (Github-feed thread, stage 2) ───────────────────────────────
// The server side of the data-feed primitive: publish a byte-bounded value onto the off-log bus AND mirror
// it to `.canvas/feeds/<name>.json` (so a reactive-notebook cell consumes it over the file-watch), in one
// place so every producer — the git-log source below, the `POST /api/feed/<name>` route — folds identically.
// The feed KEY is board-suffixed (`data:<name>:<boardId>`) so two boards' same-named feeds stay disjoint and
// the `dataFeed` capability (boardFeedSignal-shaped) reads exactly this board's; the mirror FILE is already
// board-scoped by living under that board's own `.canvas/`, so it keeps the bare `data:*` name.
function publishDataFeed(boardId: string, repo: string, value: DataFeedValue): void {
  publishFeed(value.name + ":" + boardId, value);
  writeFeedMirror(repo, value.name, value);
}

// APPEND one producer event to a `data:*` feed and publish+mirror the new tail. The route handler's one
// call; returns the folded value so the route can echo its size/truncation. `data` is the caller's payload.
export function appendDataFeed(boardId: string, repo: string, name: string, data: unknown): DataFeedValue {
  const event: DataFeedEvent = { ts: Date.now(), data };
  const value = foldDataFeedEvent(name + ":" + boardId, name, event);
  publishDataFeed(boardId, repo, value);
  return value;
}

// Feed: the board repo's recent commit log, published under the `data:*` namespace as the stage-1 proof of
// the generic primitive. Clones startGitHeadFeed's shape — chokidar on .git/HEAD + .git/logs/HEAD (the reflog
// moves on every commit/amend/pull), debounced, ASYNC execFile with the SAME narrow-and-noisy fd-exhaustion
// catch (a sync throw here crashed the dev server once, 2026-07-10). Each HEAD change re-reads the window
// (git log isn't incremental) and publishes a SNAPSHOT: `-n 51` so we can tell "there is older history" (the
// 51st row) from "that's the whole repo", then keep the newest 50 as the byte-bounded tail. Commits are
// stored oldest→newest (the tail idiom keeps the recent ones); the card renders newest-first.
export function startGitLogFeed(boardId: string, repo: string): void {
  const name = "data:git-log";
  const feedKey = name + ":" + boardId;
  const WINDOW = 50;
  const read = () => {
    try {
      execFile(
        "git",
        ["log", "-n", String(WINDOW + 1), "--format=%H%x1f%an%x1f%ct%x1f%s"],
        { cwd: repo },
        (err, stdout) => {
          if (err) return; // empty repo / not a repo — keep the previous value
          const lines = stdout.trim() ? stdout.trim().split("\n") : [];
          const older = lines.length > WINDOW; // a 51st row ⇒ history extends past the window
          // newest-first from git → reverse to oldest→newest so the byte-bounded TAIL keeps the recent ones
          const events: DataFeedEvent[] = lines
            .slice(0, WINDOW)
            .map((line) => {
              const [sha, author, ct, message] = line.split("\x1f");
              return { ts: Number(ct) * 1000, data: { sha, shortSha: sha.slice(0, 7), author, message } };
            })
            .reverse();
          const value = foldDataFeedSnapshot(feedKey, name, events, older, Date.now());
          publishDataFeed(boardId, repo, value);
        },
      );
    } catch (err) {
      // execFile throws SYNCHRONOUSLY when the child can't be forked (EBADF/EMFILE at fd exhaustion) —
      // the same crash startGitHeadFeed guards. Narrow + noisy: the feed degrades to stale, but a firing
      // here means the process is leaking fds. Investigate; don't ignore.
      let fds = "?";
      try {
        fds = String(fs.readdirSync("/dev/fd").length);
      } catch { /* leave "?" */ }
      console.error(
        `[git-log] git spawn threw (${String(err)}) — likely fd exhaustion (process holds ${fds} fds); ` +
          `git-log feed for ${repo} goes stale. This failure mode crashed the server once — find the leak.`,
      );
    }
  };

  let t: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (t) clearTimeout(t);
    t = setTimeout(read, 150); // a commit touches several .git files; coalesce to one read
  };
  chokidar
    .watch([path.join(repo, ".git/HEAD"), path.join(repo, ".git/logs/HEAD")], { ignoreInitial: true })
    .on("all", debounced);
  read();
}

// Feed: one true-internet source for flavour — the current Hacker News #1 story (keyless API).
// Polled server-side so the browser stays a pure SSE consumer like every other feed.
export function startHnFeed(): void {
  const poll = async () => {
    try {
      const ids = (await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json()) as number[];
      const item = (await (
        await fetch(`https://hacker-news.firebaseio.com/v0/item/${ids[0]}.json`)
      ).json()) as { id: number; title: string; by: string; score: number };
      publishFeed("hn", { id: item.id, title: item.title, by: item.by, score: item.score });
    } catch {
      // offline / rate-limited — keep the previous value; the card just stops advancing
    }
  };
  void poll();
  setInterval(poll, 90_000);
}

// ── usage feed (the canvas mirror of Claude Code's /usage) ──────────────────────────────────────
// See the shell's historical note: a FREE, rate-bounded metering poll of Anthropic's OAuth usage endpoint,
// republished as the off-log `usage` feed. The token stays server-side (Authorization header only).

// Read the OAuth access token the way the CLI stores it: the macOS keychain item
// "Claude Code-credentials" (a JSON blob), falling back to ~/.claude/.credentials.json. Re-read every
// poll (not cached) so when Claude Code refreshes the token in place we transparently pick up the new
// one — the pragmatic alternative to reimplementing the OAuth refresh flow here. null ⇒ not logged in.
function readClaudeOAuthToken(): Promise<string | null> {
  const fromBlob = (raw: string): string | null => {
    try {
      const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      return typeof t === "string" && t ? t : null;
    } catch {
      return null;
    }
  };
  const fromFile = (): string | null => {
    try {
      return fromBlob(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
    } catch {
      return null;
    }
  };
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      (err, stdout) => resolve((!err && fromBlob(stdout.trim())) || fromFile()),
    );
  });
}

// The required `claude-code/<version>` User-Agent. Resolve the executable through the SAME GUI-safe
// discovery as session spawning (explicit override, reduced PATH, and home-directory fallbacks).
let claudeUA: string | null = null;
export function claudeUserAgent(): Promise<string> {
  if (claudeUA) return Promise.resolve(claudeUA);
  return new Promise((resolve) => {
    let command: string;
    try {
      command = resolveClaudeCommand();
    } catch {
      return resolve((claudeUA = "claude-code/2.0.0"));
    }
    execFile(command, ["--version"], (err, stdout) => {
      const v = (!err && stdout.match(/\d+\.\d+\.\d+/)?.[0]) || "2.0.0";
      resolve((claudeUA = `claude-code/${v}`));
    });
  });
}

export function startUsageFeed(): void {
  const context = getServerContext();
  const { feedValues } = context.fsState;
  const repoPath = context.boards.get(context.defaultBoardId)?.repoPath;
  const cacheFile = repoPath ? usageCachePath(repoPath) : null;
  // Privacy migration (finding 4): purge an account email a prior build persisted into the versioned cache
  // BEFORE anything reads/republishes it. Only rewrites if an email was actually present.
  if (cacheFile) purgeCachedEmail(cacheFile);
  const cached = cacheFile ? readUsageCache(cacheFile) : null;
  if (cached && !feedValues.has("usage")) publishFeed("usage", cached);
  const envelope = () => (feedValues.get("usage") as any) ?? { schema: 2, providers: {} };
  const provider = (name: string) => envelope()?.providers?.[name] ?? {};
  const publishProvider = (name: string, value: Record<string, unknown>, persist = false) => {
    const next = mergeUsageProvider(envelope(), name, value);
    publishFeed("usage", next);
    if (persist && cacheFile) writeUsageCache(cacheFile, next);
  };

  let backoff = 0; // extra ms added after a 429, cleared on the next success
  // The blocking gate (see shouldSkipUsagePoll): set on a 401 (dead token, held until the keychain
  // token changes) or a 429 (rate-limited, held until the capped retry deadline). While it holds, we
  // wake at BASE cadence but skip the upstream fetch — so we stop hammering a dead token / an abusive
  // Retry-After, yet a token refresh mid-hold fires a prompt retry instead of waiting the sleep out.
  let gate: { hash: string | null; until: number } | null = null;
  const pollClaude = async () => {
    let nextDelay = CLAUDE_USAGE_POLL_MS;
    try {
      const token = await readClaudeOAuthToken();
      if (!token) {
        gate = null;
        backoff = 0;
        publishProvider("claude", {
          ...provider("claude"), provider: "claude", billing: "anthropic-plan",
          error: "no-credentials", fetchedAt: Date.now(),
        });
      } else {
        const hash = tokenFingerprint(token);
        if (shouldSkipUsagePoll(gate, hash)) {
          // Same failing token, still inside the hold window — keep the last published state (its
          // retryAt still shows the scheduled retry) and just re-check the local token at base cadence.
          setTimeout(pollClaude, CLAUDE_USAGE_POLL_MS);
          return;
        }
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": await claudeUserAgent(),
            "Content-Type": "application/json",
          },
        });
        if (res.status === 429) {
          // Keep last-good windows; obey Retry-After + our exponential floor, but CAPPED (15 min) so an
          // abusive Retry-After can't freeze the card for an hour. Hold this token until that deadline,
          // but keep waking at base cadence to catch a token refresh (retry immediately when it lands).
          const retry = retryAfterMs(res.headers.get("retry-after"));
          ({ backoff, delay: nextDelay } = claudeRateLimitDelay(backoff, retry));
          const retryAt = Date.now() + nextDelay;
          gate = { hash, until: retryAt };
          publishProvider("claude", {
            ...provider("claude"), provider: "claude", billing: "anthropic-plan",
            error: "rate-limited", retryAt, fetchedAt: Date.now(),
          });
          setTimeout(pollClaude, Math.min(CLAUDE_USAGE_POLL_MS, nextDelay));
          return;
        } else if (res.status === 401) {
          // Dead token — stop hammering (that hammering is what earns the abuse-429). Hold until the
          // keychain token changes; a Claude Code re-login then triggers an immediate retry.
          gate = { hash, until: Number.POSITIVE_INFINITY };
          publishProvider("claude", {
            ...provider("claude"), provider: "claude", billing: "anthropic-plan",
            error: "http-401", fetchedAt: Date.now(),
          });
        } else if (!res.ok) {
          // The endpoint changed or is down — a transient server-side fault, not a credential problem,
          // so don't gate: keep polling at base cadence.
          gate = null;
          publishProvider("claude", {
            ...provider("claude"), provider: "claude", billing: "anthropic-plan",
            error: `http-${res.status}`, fetchedAt: Date.now(),
          });
        } else {
          gate = null;
          backoff = 0;
          const data = (await res.json()) as Record<string, unknown>;
          publishProvider("claude", {
            provider: "claude", billing: "anthropic-plan", ...data,
            error: null, retryAt: null, fetchedAt: Date.now(),
          }, true);
        }
      }
    } catch {
      gate = null; // a network fault, not a credential/rate problem — retry normally
      publishProvider("claude", {
        ...provider("claude"), provider: "claude", billing: "anthropic-plan",
        error: "offline", fetchedAt: Date.now(),
      });
    }
    setTimeout(pollClaude, nextDelay); // recursive (not setInterval) so backoff can stretch the gap
  };

  const CODEX_USAGE_POLL_MS = 60_000;
  let codexBackoff = 0; // exponential backoff after a live-runtime usage failure, cleared on success
  const pollCodex = async () => {
    let nextDelay = CODEX_USAGE_POLL_MS;
    const client = getServerContext().fsState.hostClient;
    if (!client) {
      // attachSessionHost starts just after feeds; retry promptly without re-polling Anthropic.
      nextDelay = 2_000;
    } else {
      try {
        // PROBE, don't instantiate (finding 5): report Codex usage only when a runtime is already up
        // (someone spawned a Codex session this boot). A codex-less box then never boots app-server /
        // refreshes the OpenAI token from this poll. null ⇒ no live runtime → leave the last-known value
        // and just re-poll at the base cadence; nothing to publish or persist.
        const value = await client.codexUsage({ probe: true });
        if (value) {
          codexBackoff = 0;
          publishProvider("codex", value as Record<string, unknown>, true);
        }
      } catch (err) {
        // A live runtime that fails to report: back off exponentially (mirroring the Claude poll's floor)
        // so a wedged app-server isn't hammered every 60s.
        codexBackoff = Math.min(codexBackoff ? codexBackoff * 2 : CODEX_USAGE_POLL_MS, CLAUDE_USAGE_MAX_BACKOFF_MS);
        nextDelay = CODEX_USAGE_POLL_MS + codexBackoff;
        publishProvider("codex", {
          ...provider("codex"), provider: "codex", billing: "chatgpt-plan",
          error: err instanceof Error ? err.message : String(err), retryAt: Date.now() + nextDelay, fetchedAt: Date.now(),
        });
      }
    }
    setTimeout(pollCodex, nextDelay);
  };
  void pollClaude();
  void pollCodex();
}

// ── card types WATCH feed (a template edit on disk pings the client, whose registry re-imports) ──────
export function startCardTypesFeed(): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  chokidar.watch(CARD_TYPES_DIR, { ignoreInitial: true }).on("all", (_ev, abs) => {
    pending = path.relative(CARD_TYPES_DIR, abs);
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("cardtypes", { path: pending, ts: Date.now() }), 100);
  });
}

// ── operating-loop heartbeat (agent-roles.md) ────────────────────────────────────────────────────
// The Coordinator heartbeat has been RETIRED as a bespoke loop and CONVERGED onto the general STANDING-JOB
// machinery (R6/W6): standingJobsTick fires it, and under TIMERS-NUDGE-NEVER-SPAWN only NUDGES a live+idle
// Coordinator (never respawns a dormant seat). One driver, no fork. Enabling the job is the human-gated
// AUTONOMY SWITCH. The `loops` role flag survives only as legibility (the calm `scheduled` band).
const LOOP_TICK_MS = 15_000; // scheduler granularity — how often loopTick evaluates due jobs / reaps idle workers

// P5 done-member detach grace window: how long after a session ends cleanly (endReason:"done") before it is
// dropped from its threads' durable rosters and its card auto-closes. A tunable constant, kept generous so a
// just-finished card doesn't vanish out from under a human still reading it. Composes AFTER the reaper's
// IDLE_KEEPALIVE_MS (server-sessions): a worker declares done → parks → reaper ends it (endReason:"done")
// after 15m → this sweep detaches it 2m later.
const DETACH_DELAY_MS = 2 * 60_000;

// One scheduler tick: reap idle auto-wake workers and fire due standing jobs. Both iterate their own records;
// neither interrupts a RUNNING session (a mid-turn target is skipped and retried next tick).
function loopTick(): void {
  autoWakeReapTick(); // P2/W5: wind down auto-wake workers idle past the keep-alive window (own iteration)
  detachDoneMembersTick(); // P5: drop done sessions from their threads' durable rosters (+ release seat) after
  //                          the grace window — pills clear; the client reconciler best-effort closes the card
  reapPendingWorktreesTick(); // BUG-8: remove worktrees whose teardown was deferred (a live session was cwd-ed
  //                              in them) once the occupant has exited — no false "crashed" band, no leak
  standingJobsTick(); // R6/W6: fire the standing jobs that have come due (own iteration over the markers) —
  //                     this is now the SOLE heartbeat driver, incl. the migrated Coordinator heartbeat
  reconcileSessionBands(); // mrcmofwf-10: republish any session whose live band has drifted from its last
  //                          push — the catch-all for out-of-band transitions the instant paths don't cover.
}

// P5 — the done-member DETACH sweep. Board-wide over every thread's DURABLE member roster: a member gets its
// membership dropped (forgetDurableMember — marker AND the in-memory durableMembers mirror) and any seat
// released (releaseSeat) when EITHER (a) its session ended cleanly (endReason:"done") more than
// DETACH_DELAY_MS ago and is not currently live [the original P5 exited path], OR (b) it declared `done` on
// THIS thread more than DETACH_DELAY_MS ago even while STILL LIVE [thread "Thread liveness": a shared
// Coordinator seated on a meta thread + children, done on one child but working elsewhere — without this it
// defaults to `working` and keeps the finished child `active` forever]. Both are marker writes on the
// thread ledger — TAB-INDEPENDENT and AUTHORITATIVE: the write fires the threads:<board> feed, the pill
// (now durable-membership-driven) clears with or without a live tab. The on-canvas session card is NOT
// removed here — that's a canvas mutation that 503s without a tab (canvas-mutations-need-live-tab); a live
// tab's client reconciler closes it best-effort (and cleans a lingering node on next load). Guarded to
// endReason:"done" ONLY (shouldDetachDoneMember) so terminated/crashed pills — signal, not clutter — are
// left, and a live session is never touched. Because it's board-wide, a done session detaches from EVERY
// thread it belonged to (finished globally), and the one-time cleanup of the stale done-members already on a
// thread falls out for free on the first tick — no separate codepath. Reads markers only for durable
// members (a handful), so it's cheap; runs on loopTick beside the reaper.
export function detachDoneMembersTick(): void {
  const { boards, liveSessions, threadLog, publishThreadFeed, forgetDurableMember } = getServerContext();
  const now = Date.now();
  const isLive = (sid: string) => {
    const s = liveSessions.get(sid);
    return !!s && s.status !== "exited";
  };
  let detached = 0;
  for (const [boardId, board] of boards) {
    let threads: ThreadMetaMarker[];
    try {
      threads = listThreads(board.repoPath);
    } catch {
      continue;
    }
    for (const t of threads) {
      const meta = readThreadMeta(board.repoPath, t.threadId);
      let dropped = false;
      for (const sid of threadMembersFromMeta(meta)) {
        const marker = readCanvasSession(board.repoPath, sid);
        // Two independent detach triggers, same drop (releaseSeat + forgetDurableMember): the EXITED-done path
        // (a cleanly-finished process past the grace window, guarded off-live) OR the STILL-LIVE done-INTENT path
        // (a member — e.g. a shared Coordinator seated on a meta thread + children — that declared `done` on
        // THIS thread's seat while its process works elsewhere; without this it defaults to `working` and keeps
        // the finished child `active` forever, thread "Thread liveness"). A later non-done intent overwrites the
        // done at its key, so a re-declared `working` cancels the pending detach (threadIntentForSid reads the
        // freshest; its ts is the clock).
        const detachExited = shouldDetachDoneMember(sid, marker, now, DETACH_DELAY_MS, isLive);
        const detachDoneIntent = shouldDetachDoneIntent(threadIntentForSid(meta?.intents, sid), now, DETACH_DELAY_MS);
        if (!detachExited && !detachDoneIntent) continue;
        forgetDurableMember(board.repoPath, t.threadId, sid); // authoritative: drops durable membership (marker + the in-memory fsState.durableMembers mirror) → pill clears; the marker-only removeThreadMember left the mirror stale until restart (BUG-1)
        releaseSeat(board.repoPath, t.threadId, sid); // no-op unless this sid still holds a seat here
        detached++;
        dropped = true;
      }
      // The marker write fires threads:<board> (the rail), but the OPEN card's pills ride the thread:<id>
      // feed's `members` — republish it so the detached pill clears now, not at the next unrelated post.
      if (dropped) publishThreadFeed(boardId, t.threadId, threadLog(boardId, t.threadId), false);
    }
  }
  if (detached) console.warn(`[detach-done] dropped ${detached} done member(s) from their thread(s) (grace ${DETACH_DELAY_MS / 1000}s elapsed)`);
}

// BUG-8 — the DEFERRED-worktree reap sweep (back half of the merge-on-green crash fix). A worktree teardown
// (merge-on-green or explicit rm) NEVER yanks a tree a live session is cwd-ed in — that yank is what made a
// worker exit code=1 → a false "crashed" band. Instead the teardown stamps the record `pendingReap` and
// defers. This board-wide sweep finishes the job: for every worktree flagged pendingReap, once NO live
// session occupies it any more, it runs the (now-safe) removal so the already-merged tree doesn't linger.
// Cheap — reads only the worktree records on each thread marker, skips anything still occupied — and runs on
// loopTick beside detachDoneMembersTick. The occupancy predicate mirrors the route's: a live session whose
// process cwd realpaths to the worktree path.
export function reapPendingWorktreesTick(): void {
  const { boards, liveSessions } = getServerContext();
  const occupants = new Map<string, string>(); // realpath(cwd) → occupying session sid
  for (const s of liveSessions.values()) if (s.status !== "exited") occupants.set(wtRealpath(s.cwd), s.id);
  const isOccupied = (wtPath: string) => occupants.get(wtRealpath(wtPath)) ?? null;
  let reaped = 0;
  for (const [, board] of boards) {
    let threads: ThreadMetaMarker[];
    try {
      threads = listThreads(board.repoPath);
    } catch {
      continue;
    }
    for (const t of threads) {
      const wts = listWorktrees(board.repoPath, t.threadId);
      for (const [key, rec] of Object.entries(wts)) {
        if (!rec?.pendingReap) continue;
        if (isOccupied(rec.path)) continue; // occupant still live — wait for it to exit
        // Pass isOccupied so this is race-safe (a session could re-attach between the check and the call).
        const r = removeWorktree(board.repoPath, t.threadId, key, { isOccupied });
        if (r.removed) reaped++;
      }
    }
  }
  if (reaped) console.warn(`[worktree-reap] removed ${reaped} deferred worktree(s) whose live occupant has exited`);
}

// Start the single global heartbeat timer. Pinned on globalThis so a hot re-eval clears and restarts the
// one timer instead of stacking a second (mirrors boardFeedsStarted). One timer drives every board.
export function startLoopHeartbeat(): void {
  const g = globalThis as { __canvasLoopHeartbeat?: ReturnType<typeof setInterval> };
  if (g.__canvasLoopHeartbeat) clearInterval(g.__canvasLoopHeartbeat);
  g.__canvasLoopHeartbeat = setInterval(loopTick, LOOP_TICK_MS);
}

// The last request host we saw — the origin a SERVER-FIRED spawn (standingJobsTick) seeds its worker brief /
// bus commands with, since it has no triggering request of its own. The server is strictPort-pinned to
// 127.0.0.1:5173, so the constant fallback is correct until the first request refines it.
let lastKnownOrigin = "127.0.0.1:5173";
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  const origin = typeof host === "string" && host ? host : "localhost:5173";
  lastKnownOrigin = origin;
  return origin;
}

// The doc worker's first-turn brief: service the doc's open-annotation queue, loop-until-dry, wind down.
// Its own session id is baked into the collab brief (ensureLiveSession), so `<your session id>` resolves.
function docWorkerBrief(rel: string, origin: string): string {
  return (
    `[canvas] You are an auto-spawned DOC WORKER for \`${rel}\`. Activity landed on this doc's annotations and needs servicing.\n` +
    `- Read the open queue: \`scripts/canvas anno list ${rel}\` (or GET http://${origin}/api/annotations?path=${encodeURIComponent(rel)}).\n` +
    `- For each ANSWERED question (a human decided): apply the decision by editing the doc, then RESOLVE the question (resolution belongs to the asker — you).\n` +
    `- For each open COMMENT (note) meant for you: reply and make the change it asks for.\n` +
    `- LEAVE questions still AWAITING a human — you can't answer those; don't touch or resolve them.\n` +
    `- Re-read the queue after each pass so a comment that arrived mid-work is caught; LOOP until nothing actionable remains.\n` +
    `- Then WIND DOWN: POST http://${origin}/api/session/<your session id>/done. Don't linger idle — batch this wake and exit; fresh activity will spawn a new worker.`
  );
}

// The dormant-seat reconstitution brief: a FRESH session standing back up an addressed-but-vacant seat.
function dormantWakeBrief(handle: string, origin: string): string {
  return (
    `[canvas] You've been RECONSTITUTED as the \`${handle}\` seat on this thread — a message was addressed to you while the prior session had wound down. This is a FRESH session seeded from the thread's durable history (NOT a resume): read the thread to catch up.\n` +
    `- Read your inbox: GET http://${origin}/api/inbox?session=<your session id> — the message addressed to you is there (the full backlog replays on this first read).\n` +
    `- Read the thread, then respond to what was asked and continue the seat's work.\n` +
    `- Leave anything you need in the thread before you wind down — a fresh session can't recover your process state.\n` +
    `- When your part is done: POST http://${origin}/api/session/<your session id>/done.`
  );
}

// Trigger 1 — DOC-WAKE. Called after a qualifying annotation write (a `note` comment, or an `answer` on a
// question). If any active watcher's level clears the event (auto-wake.js reuses W4's wakesSeat), service the
// doc: NUDGE a live worker already on it (R1 keep-alive continuity — a comment within its idle window
// continues it, no duplicate) or spawn a fresh one. Single-flight per doc; the worker loops-until-dry.
export function maybeWakeDocWorker(boardId: string, repoPath: string, origin: string, rel: string, eventKind: "note" | "answer" | "suggestion"): void {
  const { liveSessions, sendSessionInput, serverSpawnWorker } = getServerContext();
  const qualifying = qualifyingWatchers(readWatchers(repoPath, rel), eventKind);
  if (qualifying.length === 0) return; // no watcher this activity would wake — nothing to do
  const key = docSurfaceKey(rel);
  const claimant = surfaceClaimant(key);
  if (claimant) {
    const s = liveSessions.get(claimant);
    if (s && s.status !== "exited") {
      // A worker is already servicing this doc — nudge it to re-check rather than spawn a duplicate.
      sendSessionInput(
        claimant,
        `[canvas] new annotation activity on ${rel} — re-check the open queue (\`scripts/canvas anno list ${rel}\`) and keep servicing it; POST /api/session/<your session id>/done when the queue is dry.`,
      );
      return;
    }
    releaseSurface(key, claimant); // stale claim (worker gone) — clear it and spawn fresh below
  }
  // The worker runs as the first qualifying watcher whose role is a real charter'd role; else bare (the
  // ask-armed watcher's reserved handle isn't a role, so an answer-driven wake spawns a plain doc worker).
  let roleId: string | null = null;
  for (const w of qualifying) if (readRole(repoPath, w.role)) { roleId = w.role; break; }
  serverSpawnWorker({
    boardId, repoPath, origin, roleId, threadId: null, anchorNodeId: `node:repo:${rel}`,
    claimKey: key, firstPrompt: docWorkerBrief(rel, origin),
  });
}

// Trigger 2 — DORMANT-SEAT RESPAWN (R1). Called from wakeThreadMembers when an @-addressed member has no
// live session. Reconstitute the seat: read the dormant occupant's role from its marker, spawn fresh into
// the thread, and re-occupy the SAME seat with the new sid. Single-flight per seat; a bare (unseated)
// dormant member has no reconstitution identity, so it's left as a dropped nudge (unchanged behaviour).
export function maybeRespawnDormantSeat(boardId: string, threadId: string, dormantSid: string, origin: string, meta: ThreadMetaMarker | null): void {
  const { boards, serverSpawnWorker } = getServerContext();
  const repoPath = boards.get(boardId)?.repoPath;
  if (!repoPath) return;
  const handle = seatForSid(meta?.seats, dormantSid);
  if (!handle) return; // a plain sid participant, not a seated role — nothing durable to stand back up
  const key = seatSurfaceKey(threadId, handle);
  if (isSurfaceClaimed(key)) return; // already being reconstituted — don't race a second worker onto the seat
  const roleId = (readCanvasSession(repoPath, dormantSid)?.roleId as string | undefined) ?? null;
  const newSid = serverSpawnWorker({
    boardId, repoPath, origin, roleId, threadId, anchorNodeId: threadId,
    claimKey: key, firstPrompt: dormantWakeBrief(handle, origin),
  });
  // Re-occupy the seat immediately with the fresh sid so the next addressed message finds it live/claimed
  // (onboarding also fills it from the card name; fillSeat is idempotent on the same sid).
  if (newSid) fillSeat(repoPath, threadId, handle, newSid, Date.now());
}

// The standing-job NUDGE: the cheap — and now ONLY — wake a standing job can deliver. Under "timers nudge,
// never spawn" a standing job only ever nudges an ALREADY-LIVE target. The instruction rides the nudge inline.
function standingJobNudge(job: { instruction: string }, origin: string): string {
  return (
    `[canvas] ⏱ STANDING JOB — your scheduled tick (not a human message). YOUR INSTRUCTION:\n${job.instruction}\n\n` +
    `- Do exactly what it says. **If there's nothing to do, post NOTHING** ("skip days with nothing") — no "all clear" noise.\n` +
    `- Then go back to sleep (stay live for the next tick). Read your inbox first if you need context: ` +
    `GET http://${origin}/api/inbox?session=<your session id>.`
  );
}

// Part 1 — heartbeat DEFAULT-ON. Auto-enable the Coordinator heartbeat standing job the first time a
// Coordinator seat is staffed (coordinator-heartbeat.js): staffing a Coordinator IS the (human) autonomy
// decision that turns it on. Idempotent: skipped when a Coordinator-role job already exists, so a human who
// deliberately `job rm`'d it isn't overridden. Best-effort; the CLI verb remains the manual override path.
export function ensureCoordinatorHeartbeat(repoPath: string, threadId: string): void {
  try {
    if (readJobs(repoPath, threadId).some((j) => j.role === COORDINATOR_ROLE)) return;
    upsertJob(repoPath, threadId, coordinatorHeartbeatJobSpec());
  } catch {
    /* best-effort — the CLI verb (`scripts/canvas job coordinator`) remains the manual fallback */
  }
}

// §6.1 sweep-gate memory: per Coordinator job (claim key + job id), the sweep signature captured at its
// LAST REAL FIRE. In-memory on purpose — losing it (restart / hot re-eval) merely un-gates the next due
// fire, one extra sweep. Captured AT FIRE TIME, so the occupant's own acts during the sweep (its posts
// bump lastTs) read as fresh change: at most one echo sweep per active episode, then the gate engages.
const lastSweptSig = new Map<string, string>();

// Trigger 3 — STANDING JOBS (R6, W6). The server-fired timer half of the wakeable substrate: every loop
// heartbeat, fire the standing jobs that have come due across every board's threads. TIMERS NUDGE, NEVER
// SPAWN (human-locked invariant, thread mrcauz0v-f): a role-seat job whose seat is a LIVE session NUDGES it;
// a DORMANT/reaped target is left alone (a real event revives it). SINGLE-FLIGHT: a job whose prior fire is
// still running (surface claimed, or the live occupant mid-turn) is SKIPPED and retried next tick. FIRE-NEXT-
// DUE: stampFired re-bases the schedule to now only on a REAL fire. Jobs live on the thread marker, so they
// survive their creator and a restart.
function standingJobsTick(): void {
  const { boards, liveSessions, sendSessionInput, sessionStatus } = getServerContext();
  const now = Date.now();
  for (const [boardId, board] of boards) {
    let threads;
    try {
      threads = listThreads(board.repoPath);
    } catch {
      continue;
    }
    // §6.1 sweep gate — the board's sweep-relevant state, folded once per board and only when some
    // Coordinator job actually reaches its nudge (lazy: a board with nothing due computes nothing).
    let sweepSig: string | null = null;
    const boardSweepSig = () => {
      if (sweepSig !== null) return sweepSig;
      // `status` is the session's whole-session BAND (sessionStatus), not the raw process state: the sweep
      // signature coarsens it (sweepSessionActivity) so a steadily-working session's running↔idle micro-flip
      // no longer moves the signature. Exited sessions are dropped here (they leave the live set → a
      // disappearance, which IS sweep-relevant).
      const sessions: { sid: string; status: string }[] = [];
      for (const s of liveSessions.values())
        if (s.repoPath === board.repoPath && s.status !== "exited")
          sessions.push({ sid: s.id, status: sessionStatus(board.repoPath, s.id) ?? "working" });
      return (sweepSig = heartbeatSweepSignature({ threads, sessions }, now));
    };
    for (const t of threads) {
      // Read the marker once for both the due-check's intent (part 4 backoff) and the seat resolution below.
      const tMeta = readThreadMeta(board.repoPath, t.threadId);
      for (const job of readJobs(board.repoPath, t.threadId)) {
        // Part 4 — intent-keyed backoff: a role-seat job's EFFECTIVE interval slows while its seat's occupant
        // is parked on the human (blocked:human), keeps the base cadence otherwise. Derived live from the
        // seat's declared intent — no stored backoff state (heartbeatEffectiveInterval is a no-op unless
        // blocked:human, so a bare/undeclared job fires exactly as before).
        const seatIntent = job.role ? tMeta?.intents?.[job.role]?.intent ?? null : null;
        // Thread-close cleanup: a Coordinator heartbeat whose seat has STOOD DOWN (declared `done`) belongs
        // to a closed thread — the occupant finished its work here and reap-only-on-done reclaims the idle
        // session. REMOVE the job (not just skip it) so it stops accumulating on the marker and can never
        // fire again; a later re-staffing of the seat re-creates it (ensureCoordinatorHeartbeat is
        // idempotent on staffing). This is what stops a done subthread's heartbeat from lingering — and,
        // paired with the seat-keyed gate below, from waking a Coordinator still live on another thread.
        // Scoped to the Coordinator heartbeat: other role jobs may want distinct close semantics.
        if (job.role === COORDINATOR_ROLE && seatIntent === "done") {
          removeJob(board.repoPath, t.threadId, job.id);
          continue;
        }
        if (!jobDueWithInterval(job, now, heartbeatEffectiveInterval(job.intervalMs, seatIntent))) continue;
        const key = jobClaimKey(t.threadId, job);
        if (isSurfaceClaimed(key)) continue; // a prior fire's worker still servicing this surface — no double-fire

        // TIMERS NUDGE, NEVER SPAWN (human-locked invariant, thread mrcauz0v-f). A standing job may only NUDGE
        // an already-live seat occupant; it must never create a session. So:
        //   - a BARE (roleless) job has no seat to nudge → nothing to do (its old "spawn a fresh worker every
        //     interval" behaviour is removed; re-add an explicit periodic-spawn primitive here if ever needed).
        //   - a ROLE-seat job (incl. the Coordinator heartbeat): planRoleJobFire → "nudge" a live+idle occupant
        //     (the only fire a timer may make), "skip" a mid-turn one, or "none" (dormant/absent, or a
        //     stood-down `done` seat) — both non-nudge outcomes do nothing and do NOT stamp, so the job simply
        //     re-evaluates next tick. A wound-down Coordinator is kept PARKED by the reaper (reap-only-on-done),
        //     so the nudge keeps finding it; a truly-exited seat waits for a real event (@-mention/ask/human).
        if (!job.role) continue; // bare job: no live seat to nudge, and timers don't spawn → no-op
        const sid = tMeta?.seats?.[job.role]?.sid; // reuse the marker read once at the top of this thread
        const live = typeof sid === "string" ? liveSessions.get(sid) : undefined;
        if (planRoleJobFire(live?.status ?? null, seatIntent) !== "nudge") continue; // skip / none → no fire, no stamp

        // §6.1 — GATE the Coordinator heartbeat server-side (token-efficiency-review-2026-07-11.md): a
        // nudge replays the occupant's whole parked context, and the server already knows whether a sweep
        // would find anything. Skip the nudge when the board's sweep-relevant state is UNCHANGED since the
        // last fire. No stamp on a gated skip, so the job stays due and re-checks every scheduler tick —
        // the sweep fires the tick a change lands, never later than it would have un-gated. Stall detection
        // survives inside the signature (staleness-bucket crossings read as change). The map is in-memory
        // only — a server restart just costs one extra sweep.
        //
        // DEDUPE (one Coordinator heartbeat per seat per board): the gate is keyed by the TARGET SESSION
        // (board + sid), NOT by the per-thread job. A single Coordinator session seated on N threads
        // accumulates N identical heartbeat jobs (meta + each subthread); keyed per-thread, each passed the
        // gate independently and nudged the same session N times per cadence. Keyed by sid, the first job to
        // fire stamps the board-wide signature and the rest gate out — one nudge per Coordinator session per
        // board per signature change. Two distinct Coordinator sessions (different sids) still fire
        // independently, as they should. `job rm` + re-enable still starts ungated (the sid's stamp is
        // per-session, and a fresh sweep after any board change fires anyway).
        if (job.role === COORDINATOR_ROLE) {
          const gateKey = `${boardId}|coord:${sid}`;
          const sig = boardSweepSig();
          if (lastSweptSig.get(gateKey) === sig) continue; // nothing changed since the last sweep — no nudge, no stamp
          lastSweptSig.set(gateKey, sig);
        }
        sendSessionInput(live!.id, standingJobNudge(job, lastKnownOrigin), { keepWaitingOn: true });
        stampFired(board.repoPath, t.threadId, job.id, now);
      }
    }

    // Doc standing jobs (doc-jobs.js) — the SAME server-fired timer on a DOC's marker, and the SAME invariant:
    // TIMERS NUDGE, NEVER SPAWN. A due doc job may only nudge a LIVE, idle worker already servicing the doc
    // (single-flight per doc, docJobClaimKey = docSurfaceKey); a mid-turn worker is skipped (no stamp); a
    // dead/absent claimant is a no-op (the old fresh-respawn is removed). A doc that needs a worker gets one
    // reactively via maybeWakeDocWorker (an annotation event), not from this timer.
    let docPaths: string[];
    try {
      docPaths = listDocsWithJobs(board.repoPath);
    } catch {
      docPaths = [];
    }
    for (const rel of docPaths) {
      for (const job of dueJobs(readDocJobs(board.repoPath, rel), now)) {
        const key = docJobClaimKey(rel);
        const claimant = surfaceClaimant(key);
        if (!claimant) continue; // no live worker on the doc — timers don't spawn → nothing to do
        const s = liveSessions.get(claimant);
        if (!s || s.status === "exited") {
          releaseSurface(key, claimant); // stale claim (worker gone) — clear it; no respawn
          continue;
        }
        if (s.status !== "idle") continue; // mid-turn — don't interrupt; retry next tick (no stamp)
        sendSessionInput(claimant, standingJobNudge(job, lastKnownOrigin), { keepWaitingOn: true });
        stampDocFired(board.repoPath, rel, job.id, now);
      }
    }
  }
}

// ── shadow-git committer (docs/shadow-git-ledger.md step 1) ───────────────────────────────────────
// A SERVER-SIDE watcher per root that commits the work-tree into its shadow repo on settle, preceded by a
// boot-reconcile bundling offline changes into one `external` commit. Per-session attribution rides on the
// editor tool calls (foldShadowEdits — claim on tool_use, attributed path-scoped commit on tool_result).
// Shadow DBs live centrally under the canonical repo's .canvas/ (gitRoot = repoPath); syncShadowRoots re-runs
// on worktree add/remove so the committer set tracks boardRoots. The shadowRoots map is fsState-pinned
// (`??=`-init where first read), like server-delivery's announcedMemberships.
const SHADOW_SETTLE_MS = 800;
// The shadow committer's watch ignore (Rule B): see `.canvas/` content so it gets versioned, but never the
// shadow git-dirs under `.canvas/roots/` — a commit writes objects THERE, and watching them would re-commit
// forever (docs/canvas-home.md §5). This is the load-bearing feedback-loop guard.
const shadowIgnored = (p: string): boolean => isInternalPath(p);

// Attribution (doc §6): the server already parses each session's stdout, so an editor tool CALL is our
// honest attribution signal — it names both the session and the exact file. On the assistant `tool_use` we
// CLAIM the target path (the `external` floor then leaves it for us); on the matching `user` tool_result the
// write has landed, so we commit JUST that path attributed to the session. Bash/out-of-band writes name no
// path and keep falling to the `external` floor.
const EDIT_TOOL_PATH: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

// Resolve an editor tool's target to a shadow committer: the board root whose work-tree CONTAINS the file
// (longest prefix — so a worktree session attributes to ITS root, not the canonical repo), the path relative
// to that root, and the live watcher handle. null when no active committer owns the path.
function shadowTargetFor(s: LiveSession, filePath: string): { key: string; rel: string; handle: ReturnType<typeof watchRoot> } | null {
  const { boardIdentity, boardRoots, fsState } = getServerContext();
  const shadowRoots = getShadowRoots(fsState);
  const abs = path.resolve(s.repoPath, filePath); // tools usually emit absolute paths; resolve relatives off cwd
  const boardId = boardIdentity(s.repoPath).boardId;
  let best: { id: string; path: string } | null = null;
  for (const r of boardRoots(boardId)) {
    if ((abs === r.path || abs.startsWith(r.path + path.sep)) && (!best || r.path.length > best.path.length)) best = r;
  }
  if (!best) return null;
  const rel = path.relative(best.path, abs);
  // Agent worktrees (`spawn --worktree`) live under the board's `.canvas/worktrees/` and are their OWN real
  // git checkouts — they reach main via merge-on-green, never the shadow ledger. listWorktrees excludes them
  // from boardRoots, so an edit inside one has no committer of its own and falls through to the canonical
  // repo root, yielding rel = `.canvas/worktrees/<key>/…`. Staging that with `git add` in the canonical
  // work-tree hits the nested checkout's gitlink boundary ("is in submodule"). Never shadow-attribute it.
  const wtHome = path.join(".canvas", "worktrees");
  if (rel === wtHome || rel.startsWith(wtHome + path.sep)) return null;
  const key = boardId + "\0" + best.id;
  const handle = shadowRoots.get(key);
  return handle ? { key, rel, handle } : null;
}

export function foldShadowEdits(s: LiveSession, e: { type?: string; message?: { content?: unknown } }): void {
  const shadowRoots = getShadowRoots(getServerContext().fsState);
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  if (e.type === "assistant") {
    // Claim each editor tool_use's target so the floor debounce skips it until the result commits it.
    for (const b of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b?.type !== "tool_use" || !b.id || !b.name) continue;
      const field = EDIT_TOOL_PATH[b.name];
      const fp = field && b.input ? b.input[field] : undefined;
      if (typeof fp !== "string" || !fp) continue;
      const tgt = shadowTargetFor(s, fp);
      if (!tgt) continue;
      tgt.handle.claim([tgt.rel]);
      s.pendingEdits.set(b.id, { key: tgt.key, rel: tgt.rel });
    }
  } else if (e.type === "user") {
    // The write has landed — commit each claimed path attributed (or release it if the edit errored/no-op'd).
    for (const b of content as Array<{ type?: string; tool_use_id?: string }>) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      const pending = s.pendingEdits.get(b.tool_use_id);
      if (!pending) continue;
      s.pendingEdits.delete(b.tool_use_id);
      const handle = shadowRoots.get(pending.key);
      if (!handle) continue; // committer torn down (worktree vanished mid-turn) — claim is gone with it
      const author = `session:${s.id.slice(0, 8)} <${s.id}@foolscap.session>`;
      void handle
        .commitClaimed([pending.rel], { author, message: `${s.id.slice(0, 8)}: edit ${pending.rel}` })
        .catch((err: unknown) => console.error("[shadow] session commit:", err instanceof Error ? err.message : err));
    }
  }
}

export function syncShadowRoots(boardId: string, repoPath: string): void {
  const { boardRoots, fsState } = getServerContext();
  const shadowRoots = getShadowRoots(fsState);
  const roots = boardRoots(boardId);
  const live = new Set(roots.map((r) => boardId + "\0" + r.id));
  for (const r of roots) {
    const key = boardId + "\0" + r.id;
    if (shadowRoots.has(key)) continue;
    const onErr = (e: unknown): void => console.error(`[shadow] ${r.id}:`, e instanceof Error ? e.message : e);
    // boot-reconcile: one bundled `external` commit catching offline/unobserved changes before live watching.
    void commitRoot(r.path, { rootId: r.id, gitRoot: repoPath, message: "external: reconcile on start" }).catch(onErr);
    const handle = watchRoot(r.path, {
      rootId: r.id,
      gitRoot: repoPath,
      settleMs: SHADOW_SETTLE_MS,
      ignored: shadowIgnored,
      onError: onErr,
    });
    shadowRoots.set(key, handle);
  }
  // tear down watchers for roots that vanished; the shadow DB under .canvas/ stays (history survives removal).
  for (const [key, h] of shadowRoots) {
    if (key.startsWith(boardId + "\0") && !live.has(key)) {
      void h.close();
      shadowRoots.delete(key);
    }
  }
}
