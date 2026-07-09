// Types for session-ledger.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the ledger without allowJs. Keep in sync with the exports in session-ledger.js.

export function projectsDirForCwd(cwd: string): string;
export function canvasSessionsDir(repoPath: string): string;
export function markCanvasSession(repoPath: string, id: string, data: Record<string, unknown>): void;
export function isCanvasSession(repoPath: string, id: string): boolean;
export function readCanvasSession(repoPath: string, id: string): Record<string, unknown> | null;
export function recordSessionEnd(
  repoPath: string,
  id: string,
  endReason: "done" | "terminated" | "crashed",
  endedAt?: number,
): void;
export function updateCanvasSession(repoPath: string, id: string, patch: Record<string, unknown>): void;
export function listSessions(
  dir: string,
  repoPath: string,
  dirForCwd?: (cwd: string) => string,
): { id: string; mtime: number; bytes: number }[];
