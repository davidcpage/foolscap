// vendor/highlight-lit.js — the syntax-highlight codec, the /vendor/markdown.js sibling for CODE. It lives
// in /vendor/ (the card template's capability boundary) and imports only the vendored substrate: the
// highlight.js bundle and lit-html. It turns a source string into a lit tree of escaped <span> tokens.
//
// Rendered WITHOUT injecting an HTML string, exactly as markdown.js is and for the same reason: the
// vendored lit-html ships no unsafeHTML directive, and a code file on disk must not be able to smuggle live
// markup into a card. highlight.js's public API only emits an HTML *string* (`.value`), so we parse that
// string — a controlled subset, only `<span class="hljs-…">` tags and entity-escaped text — back into a lit
// tree where every token's text is a lit TEXT binding (stays escaped) and the scope rides an attribute
// binding. The parse is the inverse of highlight.js's own escaper: it decodes the same five entities.
import { html } from "/vendor/lit-html.js";
import hljs from "/vendor/highlight.js";

// Extension/kind → highlight.js language name. `kind` arrives already lowercased and alias-folded by the
// file template's splitPath (markdown→md, yml→yaml, mjs/cjs→js). We map to the languages the 'common'
// bundle actually registers; anything absent (or a kind with no entry) falls back to a plain, unhighlighted
// <pre> in render.js, so an unknown file type is never worse than it is today. hljs also covers jsx/tsx
// under javascript/typescript, and html/svg under xml.
const KIND_LANG = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  yaml: "yaml",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kotlin: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  r: "r",
  swift: "swift",
  pl: "perl",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  makefile: "makefile",
  make: "makefile",
  mk: "makefile",
};

// The language for a kind IF the bundle actually registers it — else null (caller renders a plain <pre>).
export function langForKind(kind) {
  const lang = KIND_LANG[kind];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

// Decode the five entities highlight.js's escaper emits (`&`, `<`, `>`, `"`, `'`), so token text is restored
// to its literal form before it becomes a lit TEXT binding (which re-escapes on render). Numeric `&#x27;`
// is the apostrophe; the rest are named. No other entities appear in hljs output.
const ENTITY = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
function decodeEntities(s) {
  return s.indexOf("&") === -1 ? s : s.replace(/&(?:amp|lt|gt|quot|#x27);/g, (m) => ENTITY[m]);
}

// Parse highlight.js's HTML string into a lit tree. The grammar is tiny and closed: a run of text, an
// opening `<span class="…">` (push a scope), or a `</span>` (pop). Everything between tags is entity-escaped
// text. We build lit `<span class=…>` nodes with the token text as a child binding — so nesting is preserved
// and every leaf stays escaped. Anything unexpected is treated as text (tolerant, never throws).
const TOKEN_RE = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
function parseHljsHtml(htmlStr) {
  // A stack of open frames; each frame is { cls, out: [] }. The root frame's `out` is the final child list.
  const root = { cls: null, out: [] };
  const stack = [root];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(htmlStr))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) {
      stack.push({ cls: m[1], out: [] }); // <span class="…">
    } else if (m[2] != null) {
      top.out.push(decodeEntities(m[2])); // text run
    } else {
      // </span> — close the current frame into its parent as a classed <span>
      if (stack.length > 1) {
        const frame = stack.pop();
        stack[stack.length - 1].out.push(html`<span class=${frame.cls}>${frame.out}</span>`);
      }
    }
  }
  // Tolerate an unbalanced tail (a truncated preview can clip mid-span): flush any still-open frames.
  while (stack.length > 1) {
    const frame = stack.pop();
    stack[stack.length - 1].out.push(html`<span class=${frame.cls}>${frame.out}</span>`);
  }
  return root.out;
}

// Highlighting the same source each frame is wasteful (a file card re-renders on any signal change), so
// memoise by (lang, source) — the file's content signal is stable between edits. Bounded by distinct
// (lang,source) pairs; hard-capped like the markdown codec.
const cache = new Map();

// Highlight `text` as `lang` (a name from langForKind) and return a lit tree of escaped token spans, or
// null if highlighting fails for any reason (never throw — the caller falls back to a plain <pre>).
export function highlightCode(text, lang) {
  if (typeof text !== "string" || !lang) return null;
  const key = lang + "\0" + text;
  const hit = cache.get(key);
  if (hit) return hit;
  let out;
  try {
    const { value } = hljs.highlight(text, { language: lang, ignoreIllegals: true });
    out = parseHljsHtml(value);
  } catch {
    return null;
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}
