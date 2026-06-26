// vendor/markdown.js — the prose codec, shared across card templates (session turns, markdown files).
// It lives in /vendor/ because the import graph IS each template's capability boundary (the headless
// contract test): a template may import the vendored substrate and nothing else — not core, not
// interaction, not the shell. This module is substrate too: it imports only lit-html and renders a
// markdown string to lit, so any template can format prose without coupling to a sibling card type.
//
// Rendered WITHOUT borrowing a parser or injecting an HTML string. The vendored lit-html ships no
// unsafeHTML directive, and we wouldn't want it: a markdown→lit pass keeps every leaf a lit TEXT
// binding, which stays escaped, so neither a transcript nor a file on disk can smuggle live markup
// into a card. The parser is real JS — block AST then a render walk, no declarative layer.
//
// Block grammar (line-based): ATX headings, fenced code (``` / ~~~), blockquotes, ordered/unordered
// lists (nested by indentation, GFM task boxes), thematic breaks, paragraphs. Inline: code spans,
// **strong** / *em* (and _ guarded so file_path doesn't italicise), ~~del~~, [links](url). Tolerant
// by design — anything unrecognised falls through as paragraph text, never throws.
import { html } from "/vendor/lit-html.js";

// A code span wins over emphasis (so `**x**` stays literal inside backticks); ** / __ (strong) before
// * / _ (em). Underscore emphasis is word-boundary-guarded so identifiers like a_b_c are left alone.
const INLINE_RE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|(?<!\w)__([\s\S]+?)__(?!\w)|\*([^\s*][\s\S]*?)\*|(?<!\w)_([^_]+?)_(?!\w)|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;

// A plain-text run between (or around) inline matches may itself span soft line breaks — a paragraph's
// lines arrive joined by "\n" (see paraInline). Emit those breaks as <br> HERE, on the *text* runs, so
// the inline matcher above still sees the whole joined paragraph and a span like **…\n…** stays intact.
function pushText(out, str) {
  const parts = str.split("\n");
  for (let k = 0; k < parts.length; k++) {
    if (k) out.push(html`<br />`);
    if (parts[k]) out.push(parts[k]);
  }
}

function inlineMd(text) {
  const out = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(text))) {
    // INLINE_RE is a shared /g (stateful) regex and the recursive inlineMd calls below re-enter it,
    // clobbering its lastIndex. Snapshot the match end NOW, then restore it after recursing so this
    // loop keeps advancing — otherwise it re-matches the same span forever and blows the heap.
    const end = INLINE_RE.lastIndex;
    if (m.index > last) pushText(out, text.slice(last, m.index));
    if (m[1] != null) out.push(html`<code class="md-icode">${m[2]}</code>`);
    else if (m[3] != null) out.push(html`<strong>${inlineMd(m[3])}</strong>`);
    else if (m[4] != null) out.push(html`<strong>${inlineMd(m[4])}</strong>`);
    else if (m[5] != null) out.push(html`<em>${inlineMd(m[5])}</em>`);
    else if (m[6] != null) out.push(html`<em>${inlineMd(m[6])}</em>`);
    else if (m[7] != null) out.push(html`<del>${inlineMd(m[7])}</del>`);
    else out.push(html`<a class="md-link" href=${m[9]} target="_blank" rel="noopener noreferrer">${inlineMd(m[8])}</a>`);
    last = end;
    INLINE_RE.lastIndex = end;
  }
  if (last < text.length) pushText(out, text.slice(last));
  return out;
}

// GFM tables: a header row, a delimiter row (cells of -, with optional : alignment), then body rows.
// Detection keys on the delimiter line, so a bare pipe-grid (no |---|) stays a paragraph — as GFM wants.
const DELIM_CELL = /^:?-+:?$/;
function splitRow(line) {
  // split on | , honouring \| escapes; one optional leading/trailing pipe is decoration, not a cell.
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (s[k] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}
const isTableDelim = (line) => {
  const c = splitRow(line);
  return c.length > 0 && c.every((x) => DELIM_CELL.test(x));
};
const cellAlign = (c) =>
  c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null;

const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;
const leadWs = (s) => (/^\s*/.exec(s)[0].replace(/\t/g, "    ")).length;
const nextNonBlank = (lines, i) => {
  while (i < lines.length && !lines[i].trim()) i++;
  return i;
};

// A line that, mid-paragraph, ends it because it opens a block of its own.
function isBlockBoundary(line) {
  return (
    /^\s*(```+|~~~+)/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line) ||
    LIST_RE.test(line)
  );
}

// One list (a run of items at the same indent). Each item's content — its first line plus any lines
// indented under it — is parsed RECURSIVELY, so a nested list is just continuation that happens to be
// markers, and a multi-paragraph item just works. Returns {block, next}.
function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  // A run only stays one list while indent AND kind hold: switching ordered↔unordered at the same
  // indent starts a NEW list (else `- a` + `1. b` merge, and the ordered list's <ol> never renders).
  const sameKind = (mm) => mm[1].length === baseIndent && /\d/.test(mm[2]) === ordered;
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      // a blank between items keeps the list together; otherwise it ends here (loose-list tolerance)
      const j = nextNonBlank(lines, i);
      const mm = j < lines.length ? LIST_RE.exec(lines[j]) : null;
      if (mm && sameKind(mm)) { i = j; continue; }
      break;
    }
    const m = LIST_RE.exec(lines[i]);
    if (!m || !sameKind(m)) break;
    const contentCol = m[1].length + m[2].length + m[3].length;
    const itemLines = [m[4]];
    i++;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        const j = nextNonBlank(lines, i);
        if (j < lines.length && leadWs(lines[j]) >= contentCol) { itemLines.push(""); i++; continue; }
        break;
      }
      if (leadWs(lines[i]) >= contentCol) { itemLines.push(lines[i].slice(contentCol)); i++; continue; }
      break;
    }
    items.push(parseBlocks(itemLines.join("\n")));
  }
  return { block: { kind: "list", ordered, items }, next: i };
}

function parseBlocks(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^(\s*)(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const mark = fence[2][0];
      const closes = (ln) => { const t = ln.trim(); return /^[`~]+$/.test(t) && t[0] === mark; };
      const body = [];
      i++;
      while (i < lines.length && !closes(lines[i])) { body.push(lines[i].slice(indent)); i++; }
      i++; // skip the closing fence (or run off the end on an unterminated block)
      blocks.push({ kind: "code", lang: fence[3].trim(), text: body.join("\n") });
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { blocks.push({ kind: "heading", level: h[1].length, text: h[2] }); i++; continue; }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) { blocks.push({ kind: "hr" }); i++; continue; }

    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push({ kind: "quote", blocks: parseBlocks(q.join("\n")) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(splitRow(lines[i])); i++; }
      blocks.push({ kind: "table", header, aligns, rows });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockBoundary(lines[i])) { para.push(lines[i]); i++; }
    blocks.push({ kind: "para", text: para.join("\n") });
  }
  return blocks;
}

// Soft newlines inside a paragraph become <br> — in a transcript they're usually deliberate (a list
// the model wrote without blank lines, an address), not just reflowable prose. The break conversion
// happens INSIDE inlineMd (on text runs, via pushText), so the matcher sees the whole joined paragraph
// and an inline span that straddles a soft line break — **bold\nacross lines** — is no longer severed.
function paraInline(text) {
  return inlineMd(text);
}

function renderMdItem(blocks) {
  // A single-paragraph item renders inline (no <p> margins); a richer item keeps its block structure
  // (nested lists, multiple paragraphs). A leading [ ]/[x] is a GFM task box.
  if (blocks.length === 1 && blocks[0].kind === "para") {
    const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(blocks[0].text);
    if (task)
      return html`<li class="md-task">
        <span class="md-box">${task[1] === " " ? "☐" : "☑"}</span>${paraInline(task[2])}
      </li>`;
    return html`<li>${paraInline(blocks[0].text)}</li>`;
  }
  return html`<li>${blocks.map(renderMdBlock)}</li>`;
}

function renderMdBlock(b) {
  switch (b.kind) {
    case "heading":
      return html`<div class="md-h md-h${b.level}">${inlineMd(b.text)}</div>`;
    case "code":
      return html`<pre class="md-pre"><code>${b.text}</code></pre>`;
    case "hr":
      return html`<hr class="md-hr" />`;
    case "quote":
      return html`<blockquote class="md-quote">${b.blocks.map(renderMdBlock)}</blockquote>`;
    case "list":
      return b.ordered
        ? html`<ol class="md-list">${b.items.map(renderMdItem)}</ol>`
        : html`<ul class="md-list">${b.items.map(renderMdItem)}</ul>`;
    case "table": {
      // Body cells iterate the header (not the row), so a ragged/short row normalises to the column
      // count — missing cells render empty instead of throwing or spilling into the next row.
      const al = (k) => (b.aligns[k] ? `text-align:${b.aligns[k]}` : "");
      return html`<table class="md-table">
        <thead><tr>${b.header.map((c, k) => html`<th style=${al(k)}>${inlineMd(c)}</th>`)}</tr></thead>
        <tbody>${b.rows.map(
          (r) => html`<tr>${b.header.map((_, k) => html`<td style=${al(k)}>${inlineMd(r[k] ?? "")}</td>`)}</tr>`,
        )}</tbody>
      </table>`;
    }
    default:
      return html`<p class="md-p">${paraInline(b.text)}</p>`;
  }
}

// Re-parsing the same source each frame is wasteful: a live session re-renders per streamed delta, and
// a file card re-renders on any signal change. Historical text never changes, so memoise the rendered
// lit by source string — only a streaming tail (whose text grows each frame) ever misses. Returning the
// SAME array identity also lets lit skip unchanged turns. Bounded by distinct source strings; hard-capped.
const mdCache = new Map();
export function renderMd(src) {
  const hit = mdCache.get(src);
  if (hit) return hit;
  const out = parseBlocks(src).map(renderMdBlock);
  if (mdCache.size > 2000) mdCache.clear();
  mdCache.set(src, out);
  return out;
}
