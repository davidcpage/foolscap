// The role ledger (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// A ROLE is a durable, named identity that ephemeral sessions instantiate (docs/agent-roles.md §3): the
// addressable thing, with the live session demoted to "the role currently online". This is its on-disk
// home — one directory per role under the board's `.canvas/` home (git-ignored, shadow-versioned like
// channels/sessions/images), holding a single `role.md`:
//
//     .canvas/roles/<roleId>/role.md
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

/** The directory holding one sub-directory per role, under the board repo's `.canvas/` home. */
export function canvasRolesDir(repoPath) {
  return path.join(repoPath, ".canvas", "roles");
}

function roleDir(repoPath, roleId) {
  return path.join(canvasRolesDir(repoPath), roleId);
}
function rolePath(repoPath, roleId) {
  return path.join(roleDir(repoPath, roleId), "role.md");
}

// A role NAME is also the @-tag handle (cards are named `<Name>.<short-sid>`), so it must be a single
// tag-safe token: a letter/digit start, then letters/digits/hyphens. No spaces or dots (the dot is the
// name↔sid separator in a card name). roleId is the lowercased name — stable across renames-of-case.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Is `name` a valid role handle (tag-safe single token)? */
export function isValidRoleName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

/** The filesystem-safe, stable id for a role name (lowercase slug). */
export function roleIdFor(name) {
  return String(name).toLowerCase();
}

// Serialize / parse the tiny frontmatter. Deliberately NOT a full YAML parser — flat `key: value` lines
// between two `---` fences, values are plain strings. Matches what we write; tolerant of what it reads.
function renderRoleFile({ name, colour, charter }) {
  const fm = [`name: ${name}`];
  if (colour) fm.push(`colour: ${colour}`);
  return `---\n${fm.join("\n")}\n---\n\n${(charter ?? "").trim()}\n`;
}

function parseRoleFile(text, roleId) {
  let name = roleId;
  let colour = null;
  let charter = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === "name" && v) name = v;
      else if (k === "colour" && v) colour = v;
    }
    charter = text.slice(m[0].length);
  }
  return { roleId, name, colour, charter: charter.trim() };
}

/**
 * Read one role, or null if there is no such role / it's unreadable. Returns
 * { roleId, name, colour, charter } — `charter` is the body fed to --append-system-prompt.
 */
export function readRole(repoPath, roleId) {
  if (typeof roleId !== "string" || !roleId) return null;
  try {
    return parseRoleFile(fs.readFileSync(rolePath(repoPath, roleId), "utf8"), roleId);
  } catch {
    return null;
  }
}

/**
 * Create a role: write `.canvas/roles/<roleId>/role.md`. Throws on an invalid name or a clash with an
 * existing role (the caller maps these to 400/409). Returns the created { roleId, name, colour, charter }.
 */
export function createRole(repoPath, { name, charter, colour } = {}) {
  if (!isValidRoleName(name)) throw new Error("invalid role name (use letters, digits, hyphens)");
  const roleId = roleIdFor(name);
  if (fs.existsSync(rolePath(repoPath, roleId))) throw new Error(`role "${roleId}" already exists`);
  fs.mkdirSync(roleDir(repoPath, roleId), { recursive: true });
  fs.writeFileSync(rolePath(repoPath, roleId), renderRoleFile({ name, colour, charter }));
  return { roleId, name, colour: colour ?? null, charter: (charter ?? "").trim() };
}

/**
 * List every role this board has on disk, by name. The source for the role-picker on "new session".
 * Each entry is { roleId, name, colour } — the charter is read only when a role is actually instantiated.
 */
export function listRoles(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(canvasRolesDir(repoPath), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readRole(repoPath, e.name))
    .filter((r) => r && r.name)
    .map(({ roleId, name, colour }) => ({ roleId, name, colour }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ensure a board has at least one role so the picker is never empty on a fresh board. Idempotent: seeds the
 * default only when the roles dir holds none. Best-effort — a failed seed just leaves an empty picker.
 */
export function seedDefaultRole(repoPath) {
  try {
    if (listRoles(repoPath).length > 0) return;
    createRole(repoPath, {
      name: "Generalist",
      colour: "blue",
      charter:
        "You are a Generalist agent on this canvas — a general-purpose collaborator with no narrower " +
        "mandate. Help with whatever the current work needs, coordinate with peers over channels, and " +
        "ask on the channel when you need direction.",
    });
  } catch {
    /* not fatal — the board simply starts with no roles until one is created */
  }
}
