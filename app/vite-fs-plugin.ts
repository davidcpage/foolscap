import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

// The Node backbone of the spike — a dev-server middleware (no separate process) that exposes a real
// folder's text files to the browser and pushes live change events. This is the seam the design note
// calls "files are the source of truth for content": the canvas holds spatial state (records/log), the
// FILES hold the content, and this middleware is the bridge. It does the two jobs the browser can't:
// read the filesystem, and (phase 2) tail it for out-of-band edits. Phase 3 (write-back + git commit)
// would add a PUT handler here; deliberately not built yet.
//
//   GET /api/ls?root=<id>&path=…     → { path, dirs: [rel], files: [rel] } — immediate children, no content
//   GET /api/file?root=<id>&path=…   → { path, content, truncated }
//   GET /api/watch?root=<id>         → text/event-stream of { type: add|change|unlink, path }
//   GET /api/weather?q=<place>       → { resolved, name, current:{…}, error } — Open-Meteo, polled server-side, no root
//
// `root` is an ALLOW-LISTED id (never a caller-supplied path), and every file read is re-checked to be
// inside that root — the middleware runs with the dev server's full fs privileges, so both guards matter.

const here = path.dirname(fileURLToPath(import.meta.url));

// The one allow-listed root: the canvas repo itself, derived from the dev-server location so it tracks
// whatever machine this runs on (no hardcoded user path). Folders are added per-canvas now (the Add-files
// menu picks a SUBDIR of this root, server-validated by safeResolve) rather than a fixed dataset enum.
const ROOTS: Record<string, string> = {
  repo: path.resolve(here, ".."),
};

// Where Claude Code keeps this project's session transcripts. The slug is the project path with the
// separators flipped to dashes — derived from the repo root so it tracks whatever machine this runs
// on, no hardcoded user path. These `.jsonl` files are the historical sessions the session card
// reads (agent-sessions-on-canvas.md §4): content, served read-only, never written here.
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "projects", ROOTS.repo!.replace(/\//g, "-"));
const MAX_SESSION_BYTES = 4 * 1024 * 1024; // whole sessions, bounded against a pathological one. The
// card scrolls, so we serve the full transcript; the cap only guards an extreme outlier (and the
// card flags it honestly when it bites — the codec marks a partial tail). In-memory spike, so a few
// MB in node.text is fine.

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".vite", ".cache", "coverage",
]);
// Text files only — the cards render content inline, so binaries are skipped at the listing.
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".css", ".html", ".py", ".yaml", ".yml", ".toml", ".sh",
]);
const MAX_BYTES = 6000; // cards show a preview, not the whole file; truncate big ones

function rootDir(id: string | null): string | null {
  return id && Object.prototype.hasOwnProperty.call(ROOTS, id) ? ROOTS[id]! : null;
}

// Resolve a caller-supplied relative path against a root and refuse anything that escapes it.
function safeResolve(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

function readText(abs: string): { content: string; truncated: boolean } | null {
  try {
    const buf = fs.readFileSync(abs);
    return { content: buf.subarray(0, MAX_BYTES).toString("utf8"), truncated: buf.length > MAX_BYTES };
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// The IMMEDIATE children of one directory (root-relative paths, no content) — the lazy primitive the
// in-card file tree navigates one level at a time, the off-log `dirListing` projection on the client
// (content.ts). Same exclusions/text-filter as the file read. Scoped to a SUBDIR of root (`sub`,
// validated to sit inside root — "" = the repo root); paths returned relative to ROOT so node ids stay
// (root, path)-stable and the watch stream addresses the same cards.
function handleLs(res: ServerResponse, root: string, sub: string): void {
  const base = safeResolve(root, sub);
  if (!base) return sendJson(res, 400, { error: "bad path" });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    const rel = path.relative(root, path.join(base, e.name));
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) dirs.push(rel);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      files.push(rel);
    }
  }
  dirs.sort();
  files.sort();
  sendJson(res, 200, { path: sub, dirs, files });
}

function handleFile(res: ServerResponse, root: string, rel: string): void {
  const abs = safeResolve(root, rel);
  // Apply the SAME gates handleLs uses, so a card can only read what the listing would have shown:
  // inside the root (safeResolve), not under an excluded dir (.git, node_modules, …), and only a
  // known text extension. Without this, /api/file would read any non-listed file in the root — a
  // secret with no text ext (.env, *.pem → blocked here), or anything under .git. 404, not 403, so
  // the endpoint never confirms a blocked file exists.
  const segs = rel.split(/[\\/]/);
  const allowed =
    !!abs && !segs.some((s) => EXCLUDE_DIRS.has(s)) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  const r = allowed ? readText(abs!) : null;
  if (!r) return sendJson(res, 404, { error: "not found" });
  sendJson(res, 200, { path: rel, content: r.content, truncated: r.truncated });
}

// Real Claude Code transcripts in SESSIONS_DIR: `*.jsonl` minus the `*.usage.jsonl` sidecars (those
// are a separate usage-logging stream, not conversations). Returned newest-first by mtime so a
// caller with no id gets the most recent session.
function listSessions(): { id: string; mtime: number; bytes: number }[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".usage.jsonl"))
    .map((n) => {
      const st = fs.statSync(path.join(SESSIONS_DIR, n));
      return { id: n.slice(0, -".jsonl".length), mtime: st.mtimeMs, bytes: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// GET /api/session?id=<sessionId>  → { id, content, truncated }: one transcript's raw jsonl, bounded.
// No `id` → the most recent session. The id is an allow-listed shape (no dots/slashes) AND the
// resolved path is re-checked to sit in SESSIONS_DIR — same two guards as the file reads, since this
// also runs with the dev server's fs privileges. Content is served raw; the jsonl → turns codec is
// the card's (render.js), keeping the format understood in exactly one place.
function readSessionFile(id: string): { content: string; truncated: boolean } | null {
  const abs = path.resolve(SESSIONS_DIR, id + ".jsonl");
  if (!abs.startsWith(SESSIONS_DIR + path.sep)) return null; // id re-checked to sit in SESSIONS_DIR
  try {
    const buf = fs.readFileSync(abs);
    return {
      content: buf.subarray(0, MAX_SESSION_BYTES).toString("utf8"),
      truncated: buf.length > MAX_SESSION_BYTES,
    };
  } catch {
    return null;
  }
}

function handleSession(res: ServerResponse, id: string | null): void {
  let chosen = id;
  if (!chosen) chosen = listSessions()[0]?.id ?? null;
  if (!chosen) return sendJson(res, 404, { error: "no sessions found" });
  if (!/^[\w-]+$/.test(chosen)) return sendJson(res, 400, { error: "bad session id" });
  const r = readSessionFile(chosen);
  if (!r) return sendJson(res, 404, { error: "not found" });
  ensureSessionFeed(chosen); // a card asked for this transcript → start live-tailing it (below)
  sendJson(res, 200, { id: chosen, content: r.content, truncated: r.truncated });
}

// A human-legible label + counts for the dropdown, parsed from a transcript. The label prefers the
// agent-written `ai-title` record (a clean summary the session already produces, refined as it grows
// — so we keep the LAST one); failing that, the first human prompt, truncated. Two counts, both shown:
// `turns` is user messages carrying actual text (things you typed, not the tool-result envelopes that
// also ride the `user` channel); `messages` is the raw user+assistant record count (every tool
// iteration included). Cached by mtime so the dropdown parses each transcript at most once.
const summaryCache = new Map<
  string,
  { mtime: number; title: string | null; turns: number; messages: number }
>();

function userText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p): p is { type?: unknown; text?: unknown } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => (p.text as string).trim())
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

function sessionSummary(
  abs: string,
  mtime: number,
): { title: string | null; turns: number; messages: number } {
  const hit = summaryCache.get(abs);
  if (hit && hit.mtime === mtime)
    return { title: hit.title, turns: hit.turns, messages: hit.messages };
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let turns = 0;
  let messages = 0;
  try {
    const text = fs.readFileSync(abs, "utf8").slice(0, MAX_SESSION_BYTES);
    for (const line of text.split("\n")) {
      if (!line) continue;
      let o: { type?: string; aiTitle?: unknown; message?: { content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) {
        aiTitle = o.aiTitle.trim();
      } else if (o.type === "user" || o.type === "assistant") {
        messages++;
        if (o.type === "user") {
          const t = userText(o.message?.content);
          if (t) {
            turns++;
            if (firstPrompt === null) firstPrompt = t;
          }
        }
      }
    }
  } catch {
    // unreadable transcript → no summary; the client falls back to the bare id
  }
  const title = aiTitle ?? (firstPrompt ? firstPrompt.slice(0, 80) : null);
  summaryCache.set(abs, { mtime, title, turns, messages });
  return { title, turns, messages };
}

// GET /api/sessions → every historical transcript (newest-first), for the Open-session dropdown. The
// list IS the disk: a session card deleted from the canvas still appears here, so "reopen it later"
// needs no canvas persistence — the .jsonl is the source of truth. listSessions() stays a cheap
// readdir+stat (handleSession leans on it too); the per-transcript title/turn parse is added only here.
function handleSessions(res: ServerResponse): void {
  const sessions = listSessions().map((s) => ({
    ...s,
    ...sessionSummary(path.join(SESSIONS_DIR, s.id + ".jsonl"), s.mtime),
  }));
  sendJson(res, 200, { sessions });
}

// Server-Sent Events: hold the connection open and forward chokidar add/change/unlink as JSON frames.
// This is the reactive ingest path — an out-of-band edit (your editor, an agent, git pull) becomes a
// live event the canvas turns into a card update, with no polling.
function handleWatch(req: IncomingMessage, res: ServerResponse, root: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);

  const emit = (type: string) => (abs: string) =>
    res.write(`data: ${JSON.stringify({ type, path: path.relative(root, abs) })}\n\n`);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => p.split(path.sep).some((seg) => EXCLUDE_DIRS.has(seg)),
  });
  watcher.on("add", emit("add")).on("change", emit("change")).on("unlink", emit("unlink"));

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000); // keep proxies from closing the stream
  req.on("close", () => {
    clearInterval(ping);
    void watcher.close();
  });
}

// ── feeds (demo §10: "the clock with a fetch in it") ────────────────────────────────────────────
// A tiny server-side feed registry, multiplexed onto ONE SSE stream (/api/feeds). Each feed is a
// named source that publishes its latest value; the client turns each name into an off-log signal
// (the clock's pattern, fed from here instead of setInterval). Values are channel-1-only on the
// canvas — nothing a feed emits ever touches the log/persistence/git. New connections get every
// feed's last value immediately, so cards render without waiting for the next tick.

interface SseClient {
  res: ServerResponse;
}

// Vite restarts the dev server on a plugin-file edit by RE-EVALUATING this module in the SAME node
// process (a server.restart, not a process exit). Module-level state would therefore reset while the
// spawned session children keep running — orphaning them: the new registry has no handle, so a
// POST /input 409s and the live feed goes silent, and the process-exit kill hook never fires (the
// process never exited). That is the exact failure that lost a live session on a server edit. Pin the
// load-bearing state on globalThis (one object, shared across re-evals in the process) so a
// re-evaluated module ADOPTS the surviving children, watchers and SSE plumbing instead of leaking
// them. Identity is the point: a surviving child's stdout closure still calls the OLD publishFeed,
// which reads these SAME Set/Map objects — so the reconnected browser (re-registered in the shared
// feedClients) keeps receiving its output, and sendSessionInput finds the live child to write to.
// Pinning feedsStarted also stops configureServer's startFeeds() from stacking a second git/HN
// watcher on every reload.
interface CanvasFsState {
  feedClients: Set<SseClient>;
  feedValues: Map<string, unknown>;
  feedsStarted: boolean;
  liveSessions: Map<string, LiveSession>;
  sessionWatchers: Map<string, ReturnType<typeof chokidar.watch>>;
  sessionCleanupHooked: boolean;
}
const fsState: CanvasFsState = ((globalThis as { __canvasFsState?: CanvasFsState }).__canvasFsState ??= {
  feedClients: new Set<SseClient>(),
  feedValues: new Map<string, unknown>(),
  feedsStarted: false,
  liveSessions: new Map<string, LiveSession>(),
  sessionWatchers: new Map<string, ReturnType<typeof chokidar.watch>>(),
  sessionCleanupHooked: false,
});
// Reference-typed collections aliased by identity so the rest of the file is untouched; the two
// boolean guards are read/written through fsState (a primitive can't be aliased and still survive).
const feedClients = fsState.feedClients;
const feedValues = fsState.feedValues;
const liveSessions = fsState.liveSessions;
const sessionWatchers = fsState.sessionWatchers;

function publishFeed(feed: string, value: unknown): void {
  feedValues.set(feed, value);
  const frame = `data: ${JSON.stringify({ feed, value })}\n\n`;
  for (const c of feedClients) c.res.write(frame);
}

// Open an SSE stream and add it to a client set, with the keep-alive ping + close bookkeeping all
// the streams here share. Returns the client handle.
function openSse(req: IncomingMessage, res: ServerResponse, clients: Set<SseClient>): SseClient {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);
  const client: SseClient = { res };
  clients.add(client);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
  return client;
}

function handleFeeds(req: IncomingMessage, res: ServerResponse): void {
  openSse(req, res, feedClients);
  for (const [feed, value] of feedValues) res.write(`data: ${JSON.stringify({ feed, value })}\n\n`);
}

// Feed: the repo's HEAD commit. chokidar on .git/HEAD (branch switches) + .git/logs/HEAD (every
// commit/amend/pull — the reflog is the one file that always moves); on either, ask git for the
// tip. The walk/watch above EXCLUDE .git wholesale, so this is its own deliberate watch — the
// file-card pipeline and the commit feed stay separate ingest paths.
function startGitHeadFeed(repo: string): void {
  const read = () =>
    execFile(
      "git",
      ["log", "-1", "--format=%H%x1f%an%x1f%ct%x1f%s"],
      { cwd: repo },
      (err, stdout) => {
        if (err) return; // e.g. empty repo — keep the previous value
        const [sha, author, ct, message] = stdout.trim().split("\x1f");
        if (sha) publishFeed("githead", { sha, author, message, ts: Number(ct) * 1000 });
      },
    );

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

// ── live session feed (agent-sessions-on-canvas.md §3, slice 1: live-tail) ──────────────────────
// A session card asked for transcript `id` (handleSession), so watch that `.jsonl` and republish its
// content on the feed `session:<id>` whenever it changes — the SAME channel-1 seam the clock and git
// HEAD use. A live Claude Code session you're working in then re-renders its card as you go, with NO
// setText: the transcript is derived/channel-1, never the canvas intent log (the clock rule, §9.1;
// session-timelines.md §1/§5 — the file is the one source, the canvas only projects it).
//
// Slice-1 cost, accepted (§9.4): it republishes the WHOLE file (bounded by MAX_SESSION_BYTES) on each
// change, not a per-turn delta — fine for the spike; a real impl streams appended turns into a ring
// buffer. Debounced so a burst of appends is one publish. Idempotent per id, kept for the server's
// life like the other feeds (the registry/lifecycle of agent-sessions §8 is the live-terminal step,
// not this one — here the process is your own Claude Code, running out-of-band).
// (sessionWatchers lives on fsState — aliased at the top — so it survives a server reload.)

function ensureSessionFeed(id: string): void {
  // A registry-OWNED session (slice 2: we spawned the process) publishes session:<id> from the live
  // PROCESS stream (finer, token-level) — don't also tail its .jsonl, or two publishers fight on one
  // feed and the turn-granular file would clobber the token-granular stdout. The file watch is only
  // for sessions running OUT-OF-BAND (your own Claude Code, slice 1).
  if (liveSessions.has(id)) return;
  if (sessionWatchers.has(id) || !/^[\w-]+$/.test(id)) return;
  const feed = "session:" + id;
  const publish = () => {
    const r = readSessionFile(id);
    if (r) publishFeed(feed, r);
  };
  let t: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (t) clearTimeout(t);
    // Small coalescing window only — just enough to batch a multi-write flush into one publish. The
    // card's perceived lag is NOT here: Claude Code writes the .jsonl per COMPLETED message/turn, not
    // per token (measured: the file sits flat for seconds mid-turn while the terminal streams), so a
    // file-tail is turn-granular by nature. Token-level liveness needs the in-flight PROCESS stream as
    // a channel-1 feed (the spawn+duplex slice / agent-sessions §6), not this file watch.
    t = setTimeout(publish, 80);
  };
  const watcher = chokidar
    .watch(path.resolve(SESSIONS_DIR, id + ".jsonl"), { ignoreInitial: true })
    .on("all", debounced);
  sessionWatchers.set(id, watcher);
  publish(); // seed the feed so a fresh subscriber renders immediately (replayed on SSE connect too)
}

// Stop the out-of-band file-tail for `id`. Called when the registry takes the session live (resume):
// `--resume` appends to the SAME .jsonl, so a surviving turn-granular file watch would clobber the
// registry's token-granular stream on the shared feed — the "two publishers fight" the comment above
// warns about. The startup guard only prevents a NEW watch; this closes an EXISTING one.
function stopSessionFeed(id: string): void {
  const w = sessionWatchers.get(id);
  if (w) {
    void w.close();
    sessionWatchers.delete(id);
  }
}

// ── live session registry (agent-sessions-on-canvas.md §8; session-timelines.md §5) ─────────────
// The one genuinely-NEW piece the docs name (§8): a server-side registry that SPAWNS and OWNS a real
// Claude Code process, decoupled from card lifecycle. A live session is a real process; the card is a
// VIEW of it (closing the card never kills the process — there is no card→kill wire). This is the
// load-bearing complexity, kept here on the server, OUT of the canvas channels.
//
// The duplex (agent-sessions §3, corrected by session-timelines §3/§4):
//   • OUT: the process's stream-json stdout → republished on the SAME channel-1 feed `session:<id>`
//     the card already reads. Token-level: `--include-partial-messages` deltas are accumulated into an
//     in-flight synthetic assistant turn, so text appears as it streams (finer than slice 1's
//     turn-granular file tail). Channel-1 only — a streaming token NEVER touches the log/git (§9.1).
//   • IN: POST /api/session/<id>/input writes a stream-json user message to the process stdin. This is
//     SESSION-INTERNAL — it gets NO canvas-log entry and rides NO editor.commit (session-timelines §4
//     corrected agent-sessions §3 here): a prompt to a session is a session act the canvas points at,
//     not one it absorbs. The process writes its own `.jsonl` (the referenced one-source file, §5).
//
// PERMISSIONS (agent-sessions §9.3 — "the terminal runs code"). The spawned agent runs as you, in the
// repo, with this mode. A canvas session has no TTY to approve at, so "default" would STALL any
// tool-using turn (text-only answers still stream, but the §8 payoff — agent edits files → commits →
// the commit-watcher re-renders the cards live — never fires). "auto" lets it act unattended so a
// canvas session is genuinely a working agent; local-only solo, as §9.3 accepts. Dial to "default"
// (text only) or up to "bypassPermissions" (skip every check) here if that balance ever changes.
const SESSION_PERMISSION_MODE = "auto";

// AskUserQuestion is auto-cancelled in `-p` headless mode (VERIFIED: the CLI synthesises an
// is_error="Answer questions?" tool_result and continues — it never waits for an answer on stdin, so
// there's no tool_result loop to hook). So we DISALLOW it (below) and steer the session to a convention
// the card CAN render+answer over the existing input duplex: a fenced ```ask block (same JSON shape as
// AskUserQuestion's input) that render.js turns into clickable options and answers as a normal user
// message. The disallow is the backstop; this prompt is the replacement. See askuserquestion memory.
const ASK_CONVENTION =
  "INTERACTIVE QUESTIONS: The AskUserQuestion tool is unavailable in this environment. When you need " +
  "the user to choose between options, do NOT call AskUserQuestion and do NOT ask in prose — instead " +
  "emit a fenced code block whose info string is `ask` and whose body is a single JSON object shaped " +
  "exactly like AskUserQuestion's input:\n\n" +
  "```ask\n" +
  '{"questions":[{"question":"<the question>","header":"<≤12 char label>","multiSelect":false,' +
  '"options":[{"label":"<short choice>","description":"<what it means / the tradeoff>"}]}]}\n' +
  "```\n\n" +
  "The app renders this as clickable buttons and sends the user's selection back as their next message. " +
  "Emit the ```ask block as the LAST thing in your turn, then stop and wait for the reply. Keep option " +
  "labels short and put the rationale in `description`. Use it whenever the answer is a choice among options.";

const MAX_SESSION_FEED_BYTES = 512 * 1024; // bound the live buffer — a derived stream stays bounded
// (§9.4). Keep the most-recent tail; older completed turns drop off (the card scrolls live output).

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface LiveSession {
  id: string;
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  lines: string[]; // completed transcript-shaped events (codec-ready: {type:"user"|"assistant",message})
  inflight: ContentBlock[] | null; // the assistant message being built from partial deltas, or null
  status: "running" | "idle" | "exited";
  skills: string[] | null; // slash-invocable skills the harness advertised this session (for /-completion)
  verb: string | null; // what the live turn is doing now ("Thinking"/"Running"/…) — channel-1 chrome, null when idle
  usage: { input: number; output: number } | null; // this turn's tokens: input = latest context size, output = accrued
  turnOut: number; // output tokens from this turn's COMPLETED messages; the live output adds the streaming delta on top
}

// liveSessions lives on fsState (aliased at the top) so spawned children survive a server reload and
// stay reachable; sessionCleanupHooked is read/written through fsState so the process-exit kill hook
// is installed exactly once across reloads, not stacked.

// Publish the session's buffer (completed lines + the in-flight synthetic turn) on its feed. Bounded
// from the tail; `truncated` mirrors the codec's existing cap signal so the card flags a clipped view.
function publishSession(s: LiveSession): void {
  const lines = [...s.lines];
  if (s.inflight && s.inflight.length > 0) {
    // The live tail: a synthetic assistant message the codec parses exactly like a real one. Only
    // text/thinking accumulate visibly; a tool_use shows its name until its consolidated event lands.
    lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: s.inflight } }));
  }
  let content = lines.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content) > MAX_SESSION_FEED_BYTES) {
    content = content.slice(content.length - MAX_SESSION_FEED_BYTES);
    truncated = true;
  }
  publishFeed("session:" + s.id, {
    content,
    truncated,
    status: s.status,
    skills: s.skills ?? undefined,
    verb: s.verb ?? undefined, // live progress label for the status pill (channel-1 chrome)
    usage: s.usage ?? undefined, // {input, output} token counts for the current/last turn
  });
}

// The full prompt size a usage object represents: fresh input plus both cache tiers. This is the
// "context" number — it grows through a turn as the transcript accretes — not the (small) uncached
// `input_tokens` alone. Tolerant of the partial usage on a `message_start` (cache fields may be absent).
function ctxOf(u: any): number {
  if (!u || typeof u !== "object") return 0;
  return (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0);
}

// A short, human label for what the live turn is doing right now, derived from the in-flight content
// block's tool name. Mirrors the terminal's progress verb — purely cosmetic channel-1 chrome.
function toolVerb(name: string): string {
  switch (name) {
    case "Read": return "Reading";
    case "Write": return "Writing";
    case "Edit":
    case "NotebookEdit": return "Editing";
    case "Bash": return "Running";
    case "Grep":
    case "Glob": return "Searching";
    case "WebFetch": return "Fetching";
    case "WebSearch": return "Searching the web";
    case "Task":
    case "Agent": return "Delegating";
    case "TodoWrite": return "Planning";
    default: return "Using " + name;
  }
}

// Parse one stream-json event off the process stdout and fold it into the session buffer. The shapes
// are the ones the live `claude -p --output-format stream-json --include-partial-messages` emits
// (probed against this project): system/result/rate_limit framing, `stream_event` partial deltas, and
// the CONSOLIDATED `user`/`assistant` events (already in the on-disk .jsonl codec's shape).
function foldSessionEvent(s: LiveSession, e: any): void {
  // The harness advertises its skills in the `system`/`init` event that opens every `-p --output-format
  // stream-json` session. Capture the names so the card can offer `/`-completion. Framing only — nothing
  // folds into the transcript. VERIFIED LIVE 2026-06-20 against a real `claude -p` capture: the on-disk
  // .jsonl advertises skills as a `skill_listing` *attachment* (with a `names` array), but the live
  // stdout stream does NOT emit that attachment — the init event is the only live source. We take
  // `skills` (the curated Skill-tool set) rather than the wider `slash_commands` (which also carries
  // TUI-only built-ins like /clear,/config that are meaningless to pipe into a headless session).
  if (e?.type === "system" && e?.subtype === "init" && Array.isArray(e.skills)) {
    s.skills = (e.skills as unknown[]).filter((n): n is string => typeof n === "string");
    return;
  }

  switch (e?.type) {
    case "assistant":
    case "user":
      // The authoritative completed message — keep the raw line; the codec reads it as-is. It lands
      // mid-stream (before content_block_stop), so clearing inflight here ends the live tail cleanly.
      if (e.message) s.lines.push(JSON.stringify({ type: e.type, message: e.message }));
      s.inflight = null;
      s.status = "running";
      // Bank this message's authoritative usage into the turn total (a `user` event mid-turn is a
      // tool_result — it carries no usage and must not reset the counter; the turn resets only when WE
      // inject the next prompt, in sendSessionInput). `verb` is left alone: between an assistant
      // tool_use and its result the process is executing the tool, so the tool's verb still holds.
      if (e.type === "assistant" && e.message?.usage) {
        s.turnOut += Number(e.message.usage.output_tokens) || 0;
        s.usage = { input: ctxOf(e.message.usage), output: s.turnOut };
      }
      break;
    case "result":
      s.inflight = null;
      s.status = "idle"; // turn finished; the process waits on stdin for the next prompt
      s.verb = null; // no live activity to label; keep `usage` so the pill shows the turn's final counts
      break;
    case "stream_event": {
      const ev = e.event;
      if (ev?.type === "message_start") {
        s.inflight = [];
        s.usage = { input: ctxOf(ev.message?.usage), output: s.turnOut };
        s.verb = "Thinking"; // a neutral default until the first content_block_start names the activity
      } else if (ev?.type === "content_block_start" && s.inflight) {
        const cb = ev.content_block;
        s.inflight[ev.index] = { ...cb };
        s.verb = cb?.type === "thinking" ? "Thinking" : cb?.type === "tool_use" ? toolVerb(cb.name) : "Responding";
      } else if (ev?.type === "content_block_delta" && s.inflight) {
        const b = s.inflight[ev.index];
        if (b && ev.delta?.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text;
        else if (b && ev.delta?.type === "thinking_delta") b.thinking = (b.thinking ?? "") + ev.delta.thinking;
        // input_json_delta (tool args) isn't accumulated — the consolidated `assistant` event below
        // carries the full input; until then the tool block shows just its name.
      } else if (ev?.type === "message_delta" && s.usage && ev.usage) {
        // The streaming usage frame: output_tokens is cumulative FOR THIS MESSAGE — add it on top of the
        // turn's completed-message total so the live counter ticks up across a multi-message turn.
        s.usage.output = s.turnOut + (Number(ev.usage.output_tokens) || 0);
      }
      if (ev?.type === "message_start" || ev?.type === "content_block_start") s.status = "running";
      break;
    }
    // system / rate_limit_event / anything else: framing only, nothing to render
  }
}

// Resume starts a FRESH process whose stdout carries only the new turns — the prior transcript is not
// replayed (verified against a live `--resume` capture). So seed the live buffer from the session's
// on-disk `.jsonl`, or recommencing would blank the card's history (the live feed supersedes the
// static fields.text). The registry "materialising"/pinning the transcript for the live tail
// (session-timelines.md §5). Same shape foldSessionEvent stores: one {type,message} string per turn.
function seedFromTranscript(s: LiveSession): void {
  const r = readSessionFile(s.id);
  if (!r) return;
  for (const line of r.content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if ((e?.type === "user" || e?.type === "assistant") && e.message)
        s.lines.push(JSON.stringify({ type: e.type, message: e.message }));
    } catch {
      // a non-JSON framing line or a ragged tail — skip, same tolerance as the codec
    }
  }
}

// Spawn (or, when `resume`, continue) a Claude Code process under id and wire its stdout to the feed.
// Idempotent per id: a second call returns the existing live session. The process owns its own
// `.jsonl`; we only read its stdout — never write the transcript ourselves (the agent authors it, §5).
function ensureLiveSession(id: string, resume = false): LiveSession {
  const existing = liveSessions.get(id);
  if (existing && existing.status !== "exited") return existing;

  const args = [
    "-p",
    resume ? "--resume" : "--session-id",
    id,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", SESSION_PERMISSION_MODE,
    "--disallowedTools", "AskUserQuestion", // auto-cancels here; steer to the ```ask convention instead
    "--append-system-prompt", ASK_CONVENTION,
  ];
  const child = spawn("claude", args, {
    cwd: ROOTS.repo!,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const s: LiveSession = {
    id, child, lines: [], inflight: null, status: "running", skills: null, verb: null, usage: null, turnOut: 0,
  };
  if (resume) seedFromTranscript(s);
  liveSessions.set(id, s);
  stopSessionFeed(id); // the registry now owns this feed — drop any out-of-band file-tail for it

  let buf = "";
  let pub: ReturnType<typeof setTimeout> | null = null;
  const schedulePublish = () => {
    if (pub) return;
    pub = setTimeout(() => { pub = null; publishSession(s); }, 50); // coalesce a delta burst to one frame
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        foldSessionEvent(s, JSON.parse(line));
      } catch {
        // a partial/non-JSON framing line — skip, keep streaming
      }
    }
    schedulePublish();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {}); // drained so the pipe never blocks; not shown on the canvas
  child.on("exit", () => {
    s.status = "exited";
    s.inflight = null;
    s.verb = null;
    publishSession(s);
  });
  child.on("error", () => {
    s.status = "exited";
    publishSession(s);
  });

  if (!fsState.sessionCleanupHooked) {
    fsState.sessionCleanupHooked = true;
    const killAll = () => { for (const live of liveSessions.values()) live.child.kill(); };
    process.once("exit", killAll);
    process.once("SIGINT", () => { killAll(); process.exit(0); });
    process.once("SIGTERM", () => { killAll(); process.exit(0); });
  }

  publishSession(s); // seed the feed (empty) so the card renders the live shell immediately
  return s;
}

// Write a user prompt into a live session's stdin as a stream-json message. The prompt is echoed into
// the buffer right away (Claude does not echo stdin on stdout) so the card shows it without waiting.
function sendSessionInput(id: string, text: string): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  s.status = "running";
  // A real prompt is the turn boundary we own (tool_result `user` events are mid-turn) — reset the
  // turn's token accrual and show a neutral verb until the first stream frame names the activity.
  s.turnOut = 0;
  s.usage = null;
  s.verb = "Working";
  s.child.stdin.write(
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
  );
  publishSession(s);
  return true;
}

// Interrupt a live session's CURRENT TURN without ending the process. Writes a stream-json control
// request to its stdin — the same control channel the Claude Code SDK's `interrupt()` uses. The CLI
// halts the in-flight turn at a safe boundary and emits a `result`, which folds the card back to idle
// (foldSessionEvent), leaving the process alive for the next prompt. No-op (false) once exited.
function sendSessionInterrupt(id: string): boolean {
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.child.stdin.write(
    JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } }) +
      "\n",
  );
  return true;
}

// POST /api/session/spawn  { prompt? } → { id }. Mint a new session id, spawn the process, and send the
// first prompt if given. The client drops a session card titled <id>, which subscribes to session:<id>.
async function handleSessionSpawn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { prompt?: unknown } = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  const id = crypto.randomUUID();
  try {
    ensureLiveSession(id);
  } catch (err) {
    return sendJson(res, 500, { error: "failed to spawn", detail: String(err) });
  }
  if (typeof body.prompt === "string" && body.prompt.trim()) sendSessionInput(id, body.prompt);
  sendJson(res, 200, { id });
}

// POST /api/session/<id>/input  { text } → write a prompt into the live process. Session-internal: no
// canvas-log entry, no editor.commit (session-timelines §4). 409 if the session isn't live.
async function handleSessionInput(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  let body: { text?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof body.text !== "string" || !body.text.trim())
    return sendJson(res, 400, { error: "missing text" });
  if (!sendSessionInput(id, body.text)) return sendJson(res, 409, { error: "session not running" });
  sendJson(res, 200, { ok: true });
}

// POST /api/session/<id>/resume → recommence a historical session live, IN PLACE. Seed the live
// buffer from its .jsonl (so the history survives the feed superseding the static transcript) and
// spawn `claude --resume <id>`. The card keys its feed off session:<id>, so the SAME card flips from
// historical to live duplex — no new card, no new id. This is the unify-on-resume handoff (slice 3).
function handleSessionResume(res: ServerResponse, id: string): void {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!readSessionFile(id)) return sendJson(res, 404, { error: "no transcript for that session" });
  try {
    ensureLiveSession(id, true);
  } catch (err) {
    return sendJson(res, 500, { error: "failed to resume", detail: String(err) });
  }
  sendJson(res, 200, { ok: true });
}

// POST /api/session/<id>/interrupt → halt the live session's current turn (no body). Session-internal,
// like input/resume: a POST, never editor.commit, never a canvas-log entry. 409 if it isn't live.
function handleSessionInterrupt(res: ServerResponse, id: string): void {
  if (!/^[\w-]+$/.test(id)) return sendJson(res, 400, { error: "bad session id" });
  if (!sendSessionInterrupt(id)) return sendJson(res, 409, { error: "session not running" });
  sendJson(res, 200, { ok: true });
}

// Feed: one true-internet source for flavour — the current Hacker News #1 story (keyless API).
// Polled server-side so the browser stays a pure SSE consumer like every other feed.
function startHnFeed(): void {
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
// The account-level plan windows (5-hour session + weekly all-models / Sonnet / Opus) the TUI's
// /usage shows. There is NO local mirror of these, so this polls Anthropic's (undocumented) OAuth
// usage endpoint server-side with the locally-stored OAuth token and republishes the result as the
// off-log `usage` feed — same channel-1 seam as git HEAD / HN, never the canvas log. Two properties
// make this safe to run unattended (the user's stated concern, "is polling ok and free"):
//   • FREE in tokens: it's a METERING call — it reports window utilization and runs no inference, so
//     it consumes none of the budget it measures.
//   • BOUNDED on rate: the endpoint throttles per access-token; the community-safe cadence is 180s
//     WITH a `claude-code/<version>` User-Agent (omitting it trips an aggressive 429 bucket). We back
//     off on 429 and keep the last good value so a throttle never blanks the card.
// The token stays SERVER-SIDE: it sets the Authorization header and is never published on any feed.

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

// The required `claude-code/<version>` User-Agent. Resolved once from `claude --version` (so it tracks
// the installed CLI), cached, with a plain fallback if claude isn't on PATH — the prefix is what the
// endpoint gates on, not the exact version.
let claudeUA: string | null = null;
function claudeUserAgent(): Promise<string> {
  if (claudeUA) return Promise.resolve(claudeUA);
  return new Promise((resolve) => {
    execFile("claude", ["--version"], (err, stdout) => {
      const v = (!err && stdout.match(/\d+\.\d+\.\d+/)?.[0]) || "2.0.0";
      resolve((claudeUA = `claude-code/${v}`));
    });
  });
}

const USAGE_POLL_MS = 180_000; // 3 min — safe with the User-Agent; faster trips the 429 bucket
function startUsageFeed(): void {
  let backoff = 0; // extra ms added after a 429, cleared on the next success
  const last = () => (feedValues.get("usage") as Record<string, unknown> | undefined) ?? {};
  const poll = async () => {
    let nextDelay = USAGE_POLL_MS;
    try {
      const token = await readClaudeOAuthToken();
      if (!token) {
        publishFeed("usage", { error: "no-credentials", fetchedAt: Date.now() });
      } else {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": await claudeUserAgent(),
            "Content-Type": "application/json",
          },
        });
        if (res.status === 429) {
          // Throttled — keep the last good windows, just flag it, and wait longer next time.
          backoff = Math.min(backoff ? backoff * 2 : USAGE_POLL_MS, 15 * 60_000);
          nextDelay = USAGE_POLL_MS + backoff;
          publishFeed("usage", { ...last(), error: "rate-limited", fetchedAt: Date.now() });
        } else if (!res.ok) {
          // 401 ⇒ token expired/needs re-auth; anything else ⇒ the endpoint changed or is down.
          publishFeed("usage", { ...last(), error: `http-${res.status}`, fetchedAt: Date.now() });
        } else {
          backoff = 0;
          const data = (await res.json()) as Record<string, unknown>;
          publishFeed("usage", { ...data, error: null, fetchedAt: Date.now() });
        }
      }
    } catch {
      publishFeed("usage", { ...last(), error: "offline", fetchedAt: Date.now() });
    }
    setTimeout(poll, nextDelay); // recursive (not setInterval) so backoff can stretch the gap
  };
  void poll();
}

// ── weather (card-types/weather): Open-Meteo, keyed by a free-text location ──────────────────────
// GET /api/weather?q=<place> → geocode the place (Open-Meteo geocoding, keyless) then fetch its current
// conditions (Open-Meteo forecast, keyless). Done SERVER-SIDE so the card interior never touches the
// public internet (the card-type contract: external data is polled by the host, the interior reads a
// granted signal) and there's no API key or CORS to handle in the browser. Cached per normalized query
// with a short TTL: weather drifts slowly and the public endpoint asks callers to be gentle, so a fleet
// of cards (or a tab reopen) collapses onto one fetch per location per window. Never throws to the
// client — an unresolved place or an offline upstream comes back as a 200 with an `error` tag the card
// renders as a message, mirroring the usage feed's last-good-with-an-error-pill discipline.
interface WeatherCacheEntry {
  ts: number;
  data: unknown;
}
const weatherCache = new Map<string, WeatherCacheEntry>();
const WEATHER_TTL_MS = 10 * 60_000;

async function handleWeather(res: ServerResponse, q: string): Promise<void> {
  const query = q.trim();
  if (!query) return sendJson(res, 200, { q, resolved: false, error: "no-location", fetchedAt: Date.now() });
  const key = query.toLowerCase();
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.ts < WEATHER_TTL_MS) return sendJson(res, 200, hit.data);

  const cache = (data: unknown): void => void weatherCache.set(key, { ts: Date.now(), data });
  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
    );
    const geo = (await geoRes.json()) as { results?: Array<Record<string, unknown>> };
    const loc = geo.results?.[0];
    if (!loc) {
      const data = { q: query, resolved: false, error: "not-found", fetchedAt: Date.now() };
      cache(data); // a misspelling shouldn't re-hit the geocoder every refresh tick
      return sendJson(res, 200, data);
    }
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&timezone=auto`,
    );
    const wx = (await wxRes.json()) as {
      current?: Record<string, number | string>;
      current_units?: Record<string, string>;
    };
    const c = wx.current ?? {};
    const u = wx.current_units ?? {};
    const data = {
      q: query,
      resolved: true,
      name: loc.name as string,
      country: (loc.country as string | undefined) ?? undefined,
      admin1: (loc.admin1 as string | undefined) ?? undefined,
      latitude: lat,
      longitude: lon,
      current: {
        temperature: Number(c.temperature_2m),
        apparentTemperature: Number(c.apparent_temperature),
        humidity: Number(c.relative_humidity_2m),
        windSpeed: Number(c.wind_speed_10m),
        weatherCode: Number(c.weather_code),
        isDay: Number(c.is_day) === 1,
        time: String(c.time ?? ""),
      },
      units: { temperature: u.temperature_2m ?? "°C", windSpeed: u.wind_speed_10m ?? "km/h" },
      error: null,
      fetchedAt: Date.now(),
    };
    cache(data);
    sendJson(res, 200, data);
  } catch {
    // offline / upstream down — serve the last good reading with a staleness tag if we have one, else
    // a bare offline marker. Either way a 200 the card can render, never a 5xx it would have to special-case.
    const stale = weatherCache.get(key);
    if (stale) return sendJson(res, 200, { ...(stale.data as object), error: "offline", fetchedAt: Date.now() });
    sendJson(res, 200, { q: query, resolved: false, error: "offline", fetchedAt: Date.now() });
  }
}

function startFeeds(): void {
  if (fsState.feedsStarted) return;
  fsState.feedsStarted = true;
  startGitHeadFeed(ROOTS.repo!);
  startHnFeed();
  startUsageFeed();
  startCardTypesFeed();
}

// ── card types (card-types-as-data.md §3/§7: type definitions are data in the folder) ──────────
// The type registry's server half: list card-types/*/ (type.yaml + the render.js the browser will
// import()), and watch the folder so a template edit on disk reaches the canvas live. The change
// notification rides the EXISTING feed bus ("cardtypes") — a template edit is just one more named
// off-log event the client turns into a signal; the browser-side registry re-imports the module.

const CARD_TYPES_DIR = path.resolve(here, "card-types");

function handleCardTypesList(res: ServerResponse): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(CARD_TYPES_DIR, { withFileTypes: true });
  } catch {
    // no card-types folder yet — an empty registry, not an error
  }
  const types = entries
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const yaml = readText(path.join(CARD_TYPES_DIR, e.name, "type.yaml"));
      return yaml ? [{ type: e.name, yaml: yaml.content }] : [];
    });
  sendJson(res, 200, { types });
}

// Serve card-types/* RAW — straight off disk, Cache-Control: no-store, never through Vite's
// transform pipeline. The pipeline caches per module and only Vite's own watcher invalidates that
// cache, so a feed-triggered re-import racing that watcher could be served the PREVIOUS code (the
// "save twice" dropped-update bug — two independent chokidars, no ordering). A template is runtime
// data under the v1 contract — plain ESM importing only /vendor/lit-html.js — so the bundler has
// nothing to add: read the file, send it, fresh every request. Read in FULL (not via readText, whose
// MAX_BYTES preview cap is for file-card bodies) — a template is code the browser must parse, and a
// truncated module is a syntax error.
function handleCardTypeAsset(res: ServerResponse, pathname: string): void {
  const rel = decodeURIComponent(pathname.slice("/card-types/".length));
  const abs = path.resolve(CARD_TYPES_DIR, rel);
  if (!abs.startsWith(CARD_TYPES_DIR + path.sep)) return sendJson(res, 400, { error: "bad path" });
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "Content-Type": abs.endsWith(".js") ? "text/javascript" : "text/plain",
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function startCardTypesFeed(): void {
  let t: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  chokidar.watch(CARD_TYPES_DIR, { ignoreInitial: true }).on("all", (_ev, abs) => {
    pending = path.relative(CARD_TYPES_DIR, abs);
    if (t) clearTimeout(t);
    t = setTimeout(() => publishFeed("cardtypes", { path: pending, ts: Date.now() }), 100);
  });
}

// ── agent bus (demo §10 step 4: the MCP server's dress rehearsal) ───────────────────────────────
// In-band agent interaction over plain HTTP. An agent POSTs a Command to /api/command; the server
// forwards it over SSE (/api/bus) to the browser, which runs it through editor.commit — the SAME
// validated mutation surface a gesture uses, attributed by `actor`. The browser pushes its snapshot
// + recent intent back to POST /api/canvas (debounced), so GET /api/canvas is the agent's read side.
// The server is a dumb relay: it holds no canvas state of its own, just the browser's last push.
//
//   GET  /api/bus      → text/event-stream of Command frames (browser subscribes)
//   POST /api/command  → { type, payload?, actor? } forwarded to every connected browser
//   POST /api/canvas   → browser's { snapshot, recentIntent, ts } (stored verbatim)
//   GET  /api/canvas   → that last push, or 404 until a browser has connected

const busClients = new Set<SseClient>();
let lastCanvasPush: string | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let cmd: { type?: unknown };
  try {
    cmd = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  if (typeof cmd.type !== "string") return sendJson(res, 400, { error: "missing command type" });
  const frame = `data: ${JSON.stringify(cmd)}\n\n`;
  for (const c of busClients) c.res.write(frame);
  // delivered=0 tells the agent no canvas is listening — the command went nowhere.
  sendJson(res, busClients.size > 0 ? 200 : 503, { ok: busClients.size > 0, delivered: busClients.size });
}

async function handleCanvasPush(req: IncomingMessage, res: ServerResponse): Promise<void> {
  lastCanvasPush = await readBody(req);
  sendJson(res, 200, { ok: true });
}

function handleCanvasGet(res: ServerResponse): void {
  if (lastCanvasPush == null) return sendJson(res, 404, { error: "no canvas has pushed state yet" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(lastCanvasPush);
}

export function fsApi(): Plugin {
  return {
    name: "canvas-fs-spike-api",
    // A render.js edit must reach the canvas ONLY via the cardtypes feed → cache-busted re-import
    // (templates.ts) — that path updates the one card in place. Since handleCardTypeAsset serves the
    // folder raw, these files never enter Vite's module graph and Vite has nothing to hot-update;
    // this hook is the explicit guard for the one way they still could (a stray static import from
    // app code), where Vite's no-accept-handler fallback would be a full page reload — which drops
    // the in-memory camera.
    handleHotUpdate(ctx) {
      if (ctx.file.startsWith(CARD_TYPES_DIR + path.sep)) return [];
    },
    configureServer(server: ViteDevServer) {
      startFeeds();
      server.middlewares.use((req, res, next) => {
        if (!req.url || !(req.url.startsWith("/api/") || req.url.startsWith("/card-types/")))
          return next();
        const url = new URL(req.url, "http://localhost");
        if (url.pathname.startsWith("/card-types/")) return handleCardTypeAsset(res, url.pathname);

        // Root-less endpoints first: feeds and the agent bus aren't scoped to a dataset.
        if (url.pathname === "/api/feeds") return handleFeeds(req, res);
        if (url.pathname === "/api/session/spawn" && req.method === "POST")
          return void handleSessionSpawn(req, res);
        const inputMatch = /^\/api\/session\/([\w-]+)\/input$/.exec(url.pathname);
        if (inputMatch && req.method === "POST") return void handleSessionInput(req, res, inputMatch[1]!);
        const resumeMatch = /^\/api\/session\/([\w-]+)\/resume$/.exec(url.pathname);
        if (resumeMatch && req.method === "POST") return handleSessionResume(res, resumeMatch[1]!);
        const interruptMatch = /^\/api\/session\/([\w-]+)\/interrupt$/.exec(url.pathname);
        if (interruptMatch && req.method === "POST") return handleSessionInterrupt(res, interruptMatch[1]!);
        if (url.pathname === "/api/session") return handleSession(res, url.searchParams.get("id"));
        if (url.pathname === "/api/sessions") return handleSessions(res);
        if (url.pathname === "/api/card-types") return handleCardTypesList(res);
        if (url.pathname === "/api/bus") return void openSse(req, res, busClients);
        if (url.pathname === "/api/command" && req.method === "POST") return void handleCommand(req, res);
        if (url.pathname === "/api/canvas" && req.method === "POST") return void handleCanvasPush(req, res);
        if (url.pathname === "/api/canvas") return handleCanvasGet(res);
        if (url.pathname === "/api/weather") return void handleWeather(res, url.searchParams.get("q") ?? "");

        const root = rootDir(url.searchParams.get("root"));
        if (!root) return sendJson(res, 400, { error: "unknown root" });

        if (url.pathname === "/api/ls")
          return handleLs(res, root, url.searchParams.get("path") ?? "");
        if (url.pathname === "/api/file") return handleFile(res, root, url.searchParams.get("path") ?? "");
        if (url.pathname === "/api/watch") return handleWatch(req, res, root);
        return next();
      });
    },
  };
}
