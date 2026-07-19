import type { Persistence, RecordsDiff, Store, IntentEvent } from "./lib";

// Inbound-convergence logic for the agent bus (design §9 stage 3, D4), isolated here with TYPE-ONLY imports
// so it carries no browser dependency and is unit-testable against a real core Store + Persistence. agentBus.ts
// wires these to the live socket (onBusDiff / onFeedsReconnect) and the durable log fetch.

// The inbound-seq decision: given an inbound bus-diff seq and this tab's current watermark, is the frame one
// we already HAVE (a resend / a catch-up beat it), does it sit past a GAP (frames were missed — must NOT be
// applied out of order), or is it the NEXT in-order frame to fold?
export function classifyInbound(seq: number, watermark: number): "have" | "gap" | "next" {
  if (seq <= watermark) return "have";
  if (seq > watermark + 1) return "gap";
  return "next";
}

// Fold a caught-up event range into the store IN SEQ ORDER. Each event whose seq is still past the watermark
// is applied as a "remote" channel-2 change and its seq adopted; one already covered by a racing live frame
// is skipped (applyDiffAsChange is idempotent, but skipping avoids the churn). Returns how many were newly
// applied — 0 means the tab is already caught up (the catch-up loop's exit condition).
export function foldCatchUp(
  events: readonly IntentEvent[],
  store: Pick<Store, "applyDiffAsChange">,
  persistence: Pick<Persistence, "watermark" | "adoptSeq">,
): number {
  let applied = 0;
  for (const e of events) {
    if (e.seq <= persistence.watermark()) continue; // a live frame already delivered it — idempotent skip
    store.applyDiffAsChange(e.diff as RecordsDiff, "remote");
    persistence.adoptSeq(e.seq);
    applied++;
  }
  return applied;
}
