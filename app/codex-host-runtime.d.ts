export interface CodexHostAccount {
  type: "chatgpt";
  email: string | null;
  planType: string;
}

export interface CodexHostRuntime {
  readonly pid: number | undefined;
  readonly account: CodexHostAccount;
  usage(): {
    provider: "codex";
    billing: "chatgpt-plan";
    account: { type: string; email: string | null; planType: string };
    rateLimits?: Record<string, unknown>;
    rateLimitsByLimitId?: Record<string, Record<string, unknown>> | null;
    rateLimitResetCredits?: Record<string, unknown> | null;
    error: string | null;
    fetchedAt: number | null;
  };
  start(sid: string, spec: CodexHostThreadSpec): Promise<{ threadId: string }>;
  resume(sid: string, providerSessionId: string, spec: CodexHostThreadSpec): Promise<{ threadId: string }>;
  prompt(sid: string, text: string): Promise<unknown>;
  steer(sid: string, text: string): Promise<unknown>;
  interrupt(sid: string): Promise<unknown>;
  read(sid: string): Promise<unknown>;
  readThread(providerSessionId: string): Promise<unknown>;
  release(sid: string): Promise<boolean>;
  close(): void;
}

export interface CodexHostThreadSpec {
  cwd: string;
  model?: string;
  developerInstructions?: string;
}

export function createCodexHostRuntime(opts: {
  cwd: string;
  onEvent(sid: string | null, message: { method?: string; params?: Record<string, any> }): void;
  onRequest(sid: string, request: Record<string, unknown>): Promise<unknown>;
  onClose(reason: Error): void;
  spawnServer?: (...args: any[]) => any;
}): Promise<CodexHostRuntime>;

export function mergeRateLimitUpdate(previous: any, update: any): any;
