import type { CodexAppServerPeer, CodexRpcMessage } from "./codex-app-server.js";

export interface CodexRoutedSession {
  sid: string;
  threadId: string;
  status: string;
  activeTurnId: string | null;
  cwd: string | null;
  model: string | null;
}

export interface CodexSessionRouter {
  start(sid: string, spec?: Record<string, unknown>): Promise<CodexRoutedSession>;
  resume(sid: string, threadId: string, spec?: Record<string, unknown>): Promise<CodexRoutedSession>;
  prompt(sid: string, text: string, overrides?: Record<string, unknown>): Promise<unknown>;
  steer(sid: string, text: string): Promise<unknown>;
  interrupt(sid: string): Promise<unknown>;
  read(sid: string, includeTurns?: boolean): Promise<unknown>;
  release(sid: string): Promise<boolean>;
  get(sid: string): CodexRoutedSession | null;
  list(): CodexRoutedSession[];
  close(): void;
}

export function createCodexSessionRouter(opts: {
  client: CodexAppServerPeer;
  onEvent?: (sid: string | null, message: CodexRpcMessage) => void;
  onRequest?: ((sid: string | null, message: CodexRpcMessage) => unknown | Promise<unknown>) | null;
}): CodexSessionRouter;
