// card-types/notebook/render.js — the notebook card's interior as a runtime-loaded template
// (docs/notebook-card.md). A notebook is a file-backed card like the file card: its SOURCE is a `.html`
// file in the Observable Notebooks 2.0 format, read off-log through `fileContent` (content.ts); the card is
// a VIEW over it. This template only DISPLAYS and WIRES: it deserializes the file to cells, hands the cell
// graph to the reactive scheduler (`syncCells` → notebook-runtime.ts), renders markdown cells as PROCESSED
// PROSE (the shared /vendor/markdown.js codec — a click flips one to a raw <textarea> for editing, the
// sticky card's select-then-click-to-edit gesture) and
// `module` cells as an editable source box + wiring/policy hints + a Run button + an output pane reading
// `cellOutputs`, and writes source edits back through `writeFile`. ALL execution + reactivity lives in the
// runtime; the template never makes a Worker and never schedules (§2/§3/§6).
import { html, nothing } from "/vendor/lit-html.js";
import { renderMd } from "/vendor/markdown.js";
import { deserialize, serialize } from "/vendor/notebook-format.js";

// COMMAND MODE (docs/notebook-card.md): a Jupyter/Colab-style keyboard layer over the cells. The "selected
// cell" is NOT new card state — it's plain DOM focus: each cell wrapper is `tabindex="-1"`, so the focused
// `.nb-cell` IS the selected one and `:focus` is the highlight. Esc out of a cell's editor selects it; then
// bare keys (a/b add · ↑↓/kj move · x delete · t type · ⏎ edit) act, each stopPropagation'd so the canvas
// shortcuts (Delete→delete-card, arrows→scroll, Esc→interrupt) never also fire. Because the keys aren't
// chords they never collide with the browser/textarea the way ⌘T/⌘A would (see the doc's keymap rationale).
//
// A structural op (insert/move/delete/convert) writes the file → async re-parse → re-render, and lit
// reconciles the cell list POSITIONALLY (no keys), so the focused DOM node ends up showing a DIFFERENT cell
// (or is replaced outright on a md↔code branch swap). To keep command-mode focus on the RIGHT cell after the
// write lands, we stash the target cell id here, keyed by card, and the next render() of that card re-focuses
// it by id (a double-rAF, after lit commits). One-shot: consumed and cleared on read so it never steals
// focus mid-edit on an unrelated re-render. Module scope (the template loads once) but keyed per card.
const PENDING_FOCUS = new Map(); // cardKey → cellId to re-focus in command mode after the next render

// Deleting a cell is a direct FILE write (writeFile → POST /api/file), off-log — invisible to the canvas
// UndoManager (which only tracks the signia store), so the host's Ctrl+Z cannot bring a deleted cell back.
// To keep a delete from being data loss, we stash the just-deleted cell here (keyed per card, like
// PENDING_FOCUS) and render an in-card "undo" affordance while a stash exists — Jupyter's undo-cell-delete
// (`z`). Restoring re-inserts the cell at its original index and clears the stash. This is session-local
// view state (gone on reload, never committed); the file's shadow-git history is the durable recovery tier.
const LAST_DELETED = new Map(); // cardKey → { cell, index } — the most recent delete, awaiting undo
const cssEsc = (s) =>
  typeof globalThis !== "undefined" && globalThis.CSS && globalThis.CSS.escape
    ? globalThis.CSS.escape(String(s))
    : String(s);

// Which markdown cells are in raw-edit mode is per-card EPHEMERAL view state (the `treeState` capability,
// the directory card's expand-set shape): a Set of cell ids. Shared empty default so a card with nothing
// open (and the headless mock, which has no treeState) never allocates and reads as "none editing".
const NONE_EDITING = new Set();

// Grow a textarea to fit its content so editing never happens in a cramped two-line box that scrolls
// internally — the box matches the text it holds and the CARD scrolls instead. Reset to `auto` first so it
// shrinks back when lines are deleted, not just grows. `max` (px) caps a CODE cell so a long program doesn't
// push the whole card open: past the cap the box stops growing and scrolls internally (CSS overflow). A
// markdown raw-edit box passes no cap — prose stays fully expanded, matching the prose it replaced.
function autoGrow(el, max) {
  if (!el) return;
  el.style.height = "auto";
  const h = el.scrollHeight;
  el.style.height = (max && h > max ? max : h) + "px";
}

// Code cell sizing: an initial `rows` from the source's line count (so a freshly-loaded card is sized before
// any keystroke, no measuring pass needed) clamped to CODE_MAX_ROWS, and a hard pixel ceiling autoGrow won't
// exceed on edit. The two roughly agree (~16px/line + padding); the px cap is the authority, the row count
// just the pre-paint estimate.
const CODE_MAX_ROWS = 18;
const CODE_MAX_PX = 320;
function codeRows(source) {
  const n = String(source || "").split("\n").length;
  return Math.min(Math.max(n, 1), CODE_MAX_ROWS);
}

// A fresh, collision-free cell id for an appended cell. The format tolerates any id; we just need one no
// sibling already uses (ids are the wiring handles). `c<n>` from the cell count up, skipping taken ids.
function freshCellId(cells) {
  const taken = new Set(cells.map((c) => c.id));
  let n = cells.length + 1;
  let id = `c${n}`;
  while (taken.has(id)) id = `c${++n}`;
  return id;
}

function basename(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// One cell's output for display. The worker made the value clone-safe: strings show verbatim, everything
// else as JSON (DOM/SVG/rich rendering is a later step). No completed run yet → empty.
function display(out) {
  if (!out || (!out.status && !out.running)) return "";
  if (out.running) return "running…";
  if (out.status === "error") return out.error ?? "error";
  if (out.suppressed) return ""; // final statement ended in `;` — the cell ran but shows no value (Jupyter `;`)
  return typeof out.value === "string" ? out.value : JSON.stringify(out.value);
}

// A short policy label for the cell head; default (no data-policy) is auto.
function policyLabel(raw) {
  const k = (raw || "auto").split(":")[0];
  return k === "manual" ? "manual" : k === "debounced" ? "debounced" : "auto";
}

export default {
  contract: 1,
  render(card) {
    // Off-log content first, the static field as the pre-signal fallback — the file-card pattern, so the
    // card renders headlessly / before the signal resolves without throwing.
    const text = card.signals.fileContent ?? card.fields.text ?? "";
    const nb = deserialize(text);
    const outputs = card.signals.cellOutputs || {};

    // Feed the parsed cell graph to the reactive scheduler. Diff-guarded in the runtime, so calling it each
    // render is cheap and never re-runs cells on an unrelated re-render — only when the source/wiring/policy
    // actually changed. Guarded for the headless mock (no grant → the card is a static view).
    if (card.signals.syncCells) {
      card.signals.syncCells(
        nb.cells.map((c) => ({
          id: c.id,
          type: c.type,
          source: c.source,
          inNames: c.inNames || [],
          imports: c.imports || [], // structured imports (step-2): local | path | path#export
          outNames: c.outNames || [],
          policy: c.policy || "",
        })),
      );
    }

    // Serialize the whole cell list back to disk with ONE cell's source replaced — the write-back path.
    // Source lives in the file (§4), so an edit is a file write (writeFile → POST /api/file), never a
    // setText on the log; the watcher refresh then re-parses + re-runs (reactivity from an edit). A no-op
    // without the grant (headless mock), so the box degrades to read-only.
    //
    // GUARD no-op edits (the sticky card's commitIfChanged): @change/@blur and Shift+Enter all route here,
    // so a defocus or run that DIDN'T change the source must not write — an identical write still churns the
    // file watcher → re-parse → re-run and shows up as a spurious change/commit. Compare to the cell's
    // current (parsed) source; equal → do nothing.
    const onEdit = (cellId, value) => {
      if (!card.signals.writeFile) return;
      const current = nb.cells.find((c) => c.id === cellId);
      if (current && current.source === value) return; // nothing changed → never write
      const cells = nb.cells.map((c) => (c.id === cellId ? { ...c, source: value } : c));
      card.signals.writeFile(serialize({ title: nb.title, cells }));
    };

    // Patch ONE cell's fields (the wiring editor: imports/outNames/policy) and write the whole notebook
    // back — the same serialize→writeFile→re-parse→re-run loop as a source edit, so changing a wire
    // reactively re-runs (§11.2). Authoring imports from the UI is what makes cross-card dataflow testable
    // without hand-editing the `.html` (the `data-in`/`data-out` attributes have no other editor yet).
    const updateCell = (cellId, patch) => {
      if (!card.signals.writeFile) return;
      const cells = nb.cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c));
      card.signals.writeFile(serialize({ title: nb.title, cells }));
    };
    // The notebook's own <title> — a cosmetic heading (NOT the filename / import path, which is the file's
    // path). Editable inline, written back through serialize like any cell edit. Guarded no-op on no change.
    const onTitleEdit = (value) => {
      if (!card.signals.writeFile || value === nb.title) return;
      card.signals.writeFile(serialize({ title: value, cells: nb.cells }));
    };

    // Markdown edit-mode toggling rides `treeState` (off-log, per-card): a Set of cell ids shown as raw
    // source instead of prose. Editing needs BOTH writeFile (to persist) and treeState (to hold the mode) —
    // without either the markdown cell stays read-only prose, the headless-mock degrade. enterEdit also
    // focuses the freshly-rendered textarea: lit REPLACES the whole `.nb-cell` subtree when a cell flips
    // template branch (prose ↔ textarea), so we anchor on the stable `.nb-body` and find the new textarea
    // by its data-cell id two frames later (after treeState's notify → the scheduled render pass).
    const treeState = card.signals.treeState;
    const ev = treeState ? treeState.get() : null;
    const editing = ev instanceof Set ? ev : NONE_EDITING;
    const canEdit = Boolean(card.signals.writeFile && treeState);
    const enterEdit = (cellId, fromEl) => {
      if (!canEdit) return;
      const next = new Set(editing);
      next.add(cellId);
      treeState.set(next);
      const body = fromEl && fromEl.closest ? fromEl.closest(".nb-body") : null;
      if (body)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const ta = body.querySelector(`textarea.nb-md-source[data-cell="${cellId}"]`);
            if (ta) {
              ta.focus();
              ta.setSelectionRange(ta.value.length, ta.value.length);
              autoGrow(ta); // size to the existing content the moment it opens, before any keystroke
            }
          }),
        );
    };
    const exitEdit = (cellId) => {
      if (!treeState) return;
      const next = new Set(editing);
      next.delete(cellId);
      treeState.set(next);
    };
    // The structural cell ops (insert / move / delete / convert-type) all reduce to the SAME move: produce a
    // new cell ARRAY, serialize it, write the file — the watcher re-parse brings the result back. Two shared
    // helpers keep them honest:
    //
    // foldLiveEdits: a cell being raw-edited holds its latest text only in the DOM textarea, not yet in the
    //   parsed `nb.cells`. Every structural button fires @mousedown-preventDefault (below) so focus STAYS on
    //   that textarea — meaning its @blur never commits and document.activeElement is still it when the click
    //   runs. So before writing, fold the focused textarea's value back into its cell (matched by data-cell)
    //   so a reorder/insert/convert never silently drops an in-progress keystroke buffer. Guarded for the
    //   headless/no-DOM path (the contract test never clicks, so this never runs there).
    const foldLiveEdits = (cells) => {
      const ta = typeof document !== "undefined" ? document.activeElement : null;
      if (ta && ta.tagName === "TEXTAREA" && ta.dataset && ta.dataset.cell) {
        const id = ta.dataset.cell;
        return cells.map((c) => (c.id === id ? { ...c, source: ta.value } : c));
      }
      return cells;
    };
    const writeCells = (cells) => {
      if (!card.signals.writeFile) return;
      card.signals.writeFile(serialize({ title: nb.title, cells: foldLiveEdits(cells) }));
    };
    const setEditing = (mut) => {
      if (!treeState) return;
      const next = new Set(editing);
      mut(next);
      // Skip the notify when the set is UNCHANGED. Two reasons: it avoids a spurious re-render, and — for the
      // command-mode delete/toggle path — that spurious render would fire BEFORE the async file-write render
      // and consume the one-shot PENDING_FOCUS early, landing focus on the wrong cell. A no-op mutation (e.g.
      // deleting a cell that wasn't being raw-edited) must not re-render so the file-write render owns the focus.
      if (next.size === editing.size && [...next].every((id) => editing.has(id))) return;
      treeState.set(next);
    };

    // Insert a fresh cell AT an index (a between-cell `+`; index === cells.length is "append"). A new markdown
    // cell opens straight into raw-edit mode (added to the editing set by the id we just minted) so it's a
    // textarea to type into, not an empty "click to edit" strip; a code cell is already an editable box.
    const insertCell = (index, type) => {
      if (!card.signals.writeFile) return;
      const id = freshCellId(nb.cells);
      const cell = { id, type, source: "", imports: [], inNames: [], outNames: [], policy: "" };
      if (type === "text/markdown") setEditing((s) => s.add(id));
      const cells = [...nb.cells.slice(0, index), cell, ...nb.cells.slice(index)];
      writeCells(cells);
    };
    // Reorder: swap a cell with its neighbour in the given direction (-1 up, +1 down). Clamped at the ends.
    const moveCell = (cellId, dir) => {
      const i = nb.cells.findIndex((c) => c.id === cellId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= nb.cells.length) return;
      const cells = nb.cells.slice();
      [cells[i], cells[j]] = [cells[j], cells[i]];
      writeCells(cells);
    };
    // Delete a cell. Immediate (no modal), but RECOVERABLE: stash the removed cell + its index first, so the
    // undo affordance / command-mode `z` can put it back (LAST_DELETED above). Deserialize guarantees unique
    // ids, so filter-by-id removes EXACTLY this cell — never a colliding neighbour. Also drop it from the
    // editing set so a stale id never lingers.
    const deleteCell = (cellId) => {
      const index = nb.cells.findIndex((c) => c.id === cellId);
      if (index < 0) return;
      LAST_DELETED.set(cardKey, { cell: nb.cells[index], index });
      setEditing((s) => s.delete(cellId));
      writeCells(nb.cells.filter((c) => c.id !== cellId));
    };
    // Undo the most recent delete: re-insert the stashed cell at its original index (clamped to the current
    // length, in case the list shrank/grew since) and clear the stash. A no-op when nothing is stashed.
    const undoDelete = () => {
      const stash = LAST_DELETED.get(cardKey);
      if (!stash || !card.signals.writeFile) return;
      LAST_DELETED.delete(cardKey);
      const at = Math.max(0, Math.min(stash.index, nb.cells.length));
      keepFocus(stash.cell.id);
      writeCells([...nb.cells.slice(0, at), stash.cell, ...nb.cells.slice(at)]);
    };
    // Toggle a cell between prose (text/markdown) and code (module) — the Jupyter cell-type switch, so a
    // notebook that starts as one markdown cell becomes code without a delete-and-replace. foldLiveEdits
    // carries any in-progress text across the switch; leaving raw-edit mode lets the new type render its box.
    const convertType = (cellId, nextType) => {
      setEditing((s) => s.delete(cellId));
      writeCells(nb.cells.map((c) => (c.id === cellId ? { ...c, type: nextType } : c)));
    };

    // canWrite (wiring editor + title) needs only writeFile; canEdit (markdown raw-edit) ALSO needs
    // treeState to hold the per-cell edit-mode. Two grants, two affordances.
    const canWrite = Boolean(card.signals.writeFile);

    // ── Command mode (the keyboard layer) ───────────────────────────────────────────────────────────────
    // The card's identity for the focus-restore map: its backing file (root + path/title). Distinct per
    // open notebook; two cards on the same file would share, which is harmless (they'd refocus the same id).
    const cardKey = `${card.root}::${card.fields.title}`;
    const isProse = (c) => c.type === "text/markdown" || c.type === "text/html";
    // Mark a cell to be re-focused (in command mode) after the next render — see PENDING_FOCUS above. Every
    // structural op that should "carry the selection" with it calls this just before it writes.
    const keepFocus = (id) => PENDING_FOCUS.set(cardKey, id);
    // a / b — insert a fresh cell of the SAME TYPE above / below, and land command-mode focus on it (Jupyter:
    // the new cell is selected, not opened — press ⏎ to edit). Unlike the `+ code`/`+ text` buttons this
    // never opens the markdown editor, so the keyboard flow stays in command mode.
    const cmdInsert = (cell, dir) => {
      if (!canWrite) return;
      const i = nb.cells.findIndex((c) => c.id === cell.id);
      const index = dir < 0 ? i : i + 1;
      const id = freshCellId(nb.cells);
      const fresh = { id, type: cell.type, source: "", imports: [], inNames: [], outNames: [], policy: "" };
      keepFocus(id);
      writeCells([...nb.cells.slice(0, index), fresh, ...nb.cells.slice(index)]);
    };
    // ↑↓ / kj — reorder, keeping focus on the moved cell so a run of presses walks it through the stack.
    const cmdMove = (cell, dir) => {
      keepFocus(cell.id);
      moveCell(cell.id, dir);
    };
    // x / Delete / Backspace — delete, then select a neighbour (the next cell, or the previous if it was last)
    // so focus doesn't fall off the card. No-op selection on the last remaining cell.
    const cmdDelete = (cell) => {
      const i = nb.cells.findIndex((c) => c.id === cell.id);
      const neighbour = nb.cells[i + 1] || nb.cells[i - 1];
      if (neighbour) keepFocus(neighbour.id);
      deleteCell(cell.id);
    };
    // t — toggle prose↔code in place, keeping the cell selected across the branch swap.
    const cmdToggle = (cell) => {
      keepFocus(cell.id);
      convertType(cell.id, isProse(cell) ? "module" : "text/markdown");
    };
    // ⏎ — leave command mode INTO the cell's editor. Prose reuses enterEdit (opens the raw textarea + focuses
    // it); code focuses its source box directly (no branch swap, the box is already in the DOM).
    const editCell = (cell, wrapper) => {
      if (isProse(cell)) {
        enterEdit(cell.id, wrapper);
      } else {
        const ta = wrapper.querySelector(`textarea.nb-source[data-cell="${cssEsc(cell.id)}"]`);
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      }
    };
    // The one keydown handler bound to every cell wrapper. It serves BOTH modes by reading the event target:
    //   • target is a TEXTAREA/INPUT  → EDIT mode: only Esc matters (→ commit + select the cell).
    //   • target is the wrapper itself → COMMAND mode: the bare-key verbs.
    // Handled keys are preventDefault'd + stopPropagation'd so neither the browser nor the canvas also acts.
    const onCellKeydown = (cell, e) => {
      const wrapper = e.currentTarget;
      const t = e.target;
      const inEditor = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
      if (inEditor) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (isProse(cell)) {
            // The branch swaps editing→prose (lit REPLACES the wrapper), so re-focus by id once it lands; the
            // textarea's own @blur (fired as it's removed) commits the text — no double write from here.
            keepFocus(cell.id);
            exitEdit(cell.id);
          } else {
            wrapper.focus(); // code wrapper survives the re-render; the blur commits via the textarea @blur
          }
        }
        return; // every other key is the editor's (typing, caret motion, Shift+Enter run)
      }
      if (t !== wrapper || !canWrite) return; // command keys only when the wrapper itself holds focus
      let handled = true;
      switch (e.key) {
        case "Enter": editCell(cell, wrapper); break;
        case "Escape": wrapper.blur(); break; // deselect — leave command mode
        case "a": cmdInsert(cell, -1); break;
        case "b": cmdInsert(cell, +1); break;
        case "t": cmdToggle(cell); break;
        case "x": case "Delete": case "Backspace": cmdDelete(cell); break;
        case "z": undoDelete(); break; // Jupyter: undo the last cell delete (restores at its original index)
        case "ArrowUp": case "k": cmdMove(cell, -1); break;
        case "ArrowDown": case "j": cmdMove(cell, 1); break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const ctx = {
      runCell: card.signals.runCell,
      onEdit,
      updateCell,
      insertCell,
      moveCell,
      deleteCell,
      undoDelete,
      convertType,
      editing,
      canEdit,
      canWrite,
      enterEdit,
      exitEdit,
      onCellKeydown,
    };
    // A deletion is pending undo when this card has a stash — drives the in-card undo strip below.
    const canUndoDelete = canWrite && LAST_DELETED.has(cardKey);

    // Consume any pending command-mode focus (a structural op last render asked to carry the selection across
    // the write→re-parse→re-render). One-shot: delete on read so an unrelated re-render never steals focus
    // mid-edit. Double-rAF so lit has committed the new cell order/DOM before we focus by id. Scoped to THIS
    // card's body (data-nbkey) because cell ids (c1, c2…) are only unique within a notebook, not across them.
    if (typeof document !== "undefined" && typeof requestAnimationFrame !== "undefined") {
      const pendingId = PENDING_FOCUS.get(cardKey);
      if (pendingId != null) {
        PENDING_FOCUS.delete(cardKey);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const body = document.querySelector(`.nb-body[data-nbkey="${cssEsc(cardKey)}"]`);
            const el = body && body.querySelector(`.nb-cell[data-cellid="${cssEsc(pendingId)}"]`);
            if (el) el.focus();
          }),
        );
      }
    }

    return html`
      <div class="file-head">
        <span class="file-name">${basename(card.fields.title)}</span>
        <span class="file-ext">notebook</span>
      </div>
      <div class="nb-body" data-nbkey=${cardKey}>
        ${canUndoDelete
          ? html`<div class="nb-undo" data-interactive="1">
              <span class="nb-undo-msg">Cell deleted.</span>
              <button class="nb-undo-btn" title="restore the deleted cell (z)" @mousedown=${(e) => e.preventDefault()} @click=${() => ctx.undoDelete()}>
                ⤶ Undo
              </button>
            </div>`
          : ""}
        ${card.signals.writeFile
          ? html`<input
              class="nb-title"
              data-interactive="1"
              spellcheck="false"
              placeholder="untitled notebook"
              .value=${nb.title}
              @keydown=${(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              @blur=${(e) => onTitleEdit(e.target.value)}
            />`
          : nb.title
            ? html`<div class="nb-title">${nb.title}</div>`
            : ""}
        ${nb.cells.map((cell, i) =>
          html`${insertZone(i, ctx)}${renderCell(cell, outputs[cell.id], ctx)}`,
        )}
        ${insertZone(nb.cells.length, ctx, nb.cells.length === 0)}
      </div>
      ${canWrite ? footer() : ""}
    `;
  },
};

// A subtle legend for the keyboard layer. Rendered as a SIBLING of .nb-body (not inside it), so it stays
// pinned at the bottom of the card while only the cells scroll — the shortcuts are otherwise invisible (no
// hover chrome announces them), so the footer is their always-in-view discovery surface. Non-interactive.
function footer() {
  const key = (k) => html`<kbd class="nb-foot-key">${k}</kbd>`;
  return html`<div class="nb-foot">
    ${key("esc")} select · ${key("a")}/${key("b")} add · ${key("↑")}${key("↓")} move · ${key("x")} delete ·
    ${key("z")} undo · ${key("t")} type · ${key("⏎")} edit
  </div>`;
}

// The between-cell insert affordance (Colab/VS Code): a thin, hover-revealed strip carrying `+ code` /
// `+ text`. Rendered at every cell boundary (index 0..N), so a cell can be inserted ABOVE the first, BETWEEN
// any two, or after the last — replacing the old always-on footer with something that's invisible until the
// gap is hovered. Read-only cards (no writeFile) get none.
function insertZone(index, ctx, always) {
  if (!ctx.canWrite) return "";
  const pd = (e) => e.preventDefault(); // keep focus on any edited textarea → foldLiveEdits preserves its buffer
  // `always` keeps the strip visible (not hover-gated) when the notebook has no cells — otherwise the only
  // affordance on an empty notebook is an invisible seam nobody would think to hover.
  return html`<div class="nb-insert ${always ? "nb-insert-open" : ""}" data-interactive="1">
    <span class="nb-insert-line"></span>
    <button class="nb-insert-btn" title="insert a code cell here" @mousedown=${pd} @click=${() => ctx.insertCell(index, "module")}>+ code</button>
    <button class="nb-insert-btn" title="insert a markdown cell here" @mousedown=${pd} @click=${() => ctx.insertCell(index, "text/markdown")}>+ text</button>
    <span class="nb-insert-line"></span>
  </div>`;
}

// Per-cell actions (type switch / reorder / delete) are the keyboard layer's job now — t / ↑↓ / x in command
// mode (onCellKeydown), documented in the footer legend. The old hover toolbar that floated them at each
// cell's corner was removed: on a small card it flickered in and out as the pointer crossed cells, and it
// fully duplicated the keys. The between-cell `+ code`/`+ text` insert strips stay (insertZone) — they're the
// mouse path for adding a cell and the only affordance on an empty notebook.

function renderCell(cell, out, ctx) {
  // text/markdown and text/html cells are CONTENT, not executed: render the source as PROCESSED PROSE
  // through the shared /vendor/markdown.js codec (the same one the file + session cards use). It flips to
  // a RAW <textarea> on double-click — processed display, raw on edit — committing + exiting on blur.
  if (cell.type === "text/markdown" || cell.type === "text/html") {
    if (ctx.canEdit && ctx.editing.has(cell.id)) {
      // Raw-edit mode: the source verbatim, persisted + re-rendered as prose on blur (or Escape, which
      // blurs). data-interactive holds the pointer so typing/clicking never starts a card drag; data-cell
      // lets enterEdit find this textarea to focus it after the branch swap (and foldLiveEdits match it).
      return html`<div
        class="nb-cell nb-md nb-md-editing"
        data-cellid=${cell.id}
        tabindex=${ctx.canWrite ? "-1" : nothing}
        @keydown=${ctx.canWrite ? (e) => ctx.onCellKeydown(cell, e) : nothing}
      >
        <textarea
          class="nb-source nb-md-source"
          data-interactive="1"
          data-cell=${cell.id}
          spellcheck="false"
          @input=${(e) => autoGrow(e.currentTarget)}
          @keydown=${(e) => {
            // Shift+Enter blurs — which commits and returns to rendered prose (the code cell / Jupyter
            // "run + defocus"); plain Enter still inserts a newline. Escape is owned by the cell wrapper's
            // command-mode handler (onCellKeydown): it commits via the @blur below AND selects the cell, so
            // it must NOT also blur-to-body here, or focus would land on nothing instead of the cell.
            if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          @blur=${(e) => {
            ctx.onEdit(cell.id, e.target.value);
            ctx.exitEdit(cell.id);
          }}
        >${cell.source}</textarea>
      </div>`;
    }
    // Prose mode: renderMd keeps every leaf an escaped lit text binding (no injected HTML — the codec's
    // safety contract). A single click enters edit mode — but ONLY once the card is selected, because the
    // host's interior-interaction seam (data-text) bubbles the first press through to select/drag the card
    // and contains it thereafter, so click-to-edit is the sticky card's exact gesture: select, then click
    // the text to type. Empty source still needs a target to click, so show a muted hint, not a blank strip.
    //
    // Reactive interpolation (Observable Notebook Kit 2.0, docs/notebook-card.md §8): a `${expr}` markdown
    // cell is scheduled like a code cell and its OUTPUT VALUE is the fully-interpolated prose STRING. So when
    // there's an ok output, render THAT (the live document); fall back to the raw source for a plain cell,
    // before the first run, or on an interpolation error — which also shows a muted notice so the broken
    // expression is visible while the document structure stays readable. The card re-renders (cellOutputs
    // signal) whenever a referenced value changes, so the prose stays live.
    const interpolated = out && out.status === "ok" && typeof out.value === "string";
    const proseText = interpolated ? out.value : cell.source;
    const interpError = out && out.status === "error" ? out.error : null;
    const empty = !proseText || !proseText.trim();
    return html`<div
      class="nb-cell nb-md"
      data-cellid=${cell.id}
      tabindex=${ctx.canWrite ? "-1" : nothing}
      title=${ctx.canEdit ? "click to edit" : ""}
      @click=${(e) => ctx.enterEdit(cell.id, e.currentTarget)}
      @keydown=${ctx.canWrite ? (e) => ctx.onCellKeydown(cell, e) : nothing}
    >
      <div class="nb-md-prose md-prose" data-text>
        ${empty
          ? html`<span class="nb-md-empty">${ctx.canEdit ? "empty markdown — click to edit" : "empty markdown"}</span>`
          : renderMd(proseText)}
      </div>
      ${interpError ? html`<div class="nb-md-error" data-text>⚠ ${interpError}</div>` : ""}
    </div>`;
  }
  // A `module` (code) cell: head (id + reactive wiring + policy) → editable source → [bar] → output.
  // The CELL BAR (Run button + status badge) is only for DELAYED cells — manual + debounced, which wait
  // for a trigger. A standard (auto) cell re-runs reactively the moment you defocus an edit (the blur →
  // writeFile → re-parse → re-run pipeline), so it needs no Run button and no "ok" badge: the output pane
  // below already shows running…/error/value (display()), so success is silent and the bar would be noise.
  // Label each import for the "reads" wire: a local export shows as its bare name; a cross-card import
  // shows `name←path` (or `name←path#export`) so the dependency on ANOTHER notebook/file is legible
  // (§11.2). Falls back to inNames when a cell carries no structured imports (step-1 source).
  const imports = cell.imports && cell.imports.length ? cell.imports : (cell.inNames || []).map((name) => ({ name, path: null, export: null }));
  const importLabel = (i) => (i.path ? `${i.name}←${i.path}${i.export ? "#" + i.export : ""}` : i.name); // display: ← arrow
  const outNames = cell.outNames || [];
  // Inferred wiring (step-4a/4b): the runtime parses the cell's code (acorn) and, where the user wrote no
  // explicit data-in/data-out, reports what it auto-wired — local free vars as reads (`inReads`), cross-card
  // `import` statements as imports (`inImports`, with their `name←path`), and the `name = …` it defines
  // (`inDefines`). Surfaced via cellOutputs so the template needs no parser; shown as muted chips below (the
  // same chip the explicit wiring uses, just italic) so an auto-wired cell reads as wired.
  const inReads = (out && out.inReads) || [];
  const inImports = (out && out.inImports) || [];
  const inDefines = (out && out.inDefines) || [];
  const inferredReadLabels = [...inReads, ...inImports.map(importLabel)];
  const running = out && out.running;
  const stale = out && out.stale;
  const runCell = ctx.runCell;
  const delayed = policyLabel(cell.policy) !== "auto"; // manual + debounced keep the Run + status UI
  // Wiring is now DISPLAY-ONLY (the editable in/out boxes were removed — too much clutter, and authoring is
  // moving into the cell code: intra-notebook deps are inferred (4a), cross-notebook imports become `import`
  // statements (4b)). Explicit `data-in`/`data-out` still work as a hand-/agent-edited override and render
  // here when present; otherwise the inferred define name shows (muted). Only the POLICY stays editable.
  const cyclePolicy = () => {
    const order = ["auto", "manual", "debounced"];
    const next = order[(order.indexOf(policyLabel(cell.policy)) + 1) % order.length];
    ctx.updateCell(cell.id, { policy: next === "auto" ? "" : next });
  };
  const head = html`<div class="nb-cell-head">
    <span class="nb-cell-id">${cell.id}</span>
    ${imports.length
      ? html`<span class="nb-wire nb-in" title="reads">↓ ${imports.map(importLabel).join(", ")}</span>`
      : inferredReadLabels.length
        ? html`<span class="nb-wire nb-in nb-wire-inf" title="reads (inferred from the code)">↓ ${inferredReadLabels.join(", ")}</span>`
        : ""}
    ${outNames.length
      ? html`<span class="nb-wire nb-out" title="defines">→ ${outNames.join(", ")}</span>`
      : inDefines.length
        ? html`<span class="nb-wire nb-out nb-wire-inf" title="defines (inferred from the code)">→ ${inDefines.join(", ")}</span>`
        : ""}
    ${ctx.canWrite
      ? html`<button class="nb-policy nb-policy-btn" data-interactive="1" title="execution policy — click to cycle" @click=${cyclePolicy}>
          ${policyLabel(cell.policy)}
        </button>`
      : html`<span class="nb-policy">${policyLabel(cell.policy)}</span>`}
  </div>`;
  return html`
    <div
      class="nb-cell nb-code"
      data-cellid=${cell.id}
      tabindex=${ctx.canWrite ? "-1" : nothing}
      @keydown=${ctx.canWrite ? (e) => ctx.onCellKeydown(cell, e) : nothing}
    >
      ${head}
      <textarea
        class="nb-source"
        data-interactive="1"
        data-cell=${cell.id}
        spellcheck="false"
        rows=${codeRows(cell.source)}
        @input=${(e) => autoGrow(e.currentTarget, CODE_MAX_PX)}
        @focus=${(e) => autoGrow(e.currentTarget, CODE_MAX_PX)}
        @change=${(e) => ctx.onEdit(cell.id, e.target.value)}
        @keydown=${(e) => {
          // Shift+Enter = run + defocus (Jupyter): no newline, just blur — which commits (→ writeFile →
          // re-parse → reactive re-run for an auto cell). A delayed cell commits and goes stale, then its
          // Run button runs the freshly-synced source (running it here would run the pre-edit source).
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        @blur=${(e) => ctx.onEdit(cell.id, e.target.value)}
      >${cell.source}</textarea>
      ${delayed
        ? html`<div class="nb-cell-bar">
            <button class="nb-run" data-interactive="1" ?disabled=${!runCell} @click=${() => runCell && runCell(cell.id)}>
              Run
            </button>
            ${running
              ? html`<span class="nb-status nb-running">running…</span>`
              : stale
                ? html`<span class="nb-status nb-stale">stale — inputs changed</span>`
                : out && out.status
                  ? html`<span class="nb-status nb-${out.status}">${out.status}</span>`
                  : ""}
          </div>`
        : ""}
      <pre class="nb-output nb-out-${out && out.status ? out.status : "empty"}" data-text>${display(out)}</pre>
    </div>
  `;
}
