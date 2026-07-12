// card-types/role/render.js — the role EDIT card (agent-roles.md phase 2b). A structured editor over one
// role's `.canvas/roles/<roleId>/role.md`: the host parses the file with the shared role-format codec and
// hands this card a `roleDoc` ({roleId, name, colour, charter}); edits go back through `roleSave`, which the
// host re-serialises with the SAME codec + writes to disk. The card stays a pure view — it never imports the
// codec (templates may touch only /vendor/), exactly like the sessions/channels list cards take parsed data.
//
// NAME is READ-ONLY in v1: a role's id is its name's slug, so renaming would desync the id and orphan
// already-spawned cards' @-tags (agreed with the backend). COLOUR + CHARTER are editable. Colour clicks save
// at once; the charter saves on blur / the Save button (no-op guarded, like the notebook card's commit).
import { html } from "/vendor/lit-html.js";
import { renderMd } from "/vendor/markdown.js";

// The note palette, hardcoded (a template can't import core's NOTE_COLORS) — the same keys the sticky card
// uses, so the swatch row matches the rest of the board.
const COLOURS = ["yellow", "pink", "blue", "green", "orange", "purple"];

const charterEl = (root) => root?.querySelector("textarea.role-charter") ?? null;

export default {
  contract: 1,
  render(card) {
    // roleDoc is the parsed role.md ({roleId, name, colour, charter}) or undefined while the first file read
    // is in flight. Reading it subscribes the card to the underlying file signal — an external edit (or our
    // own save) re-renders. roleSave is the serialize-back action (absent → a read-only mount, e.g. headless).
    const doc = card.signals.roleDoc;
    const save = card.signals.roleSave;
    const canEdit = Boolean(save);
    // The charter is markdown PROSE, so it renders formatted by default (the shared /vendor/markdown.js codec,
    // the same one the file / session / notebook cards use) and only flips to a raw <textarea> when the user
    // clicks edit — the notebook card's prose-by-default / click-to-edit split. `editing` is per-card ephemeral
    // view state (treeState): never logged, gone on reload. A read-only mount (no save) can never edit, so it
    // always shows formatted prose — which was the whole bug: the charter used to be a bare textarea.
    const editState = card.signals.treeState;
    const editing = canEdit && editState?.get() === true;

    if (!doc) return html`<div class="role-card"><div class="dir-empty">loading…</div></div>`;

    // Save the whole doc with one field changed, guarding no-op writes (so a stray blur / re-save doesn't
    // churn the file + watcher). Colour clicks pass the new colour + the LIVE charter from the textarea (so a
    // colour change never discards unsaved charter text); the charter save reuses doc.colour (colour clicks
    // commit immediately, so doc.colour is already current).
    const liveCharter = (root) => charterEl(root)?.value ?? doc.charter ?? "";
    const same = (a, b) => (a ?? "") === (b ?? "");
    // loops/model aren't edited here but MUST ride every save — omitting them would strip those
    // frontmatter lines from the role.md on the next colour/charter save.
    const pickColour = (root, colour) => {
      if (!save || same(colour, doc.colour)) return;
      save({ roleId: doc.roleId, name: doc.name, colour, loops: doc.loops, model: doc.model, charter: liveCharter(root) });
    };
    const saveCharter = (root) => {
      if (!save) return;
      const charter = liveCharter(root);
      if (same(charter.trim(), (doc.charter ?? "").trim())) return; // no-op guard
      save({ roleId: doc.roleId, name: doc.name, colour: doc.colour ?? null, loops: doc.loops, model: doc.model, charter });
    };
    // Save (if changed) and drop back to the formatted-prose view. Reads the textarea before it's unmounted,
    // so the toggle click never discards an in-progress edit.
    const saveAndClose = (root) => {
      saveCharter(root);
      editState?.set(false);
    };

    return html`
      <div class="role-card">
        <div class="role-head">
          <span class="role-swatch role-head-swatch c-${doc.colour || "blue"}"></span>
          <span class="role-name" title=${`role id: ${doc.roleId} · name is fixed (rename is a later story)`}>${doc.name}</span>
          ${canEdit
            ? editing
              ? html`<button
                  class="role-save"
                  type="button"
                  title="save the charter and return to the formatted view"
                  @mousedown=${(e) => e.preventDefault()}
                  @click=${(e) => saveAndClose(e.currentTarget.closest(".role-card"))}
                >done</button>`
              : html`<button
                  class="role-save"
                  type="button"
                  title="edit the charter markdown"
                  @mousedown=${(e) => e.preventDefault()}
                  @click=${() => editState?.set(true)}
                >edit</button>`
            : ""}
        </div>

        ${canEdit && editing
          ? html`<div class="role-swatch-row" title="role colour">
              ${COLOURS.map(
                (c) => html`<button
                  class="role-swatch c-${c}${same(c, doc.colour) ? " selected" : ""}"
                  type="button"
                  data-colour=${c}
                  title=${c}
                  @click=${(e) => pickColour(e.currentTarget.closest(".role-card"), c)}
                ></button>`,
              )}
            </div>`
          : ""}

        <div class="role-charter-label">charter</div>
        ${editing
          ? html`<textarea
              class="role-charter"
              data-interactive="1"
              placeholder="Describe this role — the charter is appended to a session's prompt when it's launched as this role."
              .value=${doc.charter ?? ""}
              @keydown=${(e) => e.stopPropagation()}
              @blur=${(e) => saveCharter(e.currentTarget.closest(".role-card"))}
            ></textarea>`
          : doc.charter?.trim()
            ? html`<div class="role-charter role-charter-view md-prose" data-text>${renderMd(doc.charter)}</div>`
            : html`<div class="role-charter role-charter-view role-charter-empty">${canEdit ? "No charter yet — click edit to describe this role." : "No charter."}</div>`}
      </div>
    `;
  },
};
