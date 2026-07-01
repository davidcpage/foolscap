// Types for channel-ledger.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the ledger without allowJs. Keep in sync with the exports in channel-ledger.js.

import type { WorkIntent } from "./work-intent.js";

// One persisted channel message — the same shape the in-memory ChannelMsg holds. `kind` marks a CARD-ONLY
// entry (ask echo / work-intent act — rendered by the card, never inbox content); `intent` rides kind:"intent".
export interface ChannelLogMsg {
  seq: number;
  ts: number;
  from: string;
  text: string;
  kind?: "ask" | "intent";
  intent?: WorkIntent;
}

// The latest work-intent a member declared (threads-as-cards §6) — keyed by sid on the marker's `intents`
// until seats land (§8 step 2 moves the key to the seat, so it survives an occupant respawn).
export interface DeclaredIntent {
  intent: WorkIntent;
  ts: number;
  note?: string;
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
  intents?: Record<string, DeclaredIntent>;
}

export function canvasChannelsDir(repoPath: string): string;
export function appendChannelLine(repoPath: string, chanId: string, msg: ChannelLogMsg): void;
export function readChannelLog(repoPath: string, chanId: string): ChannelLogMsg[];
export function readChannelMeta(repoPath: string, chanId: string): ChannelMetaMarker | null;
export function upsertChannelMeta(repoPath: string, chanId: string, data: Record<string, unknown>): void;
export function listChannels(repoPath: string): ChannelMetaMarker[];
