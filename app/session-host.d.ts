// Types for session-host.js (plain ESM). The dev server talks to the host over the socket protocol —
// createHost is imported directly only by tests (and the CLI main guard). Keep in sync.

export interface SessionHost {
  shutdown(): Promise<void>;
  socketPath: string;
  pid: number;
}
export function createHost(opts: { socketPath: string; logPath: string }): Promise<SessionHost>;
