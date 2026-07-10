// card-types/ipynb/render.js — a READ-ONLY Jupyter notebook (.ipynb) card interior, loaded at runtime
// (card-types-as-data.md §7). It is the file card's cousin: the SOURCE is a `.ipynb` file read off-log
// through `fileContent` (content.ts), and the card is a VIEW over it — this template only PARSES and
// DISPLAYS. It never executes anything: there is no kernel, no REPL, no editing (that is deliberately
// out of scope, parked as a future thread — see the brief). A `.ipynb` is JSON, so we JSON.parse the
// content and render each cell: markdown via the shared prose codec, code via the shared highlighter,
// and outputs by output_type.
//
// SECURITY NOTE: `text/html` outputs (and svg) are rendered RAW and UNSANITISED — we build a real DOM
// node with innerHTML and embed it (the same live-node embedding the reactive notebook card uses for its
// output views). This is a deliberate TRUSTED-NOTEBOOK assumption: you are exploring notebooks you already
// trust on disk, and faithful rendering (tables, styled DataFrames, plots emitted as HTML) is the point.
// It is NOT safe for untrusted notebooks. If that assumption ever stops holding, sanitise here.
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

// A code cell's source as a highlighted <pre>, falling back to a plain whitespace-preserving <pre> when
// the language isn't in the bundle or highlighting fails — never worse off than raw, never throws. Mirrors
// the file card's code path (escaped token spans, no injected HTML).
function renderCode(src, lang) {
  const highlighted = highlightCode(src, langForKind(lang));
  return highlighted
    ? html`<pre class="ipynb-source hljs"><code>${highlighted}</code></pre>`
    : html`<pre class="ipynb-source">${src}</pre>`;
}

// Pick the richest displayable MIME from an execute_result / display_data bundle and render it, in the
// brief's priority order: image (png/jpeg, inline base64) → html (raw) → svg (raw) → plain text (<pre>).
// A base64 image payload may arrive as an array of lines or with embedded whitespace; strip it for the URI.
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

// One notebook cell: markdown → prose (shared codec), code → highlighted source + its outputs, raw → <pre>.
// A code cell shows its execution count (`In [n]`) as a gutter label, Jupyter-style, plus a per-cell Run
// button (Path B). `kernel` = { run(sel), status } — `run` is null when the kernel capabilities aren't
// granted (headless mock / older card); `status` is the live `kernelStatus` feed frame (or null). The cell
// selects itself by nbformat id (preferred) with the document index as a fallback (a notebook that predates
// nbformat 4.5 cell ids runs the first time by index; the broker assigns ids + persists, then id-keys after).
function renderCell(cell, index, lang, kernel) {
  if (!cell || typeof cell !== "object") return "";
  const src = joinSource(cell.source);
  if (cell.cell_type === "markdown")
    return html`<div class="ipynb-cell ipynb-md md-prose">${renderMd(src)}</div>`;
  if (cell.cell_type === "code") {
    const count = cell.execution_count;
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    const st = kernel && kernel.status;
    const running = !!(st && st.status === "busy" && st.runningCellId && cell.id && st.runningCellId === cell.id);
    const run = kernel && kernel.run;
    return html`
      <div class="ipynb-cell ipynb-code ${running ? "ipynb-running" : ""}">
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
          ${renderCode(src, lang)}
        </div>
        ${running ? html`<div class="ipynb-cell-status">running…</div>` : ""}
        ${outputs.length ? html`<div class="ipynb-outputs">${outputs.map((o) => renderOutput(o))}</div>` : ""}
      </div>
    `;
  }
  // raw cell (and any other kind): show its source verbatim.
  return html`<div class="ipynb-cell ipynb-raw"><pre class="ipynb-source">${src}</pre></div>`;
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
          ? cells.map((c, i) => renderCell(c, i, lang, kernel))
          : html`<div class="ipynb-notice">Empty notebook — no cells.</div>`}
      </div>
    `;
  },
};
