// Types for session-host-client.js (plain ESM). Keep in sync with the exports.

import type { ProcHooks, ExitReason } from "./session-proc.js";

export interface HostSessionInfo {
  id: string;
  cwd: string;
  busy: boolean;
  spawnedAt: number;
  pid: number | undefined;
  provider: "claude" | "codex";
  providerSessionId?: string | null;
}
export interface HostExitRecord {
  id: string;
  cwd: string;
  code: number | null;
  signal: string | null;
  ts: number;
  reason: ExitReason;
}

export interface SessionHostClient {
  readonly connected: boolean;
  attach(id: string, hooks: ProcHooks): void;
  detach(id: string): void;
  /** Fire-and-forget; a failed spawn surfaces as onExit({reason:"self"}) on the attached hooks. */
  spawnSession(id: string, spec: import("./session-proc.js").SpawnSpec): void;
  writeSession(id: string, data: string): boolean;
  killSession(id: string): void;
  list(): Promise<{ sessions: HostSessionInfo[]; exits: HostExitRecord[] }>;
  ackExits(ids: string[]): Promise<void>;
  close(): void;
}

export function connectSessionHost(opts: {
  socketPath: string;
  hostScript?: string;
  clientPid?: number;
}): Promise<SessionHostClient>;
