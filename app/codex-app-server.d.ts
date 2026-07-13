export interface CodexRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class CodexAppServerError extends Error {
  method?: string;
  id?: string | number;
  code?: number | null;
  signal?: string | null;
  reason?: "self" | "killed";
  data?: unknown;
}

export interface CodexAppServerPeer {
  readonly ready: Promise<unknown>;
  readonly closed: boolean;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  receiveLine(line: string): void;
  close(reason?: Error): void;
  onNotification(listener: (message: CodexRpcMessage) => void): () => void;
  onClose(listener: (reason: Error) => void): () => void;
  setRequestHandler(handler: ((message: CodexRpcMessage) => unknown | Promise<unknown>) | null): void;
}

export function createCodexAppServerPeer(opts: {
  writeLine(line: string): void;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title: string; version: string };
  capabilities?: Record<string, unknown>;
}): CodexAppServerPeer;

export interface SpawnedCodexAppServer extends CodexAppServerPeer {
  readonly pid: number | undefined;
  readonly alive: boolean;
  kill(): void;
}

export function spawnCodexAppServer(opts?: {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title: string; version: string };
  capabilities?: Record<string, unknown>;
  spawnProcess?: (...args: any[]) => any;
}): SpawnedCodexAppServer;
