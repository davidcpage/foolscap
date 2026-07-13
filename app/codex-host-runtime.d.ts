export interface CodexHostAccount {
  type: "chatgpt";
  email: string | null;
  planType: string;
}

export interface CodexHostRuntime {
  readonly pid: number | undefined;
  readonly account: CodexHostAccount;
  start(sid: string, spec: CodexHostThreadSpec): Promise<{ threadId: string }>;
  resume(sid: string, providerSessionId: string, spec: CodexHostThreadSpec): Promise<{ threadId: string }>;
  prompt(sid: string, text: string): Promise<unknown>;
  steer(sid: string, text: string): Promise<unknown>;
  interrupt(sid: string): Promise<unknown>;
  read(sid: string): Promise<unknown>;
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
  onClose(reason: Error): void;
  spawnServer?: (...args: any[]) => any;
}): Promise<CodexHostRuntime>;
