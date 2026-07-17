// Types for thread-fold.js (plain ESM, runs under node --test). Hand-written so routes/inbox.ts and
// server-delivery.ts can import the fold without allowJs. Keep in sync with the exports in thread-fold.js.

// A stored thread message or amendment event, as the fold reads it. `kind:"edit"` marks an amendment whose
// `target` is the seq it amends; `deleted:true` on such an event is a tombstone (text ignored).
export type FoldMsg = {
  seq: number;
  ts: number;
  from: string;
  text: string;
  kind?: string | null;
  target?: number;
  deleted?: boolean;
};

// A message after the fold — a superset of FoldMsg carrying the amended text plus display metadata a
// projection renders. `edited`/`deleted` are set only on a folded (amended) message; a passed-through
// message carries neither.
export type FoldedMsg = FoldMsg & {
  edited?: boolean;
  originalText?: string;
  editedBy?: string;
  editedTs?: number;
  deleted?: boolean;
  deletedBy?: string;
};

export const DELETED_STUB: string;

export function mentionSet(text: string): string;

export function checkEdit(
  target: { seq: number; from: string; text: string; kind?: string | null } | null | undefined,
  newText: string | null,
  who: { fromSid: string; isHuman?: boolean },
): { ok: true } | { ok: false; status: number; error: string };

export function foldAmendments(log: FoldMsg[]): FoldedMsg[];
