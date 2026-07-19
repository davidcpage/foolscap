// card-types/usage/render.js — provider-explicit plan/account usage, as a runtime-loaded
// template (card-types-as-data.md §7). It renders TWO off-log reads, both channel-1 (no commit, no
// log, no persistence — the clock rule):
//
//   1. PLAN WINDOWS (primary, always on) — the account-level bars the TUI's /usage shows: the 5-hour
//      session window plus the weekly all-models / Sonnet / Opus windows. These have no local mirror,
//      so the dev-server middleware (vite-fs-plugin.ts) polls Anthropic's OAuth usage endpoint
//      server-side with the locally-stored token and republishes it on the `usage` feed. Reading
//      card.signals.usage subscribes this card; each server poll re-renders it. The cadence is adaptive
//      (faster while sessions are live, slower when the board is quiet), and the top-right ⟳ button forces
//      an immediate pull. The poll is a metering call — it reports utilization and runs no inference, so it
//      spends none of the budget it measures; the only cost is the endpoint's own per-token rate limit,
//      which the server respects.
//
//   2. SESSION TOKEN GAUGE (secondary, optional) — when this card is titled with a session id that also
//      has a live session card on the canvas, it piggybacks the same `session` feed the session card
//      reads and derives a context-fill + token tally from each assistant `message.usage`. Untitled,
//      this section is simply absent and the plan bars stand alone.
//
// Inline styles only, so the whole card-type stays additive: no app CSS to touch. The card sits on the
// app's LIGHT paper background (.node c-green ≈ #f3fdf3), so colours are the app's zinc ink scale —
// dark text on light, NOT the dark-theme palette the TUI screenshot uses (that washed out here).
import { html } from "/vendor/lit-html.js";

// The paper-theme palette (matches style.css: zinc-800/700/500 ink on a light card).
const INK = "#27272a"; // primary text
const MUTE = "#52525b"; // secondary text — labels, reset lines (readable, not faint)
const FAINT = "#71717a"; // smallest captions / footnotes (still legible on white)
const TRACK = "#e4e4e7"; // empty bar groove
const BORDER = "#e4e4e7"; // section divider

// Bar fill ramps green→amber→red with fullness; readable on the light track.
function barFill(pct) {
  return pct < 60 ? "#6d75d8" : pct < 85 ? "#d18b1f" : "#d83a3a";
}

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + "k";
  return String(n);
}

// ── plan windows ────────────────────────────────────────────────────────────────────────────────

// "Resets 8:29 PM (Europe/London)" for a window inside the next day, "Resets Jun 24 at 4:59 PM (…)"
// for one further out — matching the TUI's two forms. Absolute (not a live countdown), so no `now`
// capability is needed and the line is faithful to what /usage prints.
function resetLabel(iso) {
  const raw = typeof iso === "number" && iso < 10_000_000_000 ? iso * 1000 : iso;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const soon = d.getTime() - Date.now() < 24 * 3600 * 1000;
  const when = soon ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
  return `Resets ${when} (${tz})`;
}

// "11:10" — the wall-clock (local) time a scheduled rate-limit retry will fire, from an ms timestamp.
// Used in the staleness pill so a designed-in sleep reads as "retrying at 11:10", not a dead card.
function retryClock(ts) {
  const raw = typeof ts === "number" && ts < 10_000_000_000 ? ts * 1000 : ts;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

// A labelled bar with a right-aligned value caption — the shared shape for the plan windows and the
// extra-usage row. `value` is the text to the right of the bar (e.g. "14% used", "£0.00 / £20.00").
function gaugeBar(label, pct, value, sub) {
  return html`
    <div style="margin-bottom:12px;">
      <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:${INK};">${label}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="flex:1;height:12px;border-radius:3px;background:${TRACK};overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${barFill(pct)};transition:width 0.3s;"></div>
        </div>
        <span style="font-size:11px;color:${MUTE};font-variant-numeric:tabular-nums;white-space:nowrap;"
          >${value}</span
        >
      </div>
      ${sub ? html`<div style="font-size:10px;color:${MUTE};margin-top:3px;">${sub}</div>` : ""}
    </div>
  `;
}

// One plan window — or nothing when the window is absent (e.g. seven_day_opus is null on a plan that
// hasn't touched Opus this week). utilization is a 0–100 percentage from the API.
function planBar(label, win) {
  if (!win || typeof win.utilization !== "number") return "";
  const used = Math.max(0, Math.min(100, Math.round(win.utilization)));
  return gaugeBar(label, used, `${used}% used`, win.resets_at ? resetLabel(win.resets_at) : "");
}

// Minor currency units (e.g. 2000 pence, decimal_places 2) → a localized "£20.00". Falls back to a
// plain "<amount> <currency>" if the currency code isn't one Intl recognizes.
function money(minor, decimalPlaces, currency) {
  const exp = Number.isFinite(decimalPlaces) ? decimalPlaces : 2;
  const v = (Number(minor) || 0) / Math.pow(10, exp);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(v);
  } catch {
    return `${v.toFixed(exp)} ${currency || ""}`.trim();
  }
}

// Pay-as-you-go overage, when the account has it enabled. extra_usage carries the cap + spend in minor
// currency units (used_credits / monthly_limit, decimal_places for the exponent); `spend.percent` is
// the API's own fill figure, used when used/limit can't give one. Rendered as one more bar so it reads
// like the plan windows — spend against the monthly cap.
function extraUsageSection(extra, spend) {
  if (!extra || !extra.is_enabled) return "";
  const used = Number(extra.used_credits) || 0;
  const limit = Number(extra.monthly_limit) || 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : Math.round(Number(spend?.percent) || 0);
  const value = `${money(used, extra.decimal_places, extra.currency)} / ${money(limit, extra.decimal_places, extra.currency)}`;
  return gaugeBar("Extra usage (this month)", pct, value, "");
}

// A header + message panel for the states with no bars to draw (loading, not signed in, endpoint down).
function planNote(msg, title = "⚡ plan usage") {
  return html`
    <div>
      <div style="font-weight:600;margin-bottom:8px;color:${INK};">${title}</div>
      <div style="font-size:11px;line-height:1.5;color:${MUTE};">${msg}</div>
    </div>
  `;
}

// The plan section from the `usage` feed value: { five_hour, seven_day, seven_day_sonnet,
// seven_day_opus, extra_usage, spend, error, fetchedAt }. The server keeps the last good windows
// across a transient error (rate-limit/offline), so we draw bars whenever we have ANY window and only
// fall back to a note when there's genuinely nothing to show.
function claudePlanSection(usage) {
  const title = "Claude · Anthropic plan";
  if (!usage) return planNote("Connecting to Claude usage…", title);
  const hasData = usage.five_hour || usage.seven_day || usage.seven_day_sonnet || usage.seven_day_opus;
  if (usage.error === "no-credentials" && !hasData)
    return planNote(
      "Not signed in to Claude Code — no OAuth token in the keychain or ~/.claude/.credentials.json. Sign in with the CLI and this fills in.",
      title,
    );

  if (!hasData) {
    if (usage.error === "http-401")
      return planNote("Login expired. Re-run Claude Code to refresh your token, then this updates.", title);
    return planNote(usage.error ? `Couldn't reach the usage endpoint (${usage.error}). Retrying…` : "No usage data yet.", title);
  }

  // Showing last-good windows through a transient error → a small honest staleness pill, not a blank.
  // When rate-limited with a scheduled retry, show WHEN it retries so a designed-in sleep doesn't read
  // as a dead card; fall back to "last reading" only if we somehow lack a retry time.
  const retryTime = usage.error === "rate-limited" && usage.retryAt ? retryClock(usage.retryAt) : "";
  const trouble =
    usage.error === "rate-limited"
      ? retryTime
        ? `rate-limited · retrying ${retryTime}`
        : "rate-limited · last reading"
      : usage.error
        ? `stale · ${usage.error}`
        : null;

  return html`
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-weight:600;color:${INK};">${title}</span>
        ${trouble
          ? html`<span style="font-size:9px;padding:1px 6px;border-radius:8px;background:#fef3c7;color:#92400e;"
              >${trouble}</span
            >`
          : ""}
      </div>
      ${planBar("Current session", usage.five_hour)}
      ${planBar("Current week (all models)", usage.seven_day)}
      ${planBar("Current week (Opus)", usage.seven_day_opus)}
      ${extraUsageSection(usage.extra_usage, usage.spend)}
      <div style="font-size:9px;color:${FAINT};">billing: Anthropic plan · polled server-side (adaptive)</div>
    </div>
  `;
}

function codexSnapshot(usage) {
  const byId = usage?.rateLimitsByLimitId;
  return byId?.codex ?? (byId && Object.values(byId)[0]) ?? usage?.rateLimits ?? null;
}

function codexPlanSection(usage) {
  const account = usage?.account;
  const plan = account?.planType ? String(account.planType).replaceAll("_", " ") : "ChatGPT";
  const title = `Codex · ${plan} plan`;
  if (!usage) return planNote("Connecting to Codex app-server…", title);
  const limits = codexSnapshot(usage);
  if (!limits) return planNote(usage.error ? `Codex account state unavailable (${usage.error}). Retrying…` : "No Codex rate-limit data yet.", title);
  const primary = limits.primary;
  const secondary = limits.secondary;
  const credits = limits.credits;
  const trouble = limits.rateLimitReachedType
    ? String(limits.rateLimitReachedType).replaceAll("_", " ")
    : usage.error ? `stale · ${usage.error}` : null;
  const creditText = credits?.unlimited
    ? "unlimited agentic credits"
    : credits?.balance != null
      ? `${credits.balance} agentic credits${credits.hasCredits ? "" : " · depleted"}`
      : credits?.hasCredits === false ? "agentic credits depleted" : null;
  const resetCredits = usage.rateLimitResetCredits?.availableCount;

  return html`
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid ${BORDER};">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-weight:600;color:${INK};">${title}</span>
        ${trouble
          ? html`<span style="font-size:9px;padding:1px 6px;border-radius:8px;background:#fef3c7;color:#92400e;">${trouble}</span>`
          : ""}
      </div>
      ${primary ? gaugeBar("Current session", Math.max(0, Math.min(100, primary.usedPercent ?? 0)), `${primary.usedPercent ?? 0}% used`, primary.resetsAt ? resetLabel(primary.resetsAt) : "") : ""}
      ${secondary ? gaugeBar("Current week", Math.max(0, Math.min(100, secondary.usedPercent ?? 0)), `${secondary.usedPercent ?? 0}% used`, secondary.resetsAt ? resetLabel(secondary.resetsAt) : "") : ""}
      ${creditText ? statRow("credits", creditText) : ""}
      ${Number.isFinite(resetCredits) ? statRow("rate-limit resets", String(resetCredits)) : ""}
      ${account?.email ? html`<div style="font-size:9px;color:${FAINT};margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${account.email}</div>` : ""}
      <div style="font-size:9px;color:${FAINT};margin-top:3px;">billing: ChatGPT/workspace · source: Codex app-server</div>
    </div>
  `;
}

function planSection(usage) {
  if (!usage) return planNote("Connecting to the usage feed…");
  // Shape migration: pre-step-5 feeds placed Claude fields at the top level. Render them as Claude,
  // while all new feed values name both provider and billing identity explicitly.
  const providers = usage.providers ?? { claude: usage };
  return html`${claudePlanSection(providers.claude)}${codexPlanSection(providers.codex)}`;
}

// ── per-session token gauge (secondary) ─────────────────────────────────────────────────────────

// Best-effort context window by model — an ASSUMPTION used only to draw the context bar (the absolute
// token counts are always exact). "[1m]" (the 1M-context variant) is detected from the model string;
// everything else defaults to 200K. The assumed value is shown so a wrong guess is visible, not hidden.
function contextWindow(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("1m")) return 1_000_000;
  return 200_000;
}

// The codec: raw transcript (jsonl file-tail OR stream-json process stdout) → usage tallies. Tolerant
// like the session codec — an unparseable line (a live mid-write tail, a partial frame, a
// non-conversation event) is skipped, never thrown. Usage lives on assistant events as `message.usage`;
// we fold every one we can parse, keeping the LAST as the current context snapshot.
function parseUsage(text) {
  let last = null;
  let model = null;
  let turns = 0;
  let totalOutput = 0;
  let totalNewInput = 0;

  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = e?.message?.usage ?? e?.usage;
    if (!u || typeof u !== "object") continue;
    last = u;
    model = e?.message?.model ?? model;
    turns++;
    totalOutput += Number(u.output_tokens) || 0;
    totalNewInput += Number(u.input_tokens) || 0;
  }

  const ctxNow = last
    ? (Number(last.input_tokens) || 0) +
      (Number(last.cache_read_input_tokens) || 0) +
      (Number(last.cache_creation_input_tokens) || 0)
    : 0;

  return { last, model, turns, totalOutput, totalNewInput, ctxNow };
}

function statRow(label, value) {
  return html`
    <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:1.6;">
      <span style="color:${MUTE};">${label}</span>
      <span style="color:${INK};font-variant-numeric:tabular-nums;">${value}</span>
    </div>
  `;
}

// The session section, or "" when this card isn't tracking a session with any usage yet — the plan
// bars are the primary content, so an untitled usage card simply omits this rather than apologising.
function sessionSection(card) {
  const live = card.signals.session;
  const raw = live ? live.content : card.fields.text;
  const { model, turns, totalOutput, totalNewInput, ctxNow, last } = parseUsage(raw);
  if (!last) return "";

  const status = live && live.status;
  const pill = status
    ? html`<span
        style="font-size:10px;padding:1px 6px;border-radius:8px;${status === "running"
          ? "background:#dcfce7;color:#166534;"
          : status === "idle"
            ? "background:#e4e4e7;color:#3f3f46;"
            : "background:#fee2e2;color:#991b1b;"}"
        >${status === "running" ? "● running" : status === "idle" ? "○ idle" : "✕ exited"}</span
      >`
    : live
      ? html`<span style="font-size:10px;color:${FAINT};">● live</span>`
      : "";

  const win = contextWindow(model);
  const pct = Math.min(100, Math.round((ctxNow / win) * 100));
  const barColor = pct < 60 ? "#3a7afe" : pct < 85 ? "#d18b1f" : "#d83a3a";

  return html`
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid ${BORDER};">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-weight:600;color:${INK};">this session</span>
        ${pill}
        <span style="margin-left:auto;font-size:10px;color:${FAINT};">${model ?? "?"}</span>
      </div>

      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
        <span style="color:${MUTE};">context</span>
        <span style="color:${INK};font-variant-numeric:tabular-nums;">${fmt(ctxNow)} / ${fmt(win)} · ${pct}%</span>
      </div>
      <div style="height:7px;border-radius:4px;background:${TRACK};overflow:hidden;margin-bottom:10px;">
        <div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.2s;"></div>
      </div>

      ${statRow("turns", turns)} ${statRow("output (session)", fmt(totalOutput))}
      ${statRow("input, fresh (session)", fmt(totalNewInput))}
      ${statRow("cache read (last turn)", fmt(last.cache_read_input_tokens))}
      ${statRow("cache write (last turn)", fmt(last.cache_creation_input_tokens))}

      <div style="margin-top:8px;font-size:9px;color:${FAINT};">context bar assumes a ${fmt(win)}-token window</div>
    </div>
  `;
}

// A small top-right ⟳ that forces an immediate server-side poll (POST /api/usage/refresh via the
// usageRefresh capability) — useful on first canvas open, when the last reading may predate this tab.
// Absolutely positioned so it floats over the scrolling content; data-interactive + stopPropagation keep
// the click off the host's card-drag seam (precedent: card-types/roles/render.js). Absent (nothing drawn)
// when the capability isn't wired — e.g. the headless template mock. Inline styles only, like the rest of
// this card. `refreshing` is set on the card for the in-flight beat so a double-tap is ignored.
function refreshButton(card) {
  const refresh = card.signals.usageRefresh;
  if (!refresh) return "";
  const onClick = (e) => {
    e.stopPropagation();
    if (card.refreshing) return; // ignore-while-in-flight
    card.refreshing = true;
    Promise.resolve(refresh()).finally(() => {
      card.refreshing = false;
    });
  };
  return html`<button
    type="button"
    data-interactive="1"
    title="refresh usage now"
    @click=${onClick}
    style="position:absolute;top:8px;right:8px;z-index:1;width:20px;height:20px;padding:0;line-height:18px;
      border:1px solid ${BORDER};border-radius:4px;background:#fff;color:${MUTE};font-size:12px;cursor:pointer;"
  >⟳</button>`;
}

export default {
  contract: 1,
  render(card) {
    return html`
      <div
        style="position:relative;padding:12px;font:12px/1.45 ui-sans-serif,system-ui;color:${INK};overflow:auto;height:100%;box-sizing:border-box;"
      >
        ${refreshButton(card)} ${planSection(card.signals.usage)} ${sessionSection(card)}
      </div>
    `;
  },
};
