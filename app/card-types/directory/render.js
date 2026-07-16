// card-types/directory/render.js — the directory card's interior as a runtime-loaded template
// (file-trees-on-canvas.md §3). Two modes, one tree engine:
//   • COMBINED (card.root === "roots") — the "File tree" card. Its TOP LEVEL is the board's ROOTS (the
//     canonical checkout + each git worktree), read off the `roots` capability so it updates REACTIVELY
//     as worktrees come and go. Each root is an expandable, colour-swatched row; expanding drills into
//     that root's files in place. (worktree-activity slice B/C.)
//   • SINGLE-ROOT — a card dragged/double-clicked OUT of the combined card (or a sub-folder). fields.title
//     is a path within card.root; the body is that one subtree.
// Either way the levels come from the OFF-LOG `dirListing(root, path)` capability (content.ts, /api/ls),
// not node.text, so browsing is a channel-1 projection that never touches the durable log ("derived by
// default", §9); which rows are open is `treeState` — per-card, off-log, ephemeral. Every row DRAGS out
// to pin it as its own card (loader.materializeAt, in the right root) and a FOLDER/ROOT row also CLICKS to
// expand in place; the two coexist (a drag needs pointer movement, a click doesn't) and each gets a
// persistent affordance (twisty + ⠿ grip). So you navigate INSIDE the card and drag out only what you pin.
// A file/sub-folder row is also FOCUSABLE (click selects it): Enter opens an inline rename (which doubles as
// a move — typing a "/" reaches into a sub-folder), Shift+Delete deletes it off disk. Both are real fs ops
// (fsRename/fsDelete → /api/file/{rename,delete}); a rename additionally re-keys any pinned card so it
// survives in place (loader.renameFileNodes). ROOT rows take neither — a worktree/repo root isn't a target.
import { html } from "/vendor/lit-html.js";

// The drag payload mime — App.tsx's canvas drop handler reads the same key. The ROOT + path + kind is all
// the host needs to promote it (materializeAt in that root); the drop point sets the position.
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

// The PARENT folder of a root-relative path ("a/b/c" → "a/b", "a" → ""). Used to rebuild a renamed row's
// full path from the basename the user types — and a typed "/" lets that basename reach into a sub-folder
// of the same parent, so an inline rename doubles as a move-into-(new)-folder (rename ≡ move on disk).
function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function dragStart(e, root, path, kind) {
  e.dataTransfer.setData(MIME, JSON.stringify({ root, path, kind }));
  e.dataTransfer.effectAllowed = "copy";
}

// treeState key: a (root, path) pair — the combined card spans MULTIPLE roots, so a bare path would
// collide across them. NUL can't occur in a path, so it's an unambiguous separator (same scheme content.ts
// uses for its (root, path) caches).
const tkey = (root, path) => root + "\0" + path;

export default {
  contract: 1,
  render(card) {
    // dirListing is a CALLABLE keyed by (root, path): calling it subscribes the card to that folder (lazy
    // /api/ls), so an arriving listing re-renders just this body. treeState holds the open (root, path)
    // set — ephemeral, off-log. fsOpen is the double-click quick-open (FILE rows). roots is the board's
    // root list (combined mode's top level + each row's colour). All guarded for the headless mock.
    const ls = card.signals.dirListing;
    const ts = card.signals.treeState;
    const fsOpen = card.signals.fsOpen;
    const roots = card.signals.roots || [];
    // Which rows are open. `ts.get()` is undefined until the user has toggled anything (or a persisted
    // set loads) — a stored set (even an explicitly all-collapsed empty one) always wins. With NOTHING
    // stored, the COMBINED "roots" card defaults to its top-level roots expanded (one level): seed the
    // open-set with tkey(root.id, "") per root, computed here at render time because roots load async.
    // Single-root cards keep their empty default (no depth change). The first toggle persists a real set
    // via ts.set(), so the default stops applying the moment the user interacts.
    const stored = ts.get();
    const open =
      stored ?? (card.root === "roots" ? new Set(roots.map((r) => tkey(r.id, ""))) : new Set());
    const toggle = (k) => {
      const next = new Set(open);
      next.has(k) ? next.delete(k) : next.add(k);
      ts.set(next);
    };

    // Row keyboard (the mutating gestures). A row is FOCUSABLE (tabindex) — click it and the :focus ring is
    // the selection cue, exactly the sessions card's pattern. `es` is the ephemeral edit state ({ key, err }
    // — which row is mid-rename), `ren`/`del` the granted fs actions (absent → the gestures are inert).
    const es = card.signals.editState;
    const ren = card.signals.fsRename; // (root, from, to) → Promise<bool>
    const del = card.signals.fsDelete; // (root, path)     → Promise<bool>
    const edit = es && es.get ? es.get() : null;
    const editingKey = edit ? edit.key : null;

    // Selected row + Enter → open the inline rename input; Shift+Delete → delete. We stopPropagation on
    // EVERY Delete/Backspace in a focused row (contain it from the canvas's card-delete, as the live session
    // input does) and only ACT when Shift is held — a bare Delete must never bite a file off disk.
    const onRowKey = (e, root, path) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.stopPropagation();
        if (e.shiftKey && del) {
          e.preventDefault();
          del(root, path);
        }
        return;
      }
      if (e.key === "Enter" && es && ren) {
        e.preventDefault();
        e.stopPropagation();
        es.set({ key: tkey(root, path) });
      }
    };

    // The inline rename input's own keys: Enter commits (rebuild the full path from the typed basename),
    // Escape cancels. On a failed rename (e.g. the name is already taken → 409) we KEEP the input open and
    // surface the error rather than silently discarding the edit.
    const onRenameKey = (e, root, path) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        es.set(null);
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const raw = e.target.value.trim().replace(/^\/+|\/+$/g, "");
      if (!raw) return es.set(null); // emptied → treat as cancel
      const parent = parentOf(path);
      const next = parent ? parent + "/" + raw : raw;
      if (next === path || !ren) return es.set(null); // unchanged / no grant → cancel
      ren(root, path, next).then((ok) => {
        es.set(ok ? null : { key: tkey(root, path), err: "couldn’t rename — is that name already taken?" });
      });
    };

    // The editing variant of a row: the name swapped for a text input, no drag/click affordances (so a
    // grab or stray click doesn't fight the edit). data-interactive keeps the canvas pointer seam off it.
    const editRow = (root, path, depth, kind) => html`
      <div class="dir-row dir-editing" data-interactive="1" style="padding-left:${8 + depth * 14}px">
        <span class="dir-tw"></span>
        <span class="dir-glyph">${kind === "dir" ? "📁" : "📄"}</span>
        <input
          class="dir-rename"
          type="text"
          spellcheck="false"
          autofocus
          .value=${baseName(path)}
          @pointerdown=${(e) => e.stopPropagation()}
          @click=${(e) => e.stopPropagation()}
          @focus=${(e) => e.target.select()}
          @keydown=${(e) => onRenameKey(e, root, path)}
          @blur=${() => es && es.set(null)}
        />
        ${edit && edit.err ? html`<span class="dir-rename-err" title=${edit.err}>!</span>` : ""}
      </div>
    `;

    // One level of ONE root → an array of rows, recursing into expanded sub-folders. Indent grows with
    // depth. data-interactive contains the pointer seam so a grab drags the row OUT, not the whole card.
    const rowsFor = (root, dir, depth) => {
      const listing = ls(root, dir); // { dirs, files } | undefined while loading
      const pad = 8 + depth * 14;
      if (!listing) return [html`<div class="dir-empty" style="padding-left:${pad}px">loading…</div>`];
      const out = [];
      for (const d of listing.dirs) {
        const k = tkey(root, d);
        const isOpen = open.has(k);
        if (editingKey === k) out.push(editRow(root, d, depth, "dir"));
        else
          out.push(html`
            <div
              class="dir-row dir-sub"
              draggable="true"
              data-interactive="1"
              tabindex="0"
              title="click to ${isOpen ? "collapse" : "expand"} · drag onto the canvas to pin as its own card · Enter to rename · Shift+Delete to delete"
              style="padding-left:${pad}px"
              @click=${() => toggle(k)}
              @dragstart=${(e) => dragStart(e, root, d, "dir")}
              @keydown=${(e) => onRowKey(e, root, d)}
            >
              <span class="dir-tw">${isOpen ? "▾" : "▸"}</span>
              <span class="dir-glyph">${isOpen ? "📂" : "📁"}</span>
              <span class="dir-rowname">${baseName(d)}</span>
              <span class="dir-grip" aria-hidden="true">⠿</span>
            </div>
          `);
        if (isOpen) out.push(...rowsFor(root, d, depth + 1));
      }
      for (const f of listing.files) {
        const k = tkey(root, f);
        if (editingKey === k) {
          out.push(editRow(root, f, depth, "file"));
          continue;
        }
        out.push(html`
          <div
            class="dir-row"
            draggable="true"
            data-interactive="1"
            tabindex="0"
            title="double-click or drag onto the canvas to open as a card · Enter to rename · Shift+Delete to delete"
            style="padding-left:${pad}px"
            @dragstart=${(e) => dragStart(e, root, f, "file")}
            @keydown=${(e) => onRowKey(e, root, f)}
            @dblclick=${(e) => {
              e.preventDefault();
              e.stopPropagation();
              fsOpen && fsOpen(root, f, "file");
            }}
          >
            <span class="dir-tw"></span>
            <span class="dir-glyph">📄</span>
            <span class="dir-rowname">${baseName(f)}</span>
            ${ext(f) ? html`<span class="dir-ext">${ext(f)}</span>` : ""}
            <span class="dir-grip" aria-hidden="true">⠿</span>
          </div>
        `);
      }
      return out;
    };

    // COMBINED mode — top level is the roots, drilling into each in place. Reactive: reading `roots`
    // (a tracked signal) re-renders when a worktree appears/disappears. A root row drags out to a
    // single-root tree card of that worktree; expanding it shows its files without leaving this card.
    if (card.root === "roots") {
      return html`
        <div class="file-head">
          <span class="file-name">file tree</span>
          <span class="file-ext">${roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}` : ""}</span>
        </div>
        <div class="dir-body">
          ${roots.length === 0 ? html`<div class="dir-empty">loading…</div>` : ""}
          ${roots.map((r) => {
            const k = tkey(r.id, "");
            const isOpen = open.has(k);
            return html`
              <div
                class="dir-row dir-root-row"
                draggable="true"
                data-interactive="1"
                title="${r.name}${r.branch ? " · " + r.branch : ""} — click to expand · drag out for its own tree card"
                @click=${() => toggle(k)}
                @dragstart=${(e) => dragStart(e, r.id, "", "dir")}
              >
                <span class="dir-tw">${isOpen ? "▾" : "▸"}</span>
                <span class="dir-root-swatch" style="background:${r.hue}"></span>
                <span class="dir-rowname">${r.name}</span>
                ${r.branch ? html`<span class="dir-ext">${r.branch}</span>` : ""}
                <span class="dir-grip" aria-hidden="true">⠿</span>
              </div>
              ${isOpen ? rowsFor(r.id, "", 1) : ""}
            `;
          })}
        </div>
      `;
    }

    // SINGLE-ROOT mode — one subtree of card.root. At the root level (path "") the head shows the root's
    // NAME (worktree dir / repo name) + branch + colour swatch, so two worktrees of one repo read apart;
    // a sub-folder card shows the plain folder basename.
    const path = card.fields.title;
    const myRoot = roots.find((r) => r.id === card.root);
    const hue = myRoot?.hue;
    // TOMBSTONE (slice D): the folder was deleted on disk (`gone`) or its WORKTREE was removed (root no
    // longer in the loaded roots list). Keep the card, mark it — never leave it hanging on "loading…".
    const rootGone = roots.length > 0 && !myRoot;
    if (card.signals.gone || rootGone) {
      return html`
        <div class="file-head file-gone">
          <span class="file-name">${baseName(path) || card.root}/</span>
          <span class="file-ext">${rootGone ? "removed" : "deleted"}</span>
        </div>
        <div class="file-gone-body">
          <span class="file-gone-mark">🪦</span>
          <span>${rootGone ? "worktree removed" : "folder deleted on disk"}</span>
          <span class="file-gone-hint">${path ? path + "/ · " : ""}select + Delete to dismiss</span>
        </div>
      `;
    }
    const rootListing = ls(card.root, path);
    const count = rootListing ? rootListing.dirs.length + rootListing.files.length : 0;
    const isRootLevel = !path;
    const label = isRootLevel ? (myRoot?.name ?? "repo") : baseName(path) || "repo";
    return html`
      <div class="file-head">
        ${hue ? html`<span class="dir-root-swatch" style="background:${hue}" title=${myRoot.name}></span>` : ""}
        <span class="file-name">${label}/</span>
        <span class="file-ext">${isRootLevel && myRoot?.branch ? myRoot.branch : "tree"}</span>
      </div>
      ${path ? html`<div class="file-dir">${path}/ · ${count} item${count === 1 ? "" : "s"}</div>` : ""}
      <div class="dir-body">
        ${!rootListing ? html`<div class="dir-empty">loading…</div>` : ""}
        ${rootListing && count === 0 ? html`<div class="dir-empty">empty folder</div>` : ""}
        ${rowsFor(card.root, path, 0)}
      </div>
    `;
  },
};
