# Harness restructure proposal — tight core + lazy skills

**Status:** proposal (2026-07-07). Companion research: `docs/harness-best-practices.md` (read that first for
the best-practice basis and the skills mechanism). **This doc does not edit `app/harness.md`.**

**Problem in one line:** `app/harness.md` (~126 lines, ~13 ALL-CAPS blocks) is appended verbatim to every
spawned `claude -p` session. It is correct but too dense to read, and the density is the suspected reason the
collaboration norms don't reliably stick. Best-practice (right altitude, labelled structure, show-don't-tell,
smallest high-signal set) plus Agent Skills' progressive disclosure both point the same way: a **tight
always-on CORE** of non-negotiable norms + a one-line pointer per capability, and **lazy SKILLS** holding the
detailed API recipes.

---

## Part 1 — Readability review (specific passages)

Line numbers are against the current `app/harness.md`.

### 1. The whole doc uses ALL-CAPS run-on leads instead of headings

Every block opens like `THREADS are how you talk to peers…` (L14), `DECLARE YOUR WORK-INTENT. From the
outside…` (L63), `RECEIVING. Thread messages do NOT arrive…` (L39). The caps are doing the job a heading
should do, but they sit *inside* the paragraph, so there is no scannable table of contents and no visual
separation between "this is a section title" and "this word is emphasised." Best-practice: use real headings /
delimiters so the model can tell the parts apart. **Fix:** `## Threads`, `## Receiving messages`, etc., and
reserve caps for the rare genuine emphasis (one per section, not one per sentence).

### 2. The THREADS block buries a non-negotiable norm inside a prose paragraph (L14-20)

> "A post is always LOGGED for everyone, but it only WAKES the members you @-tag — so name who you need. Tag a
> member by a prefix of their session id (`@a927e694`… `@a9`); `@all` wakes the whole room; an UNTAGGED post
> wakes no one… If you tag a specific peer and then go idle, your card shows 'waiting on an agent'…"

This is the **wake-economics rule** — one of the norms that must always be in force — yet it is a six-line
run-on wedged between the concept sentence and the endpoint list, mixing the rule with a UI side-effect
(waiting-state) that isn't part of the rule. A reader skims past it. **Fix:** promote it to its own tight
rule block in the core with a labelled heading and 3 bullets (logged-vs-woken / how to tag / untagged = wakes
no one), and drop the waiting-state aside into the thread-comms skill.

### 3. Endpoint bullets carry full query-string boilerplate that drowns the verb (L21-36)

> "post: POST {{base}}/api/thread/<threadId>/message?board={{boardId}} { from:\"{{sessionId}}\", text } (put
> @tags in text)"

Every one of the six thread verbs repeats `{{base}}/api/thread/<threadId>/…?board={{boardId}}` and
`{ from:"{{sessionId}}", … }`. The repeated scaffolding is ~70% of each line, so the actual differentiator
(`/message` vs `/join` vs `/ask`) is hard to spot. This is exactly the "formatting overhead" the ACI guidance
says to strip. **Fix:** these recipes leave the always-on core entirely and move to the `thread-comms` skill,
where one worked `curl` example plus a compact verb table teaches the pattern once.

### 4. Inline JSON schemas raise the altitude mid-sentence (L42, L9)

> "GET {{base}}/api/inbox?session={{sessionId}} → { channels:[{ channel:<threadId>, title,
> messages:[{seq,t,from,text}], pinned? }] } (from = a short @-taggable handle; t = MM-DD HH:MM)"

Dropping a nested response shape into an always-on brief spends context on a detail that only matters when the
model is actually parsing an inbox response. Same pattern at L9 (`{ snapshot: { records: [...] } }`). It's the
wrong altitude for a norms brief. **Fix:** core says only "you receive a nudge, then `GET /api/inbox` to pull
the content"; the response schema and the `?limit`/`?bytes` windowing live in the skill.

### 5. WORK-INTENT fuses concept + enum + a second rule (R5) into one 11-line block (L63-73)

The block states the concept (idle looks identical to done), lists the four-value enum, gives the endpoint,
*and* introduces the DONE-WHEN + PROOF discipline (R5) — four different things under one lead. The norm that
must stick ("declare your stance; don't go silently idle") is diluted by the endpoint mechanics and the proof
sub-rule. **Fix:** core keeps a one-line rule ("when you stop, declare working / blocked:human / blocked:peer
/ done — never go silently idle"); the endpoint, the enum semantics, and R5 proof-against-pinned-condition move
to `thread-comms`.

### 6. DOC ANNOTATIONS is a 32-line mini-manual with three embedded sub-norms (L84-115)

The single largest block. It carries the CLI verb list, raw endpoints, *and* three capitalised sub-norms
(ASK-ON-THE-DOC, THE REVISION RULE, RESOLUTION-BELONGS-TO-THE-AUTHOR), each itself a paragraph. Roughly a
quarter of the entire always-on brief is spent on a capability that only applies when a doc card is in play.
This is the textbook "keep it out of context until used" case. **Fix:** the whole block becomes the
`doc-annotations` skill; the core keeps one pointer line ("editing/answering an annotated doc? load the
doc-annotations skill first — there's a revision rule").

### 7. PUBLIC CHANNELS and THREAD MODE say the same thing twice (L117 and L119)

L117 ("the thread… is the durable, readable trace… never assume a peer or human reads your in-session text")
and L119 ("that thread… is your deliverable surface… Your session-card text is then a POINTER… never a
duplicate") are two dense single-paragraph statements of one rule: **post to the thread; the card is a pointer,
not a copy.** This violates one-home-per-fact and taxes the reader with near-duplicate prose. **Fix:** collapse
to a single core rule with a heading and 2-3 bullets.

### 8. The RED LINE is a norm buried in a 7-line run-on (L121-127)

> "…What DOES need a human nod first is the RED LINE: pushing to a remote, anything externally-visible or hard
> to reverse, deleting another agent's work, changing a thread's task/brief, or spawning a large/costly
> fan-out…"

This is the single most important always-on norm, and it's a comma-separated list embedded in a paragraph that
also explains what does *not* need a nod (commits). A hard rule this consequential should be the most scannable
thing in the file, not the least. **Fix:** keep it in core as a two-part labelled block — a short "in bounds,
no nod needed" line and a bulleted **RED LINE** list, each item on its own line.

**Cross-cutting:** the brief also has no example anywhere. Best-practice ("examples are the pictures worth a
thousand words") wants at least one worked artefact — a sample thread post showing an @-tag, a pinned
`Done when:` line — which teaches format faster than any of the prose above.

---

## Part 2 — Restructure proposal

### 2a. The always-on CORE (draft)

**Design rule for the core:** it holds (i) identity, (ii) every norm that must be in force *even if no skill
triggers* — thread-first discipline, wake economics, how to read the board, how to receive messages, the
pointer-not-copy rule, the RED LINE — and (iii) exactly one pointer line per lazy capability. Nothing that is
only a *recipe* stays. Target: ~40-45 lines, all scannable.

Blocks that stay (mapped to the ~13 originals): **1** (identity), **2** (read the board, trimmed to a
pointer), the **wake rule extracted from 3**, a **minimal receive path from 4**, **5** (peek-and-act, tightened
to a rule), a **one-line rule from 7** (declare intent), a **one-line rule from 8** (end your own session),
**10+11 merged** (pointer-not-copy), **12** (norms + RED LINE). Everything else becomes a pointer.

Drafted core text:

````markdown
# You are a session on a foolscap board

You are a Claude session running as a live card on a **foolscap board** — a shared, infinite-canvas
workspace. Other sessions may be cards on the same board; the board is shared memory you all read and write.

- board id: `{{boardId}}`  ·  your session id: `{{sessionId}}`  ·  server: `{{base}}`

## Read the board (nothing is pushed except message nudges)

You learn board state by asking:
`GET {{base}}/api/canvas?board={{boardId}}` → `snapshot.records` (nodes + edges). A **session** card is
`{type:"session"}`; a **thread** card is `{type:"thread"}` whose `text` is the task brief; a session joins a
thread via a `member:open` edge.

## Threads are how you talk to peers

A thread is a **task with a conversation attached**. You work in thread ids + your own session id; the server
resolves the rest. **One task, one thread** — put new work in a new thread, don't piggyback.

**Wake economics (always in force):** a post is **logged for everyone** but only **wakes the members you
@-tag**.
- Tag by a prefix of a session id: `@a9`. `@all` wakes the whole room.
- An **untagged post wakes no one** — it's ambient; peers see it when they next read.
- So: name who you need, and don't @-tag someone unless you actually want to interrupt them.

Post a message: `POST {{base}}/api/thread/<threadId>/message?board={{boardId}}`
`{ from:"{{sessionId}}", text }` — put @tags in `text`. Example:

> `{ "from":"{{sessionId}}", "text":"@a9 pushed the parser fix, tests green — see diff below. Done when: CI
> passes on main." }`

Joining, leaving, inviting, blocking-ask, pinning, windowing a long backlog → **load the `thread-comms`
skill** (it has every recipe). When you join a thread the server also messages you its brief + members +
recipes, so you rarely need them from memory.

## Receiving messages (you pull; content never lands in your turn)

Message content does **not** arrive as your input. When a peer posts a tagged message you get a short nudge
line (`[canvas] new thread messages: …`). Pull the actual content yourself:
`GET {{base}}/api/inbox?session={{sessionId}}` — returns what's new since your last read and marks it read.

**Peek-and-act, never peek-and-defer:** reading `/api/inbox` **advances your read cursor**, so a peek
*consumes* the nudge — it won't re-fire. When you peek, act on what you saw this turn (or explicitly note what
you'll do). Poll at natural checkpoints during a long turn (after a sub-task, before an expensive/irreversible
step) — not between every tool call.

## Say what you're doing; leave the record in the thread

- **Declare your stance when you stop** — don't go silently idle. Post an intent:
  `working` / `blocked:human` / `blocked:peer` / `done`. (Endpoint + done-with-proof discipline: `thread-comms`
  skill.)
- **The thread is the record, your card is a pointer.** If you're in a thread, post decisions, status,
  blockers, proof, and handoffs *there* — never assume anyone reads your in-session text or card narration.
  One record per fact; the card is a lens on the thread, not a second copy. (A standalone session with no
  thread uses its card to address the human, as usual.)
- **When your work is genuinely finished**, end your own session so its card settles to "✓ done" instead of
  nagging as "waiting": `POST {{base}}/api/session/{{sessionId}}/done` — but only *after* you've posted your
  result/handoff to the thread. A session is ephemeral: its durable trace is the thread log + what you wrote,
  not the process. To continue later, a **fresh** session is spawned — don't rely on being resumed.

## Capabilities that load on demand (skills)

Read the skill's body when the task calls for it:
- **`thread-comms`** — join/leave/invite, blocking `ask`/`reply`, `pin`, work-intent + done-with-proof,
  inbox windowing.
- **`doc-annotations`** — comment on / answer questions anchored to a doc card. **Load this before editing or
  answering an annotated doc** — there's a revision rule and an ask-on-the-doc rule you must follow.

## Norms

In bounds, **no nod needed**: read the board, talk in threads, claim work before racing a peer on the same
file, stay within your thread's task/brief, and do the work you were spawned for — editing files, running
tests, and **committing to the local repo** (a commit is not a push; it never reaches a remote).

**RED LINE — surface a short plan and wait for a human nod before any of these:**
- pushing to a remote;
- anything externally visible or hard to reverse;
- deleting another agent's work;
- changing a thread's task/brief;
- spawning a large/costly fan-out of sessions.
````

This core retains, as explicit rules, all six non-negotiables named in the constraint: thread-first discipline,
wake economics (@-tag wakes only tagged members), the RED LINE, pointer-not-copy, how to read the board, how to
receive messages — plus the peek-and-act and declare-intent norms. It drops all endpoint boilerplate, all
inline schemas, and the entire doc-annotations manual.

### 2b. The SKILLS

Two skills carry today's harness detail; three more are candidates sourced from `CLAUDE.md` (not currently in
the harness) if we want the same treatment for spawn/jobs/memory. Descriptions below are the always-loaded
trigger text — written to say both *what* and *when*.

#### Skill 1 — `thread-comms` (primary)

```yaml
name: thread-comms
description: >-
  Recipes for talking to peers on a foolscap board through threads: join, leave, or invite a session to a
  thread; broadcast a message and @-tag who to wake; consult one member and block for the answer (ask/reply
  oracle pattern); pin a message as re-read head context; declare work-intent (working / blocked:human /
  blocked:peer / done) with done-when-plus-proof; and window a long inbox backlog. Use whenever you need to
  post to, join, or coordinate on a thread, answer another session's blocking question, pin the task or
  Done-when condition, declare that you are blocked or done, or read a large message backlog. The exact
  HTTP/curl shapes and query params live here.
```

Body contains (moved verbatim/condensed from harness):
- The full thread verb table with worked `curl` examples: `message`, `join`, `leave`, `invite`
  (`history:"full"|"future"`), plus `addNode {type:"thread"}` to start a new thread (L21-37).
- **Blocking `ask`** (`{from,to,text,timeoutMs?}`, hangs ≤60s, `{reply}` or `{timedOut}`) and the **answer
  side** (`GET /api/asks`, `POST …/reply {askId}`) — the oracle loop (L26-29, L58-61).
- **`pin`** endpoint + "pin the task statement and the `Done when:` condition" guidance (L30-33).
- **Work-intent** endpoint + enum semantics + **R5 done-when + proof** (declaring done needs a thread message
  posting evidence against the pinned condition) (L63-73).
- **Inbox response schema** + `?limit`/`?bytes` windowing + `truncated` note (L42-47).

#### Skill 2 — `doc-annotations` (primary)

```yaml
name: doc-annotations
description: >-
  How to read, write, and answer standoff quote-anchored comments on a foolscap doc card — questions and notes
  stored outside the file so its bytes never change. Use whenever you are asked to answer or reply to comments
  on a doc, before editing any file that may carry annotations (the revision rule: read open annotations
  first, reply to what you can), when you hit a decision only the human can make and must raise an anchored
  question instead of an in-session prompt (ask-on-the-doc), or when you need the scripts/canvas anno CLI
  (list / reply / batch / resolve / reopen / ask / answer) or the raw /api/annotations endpoints. Covers who
  may resolve a comment.
```

Body contains (the whole current L84-115):
- The `scripts/canvas anno` verb list (`list`, `reply --stdin/--text-file`, `batch`, `resolve/reopen`, `ask`,
  `answer`) and the raw `GET/POST /api/annotations` ops.
- **ASK-ON-THE-DOC, NOT IN-SESSION** — raise an anchored `--blocking` question, declare `blocked:human`, wind
  down; a fresh session applies the answer.
- **THE REVISION RULE** — read open annotations before editing; reply in the same change; server
  auto-reanchors moved comments; only true orphans (deleted quotes) need hand-reattach.
- **RESOLUTION BELONGS TO THE AUTHOR** — never reply-and-resolve someone else's question.

#### Candidate skills 3-5 (from `CLAUDE.md`, not in today's harness — propose if we extend coverage)

These aren't in `harness.md` today, but they're the same shape (dense conditional recipes) and would round out
a session's toolkit. Flagged as optional so we don't scope-creep the split.

- **`session-spawn`** — `scripts/canvas spawn` / `POST /api/session/spawn` (roleId, thread, card), the
  card-drop cascade, the `MAX_LIVE_SESSIONS` cap, terminate/interrupt/done/resume. *Description trigger:* "when
  you need to spawn, resume, or tear down another worker session, or staff a thread with an agent."
- **`standing-jobs`** — `POST /api/thread/<id>/job`, intervals/60s floor, wake-live-else-respawn, the
  Coordinator heartbeat, `scripts/canvas job`. *Trigger:* "when setting up or editing a recurring
  server-fired worker on a thread."
- **`board-memory`** — role memory / `.canvas/` home conventions, one-home-per-fact. *Trigger:* "when reading
  or writing durable board/role memory."

**Recommended cut for *this* change:** ship the CORE + the two primary skills (`thread-comms`,
`doc-annotations`) — they are a clean, lossless extraction of the current harness. Treat 3-5 as a follow-up.

### 2c. Where the skills live (placement)

The constraint is real: a spawned session's **cwd is the board's repo** (`repoPath`). Project skills at
`<board-repo>/.claude/skills/` therefore exist only for the dev repo — an **externally-mounted board's cwd is a
different repo that won't contain our skills**, so those workers would silently lose the capability recipes.

**Recommendation: install the primary skills in the per-machine home `~/.claude/skills/`** (`thread-comms`,
`doc-annotations`), so every spawned session on every board — dev or externally-mounted — auto-discovers them.
The raw `claude -p` path (no `--bare`) loads `~/.claude` by default (confirmed in the research doc §4), so no
flag change is needed.

Installation for spawned sessions:
- **Own them in-repo, symlink/copy to the home on setup.** Keep the canonical `SKILL.md` sources under
  `app/skills/` (version-controlled, reviewable), and have the dev bootstrap (or a `scripts/canvas`
  setup verb) sync them into `~/.claude/skills/<name>/`. This keeps the source in git while satisfying the
  portable-home requirement. Document it next to the harness in `CLAUDE.md`.
- **Alternative: a plugin bundle via `--plugin-dir`.** Cleaner isolation and namespaced `plugin:skill`
  invocation, and it travels with the app rather than mutating the user's home. Costs a spawn-flag change
  (add `--plugin-dir <app>/plugins/…`). Prefer this if we don't want to write into `~/.claude`. Either way,
  **do not** rely on project placement in the board repo — it breaks external boards.

The always-on CORE stays exactly where the current harness is: the `collabBrief` in `--append-system-prompt`
(`app/harness.md`). It has no placement dependency — it's injected regardless of board.

### 2d. Open risks / must be live-tested

1. **Auto-trigger reliability in headless `-p`.** The core carries only a one-line pointer per capability; the
   whole scheme depends on the model **auto-reading the skill from its `description`** mid-turn, unprompted, in
   a non-interactive worker. This is the single biggest risk. Test: install `thread-comms`, spawn a worker into
   a thread with a task that needs `ask`/`pin`, and observe whether it loads the skill without a `/thread-comms`
   nudge. If auto-trigger is flaky, mitigate by naming the skill explicitly in the core pointer ("load the
   `thread-comms` skill") and/or invoking `/thread-comms` in the spawn's first turn for thread-staffed workers.
2. **Skill tool under `--permission-mode auto` + baseline `--allowedTools`.** Verify the Skill tool and the
   bash/Read it uses to open `SKILL.md` fire without tripping a deny/hold through the permission-relay MCP. If
   Read/bash on `~/.claude/skills/**` isn't in the baseline allow-list, add it.
3. **External-board placement.** Confirm a worker spawned on an **externally-mounted** board (cwd = the other
   repo) actually discovers `~/.claude/skills/` (or the `--plugin-dir` bundle). This is the case project
   placement would silently miss — test it explicitly on a mounted repo, not just the dev repo.
4. **Norm-adherence regression.** The point of the split is that norms stick *better*. Before/after check:
   spawn a worker under the new core and confirm it still (a) @-tags correctly, (b) respects the RED LINE
   (surfaces a plan before a push), (c) posts to the thread rather than narrating in its card. If a norm that
   moved into a skill stops firing, pull it back into the core.
5. **Two-surface drift.** Once recipes live in skills and rules in the core, the "one home per fact" rule has
   to be policed — e.g. the wake-economics rule is in the core, the endpoint is in the skill; don't let both
   grow a copy of the other. Keep a short "who owns what" note at the top of each skill.

---

## Summary

- **Core (always-on, ~40 lines):** identity, read-the-board pointer, wake economics, receive-by-pull +
  peek-and-act, declare-intent + thread-is-the-record + end-your-session, one pointer per skill, and the RED
  LINE — every non-negotiable norm as an explicit, scannable rule, with one worked thread-post example.
- **Skills (lazy):** `thread-comms` (all thread verbs + ask/reply + pin + work-intent + inbox windowing) and
  `doc-annotations` (CLI + endpoints + the three doc sub-norms). Optional follow-ups: `session-spawn`,
  `standing-jobs`, `board-memory` (from `CLAUDE.md`).
- **Placement:** `~/.claude/skills/` (or a `--plugin-dir` plugin bundle), sourced from a version-controlled
  `app/skills/` and synced on setup — never project `.claude/skills/` in the board repo, which external boards
  don't have.
- **Biggest risk:** whether a headless `-p` worker reliably **auto-triggers** the right skill from its
  description mid-turn; test before committing, and fall back to naming/`/invoking` the skill in the core if
  it's flaky.
