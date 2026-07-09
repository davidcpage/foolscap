// /vendor/notebook-format.js — a THIN parser for the subset of the Observable Notebooks 2.0 HTML format
// the notebook card needs (docs/notebook-card.md §13, step-0). This is NOT @observablehq/notebook-kit: a
// string-based deserialize/serialize over <notebook> → <script id> that depends on NO DOM (so it runs in
// the browser, in the worker, AND in the headless contract test under node alike — DOMParser doesn't
// exist there) and on no runtime. Swap for the real notebook-kit deserialize/serialize later if the
// format grows features we want to track (§12 "start vendored… revisit").
//
//   deserialize(html)          → { title, cells: [{ id, type, source, pinned }] }
//   serialize({ title, cells }) → the HTML string  (round-trips deserialize)
//
// Format facts honoured: per-cell `type` (default "module"), the `pinned` flag, and the one hard
// requirement — cell source escapes `</script>` as `<\/script>` so a closing tag inside JS can't end the
// block early. Source is stored 4-space-indented for readability; we dedent on read, re-indent on write.

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  return m ? m[1] : undefined;
}
function hasFlag(attrs, name) {
  return new RegExp(`\\b${name}(\\b|\\s|=|$)`, "i").test(attrs);
}
// A `data-in`/`data-out` value is a comma/space-separated name list. These `data-*` attributes are OURS
// (the reactive wiring + per-cell policy, docs/notebook-card.md §5/§6) — outside what the Observable
// format interprets, so a notebook stays portable; the format passes them through untouched.
export function nameList(s) {
  return (s || "").split(/[\s,]+/).filter(Boolean);
}

// `data-in` grew a small grammar for STEP-2 cross-card imports (docs/notebook-card.md §11.2). A token is:
//   • `name`              — a LOCAL sibling-cell export (the step-1 form, unchanged).
//   • `name=./rel`        — import the artefact at a RELATIVE PATH bound to `name`: another notebook as an
//                           OBJECT of its exports (`name.df`), or a data file's text content. `.html` is
//                           inferred when the path has no extension.
//   • `name=./rel#export` — import a SINGLE export `export` from the notebook at `./rel`, bound to `name`.
// The runtime (notebook-runtime.ts) resolves a path against the importing notebook's own directory and
// decides notebook-vs-file; the parser only splits the token. `inNames` stays the list of local binding
// names (for the spec signature + the "reads" display), so step-1 callers and the contract test are
// unaffected; the structured `imports` carry the path/export for the runtime.
export function parseImports(raw) {
  return nameList(raw).map((tok) => {
    const eq = tok.indexOf("=");
    if (eq < 0) return { name: tok, path: null, export: null };
    const name = tok.slice(0, eq).trim();
    const rest = tok.slice(eq + 1).trim();
    const hash = rest.indexOf("#");
    return hash < 0
      ? { name, path: rest, export: null }
      : { name, path: rest.slice(0, hash).trim(), export: rest.slice(hash + 1).trim() || null };
  });
}

// The inverse: render one import descriptor back to its `data-in` token (serialize round-trip).
function importToken(imp) {
  if (!imp.path) return imp.name;
  return `${imp.name}=${imp.path}${imp.export ? "#" + imp.export : ""}`;
}

// Strip the common leading indentation from a source block and drop blank lead/trail lines — the inverse
// of the 4-space indent serialize writes, so a round-trip is stable. Indent depth counts spaces and tabs
// alike (one char each); blank lines don't constrain the minimum.
function dedent(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

export function deserialize(html) {
  const src = String(html ?? "");
  const tm = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = tm ? tm[1].trim() : "";
  // The notebook-level MAIN-REALM CONSENT (the trust boundary — docs/notebook-external-libs-and-dom-output.md
  // §5). `data-main-realm="allow"` on the <notebook> element grants THIS notebook's DOM-producing cells the
  // right to run on the MAIN THREAD (full page authority; a runaway can hang the UI). Absent → those cells are
  // GATED: they don't run, and the card shows a one-time "allow" affordance. It lives on the <notebook> tag so
  // it is DURABLE and DOC-DECLARABLE — a headless/agent author pre-grants by writing the attribute, no click
  // needed. Any value other than the literal "allow" (mistyped/tampered) reads as no consent (the gate holds).
  const nm = /<notebook\b([^>]*)>/i.exec(src);
  const mainRealm = nm ? attr(nm[1] || "", "data-main-realm") || "" : "";
  const cells = [];
  // Cell ids MUST be unique: they're the per-cell handle every structural op in the card keys on
  // (delete/move/edit/convert-type in render.js) and the DOM `data-cellid`. A source file can carry
  // COLLIDING ids two ways — an explicit `id` that matches another cell's positional fallback (`c${n}`),
  // or two literal duplicate `id`s — and a collision made delete-by-id remove EVERY matching cell (a
  // silent data-loss bug: "deleting one cell also deletes the one below"). Guarantee uniqueness at the
  // parse boundary so no downstream op has to. Ids are internal handles (wiring is by data-in/out NAMES,
  // not ids), so minting a fresh id for a clash is safe and self-consistent within a render.
  const used = new Set();
  SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_RE.exec(src))) {
    const attrs = m[1] || "";
    let id = attr(attrs, "id") || `c${cells.length + 1}`;
    if (used.has(id)) {
      let n = cells.length + 1;
      while (used.has(`c${n}`)) n++;
      id = `c${n}`;
    }
    used.add(id);
    const type = attr(attrs, "type") || "module";
    const source = dedent(m[2]).replace(/<\\\/script>/g, "</script>");
    const imports = parseImports(attr(attrs, "data-in"));
    cells.push({
      id,
      type,
      source,
      pinned: hasFlag(attrs, "pinned"),
      imports, // structured imports (step-2): local | path | path#export
      inNames: imports.map((i) => i.name), // local binding names (reactive wiring + "reads" display)
      outNames: nameList(attr(attrs, "data-out")), // exports this cell defines
      policy: attr(attrs, "data-policy") || "", // "" | auto | manual | debounced[:ms]
    });
  }
  return { title, cells, mainRealm };
}

function indent(src) {
  return String(src)
    .split("\n")
    .map((l) => (l ? "    " + l : l))
    .join("\n");
}

export function serialize(nb) {
  const title = nb && nb.title != null ? String(nb.title) : "";
  // Round-trip the notebook-level main-realm consent (see deserialize). Only a truthy string is emitted, so an
  // ungranted notebook stays attribute-free (no noise in the file); granting it writes `data-main-realm="allow"`.
  const mainRealm = nb && typeof nb.mainRealm === "string" ? nb.mainRealm : "";
  const cells = (nb && nb.cells) || [];
  const blocks = cells.map((c) => {
    // Prefer the structured `imports` (carries path/export); fall back to the bare `inNames` for a cell
    // that was built without them (step-1 callers), so a round-trip never drops cross-card wiring.
    const inTokens = c.imports ? c.imports.map(importToken) : c.inNames || [];
    const inAttr = inTokens.length ? ` data-in="${inTokens.join(",")}"` : "";
    const outAttr = c.outNames && c.outNames.length ? ` data-out="${c.outNames.join(",")}"` : "";
    const polAttr = c.policy ? ` data-policy="${c.policy}"` : "";
    const flags = `${c.type ? ` type="${c.type}"` : ""}${c.pinned ? " pinned" : ""}${inAttr}${outAttr}${polAttr}`;
    const body = indent(String(c.source ?? "").replace(/<\/script>/g, "<\\/script>"));
    return `  <script id="${c.id}"${flags}>\n${body}\n  </script>`;
  });
  const nbAttr = mainRealm ? ` data-main-realm="${mainRealm}"` : "";
  return `<!doctype html>\n<notebook${nbAttr}>\n  <title>${title}</title>\n${blocks.join("\n")}\n</notebook>\n`;
}
