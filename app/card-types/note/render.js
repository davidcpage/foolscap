// card-types/note/render.js — the plain note's interior as a runtime-loaded template
// (card-types-as-data.md §7, second card). The pure-FIELDS exercise: everything shown comes off
// the node record through card.fields — no off-log signals, no codec. Reading fields inside
// render is what subscribes the card to its record, so an agent's setText re-renders exactly
// this interior. The actor badge naming who touched the card is HOST chrome (provenance about
// the card, not card content) — it never enters this module's world.
import { html } from "/vendor/lit-html.js";

export default {
  contract: 1,
  render(card) {
    return html`
      <div class="file-head">
        <span class="file-name">${card.fields.title}</span>
      </div>
      <div class="note-body" data-text>${card.fields.text}</div>
    `;
  },
};
