// The pure role.md codec shared by the server ledger and the browser role card. These guard the round-trip
// both sides depend on — a drift here silently corrupts a role when the card saves it back.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderRoleFile,
  parseRoleFile,
  isValidRoleName,
  roleIdFor,
  ROLE_NAME_RE,
} from "../role-format.js";

test("render → parse round-trips name/colour/charter", () => {
  const text = renderRoleFile({ name: "Oracle", colour: "purple", charter: "Answer in file:line." });
  assert.deepEqual(parseRoleFile(text, "oracle"), {
    roleId: "oracle",
    name: "Oracle",
    colour: "purple",
    loops: false,
    model: null,
    charter: "Answer in file:line.",
  });
});

test("renderRoleFile omits the colour line when there is no colour; parse → colour:null", () => {
  const text = renderRoleFile({ name: "Plain", charter: "hi" });
  assert.doesNotMatch(text, /colour:/);
  assert.equal(parseRoleFile(text, "plain").colour, null);
});

test("loops round-trips: rendered only when true, parsed to a boolean", () => {
  const looped = renderRoleFile({ name: "Coordinator", colour: "green", loops: true, charter: "coordinate" });
  assert.match(looped, /^loops: true$/m);
  assert.equal(parseRoleFile(looped, "coordinator").loops, true);
  // omitted unless true; absent frontmatter ⇒ false (a plain reactive role)
  const plain = renderRoleFile({ name: "Plain", charter: "hi" });
  assert.doesNotMatch(plain, /loops:/);
  assert.equal(parseRoleFile(plain, "plain").loops, false);
  // tolerant of yes/1 as well as true
  assert.equal(parseRoleFile("---\nname: X\nloops: yes\n---\nc", "x").loops, true);
  assert.equal(parseRoleFile("---\nname: X\nloops: false\n---\nc", "x").loops, false);
});

test("model round-trips: rendered only when set, parsed to null when absent", () => {
  const pinned = renderRoleFile({ name: "Coordinator", loops: true, model: "claude-fable-5", charter: "c" });
  assert.match(pinned, /^model: claude-fable-5$/m);
  assert.equal(parseRoleFile(pinned, "coordinator").model, "claude-fable-5");
  // omitted unless set; absent frontmatter ⇒ null (the spawner's default model applies)
  const plain = renderRoleFile({ name: "Plain", charter: "hi" });
  assert.doesNotMatch(plain, /model:/);
  assert.equal(parseRoleFile(plain, "plain").model, null);
});

test("parseRoleFile falls back to roleId when the frontmatter omits name", () => {
  const text = "---\ncolour: blue\n---\n\nbody";
  assert.deepEqual(parseRoleFile(text, "fallback"), {
    roleId: "fallback",
    name: "fallback",
    colour: "blue",
    loops: false,
    model: null,
    charter: "body",
  });
});

test("parseRoleFile treats a file with no frontmatter fence as all-charter", () => {
  const r = parseRoleFile("just a charter, no fence", "x");
  assert.equal(r.name, "x");
  assert.equal(r.colour, null);
  assert.equal(r.charter, "just a charter, no fence");
});

test("parseRoleFile skips unknown frontmatter keys, keeps known ones", () => {
  const r = parseRoleFile("---\nname: Bot\nshape: task\ncolour: red\n---\n\nc", "bot");
  assert.equal(r.name, "Bot");
  assert.equal(r.colour, "red");
  assert.equal(r.charter, "c");
});

test("a charter with its own --- lines survives (only the FIRST fence is frontmatter)", () => {
  const charter = "intro\n\n---\n\na horizontal rule in the body";
  const text = renderRoleFile({ name: "Doc", charter });
  assert.equal(parseRoleFile(text, "doc").charter, charter);
});

test("validation + slug helpers are the same the ledger enforces", () => {
  assert.equal(isValidRoleName("Code-Reviewer"), true);
  assert.equal(isValidRoleName("has space"), false);
  assert.equal(isValidRoleName("dot.ted"), false);
  assert.equal(roleIdFor("Oracle"), "oracle");
  assert.ok(ROLE_NAME_RE instanceof RegExp);
});
