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
    const jump = card.signals.channelJump; // open + scroll-to-message (the unseen-mention preview → a mention)
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
            // TWO differentiated per-row signals (user waiting-state + you-pill), distinct hues:
            //   (a) UNSEEN MENTION — the thread has ≥1 @you/@human mention the human hasn't VIEWED yet
            //       (ch.youWaiting/youWaitingCount, server-derived against the durable seenMentions set). A
            //       QUIET indigo count badge whose hover opens an interactive popover of the pending mentions;
            //       clicking one transports to the thread AND scrolls to that exact message (channelJump).
            //   (b) AGENT AWAITING YOU — a live participant's effective intent is blocked:human, surfaced via
            //       the already-fused thread state (ch.state === "waiting", thread-state.js — resume-safe, no
            //       stale block). The LOUD amber 'your-turn' hue.
            // They're independent and can coexist; amber (b) wins the row background when both are lit, and both
            // indicators still show. A row with EITHER signal single-click-transports to that thread (the fast
            // "the thread that needs me" path); a calm row keeps the double-click-to-open gesture.
            const unseen = !!ch.youWaiting;
            const unseenCount = ch.youWaitingCount || 0;
            const yourTurn = ch.state === "waiting";
            const signalling = unseen || yourTurn;
            // Lifecycle status rail — a coloured LEFT BORDER per row keyed off the server-derived thread state
            // (thread-state.js), mirroring the Sessions card's `.ses-status-*` rail and reusing its hexes
            // (session-status.ts): active→green, waiting→amber, dormant→grey. Waiting's amber border already
            // rides `.your-turn` (below), so we only tag the calm states here. A dormant thread that was NEVER
            // staffed (no agent ever declared an intent or posted — ch.everStaffed:false) reads as a
            // 'placeholder', not a wound-down one, so it gets a distinct DASHED/hollow grey rail (after
            // `.chan-member.pending`) rather than the solid grey of a staffed-but-dormant thread.
            const statusClass =
              ch.state === "active"
                ? "chan-status-active"
                : ch.state === "dormant"
                  ? (ch.everStaffed === false ? "chan-status-unstaffed" : "chan-status-dormant")
                  : ""; // waiting → amber, carried by .your-turn; an older server omits everStaffed → staffed (solid grey)
            const rowClass = ["ses-row", statusClass, yourTurn ? "your-turn" : "", unseen ? "unseen" : ""].filter(Boolean).join(" ");
            const preview = ch.youWaitingPreview || [];
            const more = ch.youWaitingMore || 0;
            const rowTitle = yourTurn
              ? "an agent is blocked waiting on you — click to go to this thread"
              : unseen
                ? `${unseenCount} unseen mention${unseenCount === 1 ? "" : "s"} — click to go to this thread`
                : "double-click or drag onto the canvas to open this thread";
            return html`
            <div
              class="${rowClass}"
              draggable="true"
              data-interactive="1"
              tabindex="0"
              title=${rowTitle}
              @dragstart=${(e) => dragStart(e, ch)}
              @click=${(e) => { if (!signalling) return; e.preventDefault(); e.stopPropagation(); open && open(ch.chanId, ch.title, ch.text); }}
              @dblclick=${(e) => { e.preventDefault(); e.stopPropagation(); open && open(ch.chanId, ch.title, ch.text); }}
            >
              <span class="ses-row-title ${ch.title ? "" : "ses-row-mono"} ${unseen ? "ses-row-title-pad" : ""}">${ch.title || ch.chanId}</span>
              ${unseen
                ? html`<span class="ses-row-signals">
                    ${unseen
                      ? html`<span class="ses-row-unseen" data-interactive="1" title="${unseenCount} unseen mention${unseenCount === 1 ? "" : "s"} — hover to preview">
                          ${unseenCount}
                          <!-- Interactive preview popover (Issue #4 pattern): pointer-events:auto, a DOM descendant
                               of the badge with NO gap to it, so the cursor can travel in without dropping :hover.
                               Each entry is a cross-card jump to that specific mention. -->
                          <span class="ses-row-preview" role="tooltip">
                            <span class="ses-row-preview-head">${unseenCount} unseen mention${unseenCount === 1 ? "" : "s"}${jump ? " — click one to jump" : ""}</span>
                            ${more > 0 ? html`<span class="ses-row-preview-more">+${more} earlier · newest ${preview.length} shown</span>` : ""}
                            ${preview.map(
                              (p) => html`<button
                                type="button"
                                class="ses-row-preview-item"
                                data-interactive="1"
                                title="jump to this message"
                                @click=${(e) => { e.preventDefault(); e.stopPropagation(); jump && jump(ch.chanId, ch.title, ch.text, p.seq); }}
                              >
                                <span class="ses-row-preview-from">${p.fromLabel || p.from}</span>
                                <span class="ses-row-preview-text">${p.text}</span>
                              </button>`,
                            )}
                          </span>
                        </span>`
                      : ""}
                  </span>`
                : ""}
              <span class="ses-row-meta">
                ${ch.messages ? `${ch.messages} msg${ch.messages === 1 ? "" : "s"}` : "no messages"}${ch.mtime ? ` · ${timeAgo(ch.mtime)}` : ""}
              </span>
            </div>
          `;
          },
        )}
      </div>
    `;
  },
};
