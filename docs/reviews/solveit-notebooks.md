# Review: Solveit and agent-integrated Notebook cards

*Prepared 2026-07-09 for thread "Review: Solveit notebooks & agent-integrated Notebook cards". This is a
discussion doc, meant to be carded and annotated — the recommendation at the end is a starting position, not
a settled decision. Companion reading: `docs/notebook-card.md` (our reactive notebook design),
`docs/agent-sessions-on-canvas.md` (the session-as-process/card-as-view model), `docs/doc-annotations.md`
(the standoff comment + suggestion substrate).*

---

## 1. What Solveit is

Solveit is fast.ai / Answer.AI's tool for what they call **"dialog engineering."** It ships alongside the
"How to Solve It With Code" course and has been used internally to build Answer.AI's own products. The
one-line framing from their own posts: a workspace that is "a conversation between three parties — you and
yourself (notes), you and the computer (code), and you and the AI (prompts)."

Concretely, a Solveit **dialog** is a single linear-but-editable document made of four message types:

- **Code** — Python run in a persistent per-dialog kernel, output shown inline.
- **Note** — markdown (headings, LaTeX, images) that both documents and structures the dialog.
- **Prompt** — a direct query to the AI, which answers with the full dialog *above it* as context.
- **Raw** — rarely used.

The defining moves are about **curating the AI's context**, not automating work away:

- **Context is "everything above the current message"**, and only that. The dialog is not a chat sidebar
  bolted onto an editor — the code, notes, outputs, and prior prompts *are* the context window.
- **Pin (P)** keeps a message permanently in context even as the dialog outgrows the window; **hide (H)**
  keeps a message visible to the human but drops it from the AI's context (used to prune dead ends).
  Automatic discarding sheds the oldest unpinned messages when the token budget is hit. Token counts are
  shown per-message so context cost is legible.
- **Any AI response is editable** (press N). Dialogs are living documents, not append-only logs. Their
  stated rationale is a real LLM failure mode: once a model emits a mistake, subsequent tokens are
  statistically likely to compound it, so being able to *edit the model's own past output* — not just your
  prompts — keeps the trajectory clean.
- **Tools** — any Python function can be exposed to the AI with `` &`fn` ``; built-ins include web
  search, URL reading, and file grep/sed/view. `dialoghelper` lets the AI *modify the dialog itself* —
  search messages, insert/edit cells — so the AI operates on the same document the human does.
- The kernel is a **persistent Python 3 interpreter per dialog** with a live symbol browser and
  kernel-aware autocomplete. Response *modes* (Learning / Concise / Standard) and ghost-text can be tuned;
  Learning mode disables ghost-text on purpose, to make you type.

### The philosophy is the product

The mechanics all serve one stance, stated bluntly in the launch post: **the human stays the agent.** Their
critique of autonomous coders (Cursor/Copilot-style hands-off generation) is that "if you didn't know the
foundations of how to do it before, you don't now either — you've learned nothing," plus the technical debt
of shipping code nobody understands. Solveit therefore *deliberately makes full automation awkward*:
defaults to code input, requires you to read/refactor/explicitly run AI code, and pushes small verified
steps over big generations. It's Polya's problem-solving loop and Lean-Startup fast-feedback, with an LLM in
the loop but never at the wheel.

**The transferable insight for us is not "put an AI in the notebook."** It is *dialog engineering*: a human
curating a living, prunable context and working in small, individually-verified steps, with the AI assisting
per-step. That stance is separable from the mechanics that implement it — which matters, because our
architecture implements those mechanics very differently.

---

## 2. Where we already are

Two facts about our board shape the whole tradeoff:

1. **Our Notebook card is a reactive dataflow graph, not a REPL** (`docs/notebook-card.md`). Cells are
   pure-ish functions of named inputs producing named outputs; they form a dependency DAG; changing an input
   invalidates dependents. Source lives in a file (Observable Notebooks 2.0 format, shadow-git versioned);
   the card is a *view*. There is deliberately **no single mutable namespace and no linear cell order** — a
   cell's inputs are its declared edges, not "whatever ran above."

2. **We already have a rich "external agent" substrate.** An agent is a server-owned process rendered as a
   *session card*; agents coordinate through **threads** (one task per thread, typed work-intents, @-tag to
   wake), do isolated work in **git worktrees** (edit/test/merge-on-green), carry durable state in **file
   memory**, and can comment on documents via **standoff annotations** — including a **suggestion track**
   (track-changes-style proposed edits the author accepts/rejects). This session, writing this doc, *is* that
   model in action.

So the two poles in the brief map cleanly onto us:

- **Integrated** = bring the AI *inside* the Notebook card, Solveit-style: prompt/note cells interleaved with
  code cells, an in-card model that reads the notebook and proposes/edits cells inline.
- **External** = the agent stays a *separate session* that operates on the notebook's backing file (and the
  board) through threads, worktrees, and annotations — what we already have.

---

## 3. The tradeoff, honestly

### The case for integrated

- **Tightest possible loop.** No spawn latency, no thread ceremony. Ask, see, verify, continue — the thing
  Solveit users describe as addictive.
- **The AI sees exactly the runtime state.** Live variables, outputs, the symbol table. An external agent
  reading a file sees source, not the kernel.
- **Learning-first ergonomics.** Solveit's modes and small-step defaults are genuinely good pedagogy, and
  they live naturally *in the surface where the code is*.

### Why integrated fights our grain

- **Solveit's context model assumes a linear dialog; our notebook is a DAG.** "Everything above the cursor"
  is only well-defined in an ordered document. In a dependency graph there is no canonical "above" — there's
  a topological neighbourhood. Pin/hide port reasonably (they're context-membership flags), but the core
  "edit the AI's last response so the next token doesn't compound the mistake" move relies on a linear
  trajectory we don't have. We'd be grafting a linear-dialog UX onto a non-linear execution model, and the
  seam would show.
- **We run JS-in-browser cells today; Solveit's magic needs a real backend model.** An in-card AI means
  either calling a model API straight from the browser (secrets in the client, no shared provenance, no
  reuse of our session infrastructure) or bridging the card to a server process — at which point you've
  rebuilt a session and the "integrated" boundary is cosmetic.
- **It duplicates substrate we already built.** Provenance, context curation, proposed-edit review, and
  wake/notify already exist as threads + annotations + suggestions + work-intents. A second, card-local
  copy of "AI proposes, human reviews, history is durable" is a maintenance fork of machinery that's already
  load-bearing elsewhere.

### Why external is the cheaper 80%

- **Reuses everything.** The agent edits the notebook file on a worktree, merges on green, records its
  reasoning in the thread, and proposes cell changes as *suggestion annotations* the human accepts. Every
  one of those is shipped.
- **Durable by construction (Principle 1).** The dialog-as-living-document is Solveit's provenance store;
  ours is the thread log + shadow-git + annotations. We already treat the running process as disposable and
  the record as the truth — which is exactly the discipline Solveit's editable dialog enforces, arrived at
  from the other direction.
- **Multi-agent and multi-human fall out for free.** Threads already fan work across sessions; the notebook
  file is just another file a worktree touches.

### What external loses — and it's real

- **The loop is coarse and slow.** Spawn latency, whole-file-ish edits instead of cell-granular
  back-and-forth, thread ceremony for what Solveit does in one keystroke. The intimacy — code, note, and
  prompt in one breath — is genuinely absent.
- **The agent sees source, not live kernel state.** Until the notebook exposes its symbol table / outputs to
  a reader, an external agent reasons about code, not values.

---

## 4. Recommendation

**Lean external-first, but port Solveit's *dialog-engineering affordances* onto the Notebook card — do not
rebuild Solveit's integrated dialog wholesale.**

The reasoning: Solveit's *value* is dialog engineering (curated context, small verified steps, human as
agent), and that value is separable from its *mechanism* (an in-notebook linear AI dialog). The mechanism
fights our reactive-DAG + server-session architecture; the value does not. We can capture most of the value
by teaching our existing external agent to work *through* the notebook surface, rather than embedding a
second AI runtime inside the card.

Concretely, in rough priority order:

1. **Give the Notebook card first-class `note` and `prompt` cells** alongside code cells. Notes are pure
   markdown (cheap, obviously useful). A `prompt` cell is *not* an in-browser model call — it is a
   **thread-backed request**: it targets the notebook's session (spawning one if needed) and renders the
   reply inline. This is the single highest-leverage step: it gives the Solveit *feel* (code + note + prompt
   in one surface) while the actual AI work rides the session/thread substrate we already trust.
2. **Deliver AI-proposed cell edits as suggestion annotations**, not silent writes. The suggestion track
   (W15) already models "proposed edit, human accepts/rejects, author owns resolution" — which is exactly
   Solveit's "review and explicitly run AI code," and it keeps the human as the agent by construction.
3. **Adopt pin / hide-from-context as explicit cell flags.** Our DAG gives us dependency-scoped context for
   free (a prompt can default to its topological neighbourhood), but explicit pin/hide is the cheap, legible
   override Solveit proved out. Show token cost so context stays legible.
4. **Expose the notebook's live symbol table / outputs to a reading agent**, so the external agent reasons
   about *values*, not just source — closing the biggest gap between external and integrated.
5. **Only then reconsider a truly in-card model**, and only if 1–4 leave a loop-tightness gap that users
   actually hit. My expectation is they won't: (1) already collapses most of the latency, and a fully
   in-card model reintroduces the browser-secrets / duplicated-provenance problems for a marginal gain.

This path is incremental, reuses our substrate, respects the reactive-DAG model instead of fighting it, and
still delivers the thing that makes Solveit compelling — the human curating a tight, legible, small-step
loop with the AI. It treats "integrated vs external" not as a fork but as a **surface question (the card)
layered over a mechanism question (the session)**: integrated-feeling surface, external mechanism.

### Open questions for annotation

- Is loop *latency* the thing we actually care about, or is it the single-surface *legibility*? If the
  former, step 1 may not be enough and a persistent per-notebook session (warm, not spawned-per-prompt)
  matters. If the latter, external-first is clearly right.
- Should a `prompt` cell's default context be the topological neighbourhood, the whole notebook, or an
  explicit selection? (Solveit chose "everything above"; our DAG lets us be smarter, but smarter can be
  surprising.)
- Do we want the Python-kernel Path B (`docs/notebook-card.md` §2) *before* this, given Solveit's power is
  substantially "a real kernel the AI can see"? Ordering question, not either/or.
- Is there a case for the integrated pole specifically for *teaching* (a Solveit-style learning mode),
  distinct from the working-analyst case where external clearly wins?
