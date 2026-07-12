// Types for role-format.js (pure ESM codec, runs in node AND the browser). Hand-written so both
// vite-fs-plugin.ts / role-ledger.js and the browser role card can import it. Keep in sync with the exports.

export const ROLE_NAME_RE: RegExp;
export function isValidRoleName(name: unknown): boolean;
export function roleIdFor(name: string): string;
export function renderRoleFile(role: {
  name: string;
  colour?: string | null;
  loops?: boolean;
  model?: string | null;
  charter?: string;
}): string;
export function parseRoleFile(
  text: string,
  roleId: string,
): { roleId: string; name: string; colour: string | null; loops: boolean; model: string | null; charter: string };
