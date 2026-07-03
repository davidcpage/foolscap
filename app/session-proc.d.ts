// Types for session-proc.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import without allowJs. Keep in sync with the exports.

export type ExitReason = "self" | "killed" | "shutdown";

export interface SessionProc {
  readonly kind: "local" | "remote";
  readonly alive: boolean;
  /** Write ONE stream-json line to the child's stdin (the \n is appended). False if not alive. */
  write(jsonLine: string): boolean;
  kill(): void;
}

export interface ProcHooks {
  onLine(line: string): void;
  onExit(info: { code: number | null; reason: ExitReason }): void;
}

export function localProc(
  opts: { cmd: string; args: string[]; cwd: string },
  hooks: ProcHooks,
): SessionProc;

export function remoteProc(
  client: import("./session-host-client.js").SessionHostClient,
  id: string,
  hooks: ProcHooks,
  opts?: { spawn?: { cmd: string; args: string[]; cwd: string } },
): SessionProc;
