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
  createRole,
  readRole,
  listRoles,
  isValidRoleName,
  roleIdFor,
  seedDefaultRole,
} from "../role-ledger.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "role-"));
}

test("createRole writes role.md under .canvas/roles/ and round-trips through readRole", () => {
  const repo = tmpRepo();
  const made = createRole(repo, { name: "Oracle", colour: "purple", charter: "Answer in file:line." });
  assert.deepEqual(made, { roleId: "oracle", name: "Oracle", colour: "purple", charter: "Answer in file:line." });
  // It lives where the gitignored, shadow-versioned home expects it.
  const f = path.join(canvasRolesDir(repo), "oracle", "role.md");
  assert.ok(fs.existsSync(f), "role.md is under .canvas/roles/<roleId>/");
  // The on-disk file is human-authored frontmatter + charter body, no machine timestamps mixed in.
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /^---\nname: Oracle\ncolour: purple\n---/);
  assert.doesNotMatch(text, /createdAt|spawnedAt|\d{13}/, "no machine timestamps in the frontmatter");
  // readRole recovers name/colour/charter (roleId is the lowercased slug).
  assert.deepEqual(readRole(repo, "oracle"), {
    roleId: "oracle",
    name: "Oracle",
    colour: "purple",
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
  createRole(repo, { name: "Alpha", charter: "a" });
  // Sorted by name; the charter is NOT included in the list (read only on instantiation).
  assert.deepEqual(listRoles(repo), [
    { roleId: "alpha", name: "Alpha", colour: null },
    { roleId: "zebra", name: "Zebra", colour: "blue" },
  ]);
});

test("listRoles ignores stray non-directory entries in the roles dir", () => {
  const repo = tmpRepo();
  createRole(repo, { name: "Real" });
  fs.writeFileSync(path.join(canvasRolesDir(repo), "stray.txt"), "junk"); // a loose file, not a role dir
  assert.deepEqual(listRoles(repo).map((r) => r.roleId), ["real"]);
});

test("seedDefaultRole seeds one role on an empty board and is idempotent", () => {
  const repo = tmpRepo();
  seedDefaultRole(repo);
  const after = listRoles(repo);
  assert.equal(after.length, 1, "exactly one role seeded");
  assert.equal(after[0].name, "Generalist");
  // Running again does NOT add a second or clobber — the board already has a role.
  seedDefaultRole(repo);
  assert.equal(listRoles(repo).length, 1, "idempotent");
});

test("seedDefaultRole leaves an already-populated board untouched", () => {
  const repo = tmpRepo();
  createRole(repo, { name: "Oracle" });
  seedDefaultRole(repo);
  assert.deepEqual(listRoles(repo).map((r) => r.roleId), ["oracle"], "no default added when roles exist");
});
