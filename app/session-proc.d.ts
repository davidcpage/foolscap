// Types for session-proc.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import without allowJs. Keep in sync with the exports.

export type ExitReason = "self" | "killed" | "shutdown";

export interface SessionProc {
  readonly kind: "local" | "remote";
  readonly alive: boolean;
  /** Write ONE stream-json line to the child's stdin (the \n is appended). False if not alive. */
  write(jsonLine: string): boolean;
  /** Resolve a provider-owned human gate. Unsupported by local Claude children. */
  answerRequest(requestId: string, answer: unknown): boolean;
  kill(): void;
}

export interface ProcHooks {
  onLine(line: string): void;
  onExit(info: { code: number | null; reason: ExitReason }): void;
}

/** `env` EXTENDS the owner's environment for this child (per-spawn knobs), never replaces it. */
export interface ClaudeSpawnSpec {
  provider?: "claude";
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface CodexSpawnSpec {
  provider: "codex";
  cwd: string;
  model?: string;
  reasoningEffort?: string; // the app-server's native thread-start reasoning-effort field (low|medium|high|xhigh|max)
  developerInstructions?: string;
  resumeProviderId?: string;
}

export type SpawnSpec = ClaudeSpawnSpec | CodexSpawnSpec;

export function localProc(opts: ClaudeSpawnSpec, hooks: ProcHooks): SessionProc;

export function remoteProc(
  client: import("./session-host-client.js").SessionHostClient,
  id: string,
  hooks: ProcHooks,
  opts?: { spawn?: SpawnSpec },
): SessionProc;
