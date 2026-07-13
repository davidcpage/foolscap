// The `node:<root>:<path>` id scheme — the ONE home for constructing/parsing the id prefixes so loader,
// reconcile-members, and templates agree on the convention instead of re-spelling the literals/regex (they
// used to drift). Deliberately DEPENDENCY-FREE (type-only imports, erased at runtime) so hermetic consumers
// like reconcile-members can import it in node --test without dragging in loader's editor/DOM graph. Client
// code reaches these through loader.ts, which re-exports them (loader is the id-scheme home for the app).
import type { Id } from "./lib";
import type { RootId } from "./loader";

export const NODE_PREFIX = "node:";

// Node id derived from (root, path) so it's STABLE and idempotent: re-loading or a change event addresses
// the same card without any path→id bookkeeping, and the two datasets never collide.
export function fileNodeId(root: RootId, p: string): Id<"node"> {
  return `${NODE_PREFIX}${root}:${p}` as Id<"node">;
}

// The root token of a node id (the `<root>` in `node:<root>:<p>`), defaulting to "repo" for a bare/foreign
// id. The root is colon-free (a slug), so the first two colons bound it; ids without a (root, path) shape
// (node:clock, node:session:<id>) don't match and fall back to "repo" — which those cards never read.
export function rootOfId(id: string): RootId {
  const m = /^node:([^:]+):/.exec(id);
  return (m ? m[1] : "repo") as RootId;
}

// A session card's two id spellings from its sid: the server-dropped live-summon card (`node:live:<sid>`)
// and a client reopen (`node:session:<sid>`). Kept together because reopen-dedup checks for both.
export const liveNodeId = (sid: string): Id<"node"> => `${NODE_PREFIX}live:${sid}` as Id<"node">;
export const sessionNodeId = (sid: string): Id<"node"> => `${NODE_PREFIX}session:${sid}` as Id<"node">;

// The sid of a session-shaped node id (`node:live:`/`node:session:`), or null when the id isn't one.
export const sidOfNode = (node: string): string | null => {
  const sid = node.replace(/^node:(?:live|session):/, "");
  return sid === node ? null : sid;
};
