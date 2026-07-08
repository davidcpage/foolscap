// card-types/channels/render.js — the channels browser's interior (the sessions browser's twin). The body is
// the OFF-LOG list of this board's persisted channels (content.ts, /api/channels), read through the
// `channelList` capability — listing the `.canvas/channels/` markers is a channel-1 projection that never
// touches the durable log. Every row is DRAGGABLE: drop it on the canvas and the host reopens that channel as a
// card (loader.openChannel). The header's ⟳ button re-pulls the list (channelRefresh). You browse INSIDE the
// card and drag out only the channel you want — exactly the sessions/directory card's drag-out, for channels.
import { html } from "/vendor/lit-html.js";

// The drag payload mime — App.tsx's canvas drop handler reads the same key. openChannel needs the id PLUS the
// title/description: a channel's identity isn't a file to re-read on open (its marker carries it), so the
// payload ships all three; the drop point sets the position.
const MIME = "application/x-canvas-channel";

function dragStart(e, ch) {
  e.dataTransfer.setData(MIME, JSON.stringify({ chanId: ch.chanId, title: ch.title, text: ch.text }));
  e.dataTransfer.effectAllowed = "copy";
}

// "how long ago", coarse and friendly — the meta line's clock. Inlined (a template may import only /vendor/,
// the capability boundary), exactly as the sessions card inlines it.
function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default {
  contract: 1,
  render(card) {
    // channelList is the off-log list (ChannelMeta[] | undefined while the first fetch is in flight).
    // Reading it subscribes the card; channelRefresh (the ⟳ button) re-pulls + notifies.
    const channels = card.signals.channelList;
    const refresh = card.signals.channelRefresh;
    const open = card.signals.channelOpen; // double-click → reopen this channel as a card (drag-out's twin)
    const count = channels ? channels.length : 0;

    return html`
      <div class="file-head">
        <span class="file-name">threads</span>
        ${refresh
          ? html`<button
              class="ses-refresh"
              type="button"
              title="refresh the list"
              @click=${(e) => { e.stopPropagation(); refresh(); }}
            >⟳</button>`
          : ""}
        ${channels ? html`<span class="file-ext">${count}</span>` : ""}
      </div>
      <div class="dir-body">
        ${!channels ? html`<div class="dir-empty">loading…</div>` : ""}
        ${channels && count === 0 ? html`<div class="dir-empty">no threads yet</div>` : ""}
        ${(channels ?? []).map(
          (ch) => {
            // WAITING highlight (user waiting-state + you-pill, Phase 2): the server flags a thread whose
            // @you/@human mention sits unaddressed (ch.youWaiting, same signal as the thread card's amber "you"
            // pill). A waiting row is amber AND SINGLE-CLICK transports the human to that thread card — the fast
            // path to "the thread that needs me". Transport reuses `open` (loader.openChannel): fly to the card
            // if it's already on the canvas, else open it. Non-waiting rows keep the double-click-to-open gesture
            // (a single click there would fight selection/drag); the highlight is what earns the one-click jump.
            const waiting = !!ch.youWaiting;
            const count = ch.youWaitingCount || 0;
            // The actual waiting messages (Phase 3): sender + snippet, bounded server-side with a `+N earlier`
            // overflow (thread-waiting.js). Hovering the amber row reveals this preview so the human sees WHAT
            // awaits, not just a count. It's a PURE-REVEAL tooltip (pointer-events:none, no click targets):
            // the row itself single-click-transports to the thread (Phase 2), so there's nothing to click
            // inside the preview — which sidesteps the dismiss-on-cursor-move trap the interactive pill hits.
            const preview = Array.isArray(ch.youWaitingPreview) ? ch.youWaitingPreview : [];
            const more = ch.youWaitingMore || 0;
            const fromLabel = (f) => (f === "human" ? "you" : String(f).slice(0, 8));
            return html`
            <div
              class="ses-row ${waiting ? "waiting" : ""}"
              draggable="true"
              data-interactive="1"
              tabindex="0"
              title=${waiting && preview.length === 0
                ? `${count} message${count === 1 ? "" : "s"} await you — click to go to this thread`
                : waiting
                  ? ""
                  : "double-click or drag onto the canvas to open this thread"}
              @dragstart=${(e) => dragStart(e, ch)}
              @click=${(e) => { if (!waiting) return; e.preventDefault(); e.stopPropagation(); open && open(ch.chanId, ch.title, ch.text); }}
              @dblclick=${(e) => { e.preventDefault(); e.stopPropagation(); open && open(ch.chanId, ch.title, ch.text); }}
            >
              <span class="ses-row-title ${ch.title ? "" : "ses-row-mono"}">${ch.title || ch.chanId}</span>
              ${waiting ? html`<span class="ses-row-wait" title="messages awaiting you">${count}</span>` : ""}
              <span class="ses-row-meta">
                ${ch.messages ? `${ch.messages} msg${ch.messages === 1 ? "" : "s"}` : "no messages"}${ch.mtime ? ` · ${timeAgo(ch.mtime)}` : ""}
              </span>
              ${waiting && preview.length > 0
                ? html`<div class="ses-row-preview" role="tooltip">
                    <div class="ses-row-preview-head">${count} message${count === 1 ? "" : "s"} await you · click the row to open</div>
                    ${more > 0 ? html`<div class="ses-row-preview-more">+${more} earlier · newest ${preview.length} shown</div>` : ""}
                    ${preview.map(
                      (p) => html`<div class="ses-row-preview-item">
                        <span class="ses-row-preview-from">${fromLabel(p.from)}</span>
                        <span class="ses-row-preview-text">${p.text}</span>
                      </div>`,
                    )}
                  </div>`
                : ""}
            </div>
          `;
          },
        )}
      </div>
    `;
  },
};
