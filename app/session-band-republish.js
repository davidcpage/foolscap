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

// The idle-band precedence, factored out of sessionStatus (vite-fs-plugin.ts) so the ONE thing this thread
// actually reorders is pinnable by a direct unit test — sessionStatus itself folds live-process state
// (running/exited/permission-held) a test can't cheaply construct, but the *idle* decision is pure in its
// three inputs. Called ONLY once a session is known idle-with-output; process facts (crashed/exited/running)
// are resolved by sessionStatus before this runs and are unaffected.
//
// Highest wins (thread mrcmofwf-10 Done-when v3, refined per dpage): a DECLARED intent outranks a mere wake
// timer — an explicit "I'm blocked on X" beats "I have a heartbeat" — but a server-INFERRED @-tag peer-wait
// does not (it's a free guess, weaker than the scheduled fact):
//   declared blocked:human (any thread) → "waiting"        (orange, the loud "your turn / a human")
//   declared blocked:peer  (any thread) → "waiting-agent"  (blue)
//   scheduled (a live wake on the seat) → "scheduled"      (teal, calm — no human demand)
//   @-tag waitingOn inference           → "waiting-agent"  (blue)
//   idle default                        → "waiting"        (orange)
// This is the ordering fix: declared blocked:* now precedes scheduled (so a heartbeat Coordinator that
// declared blocked:human reads orange, not teal), while scheduled still precedes the @-tag inference.
// @param {"blocked:human"|"blocked:peer"|null|undefined} idleIntent whole-session declared intent (sessionIdleIntent)
// @param {boolean} scheduled a live standing wake targets this session's seat (sessionHasScheduledWake)
// @param {boolean} hasWaitingOn the session @-tagged a specific peer and idled (live waitingOn set)
// @returns {"waiting"|"waiting-agent"|"scheduled"}
export function idleBand(idleIntent, scheduled, hasWaitingOn) {
  if (idleIntent === "blocked:human") return "waiting";
  if (idleIntent === "blocked:peer") return "waiting-agent";
  if (scheduled) return "scheduled";
  if (hasWaitingOn) return "waiting-agent";
  return "waiting";
}
