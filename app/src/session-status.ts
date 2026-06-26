// The shared lifecycle-band vocabulary for the session VISIBILITY surfaces — the minimap bar, the
// sessions-list row indicator, and the move-to-waiting heads-up. The band itself is computed once on the
// server (vite-fs-plugin.ts `sessionStatus`) and rides each /api/sessions row as `SessionMeta.status`;
// this module is the single client-side home for the band's COLOUR and human LABEL, so none of the
// indicators drift from the card's own band (style.css `.ses-frame-*`) or from one another. Change a hue
// here and the card stays the source for ITS band — keep the two in step deliberately.

export type SessionStatus = "working" | "waiting" | "waiting-agent" | "done" | "crashed" | "ended";

// Hex matched to the card band (.ses-frame-*): a calm green `working`, the loud amber `waiting`, a steady
// blue `waiting-agent` (idle but blocked on a PEER, not you), a loud red `crashed`, and muted grey
// `ended`. `done` shares the grey `ended` colour — a wound-down session makes no demand on you either
// way; the "done" vs "ended" distinction survives only in the LABEL, not the colour.
export const STATUS_COLOR: Record<SessionStatus, string> = {
  working: "#16a34a",
  waiting: "#f59e0b",
  "waiting-agent": "#2563eb",
  done: "#d4d4d8",
  crashed: "#ef4444",
  ended: "#d4d4d8",
};

// Short human label for the heads-up toast and tooltips.
export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "working",
  waiting: "waiting for you",
  "waiting-agent": "waiting on an agent",
  done: "done",
  crashed: "crashed",
  ended: "ended",
};

// `waiting` is the one state that actively demands a human (the loud band) — what the heads-up/stack fires
// on. `waiting-agent` is deliberately NOT here: it's blocked on a peer, in flight elsewhere, no demand on
// you. Kept as a predicate so callers don't hard-code the string.
export const wantsAttention = (s: SessionStatus | undefined): boolean => s === "waiting";
