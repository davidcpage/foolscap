// The role ledger: durable, named identities (charter in `.canvas/roles/<roleId>/role.md`) that ephemeral
// sessions instantiate. Storage + frontmatter round-trip + the name validation that keeps a role a tag-safe
// handle. (agent-roles.md §3.)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canvasRolesDir,
  bundledRolesDir,
  bundledRoleFileFor,
  createRole,
  readRole,
  listRoles,
  isValidRoleName,
  roleIdFor,
} from "../role-ledger.js";

// Isolate the BUNDLED-DEFAULT layer from the real `app/default-roles/` for the bulk of these tests, so a
// unit assertion about the board layer isn't perturbed by whatever ships. Point it at an empty dir here;
// the layering tests below re-point it at a controlled set and restore it.
process.env.CANVAS_DEFAULT_ROLES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "role-bundled-empty-"));

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "role-"));
}

/** A throwaway "bundled defaults" dir holding the given roles, for the layering tests. */
function tmpBundled(roles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-bundled-"));
  for (const { name, colour, charter, loops } of roles) createRole(dir, { name, colour, charter, loops });
  // createRole writes under `<dir>/.canvas/roles/`, but the bundled layer is a bare role-dir root.
  return canvasRolesDir(dir);
}

test("createRole writes role.md under .canvas/roles/ and round-trips through readRole", () => {
  const repo = tmpRepo();
  const made = createRole(repo, { name: "Oracle", colour: "purple", charter: "Answer in file:line." });
  assert.deepEqual(made, { roleId: "oracle", name: "Oracle", colour: "purple", loops: false, model: null, charter: "Answer in file:line." });
  // It lives where the gitignored, shadow-versioned home expects it.
  const f = path.join(canvasRolesDir(repo), "oracle", "role.md");
  assert.ok(fs.existsSync(f), "role.md is under .canvas/roles/<roleId>/");
  // The on-disk file is human-authored frontmatter + charter body, no machine timestamps mixed in.
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /^---\nname: Oracle\ncolour: purple\n---/);
  assert.doesNotMatch(text, /createdAt|spawnedAt|\d{13}/, "no machine timestamps in the frontmatter");
  // readRole recovers name/colour/loops/charter (roleId is the lowercased slug).
  assert.deepEqual(readRole(repo, "oracle"), {
    roleId: "oracle",
    name: "Oracle",
    colour: "purple",
    loops: false,
    model: null,
    charter: "Answer in file:line.",
  });
});

test("a role with no colour omits the frontmatter line and reads back colour:null", () => {
  const repo = tmpRepo();
  createRole(repo, { name: "Plain", charter: "hi" });
  const text = fs.readFileSync(path.join(canvasRolesDir(repo), "plain", "role.md"), "utf8");
  assert.doesNotMatch(text, /colour:/, "no colour line when none given");
  assert.equal(readRole(repo, "plain").colour, null);
});

test("readRole returns null for an unknown role, not a throw", () => {
  const repo = tmpRepo();
  assert.equal(readRole(repo, "nope"), null);
  assert.equal(readRole(repo, ""), null);
});

test("createRole rejects a clashing roleId (case-insensitive) with an 'already exists' error", () => {
  const repo = tmpRepo();
  createRole(repo, { name: "Oracle" });
  assert.throws(() => createRole(repo, { name: "oracle" }), /already exists/, "same slug clashes");
  assert.throws(() => createRole(repo, { name: "ORACLE" }), /already exists/, "case-insensitive clash");
});

test("role names must be a tag-safe single token (letters/digits/hyphens)", () => {
  assert.equal(isValidRoleName("Oracle"), true);
  assert.equal(isValidRoleName("code-reviewer"), true);
  assert.equal(isValidRoleName("Bot7"), true);
  assert.equal(isValidRoleName("bad name"), false, "no spaces — would break the @tag handle");
  assert.equal(isValidRoleName("dot.ted"), false, "no dots — the dot is the name↔sid separator");
  assert.equal(isValidRoleName("-lead"), false, "must start with a letter/digit");
  assert.equal(isValidRoleName(""), false);
  assert.equal(isValidRoleName(42), false);
  const repo = tmpRepo();
  assert.throws(() => createRole(repo, { name: "bad name!" }), /invalid role name/);
});

test("roleIdFor lowercases the name into the stable slug", () => {
  assert.equal(roleIdFor("Oracle"), "oracle");
  assert.equal(roleIdFor("Code-Reviewer"), "code-reviewer");
});

test("listRoles returns every role by name; missing dir → [] not a throw", () => {
  const repo = tmpRepo();
  assert.deepEqual(listRoles(repo), [], "no roles dir yet → empty, not a throw");
  createRole(repo, { name: "Zebra", colour: "blue", charter: "z" });
  createRole(repo, { name: "Alpha", charter: "a", loops: true });
  // Sorted by name; the charter is NOT included in the list (read only on instantiation). `loops` rides
  // the list (false unless the role opts in) so the heartbeat/picker can tell a looping role at a glance.
  assert.deepEqual(listRoles(repo), [
    { roleId: "alpha", name: "Alpha", colour: null, loops: true },
    { roleId: "zebra", name: "Zebra", colour: "blue", loops: false },
  ]);
});

test("listRoles ignores stray non-directory entries in the roles dir", () => {
  const repo = tmpRepo();
  createRole(repo, { name: "Real" });
  fs.writeFileSync(path.join(canvasRolesDir(repo), "stray.txt"), "junk"); // a loose file, not a role dir
  assert.deepEqual(listRoles(repo).map((r) => r.roleId), ["real"]);
});

test("the SHIPPED bundled defaults resolve on a fresh board with no .canvas/roles/", () => {
  // The real `app/default-roles/` is the base layer every board inherits. Temporarily un-isolate to assert
  // the packaged set is present (this is what an external repo now sees without any per-board seed).
  const saved = process.env.CANVAS_DEFAULT_ROLES_DIR;
  delete process.env.CANVAS_DEFAULT_ROLES_DIR;
  try {
    const repo = tmpRepo(); // no board-layer roles at all
    const ids = listRoles(repo).map((r) => r.roleId);
    assert.ok(ids.includes("generalist"), "Generalist ships as a bundled default");
    assert.ok(ids.includes("oracle"), "Oracle ships as a bundled default");
    assert.ok(ids.includes("pm"), "Coordinator ships as a bundled default");
    // And a bundled role is fully readable (charter included) without any board file.
    assert.equal(readRole(repo, "generalist")?.name, "Generalist");
  } finally {
    process.env.CANVAS_DEFAULT_ROLES_DIR = saved;
  }
});

test("listRoles merges bundled defaults with board roles, board WINS on an id collision", () => {
  process.env.CANVAS_DEFAULT_ROLES_DIR = tmpBundled([
    { name: "Generalist", colour: "blue", charter: "shipped generalist" },
    { name: "Oracle", colour: "purple", charter: "shipped oracle" },
  ]);
  const repo = tmpRepo();
  // Board OVERRIDES the shipped Generalist and ADDS a board-only role.
  createRole(repo, { name: "Generalist", colour: "red", charter: "this board's generalist" });
  createRole(repo, { name: "Specialist", charter: "board-only" });

  const roles = listRoles(repo);
  assert.deepEqual(roles.map((r) => r.roleId).sort(), ["generalist", "oracle", "specialist"]);
  // The override wins: colour comes from the BOARD file, not the bundled default.
  assert.equal(roles.find((r) => r.roleId === "generalist").colour, "red");
  assert.equal(readRole(repo, "generalist").charter, "this board's generalist");
  // A non-overridden default still resolves from the bundled layer.
  assert.equal(readRole(repo, "oracle").charter, "shipped oracle");
  // A board-only role resolves from the board layer.
  assert.equal(readRole(repo, "specialist").charter, "board-only");
});

test("bundledRoleFileFor resolves a role.md path to its bundled default, else null", () => {
  process.env.CANVAS_DEFAULT_ROLES_DIR = tmpBundled([{ name: "Oracle", charter: "bundled" }]);
  // A role path that HAS a bundled default → the absolute bundled file (this is what the file endpoint
  // serves read-only so the card mirrors the shipped role until the board overrides it).
  const hit = bundledRoleFileFor(".canvas/roles/oracle/role.md");
  assert.ok(hit && hit.endsWith(path.join("oracle", "role.md")), "resolves to the bundled oracle role.md");
  assert.equal(fs.readFileSync(hit, "utf8").includes("bundled"), true);
  // A role path with NO bundled default → null (a board-only role has its real file; nothing to mirror).
  assert.equal(bundledRoleFileFor(".canvas/roles/specialist/role.md"), null);
  // Not a role path at all → null (the fallback must never fire for arbitrary files).
  assert.equal(bundledRoleFileFor("docs/notes.md"), null);
  assert.equal(bundledRoleFileFor(".canvas/roles/oracle/notes.md"), null, "only role.md, not siblings");
  assert.equal(bundledRoleFileFor(".canvas/roles/oracle"), null, "the dir itself is not a file");
  assert.equal(bundledRoleFileFor(""), null);
});

test("readRole prefers the board layer, then falls back to the bundled default, else null", () => {
  process.env.CANVAS_DEFAULT_ROLES_DIR = tmpBundled([{ name: "Oracle", charter: "bundled" }]);
  const repo = tmpRepo();
  assert.equal(readRole(repo, "oracle").charter, "bundled", "falls back to bundled when board has none");
  createRole(repo, { name: "Oracle", charter: "board override" });
  assert.equal(readRole(repo, "oracle").charter, "board override", "board layer wins once present");
  assert.equal(readRole(repo, "nonesuch"), null, "unknown in both layers → null");
});
