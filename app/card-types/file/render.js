// card-types/file/render.js — the file card's interior as a runtime-loaded template
// (card-types-as-data.md §7, second card). The FIELDS + CODEC exercise: fields.title is a path and
// the splitPath mapping below is the v1 codec in its honest form (real JS, not a declarative layer).
// The body is the file's content — markdown rendered as prose, every other kind a raw monospace
// preview — and scrolls when it overflows the box (the interior-interaction seam; the card still
// drags from anywhere, only the wheel is captured). That content is OFF-LOG: it rides the
// `fileContent` capability (an off-log signal projected from disk — content.ts), not node.text, so
// the durable log keeps only the card's arrangement and its path reference. fields.text is the
// pre-signal fallback (empty now), so the card still renders headlessly / before the signal resolves.
import { html } from "/vendor/lit-html.js";
import { renderMd } from "/vendor/markdown.js";

// Extension → kind label, only where the label differs from the bare extension. The colour half
// of the old fileTypes codec stays at INGEST (the loader stamps node.color when the card is
// created) — colour keys the host's box swatch, and the template owns only the interior.
const KIND_ALIAS = { markdown: "md", yml: "yaml", mjs: "js", cjs: "js" };

function splitPath(p) {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dir = slash >= 0 ? p.slice(0, slash) : "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return { base, dir, kind: ext ? (KIND_ALIAS[ext] ?? ext) : "file" };
}

// YAML frontmatter (memory files, role.md, …): a leading `---` fence, key/value lines, a closing `---`
// fence, then the body. Split it off so the body renders as prose and the frontmatter renders as a
// structured "properties" strip (below) — NOT dumped into the prose, where the raw YAML rendered as an
// <hr> + run-on paragraph + <hr>. Kept deliberately small: only a leading fence counts (a `---` later in
// the body is a normal horizontal rule), and only markdown files are split (renderMd is shared with the
// session card, whose turn text must never be treated as frontmatter). Returns the raw body unchanged
// when there is no well-formed leading fence, so frontmatter-less markdown is untouched.
function splitFrontmatter(text) {
  if (typeof text !== "string" || !text.startsWith("---\n")) return { frontmatter: null, body: text };
  const nl = text.indexOf("\n---", 3); // the newline before the CLOSING fence
  if (nl === -1) return { frontmatter: null, body: text };
  const fence = nl + 1;
  if (text.slice(fence, fence + 3) !== "---") return { frontmatter: null, body: text };
  const rest = text.slice(fence + 3);
  if (rest && !rest.startsWith("\n")) return { frontmatter: null, body: text }; // `---xyz` isn't a fence
  const entries = parseFrontmatter(text.slice(4, nl));
  if (!entries.length) return { frontmatter: null, body: text };
  return { frontmatter: entries, body: (rest.startsWith("\n") ? rest.slice(1) : rest).replace(/^\n+/, "") };
}

// A deliberately minimal YAML reader for the frontmatter we actually write: top-level `key: value`, and
// one level of nesting (`key:` with no value, then indented `subkey: value` lines — e.g. `metadata:`).
// The key is up to the FIRST colon, so a value may itself contain colons. Lines that don't parse are
// skipped. Not a general YAML parser — just enough to render our own frontmatter legibly.
function parseFrontmatter(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = /^(\s*)(?:-\s+)?([^:]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, key, value] = m;
    const k = key.trim();
    const v = value.trim();
    if (indent.length > 0 && out.length && out[out.length - 1].children) {
      out[out.length - 1].children.push({ key: k, value: v });
    } else {
      out.push(v ? { key: k, value: v } : { key: k, children: [] });
    }
  }
  return out;
}

function fmRow(key, value) {
  return html`<div class="fm-row"><span class="fm-key">${key}</span><span class="fm-val">${value}</span></div>`;
}

// The frontmatter "properties" strip: a small key/value panel above the prose. Nested objects (children)
// render their key with the sub-rows indented beneath.
function renderFrontmatter(entries) {
  return html`<div class="file-frontmatter" title="frontmatter">
    ${entries.map((e) =>
      e.children
        ? html`<div class="fm-row fm-nest">
            <span class="fm-key">${e.key}</span>
            <span class="fm-val fm-children">${e.children.map((c) => fmRow(c.key, c.value))}</span>
          </div>`
        : fmRow(e.key, e.value),
    )}
  </div>`;
}

// Convert `[[slug]]` / `[[slug|label]]` wiki-links into markdown links to a sibling `slug.md`, so they
// render as real links and flow through the file card's link interceptor (openDocLink → open that card).
// This is the memory-store cross-link convention ([[name]] = another memory file by its `name:` slug in
// the same dir). Fenced code blocks are left verbatim so a literal `[[x]]` in an example isn't linkified;
// inline-code spans aren't specially handled (a `[[x]]` inside backticks in prose is vanishingly rare).
function linkifyWikilinks(md) {
  if (typeof md !== "string" || md.indexOf("[[") === -1) return md;
  return md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((seg, i) =>
      i % 2 === 1 // odd segments are fenced code blocks (the capture group) — leave alone
        ? seg
        : seg.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target, label) => {
            const slug = target.trim();
            return `[${(label ?? target).trim()}](${slug}.md)`;
          }),
    )
    .join("");
}

export default {
  contract: 1,
  render(card) {
    const { base, dir, kind } = splitPath(card.fields.title);
    const roots = card.signals.roots || [];
    // The file's ROOT colour (slice C): a small swatch in the head matching the session-card activity
    // dots + the tree folder, so a card opened from a worktree reads as belonging to it. Guarded for
    // cards/mocks without the `roots` capability (the canonical "repo" root carries a colour too).
    const hue = roots.find((r) => r.id === card.root)?.hue;
    // TOMBSTONE (slice D): the backing file is gone (deleted on disk → `gone`) or its WORKTREE was removed
    // (its root dropped out of the loaded roots list). Keep the card, mark it clearly, never silently drop
    // it. `roots.length` gates the worktree check so we don't tombstone during the pre-load beat.
    const rootGone = roots.length > 0 && card.root !== "roots" && !roots.some((r) => r.id === card.root);
    if (card.signals.gone || rootGone) {
      return html`
        <div class="file-head file-gone">
          <span class="file-name">${base}</span>
          <span class="file-ext">${rootGone ? "removed" : "deleted"}</span>
        </div>
        <div class="file-gone-body">
          <span class="file-gone-mark">🪦</span>
          <span>${rootGone ? "worktree removed" : "deleted on disk"}</span>
          <span class="file-gone-hint">${dir ? dir + "/" : ""}${base} · select + Delete to dismiss</span>
        </div>
      `;
    }
    // Off-log content first, the static field as the pre-signal fallback. Reading the capability is
    // what subscribes the card to it, so a disk change re-renders just this body — no setText, no log.
    const text = card.signals.fileContent ?? card.fields.text;
    // A markdown file is PROSE, so render it as such (the shared /vendor/markdown.js codec — the same
    // one the session card uses for turn text) instead of dumping the source into a <pre>. Every other
    // kind stays a raw, whitespace-preserving preview. This is a READ projection of the off-log content
    // signal; an eventual editable mode would be a raw-source toggle over the same signal, not this view.
    // YAML frontmatter is peeled off into a structured strip (renderFrontmatter) so the prose element —
    // and the [data-text] coordinate space annotations resolve against — holds only the body.
    const { frontmatter, body: mdBody } =
      kind === "md" ? splitFrontmatter(text) : { frontmatter: null, body: text };
    const body =
      kind === "md"
        ? html`
            ${frontmatter ? renderFrontmatter(frontmatter) : ""}
            <div class="file-body file-md md-prose" data-text>${renderMd(linkifyWikilinks(mdBody))}</div>
          `
        : html`<pre class="file-body" data-text>${text}</pre>`;
    return html`
      <div class="file-head">
        ${hue ? html`<span class="dir-root-swatch" style="background:${hue}"></span>` : ""}
        <span class="file-name">${base}</span>
        <span class="file-ext">${kind}</span>
      </div>
      ${dir ? html`<div class="file-dir">${dir}/</div>` : ""}
      ${body}
    `;
  },
};
