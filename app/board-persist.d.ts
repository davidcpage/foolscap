// Hand-written types for board-persist.js (plain ESM so it runs under node --test).

/** An intent event / snapshot as persisted — opaque JSON here; core owns the real shapes. */
export type PersistedEvent = Record<string, unknown>;
export type PersistedBoardSnapshot = Record<string, unknown>;

export function boardPersistDir(repoPath: string): string;
export function readBoardPersist(repoPath: string): {
  events: PersistedEvent[];
  snapshot: PersistedBoardSnapshot | null;
};
export function hasBoardPersist(repoPath: string): boolean;
export function appendBoardEvent(repoPath: string, event: PersistedEvent): void;
export function writeBoardSnapshot(repoPath: string, snapshot: PersistedBoardSnapshot): void;
export function importBoardPersist(
  repoPath: string,
  events: PersistedEvent[],
  snapshot: PersistedBoardSnapshot | null,
): boolean;
export function clearBoardPersist(repoPath: string): void;
