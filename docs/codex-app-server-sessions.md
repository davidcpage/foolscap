# Codex app-server sessions on the canvas

*Prepared 2026-07-13. Companion to `agent-sessions-on-canvas.md`, `session-timelines.md`, and
`threads-as-cards.md`. This note decides how GPT/Codex sessions enter Foolscap without disturbing the
existing Claude Code path.*

## 1. Decision

Add Codex as a native session provider through `codex app-server`. Run one long-lived app-server per
Foolscap checkout and multiplex many Codex threads through it. Keep the current Claude Code adapter;
do not make ACP a prerequisite. ACP may be added later as another provider adapter.

The shared boundary is a Foolscap agent-session driver, not either provider's wire format:

```text
canvas session card / routes / thread seats
                  |
          provider-neutral session state
             /                  \
  Claude stream-json        Codex app-server
  process per session       one process, many threads
```

The current `session-host.js` is one sidecar supervising many independent `claude -p` children. It
multiplexes *processes*: one canvas session id maps to one child stdin/stdout pair. App-server already
multiplexes *conversations*: one initialized JSON-RPC connection carries many logical threads, and events
are routed by `threadId` and `turnId`. Therefore one app-server per canvas card would be a useful debug
fallback but the wrong default architecture.

## 2. Identity vocabulary

Keep these identifiers distinct:

| Name | Meaning |
|---|---|
| canvas session id (`sid`) | Foolscap's stable card/member/seat identity |
| canvas thread id | Foolscap's durable coordination/task card |
| provider conversation id | The provider's private conversation identity; a Codex `threadId` |
| provider turn id | One in-flight/completed Codex turn |

Never call a Codex conversation merely `thread` in shared orchestration code: Foolscap already owns that
word. Durable session markers will grow `provider` and `providerSessionId`; old markers default to
`provider: "claude"` with the marker/session id as the provider id.

## 3. Ownership and restart model

The long-lived agent host owns the app-server connection. The restartable Vite server talks to that host;
it must not own app-server request correlation, subscriptions, or pending approvals.

For Claude, the host continues to own N children and one busy bit per child. For Codex, it owns one child
and an in-memory table:

```text
canvas sid -> { providerThreadId, cwd, status, activeTurnId, pendingRequests }
```

The Codex client must continue draining app-server output while Vite is detached. Unlike the present
Claude host, it cannot discard every detached stdout line after folding a single busy bit: several logical
threads and server-initiated approval requests share that stream. Completed conversation history remains
provider-authored and durable in Codex's rollout; reconnect/restart recovery uses `thread/resume` and
`thread/read`, not direct parsing of `~/.codex/sessions`.

If app-server itself dies, all in-flight Codex turns are interrupted together, but persisted threads remain
resumable. That shared failure domain is the main trade-off for one process. Per-thread cwd, model, sandbox,
permissions, developer instructions, and worktree isolation remain independent.

## 4. Protocol mapping

| Foolscap act/state | Codex app-server |
|---|---|
| create session | `thread/start` |
| resume historical session | `thread/resume` |
| prompt | `turn/start` |
| steer active work | `turn/steer` |
| interrupt | `turn/interrupt` |
| historical projection | `thread/read`, paged turn/item reads when needed |
| live text | `item/agentMessage/delta` |
| activity/tool chrome | `item/started`, item deltas, `item/completed` |
| working/idle/error | `thread/status/changed`, `turn/started`, `turn/completed` |
| plans/diffs | `turn/plan/updated`, `turn/diff/updated` |
| human gate | server requests such as command/file/permission approval and user input |
| model/usage | model/reroute events and `thread/tokenUsage/updated` |

Provider events are folded into a Foolscap session projection before reaching the card. The renderer must
not learn app-server JSON-RPC shapes, just as it should eventually stop learning raw Claude JSONL shapes.
Live deltas stay channel 1. Prompts and turns remain session-internal and never enter the canvas intent log.

## 5. Authentication and billing

App-server is authenticated once at account scope, not once per Codex thread. Foolscap uses ChatGPT login
(`account/login/start` with `type: "chatgpt"` or the device-code variant), then every multiplexed thread
draws from that account/workspace's Codex plan allowance and agentic credit pool.

The host must call `account/read` at startup and expose the returned email and plan type. The safe default
is to require `account.type === "chatgpt"`; `apiKey` mode is refused unless explicitly enabled. Do not
inject `OPENAI_API_KEY` into the child. This prevents an unnoticed switch from ChatGPT plan credits to API
organization billing. Current Codex credits are token-metered, but they remain ChatGPT/workspace credits.

Relevant current documentation:

- <https://developers.openai.com/codex/app-server/>
- <https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt>
- <https://help.openai.com/en/articles/20001106>

## 6. Provider-neutral runtime contract

The shared orchestration layer needs these operations, regardless of provider:

```ts
interface AgentSessionDriver {
  start(sid: string, spec: SessionSpec): Promise<ProviderSessionId>
  resume(sid: string, providerId: ProviderSessionId, spec: SessionSpec): Promise<void>
  prompt(sid: string, text: string): Promise<void>
  steer(sid: string, text: string): Promise<void>
  interrupt(sid: string): Promise<void>
  close(sid: string): Promise<void>
  answerRequest(sid: string, requestId: string, answer: unknown): Promise<void>
  readHistory(sid: string): Promise<SessionHistory>
}
```

The normalized event vocabulary needs message delta/completion, activity start/update/completion, plan,
diff, approval/request, usage/model, status, and error. Preserve provider payloads behind an optional debug
field rather than making them the renderer contract.

## 7. Delivery plan

1. **Protocol foundation (implemented).** A tested newline-delimited app-server JSON-RPC peer plus a
   logical-session router proving N canvas ids -> N Codex thread ids over one connection. No paid turns in
   tests; a fake app-server exercises handshake, interleaving, approvals, and interruption.
2. **Sidecar ownership (implemented for the live path).** The long-lived session host lazily owns one
   shared app-server, multiplexes logical sessions, and reports provider/thread identity on adoption.
   Replay while Vite is detached still comes from `thread/read`; approval bridging remains in step 4.
3. **Durable identity (implemented for explicit spawns).** Markers and spawn configuration carry provider
   fields; old boards and role files retain the implicit Claude default.
4. **Vertical Codex card (implemented).** Spawn/input/steer/interrupt/resume/release run through the
   provider-aware host; message/activity/plan/completion/error events fold into the card projection, and
   app-server approval/user-input requests reuse the existing permission and interactive-question gates.
5. **History and usage (implemented).** Project every `thread/read` turn item, surface account/rate-limit/
   credit state, and extend usage reporting without scraping provider-private rollout files.
6. **Renderer convergence.** Have both native adapters emit the normalized projection; delete remaining
   Claude-only labels from shared session chrome.

## 8. Acceptance criteria for the first live slice

- Two canvas Codex session cards run independent turns over one app-server process.
- Each can use a distinct worktree cwd and role charter.
- Deltas, plan/tool activity, completion, usage, and errors route only to the owning card.
- Interrupt and approval responses target the correct `threadId`/`turnId`.
- Restarting Vite preserves both active app-server ownership and canvas-to-provider mappings.
- Restarting app-server can resume persisted conversations without copying or scraping its rollout JSONL.
- `account/read` visibly proves `type: "chatgpt"`; API-key billing cannot happen silently.

## 9. Handoff checkpoint (2026-07-13)

Steps 1–4 of the delivery plan are implemented in this checkout:

- the newline-delimited app-server peer and logical-session router multiplex canvas session ids over one
  Codex app-server connection;
- the long-lived session host owns the shared Codex runtime and exposes provider-aware spawn/adoption;
- explicit spawns persist provider and provider-thread identity while existing markers continue to default
  to Claude;
- the New Session menu exposes an explicit Claude/Codex picker, and executable discovery covers the
  reduced PATH inherited by GUI-launched dev servers while retaining environment overrides;
- ChatGPT authentication is required and API-key billing is refused by default;
- Codex turns now project live message deltas, tool activity, plans, completion, token usage, and errors
  without exposing app-server JSON-RPC shapes to the renderer;
- command, file-change, and permission approvals use the existing card allow/deny gate, while
  `requestUserInput` uses the existing interactive question widget;
- the sidecar retains pending Codex gates while Vite is detached and replays their normalized projection
  on adoption; two logical sessions route turns and gates independently over one app-server;
- the origin-global legacy IndexedDB adoption path has been removed. Board-local browser adoption remains
  keyed by the checkout-derived board id;
- the working board was explicitly migrated into this checkout's `.canvas/` state. Operational session
  paths were rewritten, historical transcripts were copied where present, and repository-bound roots and
  worktrees were deliberately not carried over.

Verification at this checkpoint: app typecheck passes; the complete app suite passes with 756 tests.
The Claude session path remains covered alongside the new Codex vertical-card tests. Protocol tests use a
fake app-server and do not spend a paid turn.

### Step 5 checkpoint

Delivery-plan step 5 is now implemented:

- resumed Codex sessions project every turn and every app-server item from `thread/read`; known message,
  reasoning, plan, command, file-change, and MCP items retain their native card representation, while
  newer provider item kinds degrade to a generic activity row instead of disappearing;
- the long-lived host reads `account/read` and `account/rateLimits/read`, merges sparse
  `account/rateLimits/updated` notifications, and exposes ChatGPT account, rolling-window, agentic-credit,
  and rate-limit-reset state to the Plan Usage card;
- a runtime auth-mode switch away from ChatGPT blocks new billed work instead of silently moving to API-key
  billing;
- the usage feed is provider-explicit (`Claude · Anthropic plan`, `Codex · ChatGPT/workspace`) and uses
  app-server methods only for Codex—it never reads rollout files;
- Claude polling honors `Retry-After` plus bounded exponential backoff, uses the same GUI-safe executable
  discovery as session spawning for its required User-Agent, and preserves last-good provider snapshots in
  the ignored, mode-0600 `.canvas/cache/plan-usage.json` across full dev-server restarts.

Verification at this checkpoint: the complete app suite passes with 765 tests; app typecheck passes.
Renderer-wide normalization of the Claude and Codex projections remains delivery-plan step 6.
