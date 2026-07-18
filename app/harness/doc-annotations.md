# Doc annotations — comment on / answer a doc card

> Substitute `<base>`, `<board>`, `<your-sid>` with your own values from the identity block in your core
> brief (server, board id, session id).

Files on this board can carry **standoff comments** — quote-anchored questions and notes stored *outside*
the file (the bytes you read or edit never contain them; ledger in `.canvas/annotations/`). The human
highlights a span on a doc card and asks; your answer lands where the question lives. Prefer the
`scripts/canvas anno` CLI over raw curl for the whole loop:

- `scripts/canvas anno list [<path>]` — board sweep, or one file's comments (one line each).
- `scripts/canvas anno reply <path> <id> [TEXT]` — `--stdin` / `--text-file` for long replies (no
  shell-escaping); `--from <your-sid>` to attribute.
- `scripts/canvas anno batch <path> replies.json` — many replies at once from a JSON *data* file
  (`[{id,text}]` or `{id:text}`), not an ad-hoc script.
- `scripts/canvas anno resolve|reopen <path> <id> [--by <sid>]`.
- `scripts/canvas anno ask <path> --question "…" --anchor-exact "…" [--options "A|B|C"] [--blocking]` —
  raise an anchored question the human answers on the doc.
- `scripts/canvas anno answer <path> <id> [--choice LABEL] [--text "…"]` — answer such a question.
- `scripts/canvas anno suggest <path> --anchor-exact "…" --replacement "…"` — propose a track-changes
  edit; `anno accept|reject <path> <id>` decides it (accept splices the bytes + resolves, reject resolves
  untouched).
- `scripts/canvas anno watch <path> [--role R] [--level all|mentions|paused] [--pause|--resume|--unwatch]`
  — bind a role as a doc watcher (who to wake when a comment lands).

Raw endpoints if needed: `GET/POST <base>/api/annotations?board=<board>` (ops: `create` / `reply` /
`answer` / `resolve` / `reopen` / `accept` / `reject` / `reanchor` / `thread`; doc-watch: `watch` /
`pause` / `resume` / `unwatch`; doc-jobs: `job` / `unjob`). The per-file `GET` returns `anchor.exact` (the
quoted span) plus `orphaned` / `range`, and for a question its `state` (awaiting a human / answered, ready
to apply / resolved).

Three sub-rules govern doc work:

**Ask on the doc, not in-session.** When you hit a real decision you can't make alone — a design fork, a
choice the human must own — do **not** reach for the in-session `AskUserQuestion` block (ephemeral,
board-invisible, and it pins your process open waiting). Instead raise an anchored question on the span it
concerns (`anno ask … --blocking`), declare `blocked:human`, and wind down: the question and its answer
live on the doc forever, the board sees the decision pending, and a fresh session applies the answer
later. Reserve the in-session block for throwaway confirmations, never a decision of weight.

**The revision rule.** Before editing a file, read its open annotations (`scripts/canvas anno list
<path>` — cheap, usually empty). As part of the same change, **reply** to what you can answer. You do
**not** hand-reanchor moved comments — the server auto-reanchors any moved-but-still-resolvable comment on
the next read/write. It only leaves **true orphans** (comments whose quoted text your edit *deleted*),
shown as a loud orphan strip; re-attach those from the quote or resolve them.

**Resolution belongs to the author.** Resolve your **own** comments freely, but **never**
reply-and-resolve someone else's question — a resolved comment is hidden from the card by default, so
resolving it buries your reply before the asker has read it. Reply, leave it **open**, and let the author
resolve once satisfied (resolve another author's comment only when they explicitly say so). "Answer the
comments on `<file>`" means: reply per annotation, and where the right answer is "fix the doc", fix the doc.

**Sweep & gotchas.** The board sweep `GET /api/annotations?board=<board>` (no path) returns per-file counts
`{ total, open, orphaned, awaiting, answered }` — `awaiting` = a question needing a human, `answered` = one
needing an agent to apply. `create` needs the file to exist and 404s on non-servable (binary/internal)
paths; anchors resolve against the 128KB head-capped read, so a quoted span beyond the cap reads as
orphaned by design.
