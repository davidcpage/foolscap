// card-types/image/render.js — the image card's interior as a runtime-loaded template
// (image-cards-on-canvas). A binary sibling of the file card: where that card projects an off-log TEXT
// signal (fileContent) into a <pre>/markdown body, this one points an <img> straight at the raw bytes on
// disk — GET /api/asset?root&path streams them with a mime'd Content-Type. The (root, path) addressing is
// identical to a file card (card.root + card.fields.title, the same node-id encoding); only the transport
// differs, because text can't carry a PNG. EMPTY capability grant: everything shown comes off the node
// record + card.root, no signals, no codec — the pure-FIELDS contract the plain note also holds.
import { html } from "/vendor/lit-html.js";

function splitPath(p) {
  const slash = p.lastIndexOf("/");
  return { base: slash >= 0 ? p.slice(slash + 1) : p, dir: slash >= 0 ? p.slice(0, slash) : "" };
}

export default {
  contract: 1,
  render(card) {
    const path = card.fields.title;
    const { base } = splitPath(path);
    // The raw-bytes URL, mirroring the file card's (root, path) but on the binary endpoint. Encoded so a
    // path with spaces/odd chars resolves; root is a colon-free slug so it needs no encoding, but be safe.
    const src = `/api/asset?root=${encodeURIComponent(card.root)}&path=${encodeURIComponent(path)}`;
    // Minimal frame: no persistent header — the image IS the card, filling it edge-to-edge inside the
    // card's rounded clip. The card opens at the image's own aspect (loader.fitImageBox) and resize is
    // aspect-locked (type.yaml `aspect: auto`), so contain-fit never letterboxes. The filename returns as
    // a hover-only caption so the card stays legible without spending chrome on it at rest.
    return html`
      <div class="image-body">
        <img
          src=${src}
          alt=${base}
          draggable="false"
          @error=${(e) => e.target.closest(".image-body")?.classList.add("image-broken")}
        />
        <figcaption class="image-cap">${base}</figcaption>
        <div class="image-gone">
          <span class="image-gone-mark">🖼️</span>
          <span>image unavailable</span>
          <span class="file-gone-hint">${path}</span>
        </div>
      </div>
    `;
  },
};
