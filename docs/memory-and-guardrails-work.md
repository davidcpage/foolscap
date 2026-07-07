# Work brief — memory search, map-index, and guardrails

*Handoff 2026-07-07 from the harness-constitution thread. Design context: `docs/harness-constitution.md`
(esp. §D guardrail table), `docs/memory-classification.md`, and the memories `harness-constitution` +
`headless-session-memory` (the verified no-push finding that motivates all of this — the always-loaded
surface must stay small; everything else is pull/search).*

The constitution/charter/CLAUDE.md restructure is done. Three tracks remain, all local code/prose changes
(no push without a human nod). They share files, so **run the file-overlap check before any fan-out**
(disjoint → parallel worktrees; overlapping → serialize) per the Coordinator charter.

## T1 — `scripts/canvas memory search` (the keystone)

Make the memory corpus findable by pull, so it can grow unbounded without the index enumerating it.
- A `memory search <query>` verb on `scripts/canvas` doing **ranked lexical** search over
  `.canvas/memory/*.md` (ripgrep is available in-shell). Rank: filename/slug match > `description:`
  frontmatter match > body match. Output **web-search-shaped** — per hit, the slug + its `description:` +
  the matching lines, most-relevant first — so the agent skims and opens the promising files.
- Fold in a light **hygiene check** (a `--doctor` flag or a warning line): flag memory files missing a
  `description:` frontmatter or that look non-atomic. (This replaces the dropped "memory lint" — a size-cop
  is unnecessary once the index is a map; see T2.)
- Add a usage line to the dispatcher's `usage()`.
- **Acceptance:** a query for a known fact (e.g. `memory search "resume session"`) surfaces
  `never-resume-sessions` / `canvas-session-lifecycle` ranked at top, with description + matching lines.
- **Touches:** `scripts/canvas` (+ optionally a small `app/memory-search.js` helper). Semantic/embedding
  search is explicitly **out of scope** — lexical first; revisit only if recall degrades at scale.

## T2 — Flip `MEMORY.md` from catalog to map (depends on T1)

The index is the only always-loaded part of the store (first 200 lines / 25KB). A flat per-fact catalog
hits the silent-truncation cap as the corpus grows. Restructure `.canvas/memory/MEMORY.md` into a bounded
**map**:
- (a) a small always-hot pointer set — only the genuinely must-be-in-mind items (most behaviour now lives
  in the harness, so this is minimal);
- (b) a **topic map** — one line per *category* (not per fact) saying what lives there;
- (c) an explicit instruction: *this index is not exhaustive — find any fact with
  `scripts/canvas memory search <terms>`* (hence the T1 dependency).
- **Preserve every existing fact FILE** — only the index changes; the facts stay individually
  pullable/searchable. Keep the index well under the cap.
- **Acceptance:** the index is a bounded map, every current topic is represented, the search instruction is
  present, and no fact file was deleted.
- **Touches:** `.canvas/memory/MEMORY.md`.

## T3 — Guardrails (each retires a "can't derive" gotcha; §D of the classification)

Each guardrail lets a line be deleted from the harness "A few things you can't derive" list / a principle's
caution — the structural way the always-load surface keeps shrinking.
- **a. CLI hard-errors on `delivered:0`.** `scripts/canvas` verbs that POST `/api/command` (and `msg`) exit
  non-zero with a clear message when the bus returns `{delivered:0}`, instead of silently "succeeding". →
  retires the confirm-`delivered>0` caution under principle 6.
- **b. `join` blocks until the `member:open` edge is persisted.** So the "membership must be in the saved
  snapshot before `ask`/`message`" 403 race disappears. → retires that gotcha from `thread-comms.md`.
- **c. `removeNode` cascades its edges server-side.** So "delete edges before nodes" stops being a rule the
  operator carries. → retires that line from `agent-bus.md`.
- **d. A prose `@name` escape.** A convention the tag parser honours to mention a handle *without* waking it
  (e.g. backticked/escaped). → retires the one entry currently in the harness "can't derive" list.
- **Acceptance per guardrail:** the failure mode no longer occurs, AND the corresponding line is removed
  from the harness leaf / constitution in the same change (proof: before/after of the harness text + a
  demonstration).
- **Touches:** `scripts/canvas` (a); `vite-fs-plugin.ts` + `app/thread-tags.js` (b, c, d). Overlaps T1 on
  `scripts/canvas` — sequence or isolate accordingly.

## Done when

T1, T2, T3 all complete **with proof** posted against this brief: `memory search` returns ranked hits on a
sample query; `MEMORY.md` is a map under the 200-line/25KB cap with the search instruction; each guardrail
demonstrably retires its gotcha and the matching harness line is deleted. All changes committed **locally**
(a push is a red-line act needing a human nod). Semantic search and any index restructuring beyond map-mode
are out of scope.
