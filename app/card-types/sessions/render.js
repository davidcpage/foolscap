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

function dragStart(e, id) {
  e.dataTransfer.setData(MIME, JSON.stringify({ id }));
  e.dataTransfer.effectAllowed = "copy";
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

// A compact file size from the transcript's byte length — a free "how big" proxy off the dir stat.
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export default {
  contract: 1,
  render(card) {
    // sessionList is the off-log list (SessionMeta[] | undefined while the first fetch is in flight).
    // Reading it subscribes the card; refreshSessionList() (the ⟳ button) re-pulls + notifies.
    const sessions = card.signals.sessionList;
    const refresh = card.signals.sessionRefresh;
    const count = sessions ? sessions.length : 0;

    return html`
      <div class="file-head">
        <span class="file-name">sessions</span>
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
        ${(sessions ?? []).map(
          (s) => html`
            <div
              class="ses-row"
              draggable="true"
              data-interactive="1"
              title="drag onto the canvas to open this session"
              @dragstart=${(e) => dragStart(e, s.id)}
            >
              <span class="ses-row-title ${s.title ? "" : "ses-row-mono"}">${s.title || s.id.slice(0, 8)}</span>
              <span class="ses-row-meta">
                ${s.turns ? `${s.turns} turn${s.turns === 1 ? "" : "s"} · ` : ""}${timeAgo(s.mtime)} · ${fmtSize(s.bytes)}
              </span>
            </div>
          `,
        )}
      </div>
    `;
  },
};
