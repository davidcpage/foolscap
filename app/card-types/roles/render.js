// card-types/roles/render.js — the roles browser's interior (the channels/sessions browser's twin,
// agent-roles.md). The body is the OFF-LOG list of this board's roles (content.ts, /api/roles), read
// through the `rolesList` capability — listing the `.canvas/roles/` folders is a channel-1 projection that
// never touches the durable log. Each row carries a colour swatch, the role name, and a LIVE-INSTANCE count
// derived client-side from the `sessionList` capability (a join on roleId — no backend presence work). The
// header's ⟳ button re-pulls the list (rolesRefresh); a live push (the roles watcher) covers the common case.
//
// LAUNCH is explicit: a "＋ session" button per row spawns a session UNDER that role (roleLaunch →
// loader.spawnLiveSession), rather than a double-click — spawning a real claude process eats one of the
// board's session slots, too costly for a misclick. (Charter editing — open a role card — is phase 2b.)
import { html } from "/vendor/lit-html.js";

// Count the LIVE sessions running under each role, by roleId, off the sessions list. "Live" = the working /
// waiting / waiting-agent states (a wound-down done/ended/crashed session is not an instance), mirroring the
// session card's own liveness split. Returns a Map roleId→count; absent (list still loading) → an empty map,
// so a row just shows no count rather than a wrong zero flicker.
const LIVE_STATUS = new Set(["working", "waiting", "waiting-agent"]);
function liveCounts(sessions) {
  const by = new Map();
  for (const s of sessions ?? [])
    if (s.roleId && LIVE_STATUS.has(s.status)) by.set(s.roleId, (by.get(s.roleId) ?? 0) + 1);
  return by;
}

export default {
  contract: 1,
  render(card) {
    // rolesList is the off-log list (Role[] | undefined while the first fetch is in flight). Reading it
    // subscribes the card; rolesRefresh (the ⟳ button) re-pulls + notifies. sessionList drives the live count.
    const roles = card.signals.rolesList;
    const refresh = card.signals.rolesRefresh;
    const launch = card.signals.roleLaunch; // ＋ session → spawn under this role (explicit, never a dblclick)
    const counts = liveCounts(card.signals.sessionList);
    const count = roles ? roles.length : 0;

    return html`
      <div class="file-head">
        <span class="file-name">roles</span>
        ${refresh
          ? html`<button
              class="ses-refresh"
              type="button"
              title="refresh the list"
              @click=${(e) => { e.stopPropagation(); refresh(); }}
            >⟳</button>`
          : ""}
        ${roles ? html`<span class="file-ext">${count}</span>` : ""}
      </div>
      <div class="dir-body">
        ${!roles ? html`<div class="dir-empty">loading…</div>` : ""}
        ${roles && count === 0 ? html`<div class="dir-empty">no roles yet</div>` : ""}
        ${(roles ?? []).map((r) => {
          const live = counts.get(r.roleId) ?? 0;
          return html`
            <div class="role-row" title=${`role: ${r.name}`}>
              <span class="role-swatch c-${r.colour || "blue"}"></span>
              <span class="role-row-name">${r.name}</span>
              ${live ? html`<span class="role-row-live" title=${`${live} live session${live === 1 ? "" : "s"}`}>● ${live}</span>` : ""}
              ${launch
                ? html`<button
                    class="role-launch"
                    type="button"
                    title=${`launch a session as ${r.name}`}
                    @click=${(e) => { e.stopPropagation(); launch(r.roleId); }}
                  >＋ session</button>`
                : ""}
            </div>
          `;
        })}
      </div>
    `;
  },
};
