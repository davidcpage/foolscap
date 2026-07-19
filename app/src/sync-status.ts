// The board-level SYNC STATUS (design §9 stage 3, §3.4) — an unobtrusive-but-honest signal that the human's
// edits are (or aren't) landing. Two facts feed it: `connected` (the shared feed socket up? — set by feeds.ts
// on open/close) and `pending` (EVENT writes queued-but-not-durable — set by App from core Persistence's
// onPending, the inspectable outbound queue of §3.1). The connection pill subscribes to derive its label:
// online (hidden) / reconnecting… / offline — N edits pending / syncing N…. A tiny hand-rolled pub/sub (no
// signia dependency in this leaf); the pill reads get() and re-renders on notify.

export interface SyncStatus {
  connected: boolean;
  pending: number;
}

let state: SyncStatus = { connected: true, pending: 0 };
const subs = new Set<() => void>();

export function syncStatus(): SyncStatus {
  return state;
}

export function subscribeSyncStatus(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function set(next: Partial<SyncStatus>): void {
  const merged = { ...state, ...next };
  if (merged.connected === state.connected && merged.pending === state.pending) return; // no-op — don't churn
  state = merged;
  for (const fn of subs) fn();
}

export function setConnected(connected: boolean): void {
  set({ connected });
}

export function setPending(pending: number): void {
  set({ pending: Math.max(0, pending) });
}

// The pill's label from the two facts (pure, so it's unit-testable). null = nothing to show (online + synced).
// The truncation doctrine applies: we NEVER silently drop a queued edit, so a non-zero pending is always
// surfaced honestly — offline shows the backlog, a live drain shows the count still in flight.
export function syncPillLabel(s: SyncStatus): string | null {
  if (!s.connected) return s.pending > 0 ? `offline — ${s.pending} edit${s.pending === 1 ? "" : "s"} pending` : "reconnecting…";
  if (s.pending > 0) return `syncing ${s.pending}…`;
  return null; // online and fully synced — say nothing
}
