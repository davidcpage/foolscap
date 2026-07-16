import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { getPendingHistoryMode, getPendingPermissions, getServerContext } from "./server-context.js";
import { markCanvasSession, projectsDirForCwd, readCanvasSession, recordSessionEnd, updateCanvasSession } from "./session-ledger.js";
import { localProc, remoteProc, type ClaudeSpawnSpec, type ProcHooks, type SpawnSpec } from "./session-proc.js";
import { connectSessionHost, type SessionHostClient, type HostSessionInfo } from "./session-host-client.js";
import { sessionHostSocketPath } from "./session-host-protocol.js";
import { listThreads, ownBlockedIntentKeys, readThreadMeta, sessionDeclaredDone, sessionIdleIntent, upsertThreadMeta, type ThreadMetaMarker } from "./thread-ledger.js";
import { intentLine } from "./work-intent.js";
import { claimSurface, reapKeepAliveMs, releaseSurface, shouldReapIdle } from "./auto-wake.js";
import { idleBand, shouldRepublishBand } from "./session-band-republish.js";
import { sessionHasScheduledWake } from "./standing-jobs.js";
import { readRole } from "./role-ledger.js";
import { ensureWorktree, listWorktrees as listThreadWorktrees, workItemKey, worktreeOnboarding } from "./worktrees.js";
import { sendJson } from "./server-http.js";
import { isTmpdirRepo } from "./server-boards.js";
import type { LiveSession, SessionBand } from "./server-types.js";

// ── the session / spawn / host ENGINE (P5 sub-step 2) ───────────────────────────────────────────────────
// The second ENGINE module of the P5 god-file split (after server-delivery.ts). It owns the live-session
// REGISTRY and the session-host client: spawning/adopting a real `claude -p` child, folding its stdout into
// the card feed, the band/status reconcile loop, the idle-worker reaper, process control (input/interrupt/
// teardown), and the server-side spawn engine (worktree cwd resolution, worker-card placement, the auto-wake
// primitive). It reaches the shared cross-request state (the live-session registry, fsState maps, the board/
// thread resolvers, the delivery/wake ops, the shadow-git fold) THROUGH getServerContext() — the same pinned
// singletons the shell holds, injected once via setServerContext at plugin load. server-context.ts stays
// type-imports only, so there is no runtime import cycle: this module imports the accessor (a value) from
// server-context but only TYPES from vite-fs-plugin. Each moved function is byte-identical to its former shell
// definition save for a getServerContext()/binding preamble at its top; the private helpers moved with them.

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveClaudeCommand(): string {
  const configured = process.env.CANVAS_CLAUDE_COMMAND;
  const candidates = [
    configured,
    ...String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "claude")),
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
  ].filter((x): x is string => !!x);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. A configured but missing command is reported by the common error below.
    }
  }
  throw new Error(
    "Claude Code executable not found; install it, add it to PATH, or set CANVAS_CLAUDE_COMMAND",
  );
}

// ── spawn / permission constants (moved from the shell registry section) ─────────────────────
// PERMISSIONS (agent-sessions §9.3 — "the terminal runs code"). The spawned agent runs as you, in the
// repo, with this mode. A canvas session has no TTY to approve at, so "default" would STALL any
// tool-using turn (text-only answers still stream, but the §8 payoff — agent edits files → commits →
// the commit-watcher re-renders the cards live — never fires). "auto" lets it act unattended so a
// canvas session is genuinely a working agent; local-only solo, as §9.3 accepts. Dial to "default"
// (text only) or up to "bypassPermissions" (skip every check) here if that balance ever changes.
const SESSION_PERMISSION_MODE = "auto";

// BASELINE permission allow-list, ADDED to every spawn on top of `--permission-mode auto`. Allow-rules
// are ADDITIVE: we only ever grant explicit allows; anything without a rule still flows through the
// classifier exactly as before, so routine session changes never need hand-permissioning. The principle
// (see docs/agent-roles.md): capability is a UNIFORM baseline, NOT a second axis of role identity — a
// role is knowledge + memory + charter, not a permission set. So self-commit and spawning are normal for
// ANY session (ad-hoc sessions are the norm); only the RED LINE stays gated by the classifier — `git
// push`, destructive ops, out-of-scope or large/costly fan-out. `git commit` is decoupled from `push`.
// (A role may NARROW this in the rare case via a role.md override — deferred; not how roles normally
// differ.) Spawning rides the `scripts/canvas` wrapper so the gated /api/session/spawn curl is reachable
// without allowing `Bash(curl:*)` wholesale.
const BASELINE_ALLOWED_TOOLS = [
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(scripts/canvas:*)",
  "Bash(./scripts/canvas:*)",
].join(",");

// Permission prompts on the card (docs/threads-as-cards follow-on; the fix for the "a nod in the
// channel can't lift the builder's gate" problem): `--permission-prompt-tool` (documented CLI flag,
// v2.1.199+) routes every would-prompt permission check to an MCP tool instead of headless auto-deny.
// Ours is permission-prompt-mcp.js — a per-session stdio relay that POSTs /api/permission/request and
// waits; the server PARKS that request until a human clicks allow/deny ON THE SESSION CARD (the §16
// held-response pattern). Approval lands in the acting session's own permission flow — full trust, no
// channel relay. The RED LINE stays gated exactly as before; what changes is that a gate now surfaces
// as a clickable prompt instead of a silent denial. Hold is deliberately generous (a human may be away;
// the blocked turn is blocked on them regardless); the CLI-side MCP tool timeout must outlast it, so
// it's set a minute above via MCP_TOOL_TIMEOUT on the spawn env (sidecar pass-through — an OLD sidecar
// ignores env and the CLI's default tool timeout applies: prompts then die early but still fail closed).
// PERMISSION_HOLD_MS lives here (with settlePermission — the session-teardown path denies held prompts, so
// this engine owns them); the permission route handlers (routes/permissions.ts) import both back, and the
// spawn path below reads the hold to size MCP_TOOL_TIMEOUT a minute above it.
export const PERMISSION_HOLD_MS = 10 * 60_000;
const PERMISSION_TOOL = "mcp__canvas__permission_prompt"; // mcp__<server>__<tool> under --mcp-config's "canvas"

// Which Claude model a spawned session runs. Without an explicit `--model`, `claude -p` inherits
// ~/.claude/settings.json — on this machine that's Fable 5, so every implementation worker silently
// burned Fable quota (canvas-workers-fable-fallback-opus memory). Spawns therefore ALWAYS pass --model,
// resolved explicit spawn param > role `model:` frontmatter > this default: plain workers land on
// Opus 4.8, the Coordinator/pm role pins Fable via its frontmatter, and any spawn can override per-call.
export const DEFAULT_SESSION_MODEL = "claude-opus-4-8";

// The reasoning-effort levels the New-session menu offers and the two providers accept. `claude --effort`
// takes low|medium|high|xhigh|max; the Codex app-server `reasoningEffort` enum is a superset (it also has
// minimal/ultra, which we deliberately don't expose) — so this exact set is valid on BOTH providers with no
// per-provider mapping. Absent effort = the provider's own default (no flag / no `reasoningEffort` sent).
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Is `v` one of the reasoning-effort levels the spawn contract accepts? (spawn-body / role-frontmatter validation) */
export function isValidEffort(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

// A Claude model id is the `claude-*` family; anything else (Codex Sol/Terra/Luna, gpt-*) is a Codex model.
// This is the ONLY provider-membership test the resolver needs: an explicit model is trusted as-is (the
// picker offers only the current provider's models), but a role/default model is IGNORED on a provider
// mismatch so a Claude role's `model:` never gets sent to a Codex spawn (and vice versa).
function modelMatchesProvider(model: string, provider: "claude" | "codex"): boolean {
  const isClaude = model.startsWith("claude-");
  return provider === "claude" ? isClaude : !isClaude;
}

/**
 * The model a spawn runs, PROVIDER-AWARE: explicit spawn param > role `model:` frontmatter > provider
 * default. The role/default only applies when it matches the target provider — a Claude role model is
 * ignored on a Codex spawn and vice versa (the picker's explicit choice always matches, so it's trusted
 * as-is). Claude's default is DEFAULT_SESSION_MODEL; Codex has NO hardcoded default (absent stays absent —
 * the app-server picks the ChatGPT-plan default and we fold the ACTUAL serving model back from its events).
 * Returns null only for a Codex spawn with no explicit/role model.
 */
export function resolveSessionModel(
  explicit?: string | null,
  role?: { model?: string | null } | null,
  provider: "claude" | "codex" = "claude",
): string | null {
  if (explicit) return explicit;
  const roleModel = role?.model;
  if (roleModel && modelMatchesProvider(roleModel, provider)) return roleModel;
  return provider === "claude" ? DEFAULT_SESSION_MODEL : null;
}

/**
 * The reasoning effort a spawn runs: explicit spawn param > role `effort:` frontmatter > unset (null). The
 * levels are valid on both providers (EFFORT_LEVELS), so this is provider-agnostic; null means "send no
 * flag / no `reasoningEffort`" and the provider applies its own default.
 */
export function resolveSessionEffort(
  explicit?: string | null,
  role?: { effort?: string | null } | null,
): EffortLevel | null {
  const chosen = explicit || role?.effort || null;
  return isValidEffort(chosen) ? chosen : null;
}

// The full `claude -p` argv for a session spawn — extracted PURE so the spawn-arg contract (which model a
// child runs, which flags always ride) is testable without launching a process (session-spawn-model.test.mjs).
export function buildSessionArgs(opts: {
  id: string;
  resume: boolean;
  model: string;
  effort?: string | null;
  mcpConfig: unknown;
  settingsOverride: unknown;
  appendPrompt: string;
}): string[] {
  return [
    "-p",
    opts.resume ? "--resume" : "--session-id",
    opts.id,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model", opts.model, // always explicit — never inherit ~/.claude/settings.json (see DEFAULT_SESSION_MODEL)
    // Reasoning effort rides only when explicitly resolved (spawn param / role `effort:`); absent = the CLI's
    // own default effort, so no flag (resolveSessionEffort → null). One of low|medium|high|xhigh|max.
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--permission-mode", SESSION_PERMISSION_MODE,
    "--allowedTools", BASELINE_ALLOWED_TOOLS, // uniform baseline (commit + scripts/canvas), additive over auto
    "--disallowedTools", "AskUserQuestion", // auto-cancels here; steer to the ```ask convention instead
    "--mcp-config", JSON.stringify(opts.mcpConfig),
    "--settings", JSON.stringify(opts.settingsOverride), // built-in memory → .canvas/memory (additive over project settings)
    "--permission-prompt-tool", PERMISSION_TOOL, // gate hits → the card's allow/deny, not silent denial
    "--append-system-prompt", opts.appendPrompt,
  ];
}

// AskUserQuestion is auto-cancelled in `-p` headless mode (VERIFIED: the CLI synthesises an
// is_error="Answer questions?" tool_result and continues — it never waits for an answer on stdin, so
// there's no tool_result loop to hook). So we DISALLOW it (below) and steer the session to a convention
// the card CAN render+answer over the existing input duplex: a fenced ```ask block (same JSON shape as
// AskUserQuestion's input) that render.js turns into clickable options and answers as a normal user
// message. The disallow is the backstop; this prompt is the replacement. See askuserquestion memory.
// WORDING CONSTRAINT: this prompt must NOT name AskUserQuestion or say "the tool is unavailable,
// emit its shape as text" — that pairing reads as tool-spoofing to Fable 5's safety classifiers and
// silently demoted EVERY spawned worker to Opus 4.8 via refusal-fallback + sticky routing (bisected
// with one-turn `claude -p` probes; see canvas-workers-fable-fallback-opus memory). Describe the
// board's own feature instead; the disallow flag alone keeps the tool out of reach.
const ASK_CONVENTION =
  "MULTIPLE-CHOICE QUESTIONS: This board renders interactive option buttons from a fenced code block. " +
  "When you want the user to pick between options, do not ask in prose — emit a fenced code block " +
  "whose info string is `ask` and whose body is a single JSON object of this shape:\n\n" +
  "```ask\n" +
  '{"questions":[{"question":"<the question>","header":"<≤12 char label>","multiSelect":false,' +
  '"options":[{"label":"<short choice>","description":"<what it means / the tradeoff>"}]}]}\n' +
  "```\n\n" +
  "`questions` is an ARRAY: to ask more than one thing at once, put every question as its own object in " +
  "that SAME array inside ONE ```ask block — do NOT emit a second ```ask block (only the first is " +
  "interactive; later ones render as dead text). They are then answered together. Example with two:\n\n" +
  "```ask\n" +
  '{"questions":[' +
  '{"question":"Which color?","header":"Color","multiSelect":false,"options":[{"label":"red"},{"label":"blue"}]},' +
  '{"question":"Which size?","header":"Size","multiSelect":false,"options":[{"label":"S"},{"label":"L"}]}' +
  "]}\n" +
  "```\n\n" +
  "The app renders this as clickable buttons and sends the user's selection back as their next message. " +
  "Emit the ```ask block as the LAST thing in your turn, then stop and wait for the reply. Keep option " +
  "labels short and put the rationale in `description`. Use it whenever the answer is a choice among options.";

// ── Session-host mode (the DEFAULT): session processes live in a sidecar, survive dev-server restarts ──
// The sidecar (session-host.js) is auto-started on first attach and OWNS the `claude -p` children; this
// server is a client. Restarting the dev server no longer kills the very sessions implementing/testing
// the change being tested — on boot we re-attach and ADOPT whatever is still running. Stopping the
// SIDECAR is the explicit stop-everything (`npm run session-host:stop`). Opt OUT with
// `CANVAS_SESSION_HOST=0` (`npm run dev:local`) for the old in-process, die-with-the-server model —
// and an unreachable/busy sidecar degrades to that model by itself (see attachSessionHost).
const REMOTE_SESSIONS = process.env.CANVAS_SESSION_HOST !== "0";

// Map a session's process cwd back to its CANONICAL board root. A worktree session runs in
// `<canonical>/.canvas/worktrees/<key>` (a deterministic location we own), so its board home — where the
// `.canvas/` markers/threads/memory live — is the path before `/.canvas/worktrees/`. Any other cwd IS the
// board root. Used on adoption after a restart, where the sidecar hands back the process cwd (the worktree)
// but the marker/threads must still resolve against the canonical checkout.
function boardRootForCwd(cwd: string): string {
  const marker = `${path.sep}.canvas${path.sep}worktrees${path.sep}`;
  const i = cwd.indexOf(marker);
  return i === -1 ? cwd : cwd.slice(0, i);
}

// The CANVAS COLLABORATION BRIEF: an appended system-prompt block that tells a canvas-spawned session
// where it is running and how to coordinate with peers through THREADS (threads-as-cards.md — the per-task
// container that replaced the long-lived channel; the machinery is identical). The agent learns its own
// identity (board id, session id, server origin) — all known at spawn — so the protocol is concrete, not
// "discover the port yourself". Two jobs: TEACH the mechanics (read the board, join/post/read a thread) and
// SET NORMS (coordinate & propose; don't execute large/irreversible work without a human nod). The agent
// works in thread ids + its own sid — the server handles node/edge ids.
// The collaboration/harness brief lives in editable `app/harness.md` (git-tracked, alongside this file) so
// it can be iterated on in-repo. It carries {{base}}/{{boardId}}/{{sessionId}} placeholder tokens that are
// interpolated at spawn time here. Read fresh each call (no cache) — iteration ease is the point.
function collabBrief(boardId: string, sessionId: string, origin: string): string {
  const base = `http://${origin}`;
  return fs
    .readFileSync(path.join(here, "harness.md"), "utf8")
    .replaceAll("{{base}}", base)
    .replaceAll("{{boardId}}", boardId)
    .replaceAll("{{sessionId}}", sessionId)
    // Absolute path of the dir holding harness.md (= the app/ dir). Lets the core brief point at the
    // on-demand leaf recipes (`{{harnessDir}}/harness/thread-comms.md`) with a path a worker can Read
    // from any board's cwd. Leaves are Read RAW — collabBrief does NOT interpolate them, so they carry
    // no {{...}} tokens of their own.
    .replaceAll("{{harnessDir}}", here);
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

export function ensureSessionFeed(dir: string, id: string, repoPath: string): void {
  const { liveSessions, fsState, publishFeed } = getServerContext();
  const { sessionWatchers } = fsState;
  // A registry-OWNED, still-LIVE session (slice 2: we spawned the process) publishes session:<id> from
  // the live PROCESS stream (finer, token-level) — don't also tail its .jsonl, or two publishers fight on
  // one feed and the turn-granular file would clobber the token-granular stdout. But once that process has
  // EXITED — a canvas session whose dev server was cold-restarted (the kill-hook ends the child), or one
  // that simply finished — the entry no longer publishes, so its transcript card would be stuck on the
  // last live frame with no way to show what's on disk. Fall through to the file-tail then, so the card
  // shows the full, current transcript (where you left off) until you Resume it. (An ABSENT entry — the
  // common cold-restart case, registry empty in the fresh process — falls through too.) The feed name is
  // board-free (session ids are globally-unique UUIDs); the file lives in this board's transcripts `dir`.
  const owned = liveSessions.get(id);
  if (owned && owned.status !== "exited") return; // a live process owns the feed — don't double-publish
  if (sessionWatchers.has(id) || !/^[\w-]+$/.test(id)) return;
  const feed = "session:" + id;
  const publish = () => {
    const r = readSessionFile(dir, id);
    // Stamp `ended:true`: by construction this file-tail path only runs for a session with NO live process
    // (the early return above bows out for a live-owned one), and externals are filtered out entirely, so a
    // tail here is always a dead canvas transcript — no mtime heuristic needed. The card reads this to paint
    // the muted "inactive" band instead of guessing "live" from a status-less feed. Phase 2: carry the
    // durable end REASON off the marker too, so a post-restart card still splits "✓ done" from "✕ crashed"
    // (the in-memory s.endReason is gone after a restart — the marker on disk is the only surviving source).
    // Carry the durable model/effort/provider off the marker so a post-restart / Done file-tail card still
    // renders the tinted model pill + effort suffix — they lived only in the live registry before, which is
    // why the pill vanished on Done. Only the marker survives the process, so it's the honest source here.
    const marker = readCanvasSession(repoPath, id);
    const endReason = marker?.endReason as string | undefined;
    if (r) publishFeed(feed, {
      ...r, ended: true, endReason,
      provider: marker?.provider === "codex" ? "codex" : "claude",
      model: (marker?.model as string | undefined) ?? undefined,
      effort: (marker?.effort as string | undefined) ?? undefined,
    });
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
    .watch(path.resolve(dir, id + ".jsonl"), { ignoreInitial: true })
    .on("all", debounced);
  sessionWatchers.set(id, watcher);
  publish(); // seed the feed so a fresh subscriber renders immediately (replayed on SSE connect too)
}

// Stop the out-of-band file-tail for `id`. Called when the registry takes the session live (resume):
// `--resume` appends to the SAME .jsonl, so a surviving turn-granular file watch would clobber the
// registry's token-granular stream on the shared feed — the "two publishers fight" the comment above
// warns about. The startup guard only prevents a NEW watch; this closes an EXISTING one.
function stopSessionFeed(id: string): void {
  const { sessionWatchers } = getServerContext().fsState;
  const w = sessionWatchers.get(id);
  if (w) {
    void w.close();
    sessionWatchers.delete(id);
  }
}

// The full prompt size a usage object represents: fresh input plus both cache tiers. This is the
// "context" number — it grows through a turn as the transcript accretes — not the (small) uncached
// `input_tokens` alone. Tolerant of the partial usage on a `message_start` (cache fields may be absent).
function ctxOf(u: any): number {
  if (!u || typeof u !== "object") return 0;
  return (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0);
}

const codexUserText = (content: unknown): string => Array.isArray(content)
  ? content.map((p: any) => p?.type === "text" ? (p.text ?? "")
    : p?.type === "image" || p?.type === "localImage" ? "[image attached]"
    : p?.type === "skill" ? `[skill: ${p.name ?? p.path ?? "attached"}]`
    : "").filter(Boolean).join("\n")
  : "";

/** Complete provider-authored thread/read projection into the existing session-card message codec. */
export function projectCodexHistory(result: any): {
  lines: string[];
  error: string | null;
} {
  const lines: string[] = [];
  let error: string | null = null;
  const assistant = (content: any[]) => lines.push(JSON.stringify({
    type: "assistant", message: { role: "assistant", content },
  }));
  for (const turn of result?.thread?.turns ?? []) {
    for (const item of turn?.items ?? []) {
      if (item?.type === "userMessage") {
        const text = codexUserText(item.content);
        if (text) lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
      } else if (item?.type === "agentMessage" && typeof item.text === "string") {
        assistant([{ type: "text", text: item.text }]);
      } else if (item?.type === "reasoning") {
        const thinking = [...(item.summary ?? []), ...(item.content ?? [])].filter((x) => typeof x === "string").join("\n");
        if (thinking) assistant([{ type: "thinking", thinking }]);
      } else if (item?.type === "plan" && typeof item.text === "string") {
        assistant([{ type: "text", text: item.text }]);
      } else {
        const activity = codexActivityBlock(item);
        if (activity) {
          assistant([activity]);
          lines.push(JSON.stringify({
            type: "user",
            message: { role: "user", content: [{
              type: "tool_result", tool_use_id: activity.id, content: codexActivityResult(item),
            }] },
          }));
        }
      }
    }
    if (turn?.status === "failed") error = String(turn.error?.message ?? turn.error ?? "Codex turn failed");
  }
  return { lines, error };
}

function seedCodexHistory(s: LiveSession, result: any): void {
  if (s.lines.length) return;
  const projected = projectCodexHistory(result);
  s.lines.push(...projected.lines);
  if (projected.error) s.error = projected.error;
}

function foldCodexEvent(s: LiveSession, e: any): void {
  const { flushNudge } = getServerContext();
  const p = e?.params ?? {};
  switch (e?.method) {
    case "canvas/provider-bound":
      s.providerSessionId = typeof p.providerSessionId === "string" ? p.providerSessionId : s.providerSessionId;
      // The app-server's resolved serving model (from thread/start): fold it so a Codex spawn with no explicit
      // model still shows what it ran — the previously-blank Codex pill — and doesn't overwrite an explicit
      // model with a blank. Only take a real string.
      if (typeof p.model === "string" && p.model) s.model = p.model;
      updateCanvasSession(s.repoPath, s.id, {
        provider: "codex",
        providerSessionId: s.providerSessionId,
        ...(s.model ? { model: s.model } : {}), // durable serving model → the pill survives Done
        // Plan provenance is durable; the signed-in email is deliberately not copied into the repo marker.
        codexAccount: p.account
          ? { type: p.account.type, planType: p.account.planType }
          : null,
      });
      break;
    case "canvas/history":
      seedCodexHistory(s, p);
      break;
    case "turn/started":
      resumeRunning(s);
      s.verb = "Thinking";
      s.error = null;
      break;
    case "item/agentMessage/delta": {
      const itemId = typeof p.itemId === "string" ? p.itemId : "agent-message";
      if (!s.inflight || s.inflight[0]?.id !== itemId)
        s.inflight = [{ type: "text", text: "", id: itemId }];
      s.inflight[0].text = (s.inflight[0].text ?? "") + (typeof p.delta === "string" ? p.delta : "");
      s.verb = "Responding";
      resumeRunning(s);
      break;
    }
    case "item/started": {
      const activity = codexActivityBlock(p.item);
      if (activity) s.inflight = [activity];
      if (p.item?.type === "commandExecution") s.verb = "Running";
      else if (p.item?.type === "fileChange") s.verb = "Editing";
      else if (p.item?.type === "mcpToolCall") s.verb = "Using tool";
      resumeRunning(s);
      break;
    }
    case "item/completed":
      if (p.item?.type === "agentMessage" && typeof p.item.text === "string") {
        s.lines.push(JSON.stringify({
          type: "assistant", message: { role: "assistant", content: [{ type: "text", text: p.item.text }] },
        }));
        s.inflight = null;
      } else {
        const activity = codexActivityBlock(p.item);
        if (activity) {
          s.lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [activity] } }));
          s.lines.push(JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: activity.id, content: codexActivityResult(p.item) }] },
          }));
          s.inflight = null;
        }
      }
      break;
    case "turn/plan/updated":
      s.plan = (p.plan ?? []).map((x: any) => ({ step: String(x.step ?? ""), status: x.status }));
      break;
    case "thread/tokenUsage/updated": {
      const last = p.tokenUsage?.last;
      if (last) s.usage = { input: Number(last.inputTokens) || 0, output: Number(last.outputTokens) || 0 };
      break;
    }
    case "turn/completed":
      s.inflight = null;
      s.status = "idle";
      s.verb = null;
      if (s.autoWake) s.idleSince = Date.now();
      persistServingState(s); // make the folded Codex serving model durable so the pill survives Done
      if (s.nudge) flushNudge(s);
      if (p.turn?.status === "failed") {
        s.error = String(p.turn?.error?.message ?? p.turn?.error ?? "Codex turn failed");
      }
      break;
    case "thread/status/changed":
      if (p.status?.type === "active") resumeRunning(s);
      else if (p.status?.type === "idle" || p.status?.type === "notLoaded") {
        s.status = "idle";
        s.verb = null;
      }
      break;
    case "canvas/error":
      s.status = "idle";
      s.verb = null;
      s.error = typeof p.message === "string" ? p.message : "Codex session error";
      break;
    case "canvas/request":
      if (p.kind === "approval" && typeof p.requestId === "string") registerCodexPermission(s, p);
      else if (p.kind === "input" && typeof p.requestId === "string") {
        const questions = Array.isArray(p.questions) ? p.questions : [];
        const ask = questions.map((q: any) => ({
          question: q.question, header: q.header, multiSelect: false,
          options: Array.isArray(q.options) ? q.options : [],
        }));
        s.lines.push(JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `\`\`\`ask\n${JSON.stringify({ questions: ask })}\n\`\`\`` }] },
        }));
        s.inflight = null;
      }
      break;
    case "canvas/request-resolved": {
      const pending = getPendingPermissions(getServerContext().fsState);
      const held = pending.get(p.requestId);
      if (held?.providerRequestId) {
        clearTimeout(held.timer);
        pending.delete(p.requestId);
      }
      break;
    }
  }
}

function codexActivityBlock(item: any): any | null {
  if (!item || typeof item.id !== "string") return null;
  if (item.type === "commandExecution")
    return { type: "tool_use", id: item.id, name: "Bash", input: { command: item.command, cwd: item.cwd } };
  if (item.type === "fileChange")
    return { type: "tool_use", id: item.id, name: "Edit", input: { changes: item.changes } };
  if (item.type === "mcpToolCall")
    return { type: "tool_use", id: item.id, name: item.tool ?? item.name ?? "MCP", input: item.arguments ?? {} };
  // Preserve every remaining provider item instead of silently dropping it from resumed history. The
  // renderer already has a generic tool row; keep provider-private detail behind that debug-shaped input.
  if (typeof item.type === "string") {
    const { id, type, status, result, error, aggregatedOutput, output, ...input } = item;
    return { type: "tool_use", id, name: `Codex:${type}`, input };
  }
  return null;
}

function codexActivityResult(item: any): string {
  if (item?.type === "commandExecution") return String(item.aggregatedOutput ?? item.output ?? item.status ?? "completed");
  const value = item?.result ?? item?.error ?? item?.output ?? item?.status ?? "completed";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function registerCodexPermission(s: LiveSession, p: any): void {
  const pending = getPendingPermissions(getServerContext().fsState);
  if (pending.has(p.requestId)) return;
  const timer = setTimeout(
    () => settlePermission(p.requestId, { behavior: "deny" }),
    PERMISSION_HOLD_MS,
  );
  pending.set(p.requestId, {
    permId: p.requestId, sid: s.id, toolName: p.toolName ?? "Codex", input: p.input ?? {},
    ts: Date.now(), timer, providerRequestId: p.requestId,
  });
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
  const { foldShadowEdits, flushNudge } = getServerContext();
  if (e?.type === "codex_event") {
    foldCodexEvent(s, e);
    return;
  }
  // The harness advertises its skills in the `system`/`init` event that opens every `-p --output-format
  // stream-json` session. Capture the names so the card can offer `/`-completion. Framing only — nothing
  // folds into the transcript. VERIFIED LIVE 2026-06-20 against a real `claude -p` capture: the on-disk
  // .jsonl advertises skills as a `skill_listing` *attachment* (with a `names` array), but the live
  // stdout stream does NOT emit that attachment — the init event is the only live source. We take
  // `skills` (the curated Skill-tool set) rather than the wider `slash_commands` (which also carries
  // TUI-only built-ins like /clear,/config that are meaningless to pipe into a headless session).
  if (e?.type === "system" && e?.subtype === "init") {
    // The init frame names the REQUESTED model; each assistant message below then carries the model that
    // actually SERVED it (which differs after a refusal fallback, e.g. fable-5 → opus-4-8) and overwrites.
    if (typeof e.model === "string" && e.model) s.model = e.model;
    if (Array.isArray(e.skills)) s.skills = (e.skills as unknown[]).filter((n): n is string => typeof n === "string");
    return;
  }

  switch (e?.type) {
    case "assistant":
    case "user":
      // The authoritative completed message — keep the raw line; the codec reads it as-is. It lands
      // mid-stream (before content_block_stop), so clearing inflight here ends the live tail cleanly.
      if (e.message) s.lines.push(JSON.stringify({ type: e.type, message: e.message }));
      foldShadowEdits(s, e); // assistant tool_use → claim path; user tool_result → attributed commit (doc §6)
      s.inflight = null;
      resumeRunning(s); // idle→running: fold the transition (auto-freshen any blocked:* intent, part 2)
      // Bank this message's authoritative usage into the turn total (a `user` event mid-turn is a
      // tool_result — it carries no usage and must not reset the counter; the turn resets only when WE
      // inject the next prompt, in sendSessionInput). `verb` is left alone: between an assistant
      // tool_use and its result the process is executing the tool, so the tool's verb still holds.
      if (e.type === "assistant" && e.message?.usage) {
        s.turnOut += Number(e.message.usage.output_tokens) || 0;
        s.usage = { input: ctxOf(e.message.usage), output: s.turnOut };
      }
      // The serving model, authoritative per message — tracks a mid-session refusal fallback the moment
      // the first fallen-back message lands (the requested model from init is only the opening claim).
      if (e.type === "assistant" && typeof e.message?.model === "string" && e.message.model) s.model = e.message.model;
      break;
    case "result":
      s.inflight = null;
      s.status = "idle"; // turn finished; the process waits on stdin for the next prompt
      s.verb = null; // no live activity to label; keep `usage` so the pill shows the turn's final counts
      if (s.autoWake) s.idleSince = Date.now(); // start the R1 keep-alive clock for an auto-wake worker
      persistServingState(s); // the turn named the serving model — make it durable so the pill survives Done
      if (s.nudge) flushNudge(s); // a channel message arrived mid-turn → wake to read it at the boundary (§9)
      break;
    case "stream_event": {
      const ev = e.event;
      if (ev?.type === "message_start") {
        s.inflight = [];
        s.usage = { input: ctxOf(ev.message?.usage), output: s.turnOut };
        if (typeof ev.message?.model === "string" && ev.message.model) s.model = ev.message.model; // serving model, live
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
      if (ev?.type === "message_start" || ev?.type === "content_block_start") resumeRunning(s);
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
  // Claude Code stores transcripts per PROCESS working dir, so key off cwd (the worktree for a --worktree
  // session), not the canonical board root — else a worktree session's transcript wouldn't be found.
  const r = readSessionFile(sessionsDir(s.cwd), s.id);
  if (!r) return;
  for (const line of r.content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if ((e?.type === "user" || e?.type === "assistant") && e.message) {
        s.lines.push(JSON.stringify({ type: e.type, message: e.message }));
        // Recover the serving model from history too (last assistant message wins), so an adopted or
        // resumed session shows its model chip before its first new turn.
        if (e.type === "assistant" && typeof e.message.model === "string" && e.message.model) s.model = e.message.model;
      }
    } catch {
      // a non-JSON framing line or a ragged tail — skip, same tolerance as the codec
    }
  }
}

// Spawn (or, when `resume`, continue) a Claude Code process under id and wire its stdout to the feed.
// Idempotent per id: a second call returns the existing live session. The process owns its own
// `.jsonl`; we only read its stdout — never write the transcript ourselves (the agent authors it, §5).
// Appended when a session is spawned INTO a channel as a worker. Its task is NOT carried in the spawn
// prompt — that would be an invisible stdin DM, off the legible channel and special-casing the first
// instruction. Instead the assignment arrives as a normal, logged channel message tagged to it. This block
// tells the worker to expect that and — crucially — NOT to wind down before it arrives (the failure mode
// that made a stood-down session re-finish on nothing). Its inbox cursor is seeded to the channel tail at
// spawn (handleSessionSpawn), so the first thing it reads is its assignment, not the backlog.
function workerBrief(threadId: string): string {
  return [
    `YOUR ASSIGNMENT. You were spawned as a worker for thread ${threadId}. Your task is NOT in this prompt —`,
    "it arrives as a THREAD MESSAGE tagged to you. Read it with GET /api/inbox (the most recent message",
    "addressed to you is your assignment); if your inbox is empty it is on its way — stay idle and you'll be",
    "nudged when it lands. Do NOT wind down (/done) until you have received AND completed a task. Read the",
    "thread's brief for context, claim files before editing, and report back in the thread.",
  ].join("\n");
}

// Flip a live session to `running`, firing the idle→running side effects exactly ONCE on the transition
// (the guard makes a mid-turn running-set — every assistant/stream event — a no-op, so the thread sweep
// runs at most once per turn-start, not per event). The single chokepoint for "the process resumed".
function resumeRunning(s: LiveSession): void {
  if (s.status === "running") return;
  s.status = "running";
  try {
    clearBlockedIntents(s.repoPath, s.id);
  } catch {
    /* best-effort — part 1's live pill fusion already covers the running view */
  }
}

// Part 2 — the work-intent self-freshen. A session going idle→running means a wake landed and it is
// computing again: the block (if any) has been ANSWERED, so no agent action is needed to retire it. Sweep
// every thread this session participates in and auto-transition any `blocked:*` it declared → `working`.
// Recording it as a real intent act (a kind:"intent" log entry + the marker slot) freshens BOTH surfaces
// uniformly — the roster pill (reads the log) and the rail state / deriveThreadState (reads the marker) —
// with a provenance note, and it converges (the next resume finds nothing). Part 1's pill fusion shows 'working'
// WHILE running; this makes the durable record honest so it doesn't snap back to a stale 'blocked' the
// moment the process idles again. Best-effort: a failure just leaves the (live-covered) view to part 1.
function clearBlockedIntents(repoPath: string, sid: string): void {
  const { boardIdentity, appendThreadMsg } = getServerContext();
  const boardId = boardIdentity(repoPath).boardId;
  for (const meta of listThreads(repoPath)) {
    // ownBlockedIntentKeys is the pure (unit-tested) detection half — which of this thread's intent slots
    // hold a block THIS session itself declared (never another occupant's sacred, seat-inherited block).
    const keys = ownBlockedIntentKeys(meta.intents, sid);
    if (!keys.length) continue;
    const threadId = meta.threadId;
    // Append the freshening as a real intent act (kind:"intent" → renders on the thread + roster pill,
    // wakes no one) so the pill (which reads the log) un-stales; then overwrite the SAME marker slot(s) the
    // block sat in — the exact keys, not a re-derived seat key, so a sid-keyed block can't be stranded —
    // so the rail state / deriveThreadState (which reads the marker) agrees. Both surfaces freshen
    // uniformly, with a provenance note. Converges: the next resume finds nothing left to clear.
    // Best-effort (as this whole freshen is): appendThreadMsg throws on a durable failure (BUG-6), but a
    // failed auto-freshen line must not break the per-thread loop or the resume — part 1's live pill still
    // covers the view. Log it and move on to the next thread.
    let msg;
    try {
      msg = appendThreadMsg(boardId, threadId, sid, intentLine("working", "auto: resumed — block answered"), {
        kind: "intent",
        intent: "working",
      });
    } catch (e) {
      console.warn(`[thread] auto-resume intent for ${sid} on ${threadId} not persisted:`, (e as Error)?.message ?? e);
      continue;
    }
    const next = { ...(readThreadMeta(repoPath, threadId)?.intents ?? {}) };
    for (const key of keys) next[key] = { intent: "working", ts: msg.ts, sid };
    upsertThreadMeta(repoPath, threadId, { intents: next });
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
export function ensureLiveSession(
  id: string,
  repoPath: string,
  resume = false,
  origin = "localhost:5173",
  roleId: string | null = null,
  threadId: string | null = null,
  cwd: string = repoPath, // the process working dir — a worktree checkout for `spawn --worktree`, else the board root
  model: string | null = null, // explicit per-spawn model; null → role `model:` frontmatter → provider default
  provider: "claude" | "codex" = "claude",
  effort: string | null = null, // explicit per-spawn effort; null → role `effort:` frontmatter → provider default
): LiveSession {
  const { liveSessions, fsState, boardIdentity } = getServerContext();
  const existing = liveSessions.get(id);
  if (existing && existing.status !== "exited") return existing;

  // Backstop for EVERY new-process path (spawn / auto-wake / resume — adoption doesn't come through here):
  // a noSessions/tmpdir scratch board never runs a real `claude`. The route/worker guards refuse earlier
  // with nicer errors; this throw is the last line so no future call site can spawn around the predicate.
  const refusal = sessionSpawnRefusal(boardIdentity(repoPath).boardId);
  if (refusal) throw new Error(refusal);

  // The role this session instantiates (agent-roles.md): an explicit roleId on a fresh spawn, else the one
  // recorded on a prior marker so a --resume keeps its role. Its charter is appended to the system prompt
  // and its identity stamped on the marker (below), so the role survives a restart and names the card.
  const prior = readCanvasSession(repoPath, id) ?? {};
  const effectiveProvider = resume && prior.provider === "codex" ? "codex" : provider;
  const effectiveRoleId = roleId ?? (typeof prior.roleId === "string" ? prior.roleId : null);
  const role = effectiveRoleId ? readRole(repoPath, effectiveRoleId) : null;

  // Appended system prompt = the ```ask convention + the canvas collaboration brief (env + protocol +
  // norms) + the role charter if this session has one + a worker brief if spawned into a thread, with this
  // session's own identity baked in. One --append-system-prompt flag, all blocks. Board MEMORY is no longer
  // injected here — it IS Claude Code's built-in file memory, pointed at `.canvas/memory` via
  // `autoMemoryDirectory` (below), so the built-in system handles both recall (MEMORY.md index) and the
  // save-a-durable-fact instructions; a second custom injection only duplicated and fought that prompt.
  // A --worktree worker's cwd is its isolated checkout while repoPath stays the canonical board root; when
  // the two differ, append the isolation onboarding (worktrees.js) so the worker confines edits to its
  // worktree and keeps main clean. Every path pointer in the rest of the prompt names the main checkout, so
  // without this a worker anchors on those and edits main — the bug this closes. Branch is best-effort; the
  // cwd path is the load-bearing fact, so a git miss just drops the branch label.
  let worktreeBlock = "";
  if (cwd !== repoPath) {
    let branch = "";
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch {
      // best-effort; the onboarding stands without the branch name
    }
    worktreeBlock = "\n\n" + worktreeOnboarding({ cwd, repoPath, branch });
  }
  const appendPrompt =
    ASK_CONVENTION + "\n\n" + collabBrief(boardIdentity(repoPath).boardId, id, origin) +
    worktreeBlock +
    (role?.charter ? "\n\n## Your role: " + role.name + "\n\n" + role.charter : "") +
    (threadId ? "\n\n" + workerBrief(threadId) : "");
  // The permission relay (see PERMISSION_HOLD_MS): a per-session stdio MCP server whose one tool the
  // CLI calls for every would-prompt permission check. Target endpoint + identity ride its env — the
  // same absolute-URL convention the collab brief bakes in. node = our own execPath (the sidecar's PATH
  // isn't guaranteed to carry one).
  const mcpConfig = {
    mcpServers: {
      canvas: {
        command: process.execPath,
        args: [path.join(process.cwd(), "permission-prompt-mcp.js")],
        env: { CANVAS_PERMISSION_URL: `http://${origin}/api/permission/request`, CANVAS_SESSION_ID: id },
      },
    },
  };
  // Board MEMORY = Claude Code's built-in file memory pointed at this board's `.canvas/memory` home, so a
  // worker's recalled facts AND its saved durable facts live in the shared, shadow-versioned board store
  // rather than the per-user `~/.claude/projects/<cwd>/memory` default. MUST be ABSOLUTE — a relative value
  // is silently ignored and falls back to the default (verified on CC 2.1.202); `autoMemoryDirectory` names
  // the memory dir DIRECTLY (no `<encoded-cwd>/memory` suffix, unlike older CLI builds). Per-board via
  // repoPath, so every mounted board gets its own store. (This repo's INTERACTIVE sessions are pointed at
  // the same dir via `.claude/settings.local.json`; --settings here covers spawned workers on any board.)
  const settingsOverride = { autoMemoryDirectory: path.join(repoPath, ".canvas", "memory") };
  // Resolve model + effort ONCE, PROVIDER-AWARE, so the same chosen values flow into the spawn spec, the
  // live-session seed, and the durable marker. resolvedModel is a non-null string for Claude (falls back to
  // DEFAULT_SESSION_MODEL) and may be null for Codex (no hardcoded default — the app-server picks one and we
  // fold the actual serving model back). resolvedEffort is null unless explicitly chosen (spawn / role).
  const resolvedModel = resolveSessionModel(model, role, effectiveProvider);
  // On a --resume no effort is passed, so fall back to the level the marker recorded at the original spawn
  // (a roleless resume would otherwise lose it); a fresh spawn never has a prior effort (UUID ids).
  const resolvedEffort = resolveSessionEffort(effort, role) ?? (isValidEffort(prior.effort) ? prior.effort : null);
  const args = buildSessionArgs({
    id, resume, model: resolvedModel ?? DEFAULT_SESSION_MODEL, effort: resolvedEffort, mcpConfig, settingsOverride, appendPrompt,
  });
  // Does this session's role run an operating loop? Then its idle sessions are woken on the server heartbeat
  // (loopTick), and read calm "scheduled" rather than amber "waiting" between ticks. First heartbeat is one
  // BASE interval out — the spawn's own first-turn prompt is the session's opening tick.
  const loops = !!role?.loops;
  // Who owns the process? In CANVAS_SESSION_HOST mode the sidecar does (the child survives a dev-server
  // restart); otherwise we spawn in-process, exactly as before. Remote mode with the host UNREACHABLE
  // (crashed mid-flight, still reconnecting) throws — a loud 500 beats silently spawning a child under
  // in-process ownership that the next restart would kill. (hostClient === null means the slot was busy —
  // another dev server owns the host — and THAT falls back to local on purpose.)
  // The hooks close over `s` (declared just below) — they only fire async, well after it's assigned.
  if (REMOTE_SESSIONS && fsState.hostClient && !fsState.hostClient.connected)
    throw new Error("session host unreachable (reconnecting) — retry in a moment");
  if (effectiveProvider === "codex" && (!REMOTE_SESSIONS || !fsState.hostClient))
    throw new Error("Codex sessions require the long-lived session host");
  // MCP_TOOL_TIMEOUT must OUTLAST the server's permission hold, or the CLI gives up on the relay first
  // and the prompt dies with an opaque client-side error instead of our honest hold-timeout deny.
  const spawnSpec: SpawnSpec = effectiveProvider === "codex"
    ? {
        provider: "codex", cwd,
        // Provider-aware model: explicit > role `model:` (only if a Codex id) > absent. A Claude role's
        // model is dropped here (modelMatchesProvider), so a Codex spawn under a Claude-shaped role no
        // longer silently ignores the WHOLE resolution — it just falls through to the app-server default.
        ...(resolvedModel ? { model: resolvedModel } : {}),
        // Reasoning effort → the app-server's native `reasoningEffort` thread-start field (verified against
        // the installed codex: the ReasoningEffort enum is a superset of our levels). Absent = the plan default.
        ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
        developerInstructions: appendPrompt,
        ...(resume && typeof prior.providerSessionId === "string"
          ? { resumeProviderId: prior.providerSessionId }
          : {}),
      }
    : {
        provider: "claude", cmd: resolveClaudeCommand(), args, cwd,
        // CANVAS_SESSION_ID + CANVAS_BOARD ride the child's shell env so `scripts/canvas` verbs default
        // --from to this session's own sid (never the literal "human") and --board to this session's own
        // board (never a stale hardcoded guess) with no flags. Closes the two `canvas msg` footguns where
        // an agent silently impersonated the human / posted to the wrong board. (CANVAS_SESSION_ID also
        // rides the permission-MCP subserver env above; this puts it on the session shell too.)
        env: {
          MCP_TOOL_TIMEOUT: String(PERMISSION_HOLD_MS + 60_000),
          CANVAS_SESSION_ID: id,
          CANVAS_BOARD: boardIdentity(repoPath).boardId,
        },
      };
  const proc =
    REMOTE_SESSIONS && fsState.hostClient
      ? remoteProc(fsState.hostClient, id, wireSessionHooks(() => s), { spawn: spawnSpec })
      : localProc(spawnSpec as ClaudeSpawnSpec, wireSessionHooks(() => s));
  const s: LiveSession = {
    // Start IDLE, not running: a freshly-spawned process is waiting on stdin (it emits `system/init`, never
    // a `result`, until it's first prompted), so "running" would be a turn that never ends — and the inbox,
    // which flushes idle-immediately / at a turn boundary, would queue forever with no boundary to drain at.
    // sendSessionInput flips it to running on the first real prompt; the result event flips it back.
    id, provider: effectiveProvider,
    providerSessionId: effectiveProvider === "codex" && typeof prior.providerSessionId === "string" ? prior.providerSessionId : null,
    // Seed `model` with the REQUESTED model so the pill renders immediately (before the first turn names the
    // serving model); the stream then overwrites it with the authoritative serving model, tracking a refusal
    // fallback. For Codex-with-no-explicit-model this stays null until the provider-bound event folds it.
    // `effort` is fixed at spawn (no server-side effort fallback), so the resolved value is final.
    repoPath, cwd, proc, lines: [], inflight: null, status: "idle", skills: null, verb: null, usage: null,
    model: resolvedModel, effort: resolvedEffort, turnOut: 0,
    // Cursors revive from the marker (persistSessionState) so a --resume / sidecar adoption doesn't reset
    // them to 0 and re-deliver every joined thread's backlog as unread.
    read: prior.read && typeof prior.read === "object" ? { ...(prior.read as Record<string, number>) } : {},
    nudge: false, waitingOn: null,
    loops,
    origin, pendingEdits: new Map(),
  };
  if (resume) seedFromTranscript(s);
  liveSessions.set(id, s);
  // Record ownership in the durable ledger: this is now a canvas-spawned session, so it lists/projects as
  // one and survives a restart as ours. Covers both a fresh spawn and a --resume of an exited one (which
  // re-enters here past the not-exited early return). Best-effort; a failed write never blocks the spawn.
  markCanvasSession(repoPath, id, {
    spawnedAt: Date.now(),
    origin,
    provider: effectiveProvider,
    // Model + effort go durable HERE so the card/list pill survives Done (the root cause of the disappearing
    // pill: they lived only in the live registry). `model` records the REQUESTED model; the actual serving
    // model is folded back and re-persisted at each turn boundary (persistServingState). When resolvedModel
    // is null (a Codex spawn with no explicit/role model), preserve any serving model a prior --resume folded
    // rather than erasing it. `effort` is fixed at spawn.
    ...(resolvedModel ? { model: resolvedModel } : (typeof prior.model === "string" ? { model: prior.model } : {})),
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    ...(effectiveProvider === "codex" && typeof prior.providerSessionId === "string"
      ? { providerSessionId: prior.providerSessionId }
      : {}),
    ...(cwd !== repoPath ? { cwd } : {}), // durable note of a worktree cwd (legibility; boardRootForCwd re-derives repoPath)
    ...(effectiveRoleId
      ? {
          roleId: effectiveRoleId,
          roleName: role?.name ?? effectiveRoleId,
          roleColour: role?.colour ?? null,
          ...(loops ? { loops: true } : {}), // durable note that this session's role loops (legibility)
        }
      : {}),
  });
  stopSessionFeed(id); // the registry now owns this feed — drop any out-of-band file-tail for it

  if (!fsState.sessionCleanupHooked) {
    fsState.sessionCleanupHooked = true;
    // Local children die with the dev server (they'd be orphaned pipes otherwise). Remote children are
    // the entire point of the sidecar: leave them running — the socket just closes, the host sees a
    // detach, and the next dev server adopts them.
    const killAll = () => { fsState.shuttingDown = true; for (const live of liveSessions.values()) if (live.proc.kind === "local") live.proc.kill(); };
    process.once("exit", killAll);
    process.once("SIGINT", () => { killAll(); process.exit(0); });
    process.once("SIGTERM", () => { killAll(); process.exit(0); });
  }

  publishSession(s); // seed the feed (empty) so the card renders the live shell immediately
  return s;
}

// Connect to (auto-starting if needed) the session host, adopt its live sessions, stamp its dead ones.
// Once per process; a hot re-eval keeps the pinned client. A "busy" rejection (another dev server holds
// the client slot — the 5173/5174 footgun) leaves hostClient null: this server warns and runs its own
// spawns in-process, and does NOT touch the other server's sessions.
export async function attachSessionHost(): Promise<void> {
  const { fsState } = getServerContext();
  if (!REMOTE_SESSIONS || fsState.hostAttachStarted) return;
  fsState.hostAttachStarted = true;
  const appDir = process.cwd(); // `npm run dev` runs in app/ — same dir the session-host CLI resolves
  let client: SessionHostClient;
  try {
    client = await connectSessionHost({
      socketPath: sessionHostSocketPath(appDir),
      hostScript: path.join(appDir, "session-host.js"),
      clientPid: process.pid,
    });
  } catch (err) {
    fsState.hostClient = null;
    console.warn(`[session-host] ${String(err)} — sessions will run in-process (they die with this server)`);
    return;
  }
  fsState.hostClient = client;
  const { sessions, exits } = await client.list();
  for (const info of sessions) adoptSession(client, info);
  // Deaths while no dev server was attached: stamp them so the cards read crashed/ended, not status-less.
  for (const ex of exits) {
    const boardRoot = boardRootForCwd(ex.cwd); // a worktree cwd → its canonical board home (where the marker lives)
    if (!readCanvasSession(boardRoot, ex.id)?.endReason)
      recordSessionEnd(boardRoot, ex.id, ex.reason === "self" ? "crashed" : "terminated");
  }
  await client.ackExits(exits.map((e) => e.id));
  if (sessions.length || exits.length)
    console.log(`[session-host] adopted ${sessions.length} live session(s), stamped ${exits.length} exit(s)`);
}

// Rebuild a LiveSession around a child that survived our restart. History = seedFromTranscript (the same
// tail a --resume shows — completed turns; in-flight partials are gone until the next consolidated event).
// Status comes from the host's busy bit, never guessed: a wrong "idle" would let the nudge machinery
// inject stdin MID-TURN and interrupt it. Cursors/waitingOn/loops/origin revive from the marker
// (persistSessionState). Hooks attach FIRST, buffering, so a turn completing during the seed isn't lost
// (a rare duplicate of the newest turn is cosmetic and self-heals on the next resume).
function adoptSession(client: SessionHostClient, info: HostSessionInfo): void {
  const { liveSessions } = getServerContext();
  if (liveSessions.has(info.id)) return; // pinned across a re-eval — already ours
  // The sidecar hands back the process cwd; for a worktree session that's the worktree, so derive the
  // canonical board root (where the marker/threads/memory live) before reading the marker.
  const boardRoot = boardRootForCwd(info.cwd);
  const marker = readCanvasSession(boardRoot, info.id) ?? {};
  const hooks = wireSessionHooks(() => s);
  const pending: string[] = [];
  let buffering = true;
  const proc = remoteProc(client, info.id, {
    onLine: (line) => (buffering ? void pending.push(line) : hooks.onLine(line)),
    onExit: (x) => hooks.onExit(x),
  });
  const s: LiveSession = {
    id: info.id, provider: info.provider ?? "claude", providerSessionId: info.providerSessionId ?? null,
    repoPath: boardRoot, cwd: info.cwd, proc, lines: [], inflight: null,
    status: info.busy ? "running" : "idle", skills: null, verb: info.busy ? "Working" : null,
    // Revive model + effort from the durable marker so an adopted (post-restart) session shows its tinted
    // pill immediately; a Claude session's seedFromTranscript then refreshes `model` to the last serving one.
    usage: null,
    model: typeof marker.model === "string" ? marker.model : null,
    effort: typeof marker.effort === "string" ? marker.effort : null,
    turnOut: 0,
    read: marker.read && typeof marker.read === "object" ? { ...(marker.read as Record<string, number>) } : {},
    nudge: false,
    waitingOn: Array.isArray(marker.waitingOn) ? (marker.waitingOn as string[]) : null,
    loops: !!marker.loops,
    origin: typeof marker.origin === "string" ? marker.origin : "localhost:5173",
    pendingEdits: new Map(), // an Edit claimed pre-restart commits unattributed — accepted loss
  };
  if (s.provider === "claude") seedFromTranscript(s);
  liveSessions.set(info.id, s);
  buffering = false;
  for (const line of pending) hooks.onLine(line);
  for (const request of info.requests ?? [])
    hooks.onLine(JSON.stringify({ type: "codex_event", method: "canvas/request", params: request }));
  stopSessionFeed(info.id); // the registry owns this feed again — drop any out-of-band file-tail
  publishSession(s);
}

// The ProcHooks for a live session: fold each stdout line into the buffer/status, coalesce publishes,
// and stamp how the process ended. Takes a getter because the hooks are wired before the LiveSession
// literal exists (they only fire async, after it does). Shared by spawn (local or remote) and adoption.
function wireSessionHooks(get: () => LiveSession): ProcHooks {
  const { fsState } = getServerContext();
  let pub: ReturnType<typeof setTimeout> | null = null;
  return {
    onLine(line) {
      const s = get();
      try {
        foldSessionEvent(s, JSON.parse(line));
      } catch {
        // a partial/non-JSON framing line — skip, keep streaming
      }
      if (pub) return;
      pub = setTimeout(() => { pub = null; publishSession(get()); }, 50); // coalesce a delta burst to one frame
    },
    onExit({ reason }) {
      const s = get();
      // Release this worker's single-flight claim even on the endSession path: endSession sets status
      // "exited" before its kill lands here (so the guard below early-returns), so the release must run
      // first. Idempotent — releaseSurface only frees a claim this exact sid still holds.
      if (s.autoWakeKey) releaseSurface(s.autoWakeKey, s.id);
      if (s.status === "exited") return; // endSession already tore it down (kill → this hook still fires)
      s.status = "exited";
      s.inflight = null;
      s.verb = null;
      // Phase 2: only a child that died ON ITS OWN is a crash — not one we killed (endSession sets the
      // reason before its kill lands here as "killed"), not a host shutdown ("shutdown" — the remote twin
      // of the old shuttingDown guard, which still covers local killAll on the way out).
      if (reason === "self" && !s.endReason && !fsState.shuttingDown) {
        s.endReason = "crashed";
        recordSessionEnd(s.repoPath, s.id, "crashed");
      }
      denySessionPermissions(s.id, "the session exited before a human decided");
      publishSession(s);
    },
  };
}

// Write a user prompt into a live session's stdin as a stream-json message. The prompt is echoed into
// the buffer right away (Claude does not echo stdin on stdout) so the card shows it without waiting.
export function sendSessionInput(id: string, text: string, opts?: { keepWaitingOn?: boolean }): boolean {
  const { liveSessions } = getServerContext();
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  resumeRunning(s); // a prompt/nudge resumes the process → auto-freshen any blocked:* intent (part 2)
  s.idleSince = undefined; // back to work — reset the auto-wake keep-alive clock (no-op for a normal session)
  // A real prompt is the turn boundary we own (tool_result `user` events are mid-turn) — reset the
  // turn's token accrual and show a neutral verb until the first stream frame names the activity.
  s.turnOut = 0;
  s.usage = null;
  s.verb = "Working";
  // A DIRECT prompt (the human typing) redirects the session, so its "waiting on a peer" is stale → clear it.
  // But a channel NUDGE (flushNudge passes keepWaitingOn) must NOT clear it: being told to read the channel
  // doesn't end the wait, and clearing on every nudge made the blue evaporate the instant any traffic arrived
  // (the bug that made it un-observable). The wait is ended deliberately — by the awaited peer posting (see
  // handleThreadMessage) or by the session itself posting something new — not by a passing wake.
  if (!opts?.keepWaitingOn) s.waitingOn = null;
  s.proc.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }));
  publishSession(s);
  return true;
}

// Band-staleness safety net (thread mrcmofwf-10). Runs AFTER the ticks above so it sees the state they left
// (a job that fired, a seat reaped). For every live session, recompute the live band and republish only when
// it has drifted from what was last pushed — so the card's pushed band can never stay stale for longer than
// one tick regardless of WHAT changed it (standing job, seat flip, intent, waitingOn). Republish-on-change
// only, so this is not per-tick spam; sessionStatus short-circuits to "working" for running sessions (no
// disk read), so the listThreads read is hit only for the handful of idle sessions.
export function reconcileSessionBands(): void {
  const { liveSessions } = getServerContext();
  for (const s of liveSessions.values()) {
    if (shouldRepublishBand(s.lastBand, sessionStatus(s.repoPath, s.id))) publishSession(s);
  }
}

// Interrupt a live session's CURRENT TURN without ending the process. Writes a stream-json control
// request to its stdin — the same control channel the Claude Code SDK's `interrupt()` uses. The CLI
// halts the in-flight turn at a safe boundary and emits a `result`, which folds the card back to idle
// (foldSessionEvent), leaving the process alive for the next prompt. No-op (false) once exited.
export function sendSessionInterrupt(id: string): boolean {
  const { liveSessions } = getServerContext();
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  s.proc.write(
    JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } }),
  );
  return true;
}

// Cap on CONCURRENT live sessions (status !== "exited"), across every board this server hosts. The guard
// against runaway agent fan-out — a session spawning helpers that spawn helpers. Spawn 429s at the cap;
// /terminate frees a slot. A ceiling on concurrency, not on total spawns over time.
export const MAX_LIVE_SESSIONS = 12;
export const liveSessionCount = (): number => {
  const { liveSessions } = getServerContext();
  return [...liveSessions.values()].filter((s) => s.status !== "exited").length;
};

// Board-level spawn refusal: the reason NO real `claude` session — explicit spawn or server-fired wake —
// may run on this board, or null when spawning is allowed. Two triggers: the explicit `noSessions` mount
// flag (sticky, registry-persisted), and a backstop for any board whose repo lives under the OS tmpdir
// (isTmpdirRepo, the single definition in server-boards) — tmpdir repos are scratch/test boards by
// construction (the http-contract suite's board lives there), and its annotation writes once auto-woke a
// REAL doc worker per test run. The EXPLICIT spawn route stays LOUD (403) — never a silent drop; the
// auto-wake path's refusal is definitional on a scratch board, so its warn is quieted there (isScratchBoard).
export function sessionSpawnRefusal(boardId: string): string | null {
  const b = getServerContext().boards.get(boardId);
  if (!b) return null; // unknown board — the spawn path's own board resolution surfaces that error
  if (b.noSessions) return `board ${boardId} is mounted noSessions — real sessions never spawn on a test/scratch board`;
  if (isTmpdirRepo(b.repoPath))
    return `board ${boardId} lives under the OS tmpdir (${b.repoPath}) — treated as a scratch/test board, real sessions never spawn here`;
  return null;
}

// The boolean twin of sessionSpawnRefusal, for the call sites that only need "is this a throwaway board?"
// (skip shadow machinery, quiet the definitional guard warns) rather than the refusal reason string. True
// for both the noSessions mount flag and a tmpdir repo — either way, no real work should ever run here.
export function isScratchBoard(boardId: string): boolean {
  return sessionSpawnRefusal(boardId) !== null;
}

// Footprint of a SERVER-created worker card (matches the client's session-card default size).
const WORKER_CARD_W = 800;
const WORKER_CARD_H = 520;
// Where to drop a server-created worker card (see handleSessionSpawn). Anchor it to its channel's card —
// read from the last snapshot — and CASCADE per existing member so successive workers fan out instead of
// stacking, and, above all, land CLOSE to the channel. Agent-chosen coordinates have been reliably bad
// (cards flung far across the canvas); the server knows the channel's real position, so it places the
// worker right beside it: overlapping the channel card's right edge slightly (channel stays mostly
// visible), stepping down-right. Falls back to a near-origin cascade when the channel isn't resolvable.
export function placeWorkerCard(
  records: Array<Record<string, unknown>> | null,
  threadId: string | null,
): { x: number; y: number; w: number; h: number } {
  const { threadMemberSids } = getServerContext();
  const OVERLAP_X = 120; // worker's left edge sits this far inside the channel card's right edge
  const CASCADE = 56; // per-worker down-right step
  const n = records && threadId ? threadMemberSids(records, threadId).length : 0;
  const layout =
    records && threadId
      ? (records.find((r) => r.typeName === "layout" && (r as { nodeId?: unknown }).nodeId === threadId) as
          | { x?: number; y?: number; w?: number }
          | undefined)
      : undefined;
  if (layout && typeof layout.x === "number" && typeof layout.y === "number") {
    const cw = typeof layout.w === "number" ? layout.w : 300;
    return { x: layout.x + cw - OVERLAP_X + n * CASCADE, y: layout.y + n * CASCADE, w: WORKER_CARD_W, h: WORKER_CARD_H };
  }
  return { x: 80 + n * CASCADE, y: 80 + n * CASCADE, w: WORKER_CARD_W, h: WORKER_CARD_H };
}

// Resolve the working directory a spawn runs in: an isolated git worktree when `--worktree` was requested
// OR the work item already HAS one (so a respawn re-attaches to the same tree/branch rather than cutting a
// fresh one — the whole reason worktrees are keyed by work item, not sid), else the canonical board root.
// Throws when a worktree is needed but the work item can't be durably keyed (no thread) — surfaced as a 400.
export function resolveSpawnCwd(
  repoPath: string,
  opts: { threadId: string | null; roleId: string | null; worktree: boolean; base: string | null; explicitKey: string | null },
): { cwd: string; worktree: ReturnType<typeof ensureWorktree> | null; key: string | null } {
  const key = workItemKey({ threadId: opts.threadId, roleId: opts.roleId, explicitKey: opts.explicitKey });
  const existing = key && opts.threadId ? listThreadWorktrees(repoPath, opts.threadId)[key] : null;
  if (!opts.worktree && !existing) return { cwd: repoPath, worktree: null, key: null };
  if (!key || !opts.threadId)
    throw new Error("a worktree spawn needs a thread — the thread (or role seat) is the durable work-item key");
  const wt = ensureWorktree(repoPath, opts.threadId, key, opts.base);
  return { cwd: wt.path, worktree: wt, key };
}

// ── P2/W5: server-spawn-from-a-durable-record (auto-wake.js) ─────────────────────────────────────────
// The SERVER reconstitutes a session from a durable record on a qualifying wake — a comment/answer on a
// watched doc (Trigger 1, maybeWakeDocWorker) or an @-addressed message to a dormant thread seat (Trigger 2,
// maybeRespawnDormantSeat). Both share this one primitive: mint a fresh session, seed it from the record
// (thread history / the doc's annotation queue + the memory brief ensureLiveSession already bakes in), claim
// the surface single-flight, drop a card, and send the first-turn worker brief. `--resume` is deliberately
// NOT used (R1): reconstitution is a FRESH spawn seeded from the durable substrate, never a transcript
// replay. Only Triggers 1 & 2 spawn — standing jobs (W6) do NOT ride this: under TIMERS-NUDGE-NEVER-SPAWN a
// timer may only nudge a live seat, never mint a session. Returns the new sid, or null if it couldn't spawn
// (cap reached / spawn error — logged, never thrown: a wake is best-effort, it degrades to pull).
const IDLE_KEEPALIVE_MS = 15 * 60_000; // R1: a DONE auto-wake worker idles this long, then the reaper winds it
// down. Extended from 5 min — 5 was aggressive and churned Coordinators mid-task. Under REAP-ONLY-ON-DONE
// (reapKeepAliveMs) this window applies ONLY to a session that has declared `done`; every other stance —
// working, blocked:*, undeclared — is PARKED and never idle-reaped. The Coordinator heartbeat (4 min) stays
// well inside this so a live Coordinator is nudged, not reaped.

export function serverSpawnWorker(opts: {
  boardId: string;
  repoPath: string;
  origin: string;
  roleId: string | null;
  threadId: string | null; // set → member:open edge + thread-cursor seed; null → a standalone doc worker
  anchorNodeId: string | null; // the node to position the worker card beside (thread card / doc card)
  claimKey: string;
  firstPrompt: string;
}): string | null {
  const { fsState, historyKey, seedCursor, threadLog, persistSessionState, boardSnapshotRecords, dispatchBusCommand } =
    getServerContext();
  const pendingHistoryMode = getPendingHistoryMode(fsState);
  // Replicate handleSessionSpawn's cap guard — a server-fired spawn must not blow past MAX_LIVE_SESSIONS.
  // No silent drop (repo principle): LOG the skip so a doc/seat that should've been serviced isn't left
  // invisibly waiting. It re-fires on the next qualifying activity (a deferred-wake queue is a follow-up).
  // Board-level refusal FIRST (test/scratch boards): a wake on a noSessions/tmpdir board must never burn a
  // real session, however it was triggered — the http-contract suite's annotation answers used to.
  const refusal = sessionSpawnRefusal(opts.boardId);
  if (refusal) {
    // Quiet on a scratch/test board — a refused wake there is DEFINITIONAL (the http-contract suite trips
    // this deterministically per run), not an event worth a warn. A real board keeps the loud line so an
    // operator sees a wake that should have serviced a doc/seat being turned away.
    if (!isScratchBoard(opts.boardId))
      console.warn(`[auto-wake] REFUSED server-fired spawn for ${opts.claimKey}: ${refusal}`);
    return null;
  }
  if (liveSessionCount() >= MAX_LIVE_SESSIONS) {
    console.warn(
      `[auto-wake] live-session cap (${MAX_LIVE_SESSIONS}) reached — SKIPPING spawn for ${opts.claimKey}; ` +
        `it will re-fire on the next qualifying activity (no deferred-wake queue yet)`,
    );
    return null;
  }
  const id = crypto.randomUUID();
  // RE-ATTACH on respawn: if the work item this wake targets already has a worktree, land the fresh session
  // back in it (never cut a new one). worktree:false so we only reuse an existing record, never create here —
  // a server-fired wake shouldn't newly isolate a work item that wasn't set up for it.
  let cwd = opts.repoPath;
  try {
    cwd = resolveSpawnCwd(opts.repoPath, {
      threadId: opts.threadId, roleId: opts.roleId, worktree: false, base: null, explicitKey: null,
    }).cwd;
  } catch (err) {
    console.warn(`[auto-wake] worktree re-attach failed for ${opts.claimKey}: ${String(err)}`);
  }
  let live: LiveSession;
  try {
    live = ensureLiveSession(id, opts.repoPath, false, opts.origin, opts.roleId, opts.threadId, cwd);
  } catch (err) {
    console.warn(`[auto-wake] spawn failed for ${opts.claimKey}: ${String(err)}`);
    return null;
  }
  live.autoWake = true;
  live.autoWakeKey = opts.claimKey;
  claimSurface(opts.claimKey, id); // single-flight: the surface is now being serviced by this sid
  // A thread worker starts at the thread's FULL backlog (history:"full") so it's seeded from the thread's
  // durable history — the addressed message that woke it replays on its first inbox read (R1).
  if (opts.threadId) {
    pendingHistoryMode.set(historyKey(opts.threadId, id), "full");
    live.read[opts.threadId] = seedCursor("full", threadLog(opts.boardId, opts.threadId));
    persistSessionState(live);
  }
  // Drop the worker card (+ member:open edge for a thread worker), positioned by the SERVER beside the
  // anchor node — the human should SEE the summoned worker, and agents place cards badly. maybeAnnounceMembership
  // (fired by the addEdge) onboards a thread worker and re-fills its seat from the card name.
  const records = boardSnapshotRecords(opts.boardId);
  const role = opts.roleId ? readRole(opts.repoPath, opts.roleId) : null;
  const node = `node:live:${id}`;
  const nodePayload: Record<string, unknown> = {
    id: node, type: "session", title: id, color: role?.colour ?? "blue",
    ...placeWorkerCard(records, opts.anchorNodeId),
  };
  if (role?.name) nodePayload.name = `${role.name}.${id.slice(0, 8)}`;
  // §9 stage 2: the card (+ member:open edge) commits durably server-side here — no live tab required.
  const carded = !!dispatchBusCommand(opts.boardId, { type: "addNode", actor: "system", payload: nodePayload }, opts.origin);
  if (opts.threadId)
    dispatchBusCommand(
      opts.boardId,
      { type: "addEdge", actor: "system", payload: { id: `edge:member:${id}:${opts.threadId}`, from: node, to: opts.threadId, type: "member:open" } },
      opts.origin,
    );
  if (!carded)
    console.warn(
      `[auto-wake] failed to commit the session card for ${id} (${opts.claimKey}) on ${opts.boardId} ` +
        `(unknown board / rejected command); the session process is live regardless.`,
    );
  sendSessionInput(id, opts.firstPrompt);
  return id;
}

// The keep-alive reaper: an auto-wake worker is wound down ONLY once it has declared `done` and been idle past
// the grace window. REAP-ONLY-ON-DONE (thread mrcauz0v-f): every other stance — working, blocked:*, undeclared
// — PARKS (never idle-reaped). This is the counterpart to "timers nudge, never spawn": a reaped worker can no
// longer be revived by any timer (the heartbeat is nudge-only), so we don't reap a still-relevant session; a
// parked idle session is harmless (no tokens). Only auto-wake workers are eligible — never a human card.
// Thread markers are read once per repo per tick (only for repos with an eligible session). Runs on loopTick.
export function autoWakeReapTick(): void {
  const { liveSessions } = getServerContext();
  const now = Date.now();
  const threadsByRepo = new Map<string, ThreadMetaMarker[]>();
  for (const s of liveSessions.values()) {
    // Cheap pre-filter before the marker read: only an idle auto-wake worker with an idle stamp can reap.
    if (!s.autoWake || s.status !== "idle" || !s.idleSince) continue;
    let metas = threadsByRepo.get(s.repoPath);
    if (!metas) {
      try {
        metas = listThreads(s.repoPath);
      } catch {
        metas = [];
      }
      threadsByRepo.set(s.repoPath, metas);
    }
    // Reap only a session that has FINISHED (declared done, active nowhere); everything else parks (→ null).
    const done = sessionDeclaredDone(metas, s.id);
    const keepAlive = reapKeepAliveMs(done, IDLE_KEEPALIVE_MS);
    if (!shouldReapIdle(s, now, keepAlive)) continue;
    console.warn(
      `[auto-wake] reaping idle worker ${s.id} (declared done, idle ${Math.round((now - s.idleSince!) / 1000)}s ≥ ` +
        `${keepAlive! / 1000}s grace) — winding down`,
    );
    endSession(s.id, "done");
  }
}

// Resolve a held --permission-prompt-tool prompt (a card decision, a shell /decision, or a hold timeout):
// answer the parked relay connection, drop the entry, and repaint the blocked session's card. A no-op if the
// id is already gone (double-settle, close-after-decide). The permission ROUTE handlers (routes/permissions.ts)
// import this — the engine owns it because session teardown (denySessionPermissions below) is a caller and
// nothing about it is HTTP-routing.
export function settlePermission(permId: string, payload: Record<string, unknown>): void {
  const pending = getPendingPermissions(getServerContext().fsState);
  const p = pending.get(permId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(permId);
  if (p.providerRequestId) {
    getServerContext().liveSessions.get(p.sid)?.proc.answerRequest(p.providerRequestId, payload);
  } else if (p.res) {
    try {
      sendJson(p.res, 200, payload);
    } catch {
      /* relay disconnected — the CLI already gave up on this prompt; nothing left to answer */
    }
  }
  const s = getServerContext().liveSessions.get(p.sid);
  if (s) publishSession(s);
}

// Deny every prompt a session still holds — the teardown path (terminate/done/exit). The human can no
// longer meaningfully answer, and a relay still waiting should hear an honest reason, not a hangup.
function denySessionPermissions(sid: string, message: string): void {
  const pendingPermissions = getPendingPermissions(getServerContext().fsState);
  for (const p of [...pendingPermissions.values()])
    if (p.sid === sid) settlePermission(p.permId, { behavior: "deny", message });
}

// Shared teardown for /terminate and /done: stamp the end reason (durably, BEFORE the kill — the exit
// handler reads s.endReason to decide it wasn't a crash), kill the child, free the cap slot, republish so
// the card flips to its exited band immediately. Returns false if the session isn't live (→ 409).
export function endSession(id: string, endReason: "done" | "terminated"): boolean {
  const { liveSessions } = getServerContext();
  const s = liveSessions.get(id);
  if (!s || s.status === "exited") return false;
  denySessionPermissions(id, `the session was ${endReason} before a human decided`);
  if (s.autoWakeKey) releaseSurface(s.autoWakeKey, s.id); // free its single-flight surface immediately
  s.endReason = endReason;
  recordSessionEnd(s.repoPath, id, endReason);
  s.proc.kill();
  s.status = "exited";
  s.inflight = null;
  s.verb = null;
  publishSession(s);
  liveSessions.delete(id);
  return true;
}

// ── session-read helpers + the whole-session status band + persist/publish (P5 sub-step 3) ──────────
// The rest of the session engine that sub-step 2 left in the shell because publishSession/sessionStatus are
// cross-cutting (the band-reconcile loop above and routes/sessions.ts both reach them via ctx). They fold in
// here now, their home: a board's transcripts dir + one transcript's tail read; the ONE whole-session status
// band both the card and the thread pill render from; the cursor-persist debounce; and the session-feed
// publish. Each is byte-identical to its former shell definition save for a getServerContext()/binding
// preamble (liveSessions / fsState maps reached via ctx, exactly like the functions above).

// A board's Claude Code transcripts dir: ~/.claude/projects/<abs path with every non-alnum → ->. Per board
// (was a single module constant) so a canvas over another repo lists THAT repo's sessions, not the dev
// repo's. The slug rule lives once in projectsDirForCwd (session-ledger) — a board root has no dots so it's
// unchanged, but a worktree cwd contains `.canvas` and MUST slug the dot too (`.canvas` → `-canvas`), or its
// transcript dir won't be found. Passing a worktree cwd here resolves that session's own dir.
export function sessionsDir(repoPath: string): string {
  return projectsDirForCwd(repoPath);
}

// Claude Code's transcripts live in ~/.claude/projects/<slug> — resolved PER BOARD by sessionsDir(repoPath)
// above (the session handlers thread the board's dir), so the cards serve the right repo's history.
export const MAX_SESSION_BYTES = 4 * 1024 * 1024; // whole sessions, bounded against a pathological one. The
// card scrolls, so we serve the full transcript; the cap only guards an extreme outlier (and the
// card flags it honestly when it bites — the codec marks a partial tail). In-memory spike, so a few
// MB in node.text is fine.

// Real Claude Code transcripts in the board's transcripts `dir`: `*.jsonl` minus the `*.usage.jsonl` sidecars (those
// are a separate usage-logging stream, not conversations). Returned newest-first by mtime so a
// caller with no id gets the most recent session.
// GET /api/session?id=<sessionId>  → { id, content, truncated }: one transcript's raw jsonl, bounded.
// No `id` → the most recent session. The id is an allow-listed shape (no dots/slashes) AND the
// resolved path is re-checked to sit in the board's transcripts dir — same two guards as the file reads, since this
// also runs with the dev server's fs privileges. Content is served raw; the jsonl → turns codec is
// the card's (render.js), keeping the format understood in exactly one place.
export function readSessionFile(dir: string, id: string): { content: string; truncated: boolean } | null {
  const abs = path.resolve(dir, id + ".jsonl");
  if (!abs.startsWith(dir + path.sep)) return null; // id re-checked to sit in the board's transcripts dir
  try {
    const buf = fs.readFileSync(abs);
    // Keep the TAIL when capping, never the head: a transcript is append-only and the card reads it
    // bottom-up (auto-scroll-to-bottom), so the bytes you want are the most RECENT — where you left off.
    // Head-slicing here would have hidden the live end behind the old opening, the same class of bug as
    // the card's old turn-slice. The codec tolerates the ragged first line a tail leaves. (The live feed
    // bounds itself the same way, MAX_SESSION_FEED_BYTES.) `truncated` flags it so the card says so.
    const over = buf.length > MAX_SESSION_BYTES;
    return {
      content: (over ? buf.subarray(buf.length - MAX_SESSION_BYTES) : buf).toString("utf8"),
      truncated: over,
    };
  } catch {
    return null;
  }
}

const MAX_SESSION_FEED_BYTES = 512 * 1024; // bound the live buffer — a derived stream stays bounded
// (§9.4). Keep the most-recent tail; older completed turns drop off (the card scrolls live output).

function endReasonBand(reason: string | undefined): SessionBand {
  return reason === "done" ? "done" : reason === "crashed" ? "crashed" : "ended";
}
// Is a wake ACTUALLY scheduled for this session? The `loops` role flag is static legibility ("this is a
// looping-TYPE role") and asserts nothing about a timer — real wakes come from live standing JOBS on a thread
// (standing-jobs.js), which are human-gated and often absent. So an idle looping session reads the calm teal
// "scheduled" band only when some thread carries a live job whose ROLE-SEAT this session currently occupies
// (sessionHasScheduledWake); otherwise it's genuinely "waiting", not asleep on a heartbeat. Only consulted for
// idle looping sessions (callers gate on `loops` first), so the listThreads marker read stays off the hot path.
function hasScheduledWake(repoPath: string, id: string): boolean {
  try {
    return sessionHasScheduledWake(listThreads(repoPath), id);
  } catch {
    return false;
  }
}
// The ONE whole-session status band both surfaces render from (thread mrcmofwf-10): the session card's
// frame band (card-types/session/render.js) AND that session's participant pill in every thread
// (thread-state.js memberPillState) read THIS value, so they can never disagree. Process-observed bands
// (working/scheduled/crashed/ended) are authoritative and GLOBAL; only the *idle* band takes a declared-
// intent refinement, folded WHOLE-SESSION (across every thread the session is in — sessionIdleIntent), per
// the v2 precedence. `null` = bandless (a never-run session that has handed you nothing yet, or an unknown
// session): both surfaces render neutral, never a fabricated "your turn".
export function sessionStatus(repoPath: string, id: string): SessionBand | null {
  const { liveSessions, fsState } = getServerContext();
  const pendingPermissions = getPendingPermissions(fsState);
  const live = liveSessions.get(id);
  if (live) {
    // A held permission prompt outranks everything live: the process is technically mid-turn
    // ("running"), but it's blocked on a HUMAN click — the one state the loud band exists for.
    if (live.status !== "exited" && [...pendingPermissions.values()].some((p) => p.sid === id)) return "waiting";
    if (live.status === "running") return "working";
    if (live.status === "idle") {
      // Never-run: idle with no output yet has handed you nothing back, so the loud amber "your turn" is
      // wrong — stay bandless until the first turn produces output and idles again (which IS your turn).
      if (live.lines.length === 0) return null;
      // Idle band precedence (v3, whole-session — see idleBand): a DECLARED intent outranks a wake timer —
      // declared blocked:human (loud orange) > declared blocked:peer (blue) > scheduled (a looping role asleep
      // on its heartbeat — teal, no human demand; gated on an ACTUAL live wake, not the static `loops` flag) >
      // a server-inferred @-tag peer-wait (blue `waitingOn`, free) > the default orange "your turn". Declared
      // intent is aggregated across ALL the session's threads; `done`/`working` don't paint the idle band
      // (done never colours a live session — it shows only once the process exits, via endReason grey). One
      // listThreads read shared by both consults.
      const metas = listThreads(repoPath);
      const scheduled = !!live.loops && sessionHasScheduledWake(metas, id);
      return idleBand(sessionIdleIntent(metas, id), scheduled, !!live.waitingOn?.length);
    }
    if (live.endReason) return endReasonBand(live.endReason); // exited process with a recorded reason
  }
  // not live (or exited with no in-memory reason) → the durable marker is the only surviving source
  return endReasonBand(readCanvasSession(repoPath, id)?.endReason as string | undefined);
}

// Persist the live-registry state that must survive a restart — the thread read cursors and waitingOn —
// onto the session's durable marker. Without this, a restart that keeps the SESSION alive (a --resume, or
// the session-host sidecar) still resets its cursors to 0 and the next inbox read re-delivers every joined
// thread's whole backlog as "unread". Debounced per session (reads/posts come in bursts); the timer reads
// s.read at fire time, so it always writes the latest cursors. Best-effort like every marker write.
// Persist the folded serving model (and effort) onto the durable marker so an ENDED session still reports
// what it ran (the disappearing-pill root cause). Called at each turn boundary: `model` tracks a serving-model
// fallback / a Codex spawn learning its provider-picked model; `effort` is fixed at spawn but rides along
// idempotently. Only truthy values are written — never spread `undefined`, which would ERASE a prior value.
// Best-effort like every marker write (updateCanvasSession never throws).
function persistServingState(s: LiveSession): void {
  const patch: { model?: string; effort?: string } = {};
  if (s.model) patch.model = s.model;
  if (s.effort) patch.effort = s.effort;
  if (patch.model || patch.effort) updateCanvasSession(s.repoPath, s.id, patch);
}

export function persistSessionState(s: LiveSession): void {
  const persistTimers = (getServerContext().fsState.persistTimers ??= new Map<string, ReturnType<typeof setTimeout>>());
  if (persistTimers.has(s.id)) return;
  persistTimers.set(
    s.id,
    setTimeout(() => {
      persistTimers.delete(s.id);
      updateCanvasSession(s.repoPath, s.id, { read: s.read, waitingOn: s.waitingOn });
    }, 500),
  );
}

// The pending permission prompts addressed to one session, in card-render shape (no held internals).
// Oldest-first so the card shows them in arrival order.
function permissionsOf(sid: string): Array<{ id: string; toolName: string; input: unknown; ts: number }> {
  const pendingPermissions = getPendingPermissions(getServerContext().fsState);
  return [...pendingPermissions.values()]
    .filter((p) => p.sid === sid)
    .sort((a, b) => a.ts - b.ts)
    .map((p) => ({ id: p.permId, toolName: p.toolName, input: p.input, ts: p.ts }));
}

// Publish the session's buffer (completed lines + the in-flight synthetic turn) on its feed. Bounded
// from the tail; `truncated` mirrors the codec's existing cap signal so the card flags a clipped view.
export function publishSession(s: LiveSession): void {
  const { publishFeed } = getServerContext();
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
  // Compute the band ONCE and remember it: this pushed value is what the card renders, and the loopTick
  // safety net compares against `lastBand` to catch it going stale on an out-of-band transition.
  const band = sessionStatus(s.repoPath, s.id);
  s.lastBand = band;
  publishFeed("session:" + s.id, {
    content,
    truncated,
    status: s.status,
    provider: s.provider,
    providerSessionId: s.providerSessionId ?? undefined,
    // The ONE whole-session status band (sessionStatus) the card renders its frame from — the SAME value
    // the thread participant pill reads off /api/sessions, so the two surfaces can't drift. Sent on every
    // publish (including `null` = bandless/never-run) so the card stops recomputing the band client-side;
    // it falls back to its own derivation only when this key is absent (a slice-1 file-tail feed).
    band,
    skills: s.skills ?? undefined,
    verb: s.verb ?? undefined, // live progress label for the status pill (channel-1 chrome)
    usage: s.usage ?? undefined, // {input, output} token counts for the current/last turn
    plan: s.plan?.length ? s.plan : undefined,
    error: s.error ?? undefined,
    model: s.model ?? undefined, // the model actually serving the session (tracks refusal fallbacks)
    effort: s.effort ?? undefined, // the reasoning effort this session was spawned at (pill suffix); absent = provider default
    endReason: s.endReason ?? undefined, // Phase 2: done/terminated/crashed → the exited band's flavour
    waitingOn: s.waitingOn ?? undefined, // @-tag: idle + this set ⇒ blue "waiting on an agent", not orange
    // The card can't consult the jobs ledger, so the server tells it whether a wake is ACTUALLY scheduled:
    // an idle looping session with no held waitingOn AND a live standing job on its seat (hasScheduledWake).
    // Computed only for that narrow case (short-circuits on status/loops/waitingOn first) so the marker read
    // stays off the hot path — publishSession fires on every delta burst. Replaces the old raw `loops` flag,
    // which asserted "scheduled" for any looping role even when nothing would ever wake it.
    scheduled: (s.status === "idle" && !s.waitingOn?.length && s.loops && hasScheduledWake(s.repoPath, s.id)) || undefined,
    // Held permission prompts: the card renders allow/deny buttons and paints the loud waiting band —
    // the process is mid-turn ("running") but blocked on a HUMAN, and only the server knows that.
    permissions: (() => { const p = permissionsOf(s.id); return p.length ? p : undefined; })(),
  });
}

// Republish every LIVE seat occupant of a thread (mrcmofwf-10 instant path). A standing job created/removed
// on a seat flips that occupant's `scheduled` band (sessionHasScheduledWake goes true/false) with no process
// event of its own, so push the affected occupants' feeds now rather than waiting for the loopTick safety
// net. Cheap: a thread holds a handful of seats, publishSession recomputes the band fresh, and dead/absent
// occupants are skipped. Best-effort — a read failure leaves the safety net to reconcile.
export function republishThreadSeatOccupants(repoPath: string, threadId: string): void {
  const { liveSessions } = getServerContext();
  try {
    const seats = readThreadMeta(repoPath, threadId)?.seats ?? {};
    for (const seat of Object.values(seats) as Array<{ sid?: string }>) {
      const s = seat?.sid ? liveSessions.get(seat.sid) : undefined;
      if (s && s.status !== "exited") publishSession(s);
    }
  } catch { /* best-effort; loopTick reconciles */ }
}
