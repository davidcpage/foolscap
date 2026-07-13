// The PURE decision core of reconcileDetachedMemberCards (loader.ts) — which session cards are ORPHANED
// (member of none of their edged threads) and have stayed orphaned long enough to remove. Extracted so the
// grace logic is unit-testable without an editor/DOM: loader passes the board's member:open edges + the
// fetched rosters; this returns the node ids to remove NOW and keeps the strike bookkeeping in the map the
// caller owns.
//
// TWO-STRIKE GRACE (the 2026-07-12 fix): the roster a reconcile pass holds can PREDATE a fresh join — the
// threads feed pings on membership change, but a pass may run with members captured before a just-spawned
// worker landed in them. A single stale pass used to remove a LIVE worker's card ~120ms after spawn (board
// evt mrhhlq43-a). So a card is removed only when it has looked orphaned across MORE than the grace window:
// the first orphan sighting just stamps `firstSeenOrphan`; only a later pass — with a roster refreshed in
// the meantime — past the window removes. A card confirmed member again (or gone) clears its stamp, so the
// strike never goes stale. Genuinely detached cards still auto-close, one grace window later.
// Shared node:live:/node:session: parse. Imported from the dependency-free ./node-id leaf (NOT loader) so
// this module stays DOM-free and hermetically node-testable; the `.js` specifier lets the test's resolve
// hook map it to the .ts twin.
import { sidOfNode } from "./node-id.js";

export const RECONCILE_ORPHAN_GRACE_MS = 30_000;

/**
 * `edges`: the board's member:open edges (from = session node id, to = thread node id).
 * `roster`: threadId → confirmed member sids; a thread MISSING from the map is unconfirmed → its edged
 *   cards are kept (a partial/failed fetch or an older server may only under-remove, never wrongly nuke).
 * `firstSeenOrphan`: caller-owned strike map (node id → ts of the pass that first saw it orphaned) — MUTATED.
 * Returns the node ids whose removal is due this pass.
 */
export function detachedMemberCards(
  edges: Array<{ from: string; to: string }>,
  roster: Map<string, Set<string>>,
  firstSeenOrphan: Map<string, number>,
  now: number,
  graceMs: number = RECONCILE_ORPHAN_GRACE_MS,
): string[] {
  const edgedThreadsByNode = new Map<string, string[]>();
  for (const e of edges) {
    const list = edgedThreadsByNode.get(e.from) ?? [];
    list.push(e.to);
    edgedThreadsByNode.set(e.from, list);
  }
  const due: string[] = [];
  const orphanedNow = new Set<string>();
  for (const [node, edgedThreads] of edgedThreadsByNode) {
    const sid = sidOfNode(node);
    if (!sid) continue; // not a session-shaped node id — leave it
    // Keep while it is STILL a member of ANY edged thread, or ANY of those threads is unconfirmed.
    const keep = edgedThreads.some((tid) => {
      const members = roster.get(tid);
      return !members || members.has(sid);
    });
    if (keep) {
      firstSeenOrphan.delete(node); // membership (re)confirmed — reset the strike
      continue;
    }
    orphanedNow.add(node);
    const first = firstSeenOrphan.get(node);
    if (first === undefined) {
      firstSeenOrphan.set(node, now); // strike one — this roster may predate a fresh join
      continue;
    }
    if (now - first <= graceMs) continue; // still inside the grace window
    firstSeenOrphan.delete(node);
    due.push(node);
  }
  // A stamped node no longer among the edged/orphaned (card closed by other means) must not hold a stale
  // strike that would instantly fell a later same-id card.
  for (const node of [...firstSeenOrphan.keys()]) if (!orphanedNow.has(node)) firstSeenOrphan.delete(node);
  return due;
}
