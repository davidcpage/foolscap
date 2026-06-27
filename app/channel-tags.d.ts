// Types for channel-tags.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the resolver without allowJs. Keep in sync with the exports in channel-tags.js.

export function parseTags(text: string): string[];
export function resolveTags(
  text: string,
  members: Array<string | { sid: string; name?: string | null }>,
): { wakeAll: boolean; human: boolean; members: string[]; unknown: string[] };
