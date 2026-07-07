// Types for role-ledger.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the ledger without allowJs. Keep in sync with the exports in role-ledger.js.

export interface Role {
  roleId: string;
  name: string;
  colour: string | null;
  loops: boolean;
  charter: string;
}

export function canvasRolesDir(repoPath: string): string;
export function bundledRolesDir(): string;
export function bundledRoleFileFor(relPath: string): string | null;
export function isValidRoleName(name: unknown): boolean;
export function roleIdFor(name: string): string;
export function readRole(repoPath: string, roleId: string): Role | null;
export function createRole(
  repoPath: string,
  role: { name: string; charter?: string; colour?: string; loops?: boolean },
): Role;
export function listRoles(
  repoPath: string,
): Array<{ roleId: string; name: string; colour: string | null; loops: boolean }>;
