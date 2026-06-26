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
    const body =
      kind === "md"
        ? html`<div class="file-body file-md md-prose" data-text>${renderMd(text)}</div>`
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
