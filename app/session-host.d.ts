// Types for session-host.js (plain ESM). The dev server talks to the host over the socket protocol —
// createHost is imported directly only by tests (and the CLI main guard). Keep in sync.

export interface SessionHost {
  shutdown(): Promise<void>;
  socketPath: string;
  pid: number;
}
export function createHost(opts: {
  socketPath: string;
  logPath: string;
  codexRuntimeFactory?: (...args: any[]) => Promise<import("./codex-host-runtime.js").CodexHostRuntime>;
  codexSpawnFailureCooldownMs?: number;
}): Promise<SessionHost>;

export const CODEX_SPAWN_FAILURE_COOLDOWN_MS: number;
export function codexSpawnBlocked(
  failure: { error: Error; until: number } | null,
  now?: number,
): boolean;
