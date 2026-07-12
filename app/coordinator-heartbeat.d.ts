// Types for coordinator-heartbeat.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts
// can import the canonical Coordinator-heartbeat spec without allowJs. Keep in sync with the module's exports.

export const COORDINATOR_ROLE: "Coordinator";
export const COORDINATOR_HEARTBEAT_INTERVAL_MS: number;
export const HEARTBEAT_BLOCKED_HUMAN_INTERVAL_MS: number;
export const COORDINATOR_HEARTBEAT_INSTRUCTION: string;
export function heartbeatEffectiveInterval(baseIntervalMs: number, intent: string | null | undefined): number;

export const HEARTBEAT_STALE_BUCKET_MS: number;
export interface SweepSignatureState {
  threads?: Array<{ threadId?: string; lastTs?: number; intents?: Record<string, { intent?: string; ts?: number }> } | null> | null;
  sessions?: Array<{ sid?: string; status?: string } | null> | null;
}
export function heartbeatSweepSignature(state: SweepSignatureState | undefined, now: number, selfRole?: string): string;

export interface CoordinatorHeartbeatJobSpec {
  role: "Coordinator";
  intervalMs: number;
  instruction: string;
}
export function coordinatorHeartbeatJobSpec(opts?: { intervalMs?: number }): CoordinatorHeartbeatJobSpec;
