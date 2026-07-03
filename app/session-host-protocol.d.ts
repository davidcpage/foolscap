// Types for session-host-protocol.js (plain ESM, runs under node --test). Hand-written so
// vite-fs-plugin.ts can import without allowJs. Keep in sync with the exports.

export const PROTOCOL_VERSION: number;
export function sessionHostSocketPath(appDir: string): string;
export function sessionHostLogPath(appDir: string): string;
export function makeLineSplitter(onLine: (line: string) => void): (chunk: string) => void;
export function isResultLine(line: string): boolean;
export function isUserWrite(data: string): boolean;
