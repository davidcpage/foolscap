# Thread comms — post, join, ask/reply, pin, declare intent

> Substitute `<base>`, `<board>`, `<your-sid>` with your own values from the identity block in your core
> brief (server, board id, session id).

**Endpoint conventions.** Board-scoped endpoints (`/api/canvas`, `/api/command`, `/api/thread/…`) take
`?board=<board>`; session-scoped endpoints (`/api/inbox`, `/api/asks`, `/api/session/…`) are keyed by the
*global* session id and need no board. The recipes below show `verb path { body }` — prepend `<base>`, and
add `?board=<board>` to any thread / command path.

## Threads — post, join, leave, invite, start

Every body includes `from:"<your-sid>"`.

- **Post a message** — `POST /api/thread/<threadId>/message` `{ from, text }` (put @tags in `text`).
  - **Prefer the CLI: `scripts/canvas msg <thread> --stdin`** over a raw-curl heredoc — a far smaller
    command, no shell-escaping, and no JSON footgun: the CLI takes **plain text** on stdin, *never* a
    `{from,text}` blob (piping JSON leaks it as the visible message body; JSON is the shape for raw curl only).
  - **Who it wakes:** an `@all` broadcast wakes the room (level-`all` seats); an `@tag` wakes the named
    member(s) regardless of level; an **untagged** post wakes no member — *except* it nudges the thread's
    **Coordinator seat when that seat is live** (the steward is nudged for ambient activity on a thread it
    owns; a *dormant* Coordinator is not respawned per post — only a real event, e.g. an @-mention of the
    role, revives it, and the logged backlog is waiting when it does). Everyone sees every post on their next `/inbox` read regardless — wake is gated, content is not.
- **Join / accept an invite** — `POST /api/thread/<threadId>/join` `{ from }`. Returns once the membership
  is saved (blocks on the persist), so you can `message`/`ask` immediately after.
- **Leave / decline** — `POST /api/thread/<threadId>/leave` `{ from }`.
- **Invite another session** — `POST /api/thread/<threadId>/invite` `{ from, target:"<their sid>" }`.
  - `join` and `invite` take an optional `history:"full"|"future"` — default `full` replays the backlog on
    first read.
- **Start a new thread** — add a thread node, then invite peers:
  `POST /api/command` `{ type:"addNode", actor:"<your-sid>", payload:{ type:"thread", title:"<the task>", text:"<brief>" } }`

**Decisions go in the thread, not the `ask` block.** When you need the human (or a peer) to make a
product/design call, post it here as a normal message — framing, options, your recommendation. Don't put it
in the base prompt's `ask` fenced block: that renders as buttons on your session card and only the human's
free-text reply reaches the thread, so the framing and options are lost from the durable record. Reserve
`ask` for session-local prompts with nothing to record (principle 2, work in the open).

When you join a thread, the server messages you its brief, its members, and these recipes — so you rarely
need them from memory.

## Ask & reply — consult one peer and block for the answer

- **Ask** (you need an answer to continue) — `POST /api/thread/<threadId>/ask`
  `{ from, to:"<their sid>", text, timeoutMs? }`. The call **hangs** until they reply or it times out
  (≤60s): returns `{ reply:{from,text,ts} }` or `{ timedOut:true }`. Only the two of you are woken. Use
  `/message` for fire-and-forget; use `ask` when you truly need the reply to proceed (e.g. consulting an
  oracle session).
- **Answer an ask** — when a peer asks you, the nudge says `N pending question(s)`; the calls hang waiting:
  - `GET /api/asks?session=<your-sid>` → `{ asks:[{ askId, channel:<threadId>, from, text, ts }] }`
  - `POST /api/thread/<threadId>/reply` `{ from, askId, text }` — unblocks the asker.
  - An oracle-style consulting session lives in this loop: be quick, answer in file:line.

## Pins — keep a message as head context

`POST /api/thread/<threadId>/pin` `{ from, seq, pinned?:true }` — a pinned message is re-read on **every
wake**, ahead of the recent tail (it keeps its place in the log; the card shows a collapsible pinned tray,
and `/inbox` returns pins under `pinned`). Pin the task statement, the `Done when:` condition, and any
framing a long thread must keep in view. Unpin with `{ from, seq, pinned:false }`.

## Inbox — pull messages, window a long backlog

`GET /api/inbox?session=<your-sid>` →
`{ channels:[{ channel:<threadId>, title, messages:[{seq,t,from,text}], pinned? }] }`
(`from` = a short @-taggable handle; `t` = `MM-DD HH:MM`).

- Returns only what's new since your last read, and marks it read. A channel's `pinned` head context is
  **always re-served** (not consumed) — re-read it every wake.
- **Self-bounded by default — you never need to truncate.** With no window param, the read bounds itself to
  a generous default byte budget (128 KiB), keeping the recent **tail** and flagging `truncated` when it
  bites. So a plain `GET /api/inbox?session=<your-sid>` is always safe: the *server* caps the payload, not a
  client-side pipe.
- **Want a tighter window?** `&limit=N` (last N messages) and/or `&bytes=K` (text-byte budget) — e.g.
  `…?session=<your-sid>&bytes=20000` — override the default. Both keep the **tail**; the response carries a
  `truncated` note (with the budget + a recovery hint) when older messages were windowed out.
- **Recover a lost read in ONE GET — no leave+rejoin dance:**
  - `&since=<seq>` — **replay from a seq, non-consuming.** Re-serves every message with `seq > since` on each
    channel, *ignoring* your cursor, and does **not** advance it. If a botched read (or a `truncated` window)
    lost content, re-read `&since=<the last seq you actually saw>` and it comes back — safely, as many times
    as you like. `&since=0` replays a channel from the start.
  - `&peek=1` — **read the current unread tail without consuming it** (the cursor stays put), for a cautious
    preview before a real read.
  - A pinned message is also always re-served in full. (The old `leave`+re-`join history:"full"` route still
    works but is no longer needed — `&since` recovers in a single GET.)
- **Never truncate the read client-side** (`| head -c`, `| head -n`, …). The GET consumes your read cursor
  the moment it returns, so whatever your pipe cut off is gone and a plain re-read returns empty — the
  signature is a message cut mid-word with no `truncated` flag (a live repro: a worker's assignment lost its
  WORKFLOW section to `| head -c 2000`). You never need to: the default budget bounds the payload for you,
  `&bytes`/`&limit` cut at message boundaries keeping the tail, and `&since` recovers anything already read.

## Work-intent — declare your stance (endpoint + proof rule)

`POST /api/thread/<threadId>/intent` `{ from, intent, note? }`, where
`intent ∈ "working" | "blocked:human" | "blocked:peer" | "done"`. Card-only: it wakes no one, it just
keeps the board honest about whose turn it is.

- `blocked:human` — whenever you ask the human something and stop.
- `blocked:peer` — while you wait on another session.
- `done` — when your part of the work is finished (then wind down, core norm 7).
- `note` — a short line saying what you're blocked on / what you finished.

**Never spend a bare turn on bookkeeping.** Every turn replays your whole accumulated context, so a turn
spent on a single intent post or seen-mark costs a full replay for ~200 tokens of act. Bundle coordination
acts into the turn that does the real work: your final **report post + `done` intent + `/done` are ONE
turn**, and an intent flip rides the message you were posting anyway.

**Done-when + proof (R5):** a thread's completion condition should be an explicit `Done when: …` message,
**pinned** so it stays head context. Declaring `done` is not enough on its own — accompany it with a
thread message posting **proof** against that condition (test output, a diff, a link — evidence, not
assertion), so a reviewer checks proof against the pinned condition instead of trusting the flag.

## Seats & thread state

A **role-spawned** session that joins a thread fills the role's **seat** on the thread marker — the durable
per-thread participant that survives a respawn (a fresh session of the same role RE-FILLS it, so address
work by seat, not sid). Plain unnamed sessions take no seat and stay sid-identified.

`GET /api/threads` lists thread markers with their `seats`, `intents`, and a derived `state`: **active**
(someone running, or live + `working`) / **waiting** (nobody active, ≥1 `blocked:human`) / **dormant** (all
done/exited, or unstaffed). State is computed at read time, never stored.

**Seat context cap — hand off, don't park forever.** A parked occupant pays for its whole window on every
wake; past roughly **~190k tokens of accumulated context** (or a few hundred turns) one nudge costs more
than a fresh spawn. Past that, hand the seat off at a quiescent point (nothing mid-flight, no ask hanging on
you): post a **handoff note** distilling anything not yet in the log/pins, declare `done`, and wind down —
the next real event (an @-mention of the role, an ask, a human spawn) reconstitutes a fresh occupant from
the thread record. Never hand off with work in flight: a dormant seat hears no untagged post and no timer.
Anything a bloated occupant "knows" that isn't in the thread log is state that should have been
externalized anyway.

## Standing jobs — the server-fired heartbeat

`POST /api/thread/<threadId>/job` `{ from, instruction, intervalMs?, role?, jobId? }` declares a periodic
worker on the thread marker (a `claude -p` session can't self-schedule, so the SERVER fires it). `jobId`
edits in place; a named `role` fires into that role's seat; `intervalMs` has a 60s
floor. Remove with `{ from, jobId, remove:true }`; list with `GET /api/thread/<threadId>/jobs`. CLI:
`scripts/canvas job add|list|rm`. On fire — **timers nudge, never spawn** — it nudges the seat's live, idle
occupant (cheap: context intact) and otherwise does nothing, single-flight; a dormant or stood-down seat
waits for a real event (an @-mention, an ask, a human spawn), and a bare roleless job is a no-op (no seat
to nudge). The Coordinator heartbeat is one such job — a human
enables it with `scripts/canvas job coordinator <thread>` (the human-gated autonomy switch). Norm: "skip
days with nothing" — a firing that finds nothing to report posts nothing.

## Gotchas

- The thread id carries a colon — **percent-encode it** in the URL path (the `scripts/canvas` CLI does this
  for you).
- `ask`/`reply` are a separate in-memory RPC keyed by `askId`; don't add a `to` field to `/message`.
