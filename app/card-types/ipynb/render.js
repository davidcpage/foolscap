// card-types/ipynb/render.js — a Jupyter notebook (.ipynb) card interior, loaded at runtime
// (card-types-as-data.md §7). It is the file card's cousin: the SOURCE is a `.ipynb` file read off-log
// through `fileContent` (content.ts), and the card is a VIEW over it — this template PARSES and DISPLAYS
// each cell, can EXECUTE code cells (Path B kernel), and (P2) can EDIT cell SOURCE + add/delete/move cells.
// A `.ipynb` is JSON, so we JSON.parse the content and render each cell: markdown via the shared prose codec,
// code via the shared highlighter, and outputs by output_type.
//
// EXECUTION (Path B): a per-cell Run button drives the server-side Jupyter kernel through the /api/kernel
// broker; outputs are written back into the file by the broker (never from the card) and the watch re-renders.
//
// EDITING (P2, docs/ipynb-card.md): with the `notebookEdit` + `treeState` grants the card is EDITABLE.
//   • Structural edits go SERVER-side, BY CELL ID (notebookEdit → POST /api/notebook/<node>/edit →
//     server-notebook.ts), applied to the freshly-read FULL-FIDELITY on-disk notebook under CAS — the card
//     never ships the notebook body (its `fileContent` read is the lossy RENDER projection, which would erase
//     outputs). This is what lets a kernel run and a source edit interleave without clobbering: both are
//     by-cell-id CAS writes over disjoint fields (outputs vs source).
//   • The in-progress edit DRAFT survives a watch re-render (a kernel write-back re-renders `fileContent` on
//     every keystroke-free beat). Two pieces make that work: the EDITING SET is `treeState` (reactive, so a
//     toggle re-renders); the DRAFT TEXT lives in a module-level `DRAFTS` map (below) and is bound as the
//     textarea's CHILD TEXT (defaultValue), never `.value` — so a re-render updates other cells + all outputs
//     while the focused textarea keeps its live value, caret, and selection (an uncontrolled textarea whose
//     dirty value the DOM owns; the notebook card uses the same trick). Editing source does NOT clear a cell's
//     outputs (Jupyter: running clears them, editing doesn't).
//   • ACCEPTED LIMITATION: the vendored lit-html has no keyed `repeat`, so list reconciliation is POSITIONAL.
//     A kernel output-merge (no reorder) preserves focus exactly; a CONCURRENT STRUCTURAL edit from another
//     card that reorders cells could move DOM focus to a neighbour — but the draft TEXT is never lost (it is
//     re-rendered from the DRAFTS map keyed by cell id).
//
// SECURITY NOTE: `text/html` outputs (and svg) are rendered RAW and UNSANITISED — we build a real DOM node
// with innerHTML and embed it (the same live-node embedding the reactive notebook card uses). This is a
// deliberate TRUSTED-NOTEBOOK assumption: you are exploring notebooks you already trust on disk. It is NOT
// safe for untrusted notebooks. If that assumption ever stops holding, sanitise here.
import { html } from "/vendor/lit-html.js";
import { renderMd } from "/vendor/markdown.js";
import { highlightCode, langForKind } from "/vendor/highlight-lit.js";

// A cell's `source` / an output's `text` is EITHER a string or an array of line-strings (nbformat allows
// both). Join arrays verbatim — the lines already carry their own trailing newlines.
function joinSource(v) {
  return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
}

// Path → basename / dir, the file card's v1 codec in miniature (we only need the two here).
function splitPath(p) {
  const slash = p.lastIndexOf("/");
  return { base: slash >= 0 ? p.slice(slash + 1) : p, dir: slash >= 0 ? p.slice(0, slash) : "" };
}

// langForKind (vendor/highlight-lit.js) keys off FILE-EXTENSION kinds (`py`, `js`, …), but a notebook names
// its language in full (`python`, `javascript`). Bridge the common kernel language names to the kind the
// highlighter understands; an unmapped name is passed through (many already match, e.g. `bash`/`sql`/`go`),
// and anything the bundle doesn't know falls back to a plain <pre> in renderCode.
const LANG_KIND = { python: "py", python3: "py", ipython: "py", javascript: "js", typescript: "ts", shell: "sh", ruby: "rb", rust: "rs" };

// The notebook's code language as a highlighter KIND — metadata.language_info.name (e.g. "python") or the
// kernelspec, defaulting to python (the overwhelmingly common case).
function notebookLang(nb) {
  const meta = nb.metadata || {};
  const name = String(meta.language_info?.name || meta.kernelspec?.language || "python").toLowerCase();
  return LANG_KIND[name] ?? name;
}

// Strip ANSI/VT escape sequences from terminal-style output (error tracebacks, coloured stream text). v1
// STRIPS colour rather than translating it to markup — legible plain text, no injected HTML. Covers the
// CSI sequences Jupyter emits (colour SGR is `\x1b[…m`); the broad class also catches cursor moves etc.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return typeof s === "string" ? s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "") : "";
}

// A raw-HTML output as a live DOM node embedded in the lit tree (lit renders any Node child directly — the
// reactive notebook card does the same for its output views). This is the UNSANITISED path (see the file
// header). Guarded so the headless contract test — whose `document` is a shim with no real innerHTML —
// never throws: it just yields an inert node there, and the browser gets the real rendered markup.
function rawHtmlNode(str) {
  const el = document.createElement("div");
  el.className = "ipynb-html";
  try {
    el.innerHTML = typeof str === "string" ? str : joinSource(str);
  } catch {
    /* headless shim (no DOM) — inert node, browser renders the real thing */
  }
  return el;
}

// ── edit-mode plumbing (P2) ───────────────────────────────────────────────────────────────────────────

// The in-progress edit DRAFT buffer, keyed cardKey → (cellId → draft text). Module scope (the template
// loads once) so it SURVIVES a watch re-render — the crux of "a kernel write-back must not destroy my edit".
// A draft exists only while its cell is in edit mode (seeded on enter, cleared on commit/cancel). The card's
// identity is its backing file path (title); two cards on the same file share, which is harmless.
const DRAFTS = new Map();
// Shared empty default so a read-only card / the headless mock (no treeState) never allocates.
const NONE_EDITING = new Set();

const cssEsc = (s) =>
  typeof globalThis !== "undefined" && globalThis.CSS && globalThis.CSS.escape ? globalThis.CSS.escape(String(s)) : String(s);

// Grow a source textarea to fit its content (never a cramped scrolling box), capped so a long cell scrolls
// internally rather than pushing the whole card open. Reset to `auto` first so it shrinks back on deletion.
const EDIT_MAX_PX = 480;
function autoGrow(el) {
  if (!el || typeof el.style === "undefined") return;
  el.style.height = "auto";
  const h = el.scrollHeight || 0;
  el.style.height = (h > EDIT_MAX_PX ? EDIT_MAX_PX : h) + "px";
}

// The `.ipynb-body` ancestor of an event target (the anchor for the post-render focus query), guarded for
// the headless shim (no `closest`).
function bodyOf(e) {
  const t = e && e.target;
  return t && typeof t.closest === "function" ? t.closest(".ipynb-body") : null;
}

// Focus a freshly-rendered cell editor by id after lit commits (double-rAF, like the notebook card): lit may
// REPLACE a cell's subtree when it flips prose↔textarea, so we anchor on the stable `.ipynb-body` and find
// the new textarea. Caret to end. Guarded for headless (no requestAnimationFrame).
function focusEditor(bodyEl, cellId) {
  if (!bodyEl || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const ta = bodyEl.querySelector(`textarea.ipynb-edit[data-cell="${cssEsc(cellId)}"]`);
      if (ta) {
        ta.focus();
        try {
          ta.setSelectionRange(ta.value.length, ta.value.length);
        } catch {
          /* detached / unsupported — focus alone is enough */
        }
        autoGrow(ta);
      }
    }),
  );
}

// Build the per-card edit API (or null when the card is read-only: no `notebookEdit`/`treeState` grant, or
// the headless mock). All state reads go through treeState.get() FRESH (never a closed-over snapshot) so an
// async op that lands after a re-render still mutates the current editing set.
function makeEditApi(card) {
  const edit = card.signals.notebookEdit || null;
  const treeState = card.signals.treeState || null;
  if (!edit || !treeState) return null;
  const cardKey = card.fields.title || "";
  const drafts = () => {
    let m = DRAFTS.get(cardKey);
    if (!m) DRAFTS.set(cardKey, (m = new Map()));
    return m;
  };
  const editingSet = () => {
    const v = treeState.get();
    return v instanceof Set ? v : NONE_EDITING;
  };
  const setEditing = (mut) => {
    const next = new Set(editingSet());
    mut(next);
    treeState.set(next);
  };
  const api = {
    editing: editingSet(),
    onInput: (cellId, value) => drafts().set(cellId, value),
    draftFor: (cellId, fallback) => (drafts().has(cellId) ? drafts().get(cellId) : fallback),
    enterEdit: (cellId, src, bodyEl) => {
      const dm = drafts();
      if (!dm.has(cellId)) dm.set(cellId, src);
      setEditing((s) => s.add(cellId));
      focusEditor(bodyEl, cellId);
    },
    cancelEdit: (cellId) => {
      // Delete the draft BEFORE the re-render so the removal-blur's commit is a guaranteed no-op (see commit).
      drafts().delete(cellId);
      setEditing((s) => s.delete(cellId));
    },
    commitEdit: (cellId, origSrc) => {
      const dm = drafts();
      // GUARD the removal-blur after a cancel/earlier-commit: if the cell already LEFT edit mode, this blur is
      // stray — never write (Esc→cancel removes it from the set first, and the removal-blur's @input just
      // re-stashed the abandoned text). Drop any draft and bail. This is what makes Esc a true cancel.
      if (!editingSet().has(cellId)) {
        dm.delete(cellId);
        return;
      }
      // GUARD no-op writes (the sticky card's commitIfChanged): an unchanged draft skips the POST — an
      // identical write would only churn the file + watcher.
      const draft = dm.get(cellId);
      if (draft != null && draft !== origSrc) edit({ type: "editSource", cellId, source: draft });
      dm.delete(cellId);
      setEditing((s) => s.delete(cellId));
    },
    // Structural op → the server applies it by cell id. For addCell we auto-enter edit on the new cell once
    // the server returns its minted id (so it opens as a box to type into, not an empty strip).
    op: (o, bodyEl) => {
      const p = edit(o);
      if (o.type === "addCell" && p && typeof p.then === "function")
        p.then((r) => {
          if (r && r.ok && r.cellId) api.enterEdit(r.cellId, "", bodyEl);
        });
    },
  };
  return api;
}

// A code cell's source as a highlighted <pre>, falling back to a plain whitespace-preserving <pre> when the
// language isn't in the bundle or highlighting fails — never worse off than raw, never throws.
function renderCode(src, lang) {
  const highlighted = highlightCode(src, langForKind(lang));
  return highlighted
    ? html`<pre class="ipynb-source hljs"><code>${highlighted}</code></pre>`
    : html`<pre class="ipynb-source">${src}</pre>`;
}

// The raw-edit <textarea> for a cell's source. CHILD-TEXT bound (defaultValue), never `.value` — so a watch
// re-render updates the child (harmless on a dirty textarea) while the live value + caret are preserved. Cmd/
// Ctrl+Enter commits, Esc cancels, blur commits; every key stopPropagation'd so canvas shortcuts don't fire.
function renderEditor(cell, editApi) {
  const id = cell.id;
  const origSrc = joinSource(cell.source);
  const draft = editApi.draftFor(id, origSrc);
  return html`<textarea
    class="ipynb-edit"
    data-cell=${id}
    data-interactive="1"
    spellcheck="false"
    @input=${(e) => {
      editApi.onInput(id, e.currentTarget.value);
      autoGrow(e.currentTarget);
    }}
    @focus=${(e) => autoGrow(e.currentTarget)}
    @keydown=${(e) => {
      e.stopPropagation(); // typing never reaches the canvas shortcuts
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        editApi.onInput(id, e.currentTarget.value);
        editApi.commitEdit(id, origSrc);
      } else if (e.key === "Escape") {
        e.preventDefault();
        editApi.cancelEdit(id);
      }
    }}
    @blur=${(e) => {
      editApi.onInput(id, e.currentTarget.value);
      editApi.commitEdit(id, origSrc);
    }}
  >${draft}</textarea>`;
}

// The per-cell edit toolbar (only when editable): edit/save · move · add-below · delete. Every button is
// `data-interactive` (contained from the canvas pointer seam) and the row stops keydown propagation.
function cellActions(cell, editApi, isEditing) {
  const id = cell.id;
  const src = joinSource(cell.source);
  return html`<div class="ipynb-cell-actions" data-interactive="1" @keydown=${(e) => e.stopPropagation()}>
    ${isEditing
      ? html`<button class="ipynb-cellbtn ipynb-cell-done" title="Save (⌘/Ctrl+Enter)" @click=${() => editApi.commitEdit(id, src)}>✓ Done</button>
          <button
            class="ipynb-cellbtn"
            title="Cancel (Esc)"
            @mousedown=${(e) => e.preventDefault()}
            @click=${() => editApi.cancelEdit(id)}
          >
            ✕ Cancel
          </button>`
      : html`<button class="ipynb-cellbtn ipynb-cell-edit" title="Edit source" @click=${(e) => editApi.enterEdit(id, src, bodyOf(e))}>✎</button>`}
    <button class="ipynb-cellbtn" title="Move cell up" @click=${() => editApi.op({ type: "moveCell", cellId: id, dir: "up" })}>↑</button>
    <button class="ipynb-cellbtn" title="Move cell down" @click=${() => editApi.op({ type: "moveCell", cellId: id, dir: "down" })}>↓</button>
    <button class="ipynb-cellbtn" title="Add code cell below" @click=${(e) => editApi.op({ type: "addCell", cellType: "code", afterCellId: id }, bodyOf(e))}>＋Code</button>
    <button class="ipynb-cellbtn" title="Add markdown cell below" @click=${(e) => editApi.op({ type: "addCell", cellType: "markdown", afterCellId: id }, bodyOf(e))}>＋Md</button>
    <button class="ipynb-cellbtn ipynb-cell-del" title="Delete cell" @click=${() => editApi.op({ type: "deleteCell", cellId: id })}>🗑</button>
  </div>`;
}

// Pick the richest displayable MIME from an execute_result / display_data bundle and render it, in the
// brief's priority order: image (png/jpeg, inline base64) → html (raw) → svg (raw) → plain text (<pre>).
function renderMimeBundle(data) {
  if (!data || typeof data !== "object") return "";
  for (const mime of ["image/png", "image/jpeg"]) {
    if (data[mime] != null) {
      const b64 = joinSource(data[mime]).replace(/\s+/g, "");
      return html`<img class="ipynb-out-img" src=${`data:${mime};base64,${b64}`} alt="notebook image output" />`;
    }
  }
  if (data["text/html"] != null)
    return html`<div class="ipynb-out-html">${rawHtmlNode(data["text/html"])}</div>`;
  if (data["image/svg+xml"] != null)
    return html`<div class="ipynb-out-html">${rawHtmlNode(data["image/svg+xml"])}</div>`;
  if (data["text/plain"] != null)
    return html`<pre class="ipynb-out-text">${joinSource(data["text/plain"])}</pre>`;
  return "";
}

// One output cell rendered by output_type (nbformat v4): stream → <pre> (ANSI stripped), execute_result /
// display_data → the MIME bundle above, error → <pre> of the ANSI-stripped traceback. An unknown type is
// skipped (never throws) so a novel output kind degrades to "not shown" rather than a broken card.
function renderOutput(out) {
  if (!out || typeof out !== "object") return "";
  switch (out.output_type) {
    case "stream":
      return html`<pre class="ipynb-out-stream ${out.name === "stderr" ? "ipynb-out-stderr" : ""}">${stripAnsi(joinSource(out.text))}</pre>`;
    case "execute_result":
    case "display_data":
      return renderMimeBundle(out.data);
    case "error": {
      const tb = Array.isArray(out.traceback)
        ? out.traceback.map(stripAnsi).join("\n")
        : `${out.ename || "Error"}: ${out.evalue || ""}`;
      return html`<pre class="ipynb-out-error">${tb}</pre>`;
    }
    default:
      return "";
  }
}

// One notebook cell: markdown → prose (or a raw editor), code → highlighted source (or a raw editor) + its
// outputs, raw → <pre>. A code cell shows its execution count (`In [n]`) as a gutter label plus a per-cell
// Run button (Path B). `kernel` = { run(sel), status }. `editApi` is null when the card is read-only (P1
// behaviour, and the headless mock) — then NO edit affordances render and the output is byte-identical to P1.
function renderCell(cell, index, lang, kernel, editApi) {
  if (!cell || typeof cell !== "object") return "";
  const src = joinSource(cell.source);
  const editing = !!(editApi && cell.id && editApi.editing.has(cell.id));
  const actions = editApi && cell.id ? cellActions(cell, editApi, editing) : "";

  if (cell.cell_type === "markdown") {
    // Prose by default; click-to-edit (the sticky card's select-then-click gesture) flips to a raw editor.
    if (editing) return html`<div class="ipynb-cell ipynb-md ipynb-md-editing">${actions}${renderEditor(cell, editApi)}</div>`;
    const onClick = editApi && cell.id ? (e) => editApi.enterEdit(cell.id, src, bodyOf(e)) : null;
    return html`<div class="ipynb-cell ipynb-md">
      ${actions}
      <div class="ipynb-md-body md-prose ${onClick ? "ipynb-md-clickable" : ""}" @click=${onClick}>${renderMd(src)}</div>
    </div>`;
  }

  if (cell.cell_type === "code") {
    const count = cell.execution_count;
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    const st = kernel && kernel.status;
    const running = !!(st && st.status === "busy" && st.runningCellId && cell.id && st.runningCellId === cell.id);
    const run = kernel && kernel.run;
    // A CODE cell enters edit via the explicit ✎ Edit button only (never click-on-source), so selecting /
    // copying source text is never hijacked. The source is a raw editor while editing, else the highlighted <pre>.
    return html`
      <div class="ipynb-cell ipynb-code ${running ? "ipynb-running" : ""} ${editing ? "ipynb-code-editing" : ""}">
        ${actions}
        <div class="ipynb-in">
          <span class="ipynb-prompt">In [${running ? "*" : count == null ? " " : count}]:</span>
          ${run
            ? html`<button
                class="ipynb-run"
                data-interactive="1"
                title="Run this cell"
                ?disabled=${running}
                @click=${() => run({ cellId: cell.id, cellIndex: index })}
              >
                ▶ Run
              </button>`
            : ""}
          ${editing ? renderEditor(cell, editApi) : renderCode(src, lang)}
        </div>
        ${running ? html`<div class="ipynb-cell-status">running…</div>` : ""}
        ${outputs.length ? html`<div class="ipynb-outputs">${outputs.map((o) => renderOutput(o))}</div>` : ""}
      </div>
    `;
  }
  // raw cell (and any other kind): show its source verbatim (with the actions gutter when editable).
  return html`<div class="ipynb-cell ipynb-raw">${actions}<pre class="ipynb-source">${src}</pre></div>`;
}

// The append-cell footer (editable only): add a code / markdown cell at the END (no anchor). Also the sole
// affordance on an empty notebook, so a fresh `.ipynb` isn't a dead end.
function appendRow(editApi) {
  if (!editApi) return "";
  return html`<div class="ipynb-append" data-interactive="1" @keydown=${(e) => e.stopPropagation()}>
    <button class="ipynb-cellbtn" title="Add a code cell at the end" @click=${(e) => editApi.op({ type: "addCell", cellType: "code" }, bodyOf(e))}>＋Code cell</button>
    <button class="ipynb-cellbtn" title="Add a markdown cell at the end" @click=${(e) => editApi.op({ type: "addCell", cellType: "markdown" }, bodyOf(e))}>＋Markdown cell</button>
  </div>`;
}

// Human label for the kernel lifecycle state carried by the `kernelStatus` feed.
function kernelLabel(state) {
  switch (state) {
    case "starting": return "kernel starting…";
    case "busy": return "running…";
    case "dead": return "kernel stopped";
    case "idle": return "kernel ready";
    default: return "no kernel";
  }
}

export default {
  contract: 1,
  render(card) {
    const { base, dir } = splitPath(card.fields.title);
    // Off-log content first; the static field is the pre-signal fallback (empty now), so the card still
    // renders headlessly / for the beat before the fileContent signal resolves.
    const text = card.signals.fileContent ?? card.fields.text;

    // Path B kernel wiring. Reading `kernelStatus` here SUBSCRIBES the card to the live feed, so a status
    // push (starting/busy/idle/errored, a running stdout tail) re-renders. The action fns are bound POSTs
    // (or absent for the headless mock / a card without the grant). Outputs themselves arrive via the FILE:
    // the broker merges them into the `.ipynb` and the watch re-renders `fileContent` — this feed is only
    // the live status channel.
    const kstatus = card.signals.kernelStatus || null;
    const run = card.signals.kernelRun || null;
    const runAll = card.signals.kernelRunAll || null;
    const interrupt = card.signals.kernelInterrupt || null;
    const restart = card.signals.kernelRestart || null;
    const kernel = { run, status: kstatus };

    // P2 edit wiring. Reading `treeState.get()` here (inside makeEditApi) SUBSCRIBES the card, so entering /
    // leaving edit mode re-renders. Null when read-only (no grant / headless) → the P1 read-only path.
    const editApi = makeEditApi(card);

    const kernelState = kstatus && kstatus.status ? kstatus.status : "none";
    const busy = kernelState === "busy" || kernelState === "starting";
    const toolbar =
      runAll || interrupt || restart
        ? html`<div class="ipynb-toolbar" data-interactive="1">
            <span class="ipynb-kernel-dot ipynb-kernel-${kernelState}"></span>
            <span class="ipynb-kernel-label">${kernelLabel(kernelState)}</span>
            ${runAll ? html`<button class="ipynb-tool" title="Run all cells" ?disabled=${busy} @click=${() => runAll()}>▶▶ Run all</button>` : ""}
            ${interrupt ? html`<button class="ipynb-tool" title="Interrupt the kernel" ?disabled=${!busy} @click=${() => interrupt()}>■ Interrupt</button>` : ""}
            ${restart ? html`<button class="ipynb-tool" title="Restart the kernel" @click=${() => restart()}>⟲ Restart</button>` : ""}
          </div>`
        : "";

    const head = html`
      <div class="file-head">
        <span class="file-name">${base}</span>
        <span class="file-ext">ipynb</span>
      </div>
      ${dir ? html`<div class="file-dir">${dir}/</div>` : ""}
      ${toolbar}
    `;

    // Pre-signal / empty: a calm placeholder, never a broken card.
    if (typeof text !== "string" || text.trim() === "")
      return html`${head}<div class="ipynb-body ipynb-notice">loading…</div>`;

    // TRUNCATION / PARSE GUARD (CLAUDE.md size-cap rule): `fileContent` is byte-bounded upstream — a clipped
    // notebook is invalid JSON. We do NOT add a second cap; we catch the parse failure and show a clear
    // notice. content.ts marks a clipped body with a trailing `\n…` sentinel, so we can tell a "too big to
    // show" truncation apart from a genuinely malformed file and word the notice accordingly.
    const truncated = text.endsWith("\n…");
    let nb;
    try {
      nb = JSON.parse(truncated ? text.slice(0, -2) : text);
    } catch {
      return html`${head}
        <div class="ipynb-body ipynb-notice ipynb-notice-warn">
          ${truncated
            ? html`<strong>Notebook too large to display.</strong> This preview was truncated at the byte
                cap, so it can't be parsed as JSON. Open it in a full notebook viewer.`
            : html`<strong>Could not parse this .ipynb file.</strong> It isn't valid notebook JSON.`}
        </div>`;
    }

    const cells = Array.isArray(nb.cells) ? nb.cells : [];
    const lang = notebookLang(nb);
    // The server's notebook-aware RENDER codec keeps images but drops WHOLE outputs when the notebook
    // exceeds its generous render budget (never a byte-clip — the JSON stays valid, so we still render).
    // It flags that via metadata.__foolscap so we can tell the reader some outputs were elided, rather
    // than silently showing a partial notebook (the "where did my content go?" failure, CLAUDE.md).
    const fooled = nb.metadata && typeof nb.metadata === "object" ? nb.metadata.__foolscap : null;
    const trimNotice =
      fooled && fooled.trimmed
        ? html`<div class="ipynb-body ipynb-notice">${fooled.droppedOutputs || "Some"} large output${
            fooled.droppedOutputs === 1 ? "" : "s"
          } elided to keep this notebook renderable. Open the file directly for the full outputs.</div>`
        : "";
    return html`
      ${head}
      ${trimNotice}
      <div class="ipynb-body">
        ${cells.length
          ? cells.map((c, i) => renderCell(c, i, lang, kernel, editApi))
          : html`<div class="ipynb-notice">Empty notebook — no cells.</div>`}
        ${appendRow(editApi)}
      </div>
    `;
  },
};
