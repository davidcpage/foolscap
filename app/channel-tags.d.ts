// Types for channel-tags.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the resolver without allowJs. Keep in sync with the exports in channel-tags.js.

export type TagMembers = Array<string | { sid: string; name?: string | null }>;

export function parseTags(text: string): string[];
export function resolveTags(
  text: string,
  members: TagMembers,
): { wakeAll: boolean; human: boolean; members: string[]; unknown: string[] };
export function tagHit(token: string, members: TagMembers): boolean;
export function matchTagSpans(
  text: string,
  members: TagMembers,
): Array<{ start: number; end: number; token: string }>;
