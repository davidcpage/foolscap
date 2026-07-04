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
          (ch) => html`
            <div
              class="ses-row"
              draggable="true"
              data-interactive="1"
              tabindex="0"
              title="double-click or drag onto the canvas to open this thread"
              @dragstart=${(e) => dragStart(e, ch)}
              @dblclick=${(e) => { e.preventDefault(); e.stopPropagation(); open && open(ch.chanId, ch.title, ch.text); }}
            >
              <span class="ses-row-title ${ch.title ? "" : "ses-row-mono"}">${ch.title || ch.chanId}</span>
              <span class="ses-row-meta">
                ${ch.messages ? `${ch.messages} msg${ch.messages === 1 ? "" : "s"}` : "no messages"}${ch.mtime ? ` · ${timeAgo(ch.mtime)}` : ""}
              </span>
            </div>
          `,
        )}
      </div>
    `;
  },
};
