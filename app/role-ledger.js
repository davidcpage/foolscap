// The role ledger (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// A ROLE is a durable, named identity that ephemeral sessions instantiate (docs/agent-roles.md §3): the
// addressable thing, with the live session demoted to "the role currently online".
//
// Roles resolve in TWO LAYERS, base ← override:
//
//   1. BUNDLED DEFAULTS — `app/default-roles/<roleId>/role.md`, shipped with the server (tracked in git,
//      NOT under any board's `.canvas/`). These travel with the code, so EVERY board the server hosts —
//      including an external repo mounted as a board — sees them without a per-board seed. This is where
//      "roles defined in foolscap itself" live.
//   2. BOARD OVERRIDES — `<board repo>/.canvas/roles/<roleId>/role.md`, in the board's `.canvas/` home
//      (git-ignored, shadow-versioned like channels/sessions/images). A board file at a given `roleId`
//      OVERRIDES the bundled default of the same id (edit the Coordinator for this board), and a board file
//      at a NEW id ADDS a board-only role. The board layer always wins on an id collision.
//
// `role.md` is human-authored: YAML-ish frontmatter (`name`, `colour`) over a charter body — the mandate
// appended to a spawned session's system prompt. ONE file on purpose: a role's name and its charter are
// both human-set, edited together; machine timestamps stay OUT of the frontmatter so the file is pure
// human prose + config (the "two files" split in §3 is charter-vs-MEMORY, and memory is out of scope for
// now). `roleId` is a filesystem-safe slug of the name (lowercased) and is the stable directory key.
//
// Every write is best-effort in spirit, but createRole DOES surface failure to its caller (a POST that
// can't persist should 500, unlike a channel post whose durability is incidental).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidRoleName, roleIdFor, renderRoleFile, parseRoleFile } from "./role-format.js";

// The pure frontmatter codec (parse/serialise/validate) lives in role-format.js — a dependency-free module
// the browser role card imports too, so the two sides never drift on the format. Re-export the validators
// here so existing importers (vite-fs-plugin.ts, the ledger tests) keep their entry point.
export { isValidRoleName, roleIdFor };

/** The board-override layer: one sub-directory per role, under the board repo's `.canvas/` home. */
export function canvasRolesDir(repoPath) {
  return path.join(repoPath, ".canvas", "roles");
}

/**
 * The bundled-default layer: role dirs shipped with the server (`app/default-roles/`). Overridable via
 * CANVAS_DEFAULT_ROLES_DIR (used by tests to point at a controlled set; also an ops escape hatch).
 */
export function bundledRolesDir() {
  return (
    process.env.CANVAS_DEFAULT_ROLES_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "default-roles")
  );
}

function roleDir(repoPath, roleId) {
  return path.join(canvasRolesDir(repoPath), roleId);
}
function rolePath(repoPath, roleId) {
  return path.join(roleDir(repoPath, roleId), "role.md");
}

/**
 * The absolute bundled-default `role.md` backing a board-relative role path (`.canvas/roles/<id>/role.md`),
 * or null if it's not a role path / no such default ships. Lets the generic file endpoint serve a shipped
 * role's bytes read-only when the board has no override yet — the read half of copy-on-write: the role card
 * MIRRORS the bundled default until an edit writes the board's own `.canvas/roles/<id>/role.md`.
 */
export function bundledRoleFileFor(relPath) {
  if (typeof relPath !== "string") return null;
  const m = /^\.canvas\/roles\/([^/]+)\/role\.md$/.exec(relPath.split(path.sep).join("/"));
  if (!m) return null;
  const file = path.join(bundledRolesDir(), m[1], "role.md");
  return fs.existsSync(file) ? file : null;
}

/** Read a role.md from a specific layer directory, or null if absent/unreadable. */
function readRoleFrom(layerDir, roleId) {
  try {
    return parseRoleFile(fs.readFileSync(path.join(layerDir, roleId, "role.md"), "utf8"), roleId);
  } catch {
    return null;
  }
}

/** The role ids (sub-directory names) present in a layer directory; [] if the dir is missing. */
function roleIdsIn(layerDir) {
  try {
    return fs
      .readdirSync(layerDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Read one role, or null if there is no such role / it's unreadable. Returns
 * { roleId, name, colour, charter } — `charter` is the body fed to --append-system-prompt. The board's
 * override wins; otherwise the bundled default answers, so a fresh board still resolves the shipped roles.
 */
export function readRole(repoPath, roleId) {
  if (typeof roleId !== "string" || !roleId) return null;
  return readRoleFrom(canvasRolesDir(repoPath), roleId) ?? readRoleFrom(bundledRolesDir(), roleId);
}

/**
 * Create a role: write `.canvas/roles/<roleId>/role.md` into the board layer. Throws on an invalid name or
 * a clash with an existing BOARD role (the caller maps these to 400/409). Creating a role whose id matches
 * a bundled default is allowed — that is exactly how a board OVERRIDES a shipped role. Returns the created
 * { roleId, name, colour, charter }.
 */
export function createRole(repoPath, { name, charter, colour, loops } = {}) {
  if (!isValidRoleName(name)) throw new Error("invalid role name (use letters, digits, hyphens)");
  const roleId = roleIdFor(name);
  if (fs.existsSync(rolePath(repoPath, roleId))) throw new Error(`role "${roleId}" already exists`);
  fs.mkdirSync(roleDir(repoPath, roleId), { recursive: true });
  fs.writeFileSync(rolePath(repoPath, roleId), renderRoleFile({ name, colour, charter, loops }));
  return { roleId, name, colour: colour ?? null, loops: !!loops, charter: (charter ?? "").trim() };
}

/**
 * List every role available on this board, by name — the source for the role-picker on "new session".
 * Merges the two layers: bundled defaults first, then board overrides win on an id collision (and add
 * board-only roles). Each entry is { roleId, name, colour, loops } — the charter is read only when a role
 * is actually instantiated. `loops` rides the list so the heartbeat / picker can tell a looping role at a
 * glance.
 */
export function listRoles(repoPath) {
  const byId = new Map();
  // Base layer, then override layer — later writes to the same id win.
  for (const [layerDir, roleId] of [
    ...roleIdsIn(bundledRolesDir()).map((id) => [bundledRolesDir(), id]),
    ...roleIdsIn(canvasRolesDir(repoPath)).map((id) => [canvasRolesDir(repoPath), id]),
  ]) {
    const r = readRoleFrom(layerDir, roleId);
    if (r && r.name) byId.set(r.roleId, r);
  }
  return [...byId.values()]
    .map(({ roleId, name, colour, loops }) => ({ roleId, name, colour, loops: !!loops }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
