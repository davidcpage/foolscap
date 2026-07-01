// Types for thread-ledger.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the ledger without allowJs. Keep in sync with the exports in thread-ledger.js.

import type { WorkIntent } from "./work-intent.js";

// One persisted thread message — the same shape the in-memory ThreadMsg holds. `kind` marks a CARD-ONLY
// entry (ask echo / work-intent act — rendered by the card, never inbox content); `intent` rides kind:"intent".
export interface ThreadLogMsg {
  seq: number;
  ts: number;
  from: string;
  text: string;
  kind?: "ask" | "intent";
  intent?: WorkIntent;
}

// The latest work-intent a participant declared (threads-as-cards §6), on the marker's `intents` — keyed by
// the seat handle when the declarer occupies one (so the state survives an occupant respawn), else by sid.
// `sid` records which occupant actually spoke.
export interface DeclaredIntent {
  intent: WorkIntent;
  ts: number;
  note?: string;
  sid?: string;
}

// A role's post on one thread (threads-as-cards §5) — the durable participant. Keyed on the marker's
// `seats` by handle (= the bare role name until labelled multiplicity ships). `sid` is the current
// occupant; `fills` distinguishes a re-fill from a first fill.
export interface SeatRecord {
  role: string;
  sid: string;
  createdAt: number;
  filledAt: number;
  fills: number;
}

// A thread's on-disk marker — the rail's source of truth. createdAt is written once; title/text/lastSeq/lastTs
// are refreshed on each append. Legacy markers carry `chanId`; the readers normalize it into `threadId`.
// Extra keys tolerated (the reader merges) — typed loosely as the session marker is.
export interface ThreadMetaMarker {
  threadId: string;
  chanId?: string; // legacy key, preserved verbatim on carried-over markers
  title?: string;
  text?: string;
  createdAt?: number;
  lastSeq?: number;
  lastTs?: number;
  intents?: Record<string, DeclaredIntent>;
  seats?: Record<string, SeatRecord>;
}

export function canvasThreadsDir(repoPath: string): string;
export function migrateChannelLedger(repoPath: string): boolean;
export function appendThreadLine(repoPath: string, threadId: string, msg: ThreadLogMsg): void;
export function readThreadLog(repoPath: string, threadId: string): ThreadLogMsg[];
export function readThreadMeta(repoPath: string, threadId: string): ThreadMetaMarker | null;
export function upsertThreadMeta(repoPath: string, threadId: string, data: Record<string, unknown>): void;
export function listThreads(repoPath: string): ThreadMetaMarker[];
export function fillSeat(
  repoPath: string,
  threadId: string,
  role: string,
  sid: string,
  ts: number,
): { seat: SeatRecord; refilled: boolean };
export function seatForSid(seats: Record<string, SeatRecord> | undefined, sid: string): string | null;
