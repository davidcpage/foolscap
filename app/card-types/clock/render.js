// card-types/clock/render.js — the clock card's interior as a runtime-loaded template
// (card-types-as-data.md §7). This module is the v1 contract in full: import the vendored
// substrate, export { contract, render }. It receives `card` — capability handles, nothing
// ambient — and returns a lit-html template. Reading card.signals.now inside render is what
// subscribes the card to the tick; the template never sees the store, the editor, x/y/w/h,
// or the DOM outside the interior the host hands it. A tick re-renders this and commits nothing.
import { html, svg } from "/vendor/lit-html.js";

// Time → the three hand rotations (degrees, 0 = straight up). Minutes/hours carry the fractional
// sweep so the hour hand sits between marks. Recomputed each tick, stored nowhere.
function handAngles(ms) {
  const d = new Date(ms);
  const s = d.getSeconds();
  const m = d.getMinutes() + s / 60;
  const h = (d.getHours() % 12) + m / 60;
  return { hour: h * 30, minute: m * 6, second: s * 6 };
}

export default {
  contract: 1,
  render(card) {
    const now = card.signals.now;
    const { hour, minute, second } = handAngles(now);
    return html`
      <svg class="clock-face" viewBox="0 0 100 100">
        <circle class="clock-rim" cx="50" cy="50" r="46" />
        ${Array.from(
          { length: 12 },
          (_, i) =>
            svg`<line class="clock-tick" x1="50" y1="8" x2="50" y2=${i % 3 === 0 ? 15 : 12}
                      transform="rotate(${i * 30} 50 50)" />`,
        )}
        <line class="clock-hand hour" x1="50" y1="50" x2="50" y2="28" transform="rotate(${hour} 50 50)" />
        <line class="clock-hand minute" x1="50" y1="50" x2="50" y2="16" transform="rotate(${minute} 50 50)" />
        <line class="clock-hand second" x1="50" y1="56" x2="50" y2="12" transform="rotate(${second} 50 50)" />
        <circle class="clock-pin" cx="50" cy="50" r="2.4" />
      </svg>
    `;
  },
};
