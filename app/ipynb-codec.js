// ipynb-codec.js — notebook-aware transform for `.ipynb` served over /api/file. Plain ESM (runs under
// node --test); the TS server imports it through ipynb-codec.d.ts. Pure: it touches only its arguments.
//
// WHY this exists. A `.ipynb` is JSON, but a notebook with base64 image outputs is easily megabytes. The
// generic 128 KiB file-preview cap (MAX_BYTES, server-http.ts) head-clips it mid-stream → invalid JSON →
// the ipynb card blanks with "too large", and an agent curling /api/file gets raw nbformat with base64
// blobs inline. Those are OPPOSITE needs, so /api/file serves two shapes of the SAME notebook:
//
//   • RENDER (the card, ?notebook=render): the card wants the images. Keep every output; only if the
//     serialized notebook exceeds a GENEROUS render budget do we drop WHOLE outputs (largest first) —
//     never a byte-clip, so the JSON stays valid and the card never blanks on real input.
//   • AGENT (the default, a bare /api/file): an agent wants legibility, not megabytes of base64. Elide
//     each base64 raster-image payload to a `<image/png output elided: N bytes>` marker and clamp
//     oversized text/stream/traceback outputs to a head+marker — KEEPING cell source intact and the JSON
//     valid + parseable.
//
// Both honor CLAUDE.md's size-cap rule: the byte read (MAX_NOTEBOOK_BYTES, in server-http.ts) is the ONE
// memory bound; this codec never adds a second byte cap, it elides/drops at the STRUCTURE level so the
// result is always valid JSON. Trimming is surfaced via a flag (the envelope `trimmed` for agents, the
// injected `metadata.__foolscap` for the card banner) — never guessed from a parse failure.

// Per-output text budget (chars) for the AGENT path: a single stream/text/traceback output longer than
// this is clamped to its head + a marker. Generous — most outputs are far smaller; this only bites on a
// runaway print loop or a giant repr.
export const DEFAULT_MAX_TEXT_CHARS = 4000;

// Serialized-size budget (chars ≈ bytes, base64 is ASCII) for the RENDER path. A notebook whose full
// image-bearing JSON exceeds this has whole outputs dropped (largest first) until it fits. Generous — a
// handful of matplotlib PNGs is well under this; it only bites on a notebook stuffed with heavy images.
export const DEFAULT_RENDER_BUDGET = 12 * 1024 * 1024;

// Raster (base64) image MIME types whose payload we elide to a marker on the agent path. SVG and HTML are
// TEXT (rendered/greppable), so they go through the text-clamp path instead of being elided wholesale.
const RASTER_IMAGE = /^image\/(png|jpe?g|gif|bmp|webp|tiff|x-icon)$/i;

// An nbformat `source`/`text`/`data[mime]` value is EITHER a string or an array of line-strings. Join
// arrays verbatim (the lines carry their own newlines); a non-string/array (e.g. an application/json
// object) yields "" so the caller leaves it untouched.
function joinMaybe(v) {
  return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
}

// Clamp an oversized text field to its head + an honest marker. Stays valid nbformat (a string is a legal
// value everywhere source/text/data live) and tells the reader exactly how much was dropped.
function clampText(s, maxChars, label) {
  return s.slice(0, maxChars) + `\n<… ${label} truncated: ${s.length} chars total, ${maxChars} shown>`;
}

// The two marker SHAPES the AGENT path stamps into an output value — kept here beside their producers so the
// detector (`notebookHasElisionMarkers`, below) can never drift from what `elideOutputForAgent` writes. The
// image marker REPLACES the whole value (elideOutputForAgent → `<mime output elided: N bytes>`); the text
// marker is a SUFFIX appended by clampText. Both are the tell that a value is a lossy read projection, never
// the file's real output — writing one back would erase the real output (BUG-2), so a write carrying either
// must be refused. Anchored/precise so an incidental cell-source string can't false-trip the detector.
const ELIDED_IMAGE_MARKER = /^<image\/(?:png|jpe?g|gif|bmp|webp|tiff|x-icon) output elided: \d+ bytes>$/i;
const CLAMPED_TEXT_MARKER = /\n<… .+? truncated: \d+ chars total, \d+ shown>$/;

// AGENT path — elide one output in place. Base64 raster images become a byte-count marker; oversized
// text/stream/traceback outputs are clamped. Returns true if anything was trimmed. Cell SOURCE is never
// touched (that's what an agent is reading for).
function elideOutputForAgent(out, maxTextChars) {
  if (!out || typeof out !== "object") return false;
  let trimmed = false;
  // execute_result / display_data carry a MIME bundle in `data`.
  if (out.data && typeof out.data === "object") {
    for (const mime of Object.keys(out.data)) {
      if (RASTER_IMAGE.test(mime)) {
        const bytes = Buffer.byteLength(joinMaybe(out.data[mime]).replace(/\s+/g, ""), "utf8");
        out.data[mime] = `<${mime} output elided: ${bytes} bytes>`;
        trimmed = true;
      } else {
        const s = joinMaybe(out.data[mime]); // "" for a structured (JSON object) value → left as-is
        if (s.length > maxTextChars) {
          out.data[mime] = clampText(s, maxTextChars, mime);
          trimmed = true;
        }
      }
    }
  }
  // stream output (stdout/stderr text).
  if (out.output_type === "stream") {
    const s = joinMaybe(out.text);
    if (s.length > maxTextChars) {
      out.text = clampText(s, maxTextChars, "stream");
      trimmed = true;
    }
  }
  // error output (traceback lines).
  if (out.output_type === "error" && Array.isArray(out.traceback)) {
    const s = out.traceback.join("\n");
    if (s.length > maxTextChars) {
      out.traceback = [clampText(s, maxTextChars, "traceback")];
      trimmed = true;
    }
  }
  return trimmed;
}

// RENDER path — if the notebook's full serialized size exceeds `budget`, drop WHOLE outputs (largest
// first) until it fits, mutating cell.outputs in place. Keeps valid JSON (no byte-clip). Returns
// { trimmed, dropped }. Sizes are approximated per-output (stringify + delimiter) so we don't re-serialize
// the whole notebook on every drop — the budget is deliberately generous, so a small approximation error
// costs nothing.
function fitRenderBudget(nb, budget) {
  const base = JSON.stringify(nb).length;
  if (base <= budget) return { trimmed: false, dropped: 0 };
  const outs = [];
  for (const cell of nb.cells) {
    if (cell && Array.isArray(cell.outputs)) {
      cell.outputs.forEach((o, i) => outs.push({ cell, i, size: JSON.stringify(o).length + 1 }));
    }
  }
  outs.sort((a, b) => b.size - a.size); // largest output first — dropping the fewest to fit
  const dropByCell = new Map();
  let size = base;
  let dropped = 0;
  for (const o of outs) {
    if (size <= budget) break;
    let set = dropByCell.get(o.cell);
    if (!set) dropByCell.set(o.cell, (set = new Set()));
    set.add(o.i);
    size -= o.size;
    dropped++;
  }
  for (const [cell, set] of dropByCell) {
    cell.outputs = cell.outputs.filter((_, i) => !set.has(i));
  }
  return { trimmed: dropped > 0, dropped };
}

// Transform a `.ipynb`'s raw JSON text for one of THREE paths. Returns { content, trimmed, parsed }:
//   • parsed=false when the text isn't valid notebook JSON (malformed, or already byte-clipped upstream) —
//     content is the ORIGINAL text, unchanged, so the card's own parse-guard shows its "couldn't parse" /
//     "too large" notice and an agent sees the raw bytes. We never GUESS truncation here.
//   • otherwise content is the transformed, re-serialized, still-valid JSON and `trimmed` says whether any
//     elision/drop happened.
//
// Modes:
//   • "render" — the card view: keep images, drop WHOLE outputs only past a generous budget (never lossy JSON).
//   • "agent"  — the default read: elide base64 images to markers, clamp huge text (legible, not megabytes).
//   • "full"   — FULL-FIDELITY identity projection for WRITE-BACK (the kernel broker's cell-output merge):
//     no elision, no drop — the on-disk record must be complete. It still routes through the codec (rather
//     than a bare JSON.stringify at the call site) so notebook-shape validation and the __foolscap strip
//     live in ONE place: the render path injects `metadata.__foolscap` as a card-only banner flag; it must
//     NEVER be persisted back to the file, so "full" strips it. This is the ONLY sanctioned write projection.
export function transformNotebook(text, opts = {}) {
  const mode = opts.mode === "render" ? "render" : opts.mode === "full" ? "full" : "agent";
  const maxTextChars = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const renderBudget = opts.renderBudget ?? DEFAULT_RENDER_BUDGET;

  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return { content: text, trimmed: false, parsed: false };
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) {
    return { content: text, trimmed: false, parsed: false };
  }

  if (mode === "full") {
    // Identity + strip the render-only banner flag. Nothing elided or dropped — full fidelity.
    if (nb.metadata && typeof nb.metadata === "object") delete nb.metadata.__foolscap;
    return { content: JSON.stringify(nb, null, 1), trimmed: false, parsed: true };
  }

  let trimmed = false;
  if (mode === "agent") {
    for (const cell of nb.cells) {
      if (cell && Array.isArray(cell.outputs)) {
        for (const out of cell.outputs) {
          if (elideOutputForAgent(out, maxTextChars)) trimmed = true;
        }
      }
    }
  } else {
    const r = fitRenderBudget(nb, renderBudget);
    trimmed = r.trimmed;
    if (trimmed) {
      // Inject a namespaced flag the card reads (metadata.__foolscap) to show a banner. Only on the render
      // path — the agent path flags via the response envelope + the in-data markers, keeping its JSON clean.
      nb.metadata = nb.metadata && typeof nb.metadata === "object" ? nb.metadata : {};
      nb.metadata.__foolscap = { trimmed: true, droppedOutputs: r.dropped };
    }
  }
  return { content: JSON.stringify(nb), trimmed, parsed: true };
}

// Does a value (a joined source/text/data-mime string) carry one of the agent path's elision markers?
function valueHasElisionMarker(s) {
  return typeof s === "string" && (ELIDED_IMAGE_MARKER.test(s) || CLAMPED_TEXT_MARKER.test(s));
}

// True if any OUTPUT in this notebook text carries an agent-projection elision marker — i.e. the text is (or
// contains) the lossy agent read projection, not a full-fidelity notebook. The BUG-2 guard: /api/file must
// REFUSE to write such a body, because persisting it replaces every real output with a marker (data loss on
// a well-behaved read-edit-write). We inspect only OUTPUT fields (data mime values, stream text, error
// traceback) — the exact places `elideOutputForAgent` stamps markers — so a marker string that merely
// appears in cell SOURCE (a test, a doc snippet) never false-trips this. Malformed / non-notebook JSON → false
// (nothing to protect; it isn't our projection). Mirrors elideOutputForAgent's traversal on purpose.
export function notebookHasElisionMarkers(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return false;
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) return false;
  for (const cell of nb.cells) {
    if (!cell || !Array.isArray(cell.outputs)) continue;
    for (const out of cell.outputs) {
      if (!out || typeof out !== "object") continue;
      if (out.data && typeof out.data === "object") {
        for (const mime of Object.keys(out.data)) {
          if (valueHasElisionMarker(joinMaybe(out.data[mime]))) return true;
        }
      }
      if (out.output_type === "stream" && valueHasElisionMarker(joinMaybe(out.text))) return true;
      if (out.output_type === "error" && Array.isArray(out.traceback) && valueHasElisionMarker(out.traceback.join("\n")))
        return true;
    }
  }
  return false;
}
