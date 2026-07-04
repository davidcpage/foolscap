// Types for board-memory.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the reader without allowJs. Keep in sync with the exports in board-memory.js.

export function boardMemoryPath(repoPath: string): string;
export function readBoardMemory(repoPath: string): { content: string; truncated: boolean } | null;
export function boardMemoryBrief(repoPath: string): string;
