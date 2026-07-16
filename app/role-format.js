// The role.md codec (PURE — no node imports, runs in both the dev-server and the browser). One source of
// truth for `role.md text <-> { name, colour, charter }`, shared by the server-side ledger (role-ledger.js)
// and the browser-side role card so the two never drift on the frontmatter format.
//
// A role.md is a tiny human-authored file: YAML-ish frontmatter (flat `key: value` lines between two `---`
// fences — name, colour) over a charter body. Deliberately NOT a full YAML parser: it matches exactly what
// renderRoleFile writes and is tolerant of what it reads (an unknown key is skipped, a missing fence means
// the whole file is the charter).

// A role NAME is also the @-tag handle (cards are named `<Name>.<short-sid>`), so it must be a single
// tag-safe token: a letter/digit start, then letters/digits/hyphens. No spaces or dots (the dot is the
// name-to-sid separator in a card name). roleId is the lowercased name — stable across renames-of-case.
export const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Is `name` a valid role handle (tag-safe single token)? */
export function isValidRoleName(name) {
  return typeof name === "string" && ROLE_NAME_RE.test(name);
}

/** The filesystem-safe, stable id for a role name (lowercase slug). */
export function roleIdFor(name) {
  return String(name).toLowerCase();
}

/**
 * Serialise { name, colour?, charter?, loops?, model?, effort? } to role.md text. Omits the colour line
 * when there is no colour, the `loops` line unless it's true (an operating-loop role woken on the server
 * heartbeat — agent-roles.md; the absent default is a plain reactive role), the `model` line when there is
 * none (the spawner's default model applies — server-sessions.ts resolveSessionModel), and the `effort`
 * line when there is none (the provider default reasoning effort applies — no `--effort`/`reasoningEffort`
 * sent). `model` and `effort` are provider-aware at spawn: a role's Claude `model:` is ignored on a Codex
 * spawn (and vice versa); `effort:` is a bare level (low|medium|high|xhigh|max) valid on both providers.
 */
export function renderRoleFile({ name, colour, charter, loops, model, effort }) {
  const fm = [`name: ${name}`];
  if (colour) fm.push(`colour: ${colour}`);
  if (loops) fm.push(`loops: true`);
  if (model) fm.push(`model: ${model}`);
  if (effort) fm.push(`effort: ${effort}`);
  return `---\n${fm.join("\n")}\n---\n\n${(charter ?? "").trim()}\n`;
}

/**
 * Parse role.md text to { roleId, name, colour, charter, loops, model, effort }. `roleId` is taken as given
 * (the caller knows it from the directory / file path); `name` falls back to roleId when the frontmatter
 * omits it; `colour` is null when absent; `loops` is true only for `loops: true` (the role's sessions run an
 * operating loop driven by the server heartbeat); `model` is the model id this role's sessions default to
 * (null when absent — the spawner's default applies; ignored at spawn on a provider mismatch); `effort` is
 * the reasoning-effort level this role's sessions default to (null when absent — the provider default
 * applies); `charter` is the body after the frontmatter (or the whole file when there is no fence).
 */
export function parseRoleFile(text, roleId) {
  let name = roleId;
  let colour = null;
  let loops = false;
  let model = null;
  let effort = null;
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
      else if (k === "loops") loops = /^(true|yes|1)$/i.test(v);
      else if (k === "model" && v) model = v;
      else if (k === "effort" && v) effort = v;
    }
    charter = text.slice(m[0].length);
  }
  return { roleId, name, colour, loops, model, effort, charter: charter.trim() };
}
