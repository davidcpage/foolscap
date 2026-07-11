// Records — the semantic / layout split (doc §9.3).
//
// Typed string ids + flat JSON keep records serializable AND tldraw-translatable (the optional
// sync-adapter seam): a tldraw "shape" ≈ JOIN(NodeRecord, LayoutRecord).
//
//   NodeRecord / EdgeRecord  = the SEMANTIC graph — what an agent reads/writes (meaning).
//   LayoutRecord (keyed by node) = what the HUMAN + RENDERER own — the drag HOT PATH.
//
// The payoff of the split (verified by the per-entity routing in ../browser-spike): a drag
// touches the layout atom only, so an agent's title edit and a human's drag never collide on
// the same record, and a renderer's NodeView subscribes to BOTH (layout for moves, node for edits).

export type Id<T extends string> = `${T}:${string}`;

export interface BaseRecord {
  id: string;
  typeName: string;
}

export interface NodeRecord extends BaseRecord {
  typeName: "node";
  id: Id<"node">;
  type: string; // "note" | "image" | ...
  title: string;
  text: string;
  color: string; // a NOTE_COLORS key ("yellow" | …). Semantic, not layout: it's a property of the
  // note an agent can read/set, and the renderer maps the key → an actual swatch (see app CSS).
  name?: string; // an OPTIONAL human display handle, distinct from `title`. Some cards key machinery off
  // their title (a session card's title IS its session id — it keys the live feed), so a friendlier label
  // can't overwrite it; `name` is that label, rendered in preference to the title where present (e.g. a
  // role-spawned session reads "<RoleName>.<short-sid>"). Absent ≡ no override; the renderer falls back to
  // the title. Semantic (agent-legible), not layout.
}

// The sticky-note palette, as agent-legible KEYS (the records store the key; the renderer owns the
// hex). addNode cycles through these so a fresh board reads as a bright spread; an agent (or the app)
// can pass an explicit one. Order here is the cycle order.
export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange", "purple"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface EdgeRecord extends BaseRecord {
  typeName: "edge"; // first-class relationship (≈ tldraw binding, doc §2.5)
  id: Id<"edge">;
  from: Id<"node">;
  to: Id<"node">;
  type: string; // "links" | "contains" | "member:open" | "member:pending" | "watch:open" | ...
  // A "member:*" edge is a session card's membership in a channel node (from: session, to: channel) — the
  // join relationship the agent-coordination layer rides (see app/src/channels.ts). The description lives on
  // the channel NODE's text, not here, so it stays editable like any card. The engine is blind to all of
  // this: it only sees a typed edge between two nodes.
}

export interface LayoutRecord extends BaseRecord {
  typeName: "layout";
  id: Id<"layout">; // layout:<nodeId>
  nodeId: Id<"node">;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number; // stacking order — higher paints on top + wins hit-testing. Explicit (not insertion
  // order) so it's serializable + agent-legible: an agent can read/reason about "what's on top".
  anchor?: "screen" | "world"; // where x/y/w/h live. Absent ≡ "world" (the default): page-space, pans
  // and zooms with the canvas like every card. "screen" makes the card FLOATING chrome — x/y/w/h are
  // SCREEN pixels and it stays put under pan/zoom (a pinned minimap, legend, scratch note). A floating
  // card is renderer chrome: excluded from the spatial index / hit-test / marquee / zoom-to-fit bounds,
  // and moved by its own drag, not the engine's. Flip back to "world" to drop it onto the canvas.
}

export type AnyRecord = NodeRecord | EdgeRecord | LayoutRecord;
export type RecordId = AnyRecord["id"];

// Map a record's typeName to its concrete type, for typed get/query.
export type RecordOf = {
  node: NodeRecord;
  edge: EdgeRecord;
  layout: LayoutRecord;
};

// ── id helpers ──────────────────────────────────────────────────────────────────────
let _counter = 0;
export function uid(): string {
  return Date.now().toString(36) + "-" + (_counter++).toString(36);
}
export function nodeId(): Id<"node"> {
  return `node:${uid()}`;
}
export function edgeId(): Id<"edge"> {
  return `edge:${uid()}`;
}
// One layout per node, keyed by it → cheap lookup on the drag path, and the JOIN is trivial.
export function layoutId(node: Id<"node">): Id<"layout"> {
  return `layout:${node}`;
}
