// card-types/sessions/render.js — the sessions browser's interior as a runtime-loaded template
// (Phase C). The body is the OFF-LOG list of historical agent transcripts (content.ts, /api/sessions),
// read through the `sessionList` capability — listing the disk is a channel-1 projection that never
// touches the durable log. Every row is DRAGGABLE: drop it on the canvas and the host promotes that one
// session to a card (loader.openSession), the deliberate promotion gesture — exactly the directory card's
// drag-out, applied to sessions instead of files. The header's ⟳ button re-pulls the list (sessionRefresh)
// since the sessions dir has no live watch. You browse INSIDE the card and drag out only the session you want.
import { html } from "/vendor/lit-html.js";

// The drag payload mime — App.tsx's canvas drop handler reads the same key. The session id is all the
// host needs (openSession resolves the rest); the drop point sets the position.
const MIME = "application/x-canvas-session";

// Serving-model chip: friendly name + subtle metal tint by tier, effort suffix only when explicitly set.
// INLINED (card-type render.js may import only /vendor/*, per card-templates.test.mjs) — kept in lockstep
// with the identical map in card-types/session/render.js and loader.ts's PROVIDER_MODELS ids. Unknown ids
// keep the base grey chip with `claude-` stripped — never blank. /api/sessions carries model/effort for
// ended sessions too (W1), so the row chip persists after Done.
const MODEL_DISPLAY = {
  "claude-fable-5": ["Fable", "gold"],
  "claude-opus-4-8": ["Opus", "silver"],
  "claude-sonnet-5": ["Sonnet", "bronze"],
  "gpt-5.6-sol": ["Sol", "gold"],
  "gpt-5.6-terra": ["Terra", "silver"],
  "gpt-5.6-luna": ["Luna", "bronze"],
};
// Short model ALIASES on a Task/Agent tool_use `input.model` (subagent chips only) — kept in lockstep with
// session/render.js's identical map. Mapped to the same friendly label + tier as the full-id MODEL_DISPLAY.
const MODEL_ALIAS = {
  fable: ["Fable", "gold"],
  opus: ["Opus", "silver"],
  sonnet: ["Sonnet", "bronze"],
  haiku: ["Haiku", "plain"],
};
function modelChip(model, effort, variant, note) {
  if (typeof model !== "string" || !model) return null;
  let label, tier;
  if (MODEL_DISPLAY[model]) [label, tier] = MODEL_DISPLAY[model];
  else if (MODEL_ALIAS[model]) [label, tier] = MODEL_ALIAS[model];
  else if (/^claude-haiku/.test(model)) [label, tier] = ["Haiku", "plain"];
  else [label, tier] = [model.replace(/^claude-/, ""), "plain"];
  const eff = typeof effort === "string" && effort ? effort : null;
  const sub = variant === "sub"; // a subagent chip: smaller, dimmer, ↳-marked, never the main pill
  const kind = sub ? `subagent${note ? ` (${note})` : ""} ` : ""; // note = subagent_type, in the tooltip
  return html`<span
    class="ses-model ses-model-${tier}${sub ? " ses-model-sub" : ""}"
    title=${`${kind}model: ${model}${eff ? ` · effort: ${eff}` : ""}`}
    >${label}${eff ? html`<span class="ses-model-effort"> ·${eff}</span>` : ""}</span
  >`;
}

function dragStart(e, id) {
  e.dataTransfer.setData(MIME, JSON.stringify({ id }));
  e.dataTransfer.effectAllowed = "copy";
}

// Row keyboard: a SELECTED row (click it → it takes focus, the `:focus` outline is the selection cue)
// is HIDDEN from this list by Shift+Delete — a deliberate, two-key gesture for a rare, mildly-destructive
// act (it never deletes the .jsonl, only drops it from the view; sessionDelete persists the hide). The
// guard is the Shift: a bare Delete must NOT bite, both to demand intent and because the host's global
// Delete removes the selected canvas card. So we stopPropagation on every Delete/Backspace in a focused
// row (contain it from the canvas shortcuts, exactly as the live session input does) and only act when
// Shift is held. `del` is card.signals.sessionDelete (absent if the capability wasn't granted → no-op).
function onRowKey(e, id, del) {
  if (e.key !== "Delete" && e.key !== "Backspace") return; // leave every other key for the host
  e.stopPropagation(); // a focused row owns Delete/Backspace — never let it reach the canvas card-delete
  if (e.shiftKey && del) {
    e.preventDefault();
    del(id);
  }
}

// "how long ago", coarse and friendly — the meta line's clock. Mirrors feeds.ts timeAgo, inlined here
// because a template may import only /vendor/ (the capability boundary), exactly as the directory card
// inlines baseName/ext rather than reaching into the app.
function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// A compact file size for Claude's file-backed transcript. Codex history is provider-backed, not a zero-byte
// file; a failed prompt-less Claude spawn likewise has no transcript rather than an empty one.
function historyLabel(session) {
  if (session.provider === "codex") return session.noHistory ? "no provider history" : "app-server history";
  if (session.noHistory || session.bytes == null) return "no transcript";
  const bytes = session.bytes;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// The NON-TERMINAL session states — a session still in flight, whatever it's blocked on. Mirrors the
// lifecycle band (app/src/session-status.ts): working (running), waiting (on the human), waiting-agent
// (on a peer), scheduled (asleep on a timer between heartbeats). done/crashed/ended are terminal and
// excluded. The header's running badge counts these, so a glance at the HUD tells you how many agents
// are live without opening a single card.
const RUNNING_STATUS = new Set(["working", "waiting", "waiting-agent", "scheduled"]);

export default {
  contract: 1,
  render(card) {
    // sessionList is the off-log list (SessionMeta[] | undefined while the first fetch is in flight).
    // Reading it subscribes the card; refreshSessionList() (the ⟳ button) re-pulls + notifies.
    const sessions = card.signals.sessionList;
    const refresh = card.signals.sessionRefresh;
    const del = card.signals.sessionDelete; // hide-from-list action (Shift+Delete on a selected row)
    const open = card.signals.sessionOpen; // double-click → open this session as a card (drag-out's twin)
    const count = sessions ? sessions.length : 0;
    // Running = non-terminal sessions (still in flight — see RUNNING_STATUS). The header badge is the
    // at-a-glance "how many agents are live" read the HUD placement is for.
    const running = (sessions ?? []).filter((s) => RUNNING_STATUS.has(s.status)).length;

    return html`
      <div class="file-head">
        <span class="file-name">sessions</span>
        ${running
          ? html`<span class="ses-running" title=${`${running} session${running === 1 ? "" : "s"} running`}
              >${running} running</span
            >`
          : ""}
        ${refresh
          ? html`<button
              class="ses-refresh"
              type="button"
              title="refresh the list"
              @click=${(e) => { e.stopPropagation(); refresh(); }}
            >⟳</button>`
          : ""}
        ${sessions ? html`<span class="file-ext">${count}</span>` : ""}
      </div>
      <div class="dir-body">
        ${!sessions ? html`<div class="dir-empty">loading…</div>` : ""}
        ${sessions && count === 0 ? html`<div class="dir-empty">no sessions on disk</div>` : ""}
        ${(sessions ?? []).map((s) => {
          const chip = modelChip(s.model, s.effort);
          return html`
            <div
              class="ses-row ${s.status ? `ses-status-${s.status}` : ""}"
              draggable="true"
              data-interactive="1"
              tabindex="0"
              title="double-click or drag onto the canvas to open · click then Shift+Delete to hide from this list"
              @dragstart=${(e) => dragStart(e, s.id)}
              @dblclick=${(e) => { e.preventDefault(); e.stopPropagation(); open && open(s.id); }}
              @keydown=${(e) => onRowKey(e, s.id, del)}
            >
              <span class="ses-row-line">
                ${s.roleName
                  ? html`<span class="ses-row-role c-${s.roleColour || "blue"}" title=${`role: ${s.roleName}`}>${s.roleName}</span>`
                  : ""}
                <span class="ses-row-title ${s.title ? "" : "ses-row-mono"}">${s.title || s.id.slice(0, 8)}</span>
              </span>
              <span class="ses-row-meta">
                ${chip /* serving model + effort; persists for ended sessions (W1 records it on the marker) */
                  ? html`${chip} · `
                  : ""}${s.turns ? `${s.turns} turn${s.turns === 1 ? "" : "s"} · ` : ""}${timeAgo(s.mtime)} · ${historyLabel(s)}
              </span>
            </div>
          `;
        })}
      </div>
    `;
  },
};
