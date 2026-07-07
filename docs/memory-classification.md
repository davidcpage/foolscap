# Memory & instruction classification audit

*Prepared 2026-07-07. A classification of every atomic fact/rule across the four always-loaded or
pull-able instruction surfaces, into the memory TYPES our two-gate model implies. Companion to the
verified finding in `[[headless-session-memory]]`: board sessions are headless `claude -p`, and the ONLY
things auto-loaded are (a) the always-loaded instruction text — the harness brief (`app/harness.md`) +
`CLAUDE.md` (loaded because cwd=repo) + `role.md` for a role session — and (b) the `MEMORY.md` **index**.
Everything else (memory-file bodies, the on-demand harness recipe leaves, docs) is **PULL-only**: read on
demand only if the agent thinks to look. There is **no relevance-push**. Therefore a behaviour-changing
fact the agent won't think to look for ("unknown-unknown") is only reliable if it lives in an
always-loaded surface.*

## The type scheme

| Type | Gate it needs | Where it should live |
|---|---|---|
| `FACT-PULL` | agent-pull | pull-able corpus (memory body, recipe leaf, reference page) — safe |
| `GOTCHA-GLOBAL` | always-loaded, all sessions | harness brief / CLAUDE.md |
| `GOTCHA-ROLE` | always-loaded, one role | that role's `role.md` charter |
| `NORM-GLOBAL` | always-loaded, all sessions | harness brief |
| `NORM-ROLE` | always-loaded, one role | that role's `role.md` charter |
| `PROVENANCE` | pull-able reference | memory body / docs — never always-load |
| `MOVING` | not durable at all | a thread, never memory |

## Counts by source

| Source (gate) | GOTCHA-GLOBAL | GOTCHA-ROLE | NORM-GLOBAL | NORM-ROLE | FACT-PULL | PROVENANCE | MOVING |
|---|---|---|---|---|---|---|---|
| `app/harness.md` + 2 recipe leaves (always-loaded brief + pull leaves) | 9 | 0 | 34 | 1 | 44 | 0 | 0 |
| `CLAUDE.md` (always-loaded for board sessions) | 20 | 0 | 21 | 2 | ~78 | 14 | 1 |
| `pm/role.md` Coordinator charter (always-loaded for the role) | 6† | 4 | 6† | 38 | 8 | 5 | 0 |
| `.canvas/memory/` store (index always-loaded; bodies pull-only) | 15 (4 stranded) | 1 (stranded) | 12 | 10 | 6 | ~23 | 0 |

† The Coordinator charter's 6 GOTCHA-GLOBAL + 6 NORM-GLOBAL are *leaked* global items that duplicate the
harness/memory and should be hoisted out (see §B).

---

# Action findings (read this part)

## A. Stranded gotchas — behaviour-changing, and NOT in any always-loaded surface (HIGHEST PRIORITY)

These are unknown-unknowns that live *only* in a pull-only body, with an index line that doesn't hint at
them. An agent will confidently do the wrong thing and never think to look. Fix = extract the kernel to an
always-loaded surface (or convert to a guardrail, §D).

1. **Co-located peer sessions share ONE auto-memory dir, so concurrent unclaimed writes to the same memory
   file clobber each other (last-write-wins, no merge).** Source: `channel-coordination-norms` body — *not
   in its index line at all*. The most dangerous item found: it corrupts the memory store itself during
   exactly the multi-agent work the board exists for. → extract to harness brief §6 (memory) + convert
   (per-session write scoping or file-claim).
2. **Writing `@all` / `@human` / `@<prefix>` in PROSE trips the tag parser and actually wakes those
   members — there is no "just a mention" escape.** Source: `channel-tagging` body — *not in index*. An
   agent quoting a tag in a message fires an accidental broadcast wake. → extract to harness brief §3 +
   convert (a mention-escape syntax).
3. **Clicking Resume on a session already live elsewhere forks a second `--resume` on the same id that
   hijacks the `session:<id>` feed.** Source: `canvas-session-lifecycle` body — *index reduces it to
   "Resume≠Reconnect"*. Niche (a UI action) but feed-corrupting. → convert (server refuses a second resume).
4. **Don't trust `delivered` counts or snapshot contents while any headless probe is alive — probes join
   as real empty tabs, win the `/api/canvas` last-push race, and can leak for days.** Source:
   `template-registry-stuck-tab` body — *only the "leak" half is in the index; the don't-trust-delivered
   rule is body-only*. Compounds the 503/`delivered` gotcha. → extract the operational rule.
5. **(ROLE) NEVER join another Coordinator's thread — a Coordinator-role join steals that thread's
   Coordinator seat.** Source: `coordinator` body — *index carries only the cryptic keyword "seat
   displacement"*. → belongs in `pm/role.md` (always-loaded for the role). (Note: the harness reviewer
   independently found the same footgun already correctly present in the charter body at L28 — so the fix
   is to make sure it survives any charter rewrite, and to drop the duplicate cryptic memory hook.)

**Cross-source reconciliation (important):** the harness reviewer flagged three doc-annotation norms as
"stranded in a pull-only leaf" — *ask-on-the-doc-not-in-session*, *the revision rule*, and
*resolution-belongs-to-the-author*. They are in fact carried as always-loaded `NORM-GLOBAL` text in
`CLAUDE.md`, which board sessions also load. So for board sessions they ARE covered; the gap is only that
`app/harness.md` (the leaner brief) doesn't restate them. Lower priority than the five above, which are
stranded *everywhere*.

## B. Hoist map — global items leaked into the Coordinator charter (drift risk + bloat)

12 items in `pm/role.md` are global norms/gotchas that duplicate the harness/memory and apply to every
session; a plain session gets them nowhere from here, and duplicating them here bloats the role's
always-load budget and risks drift against `MEMORY.md`. Delete the global half, keep the role-specific
application beside it.

- GOTCHA-GLOBAL leaked → hoist to harness: uniform-permission-baseline (L16); idle-states-look-identical
  (L23); narration-renders-on-your-session-card (L22); resume-replays-backlog (L26);
  `claude -p`-can't-self-schedule (L35); tag-gates-the-wake (L29).
- NORM-GLOBAL leaked → hoist to harness: one-task-one-thread (L10); the RED LINE (L18) *(except the
  change-a-thread-brief clause, which is role-flavoured)*; declare-work-intent (L23); never-resume (L26);
  durable-state-not-in-process (L26); be-terse (L31).

Keep in the charter (genuinely Coordinator-specific, correctly always-loaded): the 38 `NORM-ROLE` +
4 `GOTCHA-ROLE` items — identity (coordination-not-code), stay-out-of-code/delegate-to-subagent,
thread-as-status-surface, commit-as-authority-by-asking, verify-done-against-proof,
staff-then-assign-via-tagged-post, the operating loop + wind-down conditions + no-auto-continue, the
stance, and the two sharp footguns (never-put-the-task-in-the-spawn-prompt; don't-join-another-Coordinator's-thread).
Target shape: ~40 lines of pure role disposition, matching the `generalist`/`oracle` charters (which are
pure identity + disposition, zero mechanism).

## C. Trim — provenance/reference bloating always-loaded surfaces

- **CLAUDE.md (~30-40% trimmable without weakening any gotcha coverage).** Cleanest cut: the ~48
  intro/architecture/build lines + the History blockquote (~14% — core-dev reference, useless to a
  board-driving agent). The ~20-line **Size caps** section is real but **dev-only** — dead weight for a
  pure board-driving session; a candidate for a "working on app/ code" charter if we ever role-split
  CLAUDE.md. Plus ~14 rationale/history clauses threaded through the operational sections ("because SSE
  starved the pool", the 5174 port-slide story, pre-rename `channel` aliases, W1/W5 roadmap,
  "learned the hard way").
- **Coordinator charter:** ~12% pull-able mechanics (spawn/seat/endpoint syntax) + ~7% provenance
  (channel-wiki-retired lore, the `coordinator-heartbeat.js` pointer, thrice-repeated delegation
  rationale) → demote/trim.
- **Memory store:** provenance-dominant (~a third of entries, most of the byte-weight are shipped-in-X /
  commit-hash / tried-then-reverted build records). Correctly pull-able — no action, but it means the
  always-loaded index is mostly provenance hooks; the load-bearing behaviour layer is a smaller slice.

## D. Convert-to-guardrail candidates — the real lever to SHRINK the always-load set

Each of these gotchas can be *downgraded to a mere pull-able fact* by fixing the mechanism so the agent no
longer needs to always know it. This is the structural answer to "don't let unknown-unknown gotchas
accumulate" — every guardrail retires one always-load item.

| Gotcha | Guardrail that retires it |
|---|---|
| `POST /api/command` 503 `{delivered:0}` silently means "went nowhere" | CLI wrapper hard-errors on `delivered:0` |
| `GET /api/inbox` peek consumes the read cursor | a non-consuming peek endpoint (cursor advances only on explicit ack) |
| remove edges before nodes (dangling wires) | `removeNode` cascades its edges server-side |
| percent-encode the colon in thread ids | steer all thread ops through `scripts/canvas` (already encodes) |
| membership must be in the saved snapshot before `ask`/`message` (spurious 403) | `join` blocks until the `member:open` edge is persisted |
| a bare shell spawn leaves no canvas card | `scripts/canvas spawn` always creates the card server-side |
| Resume forks/replays a live-or-done session | server refuses a second `--resume` on a live id |
| reply-and-resolving another author's comment buries the reply | guardrail blocks resolving another author's comment |
| the revision rule (read annotations before editing) | pre-edit hook surfaces open annotations |
| in-session AskUserQuestion is invisible/blocking | intercept it and route to an anchored doc question |
| co-located memory clobber (finding A1) | per-session memory write scoping or file-claim |
| prose `@tag` wakes members (finding A2) | a mention-escape syntax the parser honours |

## E. Duplication across the always-loaded surfaces (drift risk)

Several global norms/gotchas are stored in ALL of: `harness.md`, `CLAUDE.md`, the `MEMORY.md` index, AND
the Coordinator charter — e.g. one-task-one-thread, never-resume, the red line, work-intent,
tag-gates-the-wake. This is same-altitude duplication (the kind our "one home per fact" rule warns
against), and it will drift. Decision needed: pick the single canonical always-loaded home for each global
norm (recommendation: `harness.md`, since it's the leanest universal brief), and have the others *point*
rather than restate.

---

# Full classified list

## GOTCHA-GLOBAL (always-load, all sessions)

*Harness brief (`harness.md`) — all correctly always-loaded:* nothing-is-pushed-you-must-ask (§1);
a-post-logs-for-all-but-wakes-only-@-tagged (§3); message-content-never-enters-your-turn-you-pull-it (§4);
inbox-read-advances-the-cursor-so-a-peek-consumes-the-nudge (§4); idle/working/blocked/done-look-identical-from-outside (§5);
every-idle-session-reads-as-waiting-for-a-human (§7); a-resumed-session-can't-tell-new-work-from-replayed-backlog (§7);
[from leaves] AskUserQuestion-is-ephemeral/invisible/pins-the-process (doc-annotations); resolving-hides-a-comment-from-the-card (doc-annotations).

*CLAUDE.md — all correctly always-loaded:* never-read-.canvas-files-directly (agent-bus);
`/api/command`-503-`delivered:0`-when-no-tab-live; no-shell-path-to-mutate-a-tabless-board;
a-`/api/canvas`-read-succeeds-with-no-tab-live (tabs=liveness); don't-curl-write-persist-endpoints;
delete-edges-before-nodes; `/input`-reads-AS-the-human-and-interrupts (thread-messages-must-not-use-it);
a-bare-shell-spawn-leaves-no-card; a-leaked-spawn-lingers-until-server/sidecar-stops;
Ctrl-C-no-longer-reaps-leaked-sessions; a-long-running-sidecar-keeps-old-code-across-upgrades;
don't-mix-session-modes (local-mode-won't-adopt-sidecar-sessions); percent-encode-the-colon-in-thread-ids;
membership-must-be-in-the-saved-snapshot-before-ask/message (spurious-403); inbox-peek-consumes-the-cursor;
membership-ops-need-`delivered`>0; never-copy-node_modules-between-machines;
never-guess-truncation-from-a-parse-failure; a-downstream-turn/row-cap-frees-no-memory-and-re-drops-content;
annotation-anchors-resolve-against-the-128KB-head-cap.

*Coordinator charter — LEAKED, hoist to harness (§B):* uniform-permission-baseline;
idle-states-look-identical; narration-on-your-session-card; resume-replays-backlog;
`claude -p`-can't-self-schedule; tag-gates-the-wake.

*Memory store — reliably surfaced (index line and/or CLAUDE.md):* push-`origin main`-only-never-`--all`/`--mirror` (push-safety);
re-run-a-privacy-sweep-before-any-push (push-safety); a-thread-relayed-nod-can't-lift-a-harness-gate (session-permission-model);
`claude -p`-can't-self-wake (canvas-session-self-wake); reads-work-tab-free/tabs=0-is-outage (pm-board-outage-resilience);
never-hand-write-the-thread-.jsonl (pm-board-outage-resilience); `autoMemoryDirectory`-must-be-absolute (headless-session-memory);
`EnterWorktree`-is-Agent-tool-only (worktree-spawn-primitive); don't-curl-write-a-board's-persist-endpoints (external-repo-boards);
a-unix-socket-in-the-watched-tree-crashes-Vite (session-host-sidecar).

*Memory store — STRANDED in pull-only bodies (§A):* co-located-peers-share-one-memory-dir-writes-clobber (channel-coordination-norms);
prose-@tag-actually-wakes (channel-tagging); Resume-on-a-live-session-forks-and-hijacks-the-feed (canvas-session-lifecycle);
don't-trust-`delivered`/snapshot-while-a-probe-lives (template-registry-stuck-tab).

## GOTCHA-ROLE (always-load, one role)

*Coordinator charter (correctly always-loaded):* never-put-the-task-in-the-spawn-prompt (L27);
don't-join-another-Coordinator's-thread-it-steals-the-seat (L28); nothing-fires-when-an-agent-goes-silent-hence-the-heartbeat (L34);
your-heartbeat-is-a-human-gated-server-fired-job-not-a-self-timer (L35).
*Memory store (stranded, → charter):* never-join-another-Coordinator's-thread (coordinator body — duplicate of the above, index has only "seat displacement").

## NORM-GLOBAL (always-load, all sessions)

*Harness brief (34, all correctly homed):* read-core-norms-first/open-a-leaf-on-demand; one-task-one-thread;
leave-a-post-untagged-unless-you-mean-to-wake; peek-and-act-never-peek-and-defer; poll-inbox-at-checkpoints-not-every-tool-call;
never-go-silently-idle-declare-a-typed-intent; the-thread-is-your-deliverable-surface-and-record;
post-decisions/status/blockers/proof-to-the-thread; your-card-is-a-pointer-not-a-copy;
a-standalone-session-addresses-the-human-via-its-card; memory-is-for-settled-facts-only;
moving-work-stays-in-the-thread; end-your-session-only-after-posting-your-result; sessions-are-ephemeral-the-record-is-the-log;
to-continue-expect-a-fresh-spawn-not-a-resume; in-bounds-without-a-nod (read/talk/claim/edit/test/commit-locally);
nod-before-push; nod-before-externally-visible-or-hard-to-reverse; nod-before-deleting-another's-work;
nod-before-changing-a-thread-brief; nod-before-a-costly-fan-out; [leaf, acceptable] message-vs-ask-choice;
pin-the-task/done-condition/framing; declare-blocked:human-when-you-ask-and-stop; declare-blocked:peer-while-waiting;
declare-done-then-wind-down; done-condition-should-be-a-pinned-post; done-must-carry-proof-against-the-condition;
prefer-the-anno-CLI; [leaf, WRONG-HOME vs harness but in CLAUDE.md] ask-on-the-doc-not-in-session;
reserve-AskUserQuestion-for-throwaway-confirmations; read-annotations-before-editing (the-revision-rule);
reply-to-annotations-in-the-same-edit; re-attach-or-resolve-true-orphans; resolution-belongs-to-the-author.

*CLAUDE.md (21):* read/mutate-canvas-only-through-the-bus; channel-discipline-don't-cross-the-wires *(dev-only)*;
signia-stays-behind-Subscribable *(dev-only)*; develop-on-main-no-feature-branches; bound-size-in-one-place *(dev-only)*;
keep-the-tail-for-logs-head-for-source *(dev-only)*; always-surface-a-truncated-flag *(dev-only)*;
prefer-generous-caps-virtualize-don't-drop *(dev-only)*; stop-the-process-on-5173-don't-override-the-port;
prefer-terminate-over-kill; prefer-`scripts/canvas spawn`-over-raw-spawn; poll-inbox-at-checkpoints;
done-must-carry-proof; `job coordinator`-is-the-human-gated-autonomy-switch; don't-add-a-`to`-field-to-messages;
prefer-the-anno-CLI; check-the-`orphaned`-flag-after-create; ask-on-the-doc-not-in-session;
the-revision-rule; re-attach-true-orphans; resolution-belongs-to-the-author.

*Coordinator charter — LEAKED, hoist (§B):* one-task-one-thread; the-RED-LINE; declare-work-intent;
never-resume; durable-state-not-in-process; be-terse.

*Memory store (12, surfaced):* one-task-one-thread; @-tag-gates-the-wake-not-the-read; never-resume-spawn-fresh;
local-commits-need-no-nod; the-red-line-set; surface-a-weighty-decision-on-the-most-visible-surface+blocked:human;
ask-on-the-doc-not-in-session; the-revision-rule; resolution-belongs-to-the-author; memory-is-settled-facts-status-in-threads;
autonomy-is-off-by-default-human-gated; [superseded] bundled-commits-ok → worktree-merge-workflow.

## NORM-ROLE (always-load, one role)

*Coordinator charter (38 — the genuine core; keep):* coordination-not-code-identity; own-a-thread-set-up-keep-moving-keep-legible;
act-like-a-human-user; create/adopt-the-thread-and-write-the-brief; pin-the-Done-when-and-revise-on-scope-shift;
spawn+invite-workers-no-per-spawn-nod; propose+get-a-nod-before-creating-a-new-ROLE; track-ownership-by-seat-surface-blockers-nudge-stalls;
loop-the-human-in-on-large/ambiguous/irreversible-calls; the-log-is-history-not-a-wiki-don't-curate-a-summary;
keep-the-brief-tight-post-decisions-as-messages; on-close-consider-a-docs-writeup+promote-lessons-to-memory;
do-freely (post/tag/invite/brief/summarise/small-calls/spawn/commit-at-green); DON'T-read/write-code-delegate-to-a-subagent;
status/decision/blocker/handoff-goes-in-the-thread-card-stays-terse; own-the-commit-as-authority-by-asking-the-author;
`git status`/`--stat`-ok-reading-the-diff-is-not-your-job; check-proof-against-the-pinned-Done-when-before-accepting-done;
restart-a-work-unit-via-a-fresh-thread-pointed-spawn; assign-via-a-tagged-thread-post-after-spawn-never-DM;
address-work-by-seat-not-sid; bridge-cross-Coordinator-via-the-human-or-a-neutral-thread;
tag-who-you-need-ambient-for-status-@all-for-room-events; pull-board/sessions/inbox-before-nudging;
operate-as-a-loop-not-purely-reactive; heartbeat-sweep-then-act-or-wind-down-silently; treat-@Coordinator-as-an-immediate-interrupt;
don't-firehose-rely-on-heartbeat+interrupt; your-loop-has-a-termination-close-with-`/done`;
wind-down-when: Done-when-met-with-proof / all-your-workers-closed / write-up+memory-current / nothing-awaiting-you;
post-a-short-wrap-before-`/done`; stay-up-if-merely-paused; don't-auto-continue-past-Done-when;
continuing-a-program-is-a-deliberate-new-thread; stance-calm-organised-bias-to-momentum;
know-the-call-you-can-make-vs-must-escalate.

*Also NORM-ROLE (elsewhere):* [CLAUDE.md] done-condition-is-a-pinned-post/Coordinator-reviews-proof;
skip-days-with-nothing (standing-job-worker brief). [harness leaf] oracle-answers-in-file:line-stay-in-the-ask/reply-loop.
[memory `coordinator`/`channel-coordination-norms`] card-is-not-a-status-surface; assign-via-tagged-post;
done-with-proof; no-auto-continue; own-commits-as-authority; ask-in-the-thread-not-as-a-session-ask-prompt;
discuss+wait-for-a-nod-before-building; short-plain-messages; poll-inbox-frequently;
file-overlap-check-before-fan-out+merge-on-green.

## FACT-PULL (pull-able — safe, no action)

Concentrated, correctly, in the on-demand surfaces. Groups:
- **Harness core/leaves (44):** canvas/thread/session node shapes; `@`-tag prefix syntax; the thread/inbox/
  message/join/leave/invite/ask/reply/pin/intent/window endpoints and their request/response shapes;
  board-vs-session endpoint scoping; the two recipe-leaf paths; `.canvas/memory` location.
- **CLAUDE.md (~78):** the full agent-bus / session-spawn / session-host / thread-coordination / doc-annotation
  API reference — every endpoint, id format, field name, status code, file path, CLI subcommand.
- **Coordinator charter (8):** `scripts/canvas spawn` syntax; `--thread` server cascade; immediate-membership;
  bare-`@Role`-mention-spawn; seat-survives-respawn; heartbeat endpoints; wake-live-else-respawn.
- **Memory store (6):** board-memory-is-CC-file-memory; headless-`-p`-gets-the-index-recall-is-pull;
  boardId-formula; background-task-completion-re-invokes-`-p`; sidecar-is-default; @-tag-token-semantics.

## PROVENANCE (pull-able reference / trim from always-load surfaces)

- **CLAUDE.md (14):** the de-risking-spikes history; Solid-port swappability story; `@tldraw/state`-single-copy;
  truncation-caused-more-bugs rationale; the SSE-pool "why"; the 5174 port-slide story; pre-rename `channel`
  alias; server-places-cards-because-agents-place-badly; legacy-`{type:channel}` residue; seats-1:1-until-multiplicity;
  work-intent-exists-because-process-states-are-identical; standing-jobs-exist-because-`-p`-can't-self-schedule;
  annotation-continuation-is-pull-for-now (W1/W5); resolution-rule-learned-the-hard-way.
- **Coordinator charter (5):** channel-wiki-retired lore; thread-can't-drift rationale; most-threads-need-neither
  rationale; the `coordinator-heartbeat.js` pointer; thrice-repeated delegation rationale.
- **Memory store (~23):** the bulk of the store — shipped-in-commit-X / tried-then-reverted / build-record entries
  (`agent-roles`, `threads-as-cards`, `session-lifecycle-status`, `session-substrate-decision`,
  `wakeable-substrate-plan`, `claude-tag-slack-reference`, `external-repo-boards`, `canvas-home`,
  `shadow-git-ledger`, `image-cards`, `canvas-perf-review`, `wayfinding-and-floating-cards`,
  `worktree-activity-experiment`, `worktree-spawn-primitive`, `notebook-card`, `multi-canvas-plan`, etc.).
  Correctly pull-able; several wrap a small extractable behaviour kernel already accounted for above.

## MOVING (should not be durable at all)

- CLAUDE.md: "all ongoing development happens here (app/)" — a status claim that will drift.
- Memory store & charters: none — both are disciplined about keeping moving status in threads.
