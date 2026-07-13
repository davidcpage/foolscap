// The PURE pill-union core of ThreadView (NodeView.tsx). Extracted so the union/dedup/sort — dense and
// once the site of P4 reopen-by-pill bugs — is unit-testable without the editor store / DOM. ThreadView maps
// the board's member:* edges to `edgeMembers` (needs store.get) and hands them here with the server's durable
// roster off the thread feed.
//
// Pills come from TWO sources unioned by sid: (1) local member:* EDGES — a member with an open session card
// on this board (`open` reflects the edge type; a non-`member:open` edge is a pending INVITE); (2) the
// server's DURABLE roster off the feed — members whose membership survives even after their session card (and
// its edge) was select-deleted (a display-only close). A durable member with NO edge here is exactly that
// deleted-card case: it gets a CLOSED pill (open:false, invited:false, no edgeId) that stays clickable so
// openSession reopens it (P4 pill-open). Without this union the pill would vanish on delete and P4's
// reopen-by-pill would be dead. `invited` splits the two open:false cases: a non-member:open EDGE is a
// pending invite (not yet joined server-side); a cardless roster member is a CLOSED member (joined, card
// deleted) — reopenable, not invited — so a deleted-card pill doesn't masquerade as an un-joined invite.

export interface PillMember {
  edgeId: string | null;
  sid: string;
  name: string | null;
  open: boolean;
  invited: boolean;
}

// Union edge-derived members with the durable roster: a roster sid with no edge here becomes a closed,
// reopenable pill; an edge always wins over the roster (deduped by sid). Sorted open-first so live pills lead.
export function unionPillMembers(
  edgeMembers: PillMember[],
  roster: Array<{ sid: string; name: string | null }>,
): PillMember[] {
  const edgeSids = new Set(edgeMembers.map((m) => m.sid));
  const cardless: PillMember[] = roster
    .filter((r) => !edgeSids.has(r.sid))
    .map((r) => ({ edgeId: null, sid: r.sid, name: r.name, open: false, invited: false }));
  return [...edgeMembers, ...cardless].sort((a, b) => Number(b.open) - Number(a.open));
}
