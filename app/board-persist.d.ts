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
export function readBoardSnapshot(repoPath: string): PersistedBoardSnapshot | null;
export function boardPersistMtime(repoPath: string): number;
export function describeBoardEvents(events: PersistedEvent[], n?: number): string;
export function appendBoardEvent(repoPath: string, event: PersistedEvent): void;
export function writeBoardSnapshot(repoPath: string, snapshot: PersistedBoardSnapshot): void;
export function importBoardPersist(
  repoPath: string,
  events: PersistedEvent[],
  snapshot: PersistedBoardSnapshot | null,
): boolean;
export function clearBoardPersist(repoPath: string): void;
export const COMPACT_KEEP_TAIL: number;
export const COMPACT_MIN_DROP: number;
export function compactBoardEvents(
  repoPath: string,
  opts?: {
    keepTail?: number;
    minDrop?: number;
    /** Pre-read log/snapshot the boot GET already parsed, shared so the log is read+parsed once per load. */
    events?: PersistedEvent[];
    snapshot?: PersistedBoardSnapshot | null;
  },
): { dropped: number };
/** The boot read: `{ snapshot, events }` where `events` is ONLY the post-watermark tail (the set hydrate
 *  replays), derived from a single parse of the log. `full:true` when a legacy no-seq snapshot forces the
 *  whole log; `dropped` = events compaction removed on this read. */
export function readBoardBoot(repoPath: string): {
  snapshot: PersistedBoardSnapshot | null;
  events: PersistedEvent[];
  dropped: number;
  full: boolean;
};
