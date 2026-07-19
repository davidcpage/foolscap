// card-types/git-stats/render.js — a live CODE-GROWTH + CHURN visualization, as a runtime-loaded template
// (card-types-as-data.md §7, Github-feed thread work item 2). Its TITLE is a `data:*` feed name and it reads
// that feed's FULL-history disk mirror through the host's `dataFeedHistory` capability (templates.ts →
// .canvas/feeds/<name>.json, written by startGitStatsFeed). The interior fetches nothing itself — it imports
// only lit-html and reads the granted capability; reading card.fields.title subscribes the card to its own
// record and calling dataFeedHistory(title) subscribes it to the mirror file, so a fresh commit (which
// re-derives + rewrites the mirror) re-renders just this card. The one WRITE is setTitle (the header input).
//
// The series shape (server-data-feeds.ts deriveGitStats): { name, updatedAt, totals:{commits,adds,dels,net,
// files}, dirs:[topLevelDir…("other")], growth:{ t:[ms…], cum:[[netLOC per dir]…] }, commits:[{s,a,d,t}…],
// churn:[{p,a,d,c}…], downsampled, truncated }. Charts are hand-rolled SVG (no chart lib vendored). Every
// draw guards a missing/partial series (headless + the pre-publish beat both pass `undefined`).
import { html, svg } from "/vendor/lit-html.js";

const INK = "#27272a";
const MUTE = "#52525b";
const FAINT = "#71717a";
const ADD = "#16a34a";
const DEL = "#dc2626";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

// A stable, readable categorical palette for the stacked directories (brand-neutral). Cycles if a repo has
// more kept dirs than colours — the trailing "other" bucket then just reuses one, harmless for a rollup.
const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#dc2626", "#65a30d", "#db2777", "#57534e"];
const colorFor = (i) => PALETTE[i % PALETTE.length];

// Compact integer: 83747 → "83.7k", 1200000 → "1.2M". Keeps the totals line + axis labels short.
function kfmt(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}

// The stacked-area LOC-growth chart: cumulative NET LOC by top-level dir over the commit timeline. One filled
// band per dir, stacked; negatives are floored to 0 so the stack stays monotone (a dir that net-shrinks just
// reads as a thinning band). Pure SVG with a viewBox so it scales to the card width.
function growthChart(series) {
  const dirs = Array.isArray(series.dirs) ? series.dirs : [];
  const t = series.growth && Array.isArray(series.growth.t) ? series.growth.t : [];
  const cum = series.growth && Array.isArray(series.growth.cum) ? series.growth.cum : [];
  const n = Math.min(t.length, cum.length);
  if (!dirs.length || n < 2)
    return html`<div style="color:${FAINT};font-size:11px;">Not enough history to chart growth yet.</div>`;

  const W = 300;
  const H = 130;
  const PAD_L = 4;
  const PAD_R = 4;
  const PAD_T = 6;
  const PAD_B = 4;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // Stacked totals per sample → the y-scale top; x by sample index (time is roughly monotone, index reads clean).
  const at = (i, d) => Math.max(0, Number(cum[i]?.[d]) || 0);
  let maxTotal = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < dirs.length; d++) s += at(i, d);
    if (s > maxTotal) maxTotal = s;
  }
  if (maxTotal <= 0) maxTotal = 1;
  const x = (i) => PAD_L + (plotW * i) / (n - 1);
  const y = (v) => PAD_T + plotH - (plotH * v) / maxTotal;

  // Build one closed polygon per dir from its lower boundary (sum below) to its upper boundary (sum incl. self).
  const bands = [];
  const lower = new Array(n).fill(0); // running baseline as we stack upward
  for (let d = 0; d < dirs.length; d++) {
    const upPts = [];
    const downPts = [];
    for (let i = 0; i < n; i++) {
      const base = lower[i];
      const top = base + at(i, d);
      upPts.push(`${x(i).toFixed(1)},${y(top).toFixed(1)}`);
      downPts.push(`${x(i).toFixed(1)},${y(base).toFixed(1)}`);
      lower[i] = top;
    }
    downPts.reverse();
    // Each band is a SEPARATELY-tagged fragment placed inside the outer <svg> via a child part, so it MUST
    // use the `svg` tag: lit-html parses a bare `html` fragment through innerHTML in the HTML namespace,
    // making the <polygon> an HTMLUnknownElement that SVG never paints. `svg` wraps it in <svg> first, so
    // the node is born SVG-namespaced. (The outer template's LITERAL <svg> is fine — the HTML parser enters
    // foreign-content mode for it; only nested separately-tagged fragments need the explicit svg tag.)
    bands.push(svg`<polygon
      points=${[...upPts, ...downPts].join(" ")}
      fill=${colorFor(d)}
      fill-opacity="0.85"
      stroke=${colorFor(d)}
      stroke-width="0.5"
    />`);
  }

  return html`
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:130px;display:block;">
      ${bands}
    </svg>
    <div style="display:flex;justify-content:space-between;color:${FAINT};font-size:9px;margin-top:2px;">
      <span>${new Date(t[0]).toLocaleDateString()}</span>
      <span>peak ${kfmt(maxTotal)} net LOC</span>
      <span>${new Date(t[n - 1]).toLocaleDateString()}</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:6px;">
      ${dirs.map(
        (d, i) => html`<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:${MUTE};">
          <span style="width:9px;height:9px;border-radius:2px;background:${colorFor(i)};"></span>${d}
        </span>`,
      )}
    </div>
  `;
}

// The churn view: top files by total (adds+dels) as horizontal split bars (green adds / red dels), each
// scaled to the busiest file. Shows a leading slice; the region scrolls for the rest.
function churnList(series) {
  const churn = Array.isArray(series.churn) ? series.churn : [];
  if (!churn.length) return html`<div style="color:${FAINT};font-size:11px;">No file churn recorded.</div>`;
  const max = churn[0].c || 1;
  const short = (p) => (p.length > 42 ? "…" + p.slice(-41) : p);
  return html`
    <div style="display:flex;flex-direction:column;gap:5px;">
      ${churn.map((f) => {
        const aw = (100 * (Number(f.a) || 0)) / max;
        const dw = (100 * (Number(f.d) || 0)) / max;
        return html`<div>
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:10px;color:${MUTE};">
            <span style="font-family:${MONO};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${f.p}
              >${short(String(f.p))}</span
            >
            <span style="flex:none;"><span style="color:${ADD};">+${kfmt(f.a)}</span> <span style="color:${DEL};">−${kfmt(f.d)}</span></span>
          </div>
          <div style="display:flex;height:5px;border-radius:3px;overflow:hidden;background:#f4f4f5;">
            <span style="width:${aw.toFixed(1)}%;background:${ADD};"></span>
            <span style="width:${dw.toFixed(1)}%;background:${DEL};"></span>
          </div>
        </div>`;
      })}
    </div>
  `;
}

// The body beneath the header: the prompt (non-data title), the loading beat, or the charts + totals. Never
// throws on a missing/partial value (headless + the pre-publish beat both pass `series === undefined`).
function body(name, series) {
  if (!name.trim())
    return html`<div style="color:${FAINT};font-size:12px;line-height:1.5;">
      Type a <code>data:*</code> feed name above — e.g. <code>data:git-stats</code> for this repo's code growth
      &amp; churn (published by the git-stats source).
    </div>`;
  if (!name.startsWith("data:"))
    return html`<div style="color:${FAINT};font-size:12px;line-height:1.5;">
      “${name}” isn't a <code>data:*</code> feed. Only the <code>data:</code> namespace is readable here.
    </div>`;
  if (!series || typeof series !== "object")
    return html`<div style="color:${FAINT};font-size:12px;">Waiting for ${name}…</div>`;

  const tot = series.totals || {};
  return html`
    <div class="gs-scroll" data-autoscroll style="display:flex;flex-direction:column;gap:12px;overflow:auto;flex:1;min-height:0;">
      <div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:${MUTE};">
        <span><strong style="color:${INK};">${kfmt(tot.commits)}</strong> commits</span>
        <span><strong style="color:${INK};">${kfmt(tot.files)}</strong> files</span>
        <span style="color:${ADD};">+${kfmt(tot.adds)}</span>
        <span style="color:${DEL};">−${kfmt(tot.dels)}</span>
        <span><strong style="color:${INK};">${kfmt(tot.net)}</strong> net LOC</span>
      </div>

      <div>
        <div style="font-size:10px;font-weight:600;color:${FAINT};text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">
          Code growth by directory
        </div>
        ${growthChart(series)}
      </div>

      <div>
        <div style="font-size:10px;font-weight:600;color:${FAINT};text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">
          Top file churn
        </div>
        ${churnList(series)}
      </div>

      ${series.downsampled || series.truncated
        ? html`<div style="color:${FAINT};font-size:9px;">
            ${series.downsampled ? "· timeline downsampled to fit ·" : ""}
            ${series.truncated ? "· smaller dirs rolled into “other” / file list capped ·" : ""}
          </div>`
        : ""}
    </div>
  `;
}

export default {
  contract: 1,
  render(card) {
    const name = card.fields.title;
    const setTitle = card.signals.setTitle;
    // Only read a feed once the title names a data:* one — a non-data title shows the hint and reads nothing.
    const series = name.trim() && name.startsWith("data:") ? card.signals.dataFeedHistory(name) : undefined;

    return html`
      <div
        style="padding:12px;font:13px/1.45 ui-sans-serif,system-ui;color:${INK};height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;overflow:hidden;"
      >
        <div style="display:flex;align-items:baseline;gap:8px;">
          <input
            class="gs-name"
            type="text"
            .value=${name}
            placeholder="data:git-stats"
            ?readonly=${!setTitle}
            style="font:600 12px/1 ${MONO};color:${INK};border:none;border-bottom:1px solid #d4d4d8;background:transparent;padding:2px 0 6px;outline:none;flex:1;min-width:0;box-sizing:border-box;"
            @keydown=${(e) => {
              // Keep canvas shortcuts (⌫ deletes the card, v/h switch tools) from firing mid-edit — the
              // stopPropagation the weather/git-log inputs use on the interior seam. Enter commits + blurs.
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
        </div>
        ${body(name, series)}
      </div>
    `;
  },
};
