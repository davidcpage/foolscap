// Types for coordinator-heartbeat.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts
// can import the canonical Coordinator-heartbeat spec without allowJs. Keep in sync with the module's exports.

export const COORDINATOR_ROLE: "Coordinator";
export const COORDINATOR_HEARTBEAT_INTERVAL_MS: number;
export const COORDINATOR_HEARTBEAT_INSTRUCTION: string;

export interface CoordinatorHeartbeatJobSpec {
  role: "Coordinator";
  intervalMs: number;
  instruction: string;
}
export function coordinatorHeartbeatJobSpec(opts?: { intervalMs?: number }): CoordinatorHeartbeatJobSpec;
