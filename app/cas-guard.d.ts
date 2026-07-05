// Types for cas-guard.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can import
// the guards without allowJs. Keep in sync with the exports in cas-guard.js.

export type CasMembers = Array<string | { sid: string; name?: string | null }>;

export interface CasMessage {
  seq: number;
  from: string;
  text: string;
  ts?: number;
  kind?: string | null;
}

/** W11 — the unread messages that @-mention `from` and thus block it from posting (empty ⇒ post allowed). */
export function unreadMentions(args: {
  log?: CasMessage[];
  cursor?: number;
  from: string;
  members?: CasMembers;
}): CasMessage[];

/** W12 — the content version stamp for a doc's bytes (a 16-hex content hash), or null for absent content. */
export function contentVersion(content: string | Buffer | null | undefined): string | null;

/** W12 — whether a write based on `baseVersion` is stale against the file's `currentVersion` (⇒ reject 409). */
export function isStaleWrite(baseVersion: unknown, currentVersion: string | null): boolean;
