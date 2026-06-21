// card-types/sticky/render.js — a sticky note for brief memos and todo lists. The first EDITABLE
// card: where note/file/session render their fields read-only, this one takes typed input and
// commits it back to the node's own record through two granted WRITE capabilities —
// card.signals.setTitle (the header) and card.signals.setText (the body). Each commit lands on the
// intent log as actor "user": undoable with ⌘Z, badged with provenance, persisted to IndexedDB like
// every other card's spatial state. That IS the storage for now — the record's title/text fields.
// (A markdown-file backing would later be a codec over a file-backed body, the file card's
// disk-projection pattern made writable; not needed to take and keep a memo.)
//
// The editing model is one-gesture-per-edit, matching the channel-3 discipline: you focus, type
// freely against the browser's own input state (no commit, so no re-render interrupts you), and the
// single commit fires on BLUR (or Enter, for the one-line title) — one IntentEvent per editing pass,
// not one per keystroke. Reading card.fields in render is what subscribes this card to its record,
// so an agent's setText (or your undo) re-renders exactly this interior.
import { html, nothing } from "/vendor/lit-html.js";

// The note palette, kept in sync with NOTE_COLORS in core/src/records.ts (templates can't import core).
// Each swatch commits card.signals.setColor(c); the host re-themes the box via its c-<color> class, so
// there's no extra wiring here — recolouring the record recolours the card.
const NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange", "purple"];

// Commit `value` through the granted capability, but only if it actually changed — a blur with no
// edit must not push a no-op event onto the log. `commit` is the bound per-card action (setText /
// setTitle); absent (e.g. a misconfigured grant) we simply render read-only rather than throw.
function commitIfChanged(commit, current, value) {
  if (commit && value !== current) commit(value);
}

export default {
  contract: 1,
  render(card) {
    const title = card.fields.title;
    const text = card.fields.text;
    const color = card.fields.color;
    const setTitle = card.signals.setTitle;
    const setText = card.signals.setText;
    const setColor = card.signals.setColor;

    return html`
      <div class="sticky-head">
        <input
          class="sticky-title"
          type="text"
          .value=${title}
          placeholder="memo…"
          ?readonly=${!setTitle}
          @keydown=${(e) => {
            // Keep canvas shortcuts (⌫ deletes the card, v/h switch tools) from firing mid-edit — the
            // same stopPropagation the session input uses on the interior-interaction seam. Enter
            // commits the one-line title and drops focus rather than inserting a newline.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          @blur=${(e) => commitIfChanged(setTitle, title, e.currentTarget.value)}
        />
        ${
          // The colour swatches — one per NOTE_COLORS, each committing setColor(c); the host re-themes
          // the box from the new record. Same read-only fallback as title/body: without the grant the
          // row is hidden (nothing to commit through). Buttons work via the interior-interaction seam.
          setColor
            ? html`<div class="sticky-swatch-row">
                ${NOTE_COLORS.map(
                  (c) => html`<button
                    class="sticky-swatch c-${c} ${c === color ? "selected" : ""}"
                    type="button"
                    title=${c}
                    aria-label=${c}
                    aria-pressed=${c === color}
                    @click=${() => commitIfChanged(setColor, color, c)}
                  ></button>`,
                )}
              </div>`
            : nothing
        }
      </div>
      <textarea
        class="sticky-body"
        .value=${text}
        placeholder="brief memo or todo list…&#10;- [ ] a thing to do"
        ?readonly=${!setText}
        @keydown=${(e) => e.stopPropagation()}
        @blur=${(e) => commitIfChanged(setText, text, e.currentTarget.value)}
      ></textarea>
    `;
  },
};
