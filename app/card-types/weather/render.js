// card-types/weather/render.js — current local weather for a typed location, as a runtime-loaded
// template (card-types-as-data.md §7). Like the clock and the usage card it renders an OFF-LOG read
// (no commit, no log, no persistence — the clock rule): the location is this card's title, and
// card.signals.weather(title) resolves it through the host's server-side Open-Meteo poll (weather.ts /
// /api/weather). The interior never fetches the internet itself — it imports only lit-html and reads
// the granted capability. Reading card.fields.title subscribes the card to its own record (so an edit
// or undo re-renders it) and calling weather(title) subscribes it to that location's feed (so a refresh
// re-renders just this card). The one WRITE is setTitle: the header input commits the location like the
// sticky card's title, one IntentEvent on blur/Enter.
import { html } from "/vendor/lit-html.js";

// WMO weather-code → an emoji glyph + a short label. Day/night swaps the clear-sky glyph. The codes are
// Open-Meteo's documented set, collapsed to the families a glance needs (clear, cloud, fog, drizzle,
// rain, snow, showers, storm) rather than every numeric variant.
function describe(code, isDay) {
  const c = Number(code);
  if (c === 0) return { icon: isDay ? "☀️" : "🌙", label: "Clear sky" };
  if (c === 1) return { icon: isDay ? "🌤️" : "🌙", label: "Mainly clear" };
  if (c === 2) return { icon: isDay ? "⛅" : "☁️", label: "Partly cloudy" };
  if (c === 3) return { icon: "☁️", label: "Overcast" };
  if (c === 45 || c === 48) return { icon: "🌫️", label: "Fog" };
  if (c >= 51 && c <= 57) return { icon: "🌦️", label: "Drizzle" };
  if (c >= 61 && c <= 67) return { icon: "🌧️", label: "Rain" };
  if (c >= 71 && c <= 77) return { icon: "🌨️", label: "Snow" };
  if (c >= 80 && c <= 82) return { icon: "🌦️", label: "Rain showers" };
  if (c === 85 || c === 86) return { icon: "🌨️", label: "Snow showers" };
  if (c === 95) return { icon: "⛈️", label: "Thunderstorm" };
  if (c === 96 || c === 99) return { icon: "⛈️", label: "Thunderstorm, hail" };
  return { icon: "🌡️", label: "—" };
}

// Inline styles only, so the whole card-type stays additive (the usage card's pattern): dark zinc ink on
// the app's LIGHT paper card. Kept as named constants so the small palette reads once.
const INK = "#27272a";
const MUTE = "#52525b";
const FAINT = "#71717a";

const round = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : "—");

// One label/value line in the detail stack (feels like / humidity / wind).
function statRow(label, value) {
  return html`
    <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:1.6;">
      <span style="color:${MUTE};">${label}</span>
      <span style="color:${INK};font-variant-numeric:tabular-nums;">${value}</span>
    </div>
  `;
}

// The body beneath the location header: the prompt (empty title), the loading beat, the resolve/offline
// states, or the conditions panel. Never throws for a missing/partial value — the headless mount and the
// pre-fetch beat both pass `data === undefined`.
function body(query, data) {
  if (!query.trim())
    return html`<div style="color:${FAINT};font-size:12px;line-height:1.5;">
      Type a city or place in the field above — e.g. “London” or “Paris, France” — to see its current weather.
    </div>`;
  if (!data) return html`<div style="color:${FAINT};font-size:12px;">Loading ${query}…</div>`;

  if (!data.resolved) {
    const msg =
      data.error === "not-found"
        ? html`Couldn't find “${query}”. Try a city name, or “City, Country”.`
        : data.error === "offline"
          ? html`Offline — couldn't reach the weather service. Retrying…`
          : html`No weather for “${query}”.`;
    return html`<div style="color:${FAINT};font-size:12px;line-height:1.5;">${msg}</div>`;
  }

  const cur = data.current ?? {};
  const { icon, label } = describe(cur.weatherCode, cur.isDay);
  const place = [data.name, data.admin1, data.country].filter(Boolean).join(", ");
  const tUnit = data.units?.temperature ?? "°C";
  const wUnit = data.units?.windSpeed ?? "km/h";

  return html`
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="font-size:46px;line-height:1;">${icon}</div>
      <div>
        <div style="font-size:34px;font-weight:600;color:${INK};font-variant-numeric:tabular-nums;line-height:1.05;">
          ${round(cur.temperature)}${tUnit}
        </div>
        <div style="font-size:12px;color:${MUTE};">${label}</div>
      </div>
    </div>
    <div style="font-size:11px;color:${FAINT};">${place}</div>
    <div style="display:flex;flex-direction:column;gap:2px;margin-top:2px;">
      ${statRow("Feels like", `${round(cur.apparentTemperature)}${tUnit}`)}
      ${statRow("Humidity", `${round(cur.humidity)}%`)}
      ${statRow("Wind", `${round(cur.windSpeed)} ${wUnit}`)}
    </div>
    ${data.error === "offline"
      ? html`<div style="font-size:10px;color:#b45309;">stale · offline</div>`
      : ""}
    <div style="margin-top:auto;font-size:9px;color:#a1a1aa;">Open-Meteo · refreshes every 10 min</div>
  `;
}

export default {
  contract: 1,
  render(card) {
    const query = card.fields.title;
    const setTitle = card.signals.setTitle;
    // Only subscribe to a location's feed once there's something to look up — an empty card shows the
    // hint and starts no poll.
    const data = query.trim() ? card.signals.weather(query) : undefined;

    return html`
      <div
        style="padding:12px;font:13px/1.45 ui-sans-serif,system-ui;color:${INK};height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;overflow:auto;"
      >
        <input
          class="weather-loc"
          type="text"
          .value=${query}
          placeholder="city or place…"
          ?readonly=${!setTitle}
          style="font:600 13px/1 ui-sans-serif,system-ui;color:${INK};border:none;border-bottom:1px solid #d4d4d8;background:transparent;padding:2px 0 7px;outline:none;width:100%;box-sizing:border-box;"
          @keydown=${(e) => {
            // Keep canvas shortcuts (⌫ deletes the card, v/h switch tools) from firing mid-edit — the
            // same stopPropagation the sticky/session inputs use on the interior-interaction seam. Enter
            // commits the one-line location and drops focus.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          @blur=${(e) => {
            const v = e.currentTarget.value;
            if (setTitle && v !== query) setTitle(v); // commit only a real change — no no-op event on the log
          }}
        />
        ${body(query, data)}
      </div>
    `;
  },
};
