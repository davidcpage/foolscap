// card-types/git-log/render.js — a live DATA-FEED TIMELINE, as a runtime-loaded template
// (card-types-as-data.md §7). Like the weather card it renders an OFF-LOG read keyed by its TITLE: the title
// is a `data:*` feed name, and card.signals.dataFeed(title) resolves it through the host's generic feed
// capability (templates.ts → server-data-feeds.ts). The interior never fetches anything itself — it imports
// only lit-html and reads the granted capability. Reading card.fields.title subscribes the card to its own
// record (an edit / undo re-renders it) and calling dataFeed(title) subscribes it to that feed (a publish
// re-renders just this card). The one WRITE is setTitle: the header input commits the feed name like the
// weather card's location.
//
// The feed VALUE is { name, events:[{ts,data}], truncated, updatedAt } — events chronological (oldest→
// newest), the byte-bounded TAIL; we render them NEWEST-FIRST. A commit-shaped event (data carries a `sha`,
// from the git-log source) gets a rich commit row; any other event renders generically, so one card serves
// both the git-log feed and an arbitrary `POST /api/feed/data:*` producer.
import { html } from "/vendor/lit-html.js";

const INK = "#27272a";
const MUTE = "#52525b";
const FAINT = "#71717a";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

// Coarse, friendly "how long ago" — the timeline's per-row meta (feeds.ts's timeAgo, inlined so the
// template keeps its lit-html-only import). Guards a missing/NaN ts (a malformed event) to "".
function timeAgo(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// A compact one-line rendering of a non-commit event's payload — a string as-is, an object's `message`/
// `text`/`title` if it has one, else its JSON. Never throws for a circular/odd value.
function summarize(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const d = data;
    if (typeof d.message === "string") return d.message;
    if (typeof d.text === "string") return d.text;
    if (typeof d.title === "string") return d.title;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

// One commit row: short sha (mono chip) + subject, with author · age beneath.
function commitRow(ev) {
  const d = ev.data ?? {};
  return html`
    <div class="gl-row gl-commit">
      <div class="gl-line">
        <span class="gl-sha">${d.shortSha ?? (d.sha ? String(d.sha).slice(0, 7) : "")}</span>
        <span class="gl-msg" style="color:${INK};">${d.message ?? ""}</span>
      </div>
      <div class="gl-meta" style="color:${FAINT};">${[d.author, timeAgo(ev.ts)].filter(Boolean).join(" · ")}</div>
    </div>
  `;
}

// One generic event row: the age + a compact payload summary (an agent/script producer's stream).
function eventRow(ev) {
  return html`
    <div class="gl-row">
      <div class="gl-msg" style="color:${INK};">${summarize(ev.data)}</div>
      <div class="gl-meta" style="color:${FAINT};">${timeAgo(ev.ts)}</div>
    </div>
  `;
}

// The body beneath the header: the prompt (non-data title), the loading beat, the empty feed, or the
// newest-first timeline with a truncation note. Never throws on a missing/partial value (headless + the
// pre-publish beat both pass `value === undefined`).
function body(name, value) {
  if (!name.trim())
    return html`<div style="color:${FAINT};font-size:12px;line-height:1.5;">
      Type a <code>data:*</code> feed name above — e.g. <code>data:git-log</code> for this repo's commits, or
      <code>data:demo</code> for a feed you publish with <code>POST /api/feed/data:demo</code>.
    </div>`;
  if (!name.startsWith("data:"))
    return html`<div style="color:${FAINT};font-size:12px;line-height:1.5;">
      “${name}” isn't a <code>data:*</code> feed. Only the <code>data:</code> namespace is readable here.
    </div>`;
  if (!value) return html`<div style="color:${FAINT};font-size:12px;">Waiting for ${name}…</div>`;

  const events = Array.isArray(value.events) ? value.events : [];
  if (!events.length)
    return html`<div style="color:${FAINT};font-size:12px;">No events on ${name} yet.</div>`;

  // newest-first: the tail is oldest→newest, so iterate reversed.
  const rows = [...events].reverse().map((ev) => (ev?.data && ev.data.sha ? commitRow(ev) : eventRow(ev)));
  return html`
    <div class="gl-list" data-autoscroll style="display:flex;flex-direction:column;gap:8px;overflow:auto;flex:1;min-height:0;">
      ${value.truncated
        ? html`<div class="gl-trunc" style="color:${MUTE};font-size:10px;">· older history truncated ·</div>`
        : ""}
      ${rows}
    </div>
  `;
}

export default {
  contract: 1,
  render(card) {
    const name = card.fields.title;
    const setTitle = card.signals.setTitle;
    // Only subscribe to a feed once the title names one — a non-data title shows the hint and reads nothing.
    const value = name.trim() && name.startsWith("data:") ? card.signals.dataFeed(name) : undefined;
    const count = value && Array.isArray(value.events) ? value.events.length : 0;

    return html`
      <div
        style="padding:12px;font:13px/1.45 ui-sans-serif,system-ui;color:${INK};height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;overflow:hidden;"
      >
        <div style="display:flex;align-items:baseline;gap:8px;">
          <input
            class="gl-name"
            type="text"
            .value=${name}
            placeholder="data:git-log"
            ?readonly=${!setTitle}
            style="font:600 12px/1 ${MONO};color:${INK};border:none;border-bottom:1px solid #d4d4d8;background:transparent;padding:2px 0 6px;outline:none;flex:1;min-width:0;box-sizing:border-box;"
            @keydown=${(e) => {
              // Keep canvas shortcuts (⌫ deletes the card, v/h switch tools) from firing mid-edit — the
              // stopPropagation the weather/sticky inputs use on the interior seam. Enter commits + blurs.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            @blur=${(e) => {
              const v = e.currentTarget.value;
              if (setTitle && v !== name) setTitle(v); // commit only a real change — no no-op event on the log
            }}
          />
          ${count ? html`<span style="font-size:10px;color:${FAINT};">${count}</span>` : ""}
        </div>
        ${body(name, value)}
      </div>
    `;
  },
};
