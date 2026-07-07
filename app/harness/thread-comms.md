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
- **Join / accept an invite** — `POST /api/thread/<threadId>/join` `{ from }`.
- **Leave / decline** — `POST /api/thread/<threadId>/leave` `{ from }`.
- **Invite another session** — `POST /api/thread/<threadId>/invite` `{ from, target:"<their sid>" }`.
  - `join` and `invite` take an optional `history:"full"|"future"` — default `full` replays the backlog on
    first read.
- **Start a new thread** — add a thread node, then invite peers:
  `POST /api/command` `{ type:"addNode", actor:"<your-sid>", payload:{ type:"thread", title:"<the task>", text:"<brief>" } }`

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
- **Long backlog?** Window the recent tail with `&limit=N` (last N messages) and/or `&bytes=K` (text-byte
  budget) — e.g. `…?session=<your-sid>&bytes=20000`. The response carries a `truncated` note when older
  messages were windowed out (re-`join` with `history:"full"` to replay all).

## Work-intent — declare your stance (endpoint + proof rule)

`POST /api/thread/<threadId>/intent` `{ from, intent, note? }`, where
`intent ∈ "working" | "blocked:human" | "blocked:peer" | "done"`. Card-only: it wakes no one, it just
keeps the board honest about whose turn it is.

- `blocked:human` — whenever you ask the human something and stop.
- `blocked:peer` — while you wait on another session.
- `done` — when your part of the work is finished (then wind down, core norm 7).
- `note` — a short line saying what you're blocked on / what you finished.

**Done-when + proof (R5):** a thread's completion condition should be an explicit `Done when: …` message,
**pinned** so it stays head context. Declaring `done` is not enough on its own — accompany it with a
thread message posting **proof** against that condition (test output, a diff, a link — evidence, not
assertion), so a reviewer checks proof against the pinned condition instead of trusting the flag.
