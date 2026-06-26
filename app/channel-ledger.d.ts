// Types for channel-ledger.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the ledger without allowJs. Keep in sync with the exports in channel-ledger.js.

// One persisted channel message — the same shape the in-memory ChannelMsg holds (seq/ts/from/text/kind?).
export interface ChannelLogMsg {
  seq: number;
  ts: number;
  from: string;
  text: string;
  kind?: "ask";
}

// A channel's on-disk marker — the rail's source of truth. createdAt is written once; title/text/lastSeq/lastTs
// are refreshed on each append. Extra keys tolerated (the reader merges) — typed loosely as the session marker is.
export interface ChannelMetaMarker {
  chanId: string;
  title?: string;
  text?: string;
  createdAt?: number;
  lastSeq?: number;
  lastTs?: number;
}

export function canvasChannelsDir(repoPath: string): string;
export function appendChannelLine(repoPath: string, chanId: string, msg: ChannelLogMsg): void;
export function readChannelLog(repoPath: string, chanId: string): ChannelLogMsg[];
export function readChannelMeta(repoPath: string, chanId: string): ChannelMetaMarker | null;
export function upsertChannelMeta(repoPath: string, chanId: string, data: Record<string, unknown>): void;
export function listChannels(repoPath: string): ChannelMetaMarker[];
