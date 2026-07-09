// Session-band staleness reconciliation (thread mrcmofwf-10). The session CARD renders the whole-session
// status band off a `band` field PUSHED onto its feed by publishSession, which fires only on the session's
// OWN process events (stdout/stdin/exit/permission/peer-reply). The thread PILL renders the SAME band, but
// reads it LIVE off /api/sessions (sessionStatus recomputed per request). So when an input sessionStatus
// depends on changes OUT OF BAND — a standing job created/removed on the seat, a seat-occupancy flip, a
// declared blocked:* intent, a waitingOn set — the live value moves but the pushed band freezes, and the
// two surfaces diverge (the canonical bug: card blue "waiting-agent" while the pill shows teal "scheduled").
//
// The fix is a loopTick safety net that recomputes each live session's band and republishes when it has
// drifted from the last-published value. This is the PURE decision half, factored out so it's unit-testable
// and the republish fires ONLY on a real change (never per-tick spam):
//   - `lastBand === undefined` → the session has never been published, so there is no stale band to correct
//     (the card falls back to its own file-tail derivation). Don't manufacture a spurious first publish.
//   - otherwise republish iff the freshly computed band differs from the last one published.
// `null` is a legitimate published value (a bandless never-run session), distinct from `undefined`
// (never published) — so a null→working transition DOES republish.
export function shouldRepublishBand(lastBand, current) {
  return lastBand !== undefined && lastBand !== current;
}
