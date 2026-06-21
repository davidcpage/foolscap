// card-types/directory/render.js — the directory card's interior as a runtime-loaded template
// (file-trees-on-canvas.md §3). fields.title is a folder path; the body is an in-card TREE: it lists the
// root's immediate children and lets you DRILL DOWN by expanding sub-folders in place, each level's
// children read off the OFF-LOG `dirListing(path)` capability (content.ts, /api/ls), not node.text, so
// browsing the tree is a channel-1 projection that never touches the durable log ("derived by default",
// §9). Which folders are open is `treeState` — per-card view state, also off-log. Every row is DRAGGABLE:
// drop it on the canvas and the host promotes that one path to an authored node (a file card, or a fresh
// directory card for a sub-folder — loader.materializeAt). So you navigate INSIDE the card and drag out
// only the specific level you want to pin — the deliberate §9 promotion gesture.
import { html } from "/vendor/lit-html.js";

// The drag payload mime — App.tsx's canvas drop handler reads the same key. A path + whether it's a dir
// (→ directory card) or a file (→ file card) is all the host needs; the drop point sets the position.
const MIME = "application/x-canvas-fsnode";

function baseName(p) {
  const s = p.lastIndexOf("/");
  return s >= 0 ? p.slice(s + 1) : p;
}

function ext(p) {
  const b = baseName(p);
  const d = b.lastIndexOf(".");
  return d > 0 ? b.slice(d + 1).toLowerCase() : "";
}

function dragStart(e, path, kind) {
  e.dataTransfer.setData(MIME, JSON.stringify({ path, kind }));
  e.dataTransfer.effectAllowed = "copy";
}

export default {
  contract: 1,
  render(card) {
    const root = card.fields.title;
    // dirListing is a CALLABLE keyed by path: calling it for a folder is what subscribes the card to that
    // folder (lazy /api/ls), so an arriving listing re-renders just this body — no log. We call it for the
    // root and for each EXPANDED sub-folder; collapsing one stops calling it → it unsubscribes.
    const ls = card.signals.dirListing;
    // treeState holds the expand-set (paths of open sub-folders) — per-card, off-log, ephemeral. Reading
    // it subscribes the card; toggling re-renders via set(). Root is always shown, so it isn't in the set.
    const ts = card.signals.treeState;
    const open = ts.get() ?? new Set();
    const toggle = (p) => {
      const next = new Set(open);
      next.has(p) ? next.delete(p) : next.add(p);
      ts.set(next);
    };

    // One level → an array of rows, recursing into expanded sub-folders. Indent grows with depth; each
    // dir row carries a twisty (expand/collapse) and is draggable; each file row is draggable.
    const rowsFor = (dir, depth) => {
      const listing = ls(dir); // { dirs, files } | undefined while loading
      const pad = 8 + depth * 14;
      if (!listing) return [html`<div class="dir-empty" style="padding-left:${pad}px">loading…</div>`];
      const out = [];
      for (const d of listing.dirs) {
        const isOpen = open.has(d);
        out.push(html`
          <div
            class="dir-row dir-sub"
            draggable="true"
            data-interactive="1"
            title="drag onto the canvas to pin as its own card"
            style="padding-left:${pad}px"
            @dragstart=${(e) => dragStart(e, d, "dir")}
          >
            <span class="dir-tw" @click=${(e) => { e.stopPropagation(); toggle(d); }}>${isOpen ? "▾" : "▸"}</span>
            <span class="dir-glyph">${isOpen ? "📂" : "📁"}</span>
            <span class="dir-rowname" @click=${(e) => { e.stopPropagation(); toggle(d); }}>${baseName(d)}</span>
          </div>
        `);
        if (isOpen) out.push(...rowsFor(d, depth + 1));
      }
      for (const f of listing.files) {
        out.push(html`
          <div
            class="dir-row"
            draggable="true"
            data-interactive="1"
            title="drag onto the canvas to open as a card"
            style="padding-left:${pad}px"
            @dragstart=${(e) => dragStart(e, f, "file")}
          >
            <span class="dir-tw"></span>
            <span class="dir-glyph">📄</span>
            <span class="dir-rowname">${baseName(f)}</span>
            ${ext(f) ? html`<span class="dir-ext">${ext(f)}</span>` : ""}
          </div>
        `);
      }
      return out;
    };

    const rootListing = ls(root);
    const count = rootListing ? rootListing.dirs.length + rootListing.files.length : 0;

    return html`
      <div class="file-head">
        <span class="file-name">${baseName(root) || "repo"}/</span>
        <span class="file-ext">tree</span>
      </div>
      ${root ? html`<div class="file-dir">${root}/ · ${count} item${count === 1 ? "" : "s"}</div>` : ""}
      <div class="dir-body">
        ${!rootListing ? html`<div class="dir-empty">loading…</div>` : ""}
        ${rootListing && count === 0 ? html`<div class="dir-empty">empty folder</div>` : ""}
        ${rowsFor(root, 0)}
      </div>
    `;
  },
};
