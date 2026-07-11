import { layoutId, nodeId, edgeId, NOTE_COLORS, type Id } from "./records.js";
import type { Store } from "./store.js";

// Command handlers: the "one mutation API, three clients" surface (doc §9.1). Human gestures, the
// agent, and internal logic ALL go through Editor.commit → these handlers, so validation/invariants/
// undo/migrations apply uniformly. signia contributes nothing here; this is entirely ours.
//
// A handler turns a payload into store mutations; the Editor wraps the call in one transaction and
// records the resulting diff into one IntentEvent. The set is extensible per Editor (register()).
export type CommandHandler = (store: Store, payload: any) => void;

// A canvas-shaped starter set. addNode emits the semantic + layout pair atomically (one diff with
// two `added`); moveNode touches the layout record only (the hot path / semantic split, doc §9.3).
export const defaultCommands: Record<string, CommandHandler> = {
  addNode(store, p: { id?: Id<"node">; type?: string; title?: string; text?: string; color?: string; name?: string; x?: number; y?: number; w?: number; h?: number; z?: number; anchor?: "screen" | "world" }) {
    const id = p.id ?? nodeId();
    store.put([
      // `name` is the optional display handle (see NodeRecord) — only stamped when supplied, so an ordinary
      // card stays name-less and the renderer falls back to its title.
      { typeName: "node", id, type: p.type ?? "note", title: p.title ?? "", text: p.text ?? "", color: p.color ?? pickColor(store), ...(p.name ? { name: p.name } : {}) },
      { typeName: "layout", id: layoutId(id), nodeId: id, x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 200, h: p.h ?? 120, z: p.z ?? nextZ(store), ...(p.anchor ? { anchor: p.anchor } : {}) },
    ]);
  },

  // Pin a card to the viewport (anchor "screen" → floating chrome) or drop it back onto the canvas
  // ("world"), carrying the converted box so the toggle is visually seamless — the caller (which knows
  // the camera) computes the screen↔page coordinates. Layout-only, like moveNode; the engine stays
  // blind to anchoring (it just stops indexing a "screen" card — see syncIndexFromStore).
  setAnchor(store, p: { id: Id<"node">; anchor: "screen" | "world"; x?: number; y?: number; w?: number; h?: number }) {
    const patch: Partial<import("./records.js").LayoutRecord> = { anchor: p.anchor };
    if (p.x != null) patch.x = p.x;
    if (p.y != null) patch.y = p.y;
    if (p.w != null) patch.w = p.w;
    if (p.h != null) patch.h = p.h;
    store.update<import("./records.js").LayoutRecord>(layoutId(p.id), patch);
  },

  // Recolour a note — the semantic counterpart to addNode's colour, so an agent can restyle the board.
  setColor(store, p: { id: Id<"node">; color: string }) {
    store.update<import("./records.js").NodeRecord>(p.id, { color: p.color });
  },

  // Raise nodes above everything else, preserving their relative order. The agent-facing counterpart
  // of the lift the select tool folds into a drag — "one mutation API, three clients".
  bringToFront(store, p: { ids: Id<"node">[] }) {
    store.transact(() => {
      let z = nextZ(store);
      const ordered = [...p.ids].sort((a, b) => zOf(store, a) - zOf(store, b));
      for (const id of ordered) store.update<import("./records.js").LayoutRecord>(layoutId(id), { z: z++ });
    });
  },

  removeNode(store, p: { id: Id<"node"> }) {
    // Cascade to connected edges: an edge whose endpoint node is gone is a dangling reference (never
    // valid), so deleting a card tears down its wires too — a channel card removes its memberships, a
    // session card removes the memberships pointing out of it, a computed card removes its input wires.
    // One store.remove → one diff → one undoable IntentEvent that restores node + layout + edges together.
    const edges = store.getSnapshot().records
      .filter((r) => r.typeName === "edge" && (r.from === p.id || r.to === p.id))
      .map((r) => r.id);
    store.remove([p.id, layoutId(p.id), ...edges]);
  },

  setTitle(store, p: { id: Id<"node">; title: string }) {
    store.update<import("./records.js").NodeRecord>(p.id, { title: p.title });
  },

  setText(store, p: { id: Id<"node">; text: string }) {
    store.update<import("./records.js").NodeRecord>(p.id, { text: p.text });
  },

  // Layout-only edit; an agent's setTitle and this never collide on the same record.
  moveNode(store, p: { id: Id<"node">; x: number; y: number }) {
    store.update<import("./records.js").LayoutRecord>(layoutId(p.id), { x: p.x, y: p.y });
  },

  // Multi-node move — the non-interactive counterpart of the select tool's drag gesture (which
  // records an IntentEvent of THIS type). Gives an agent the same intent the human expresses by
  // dragging, so "one mutation API, three clients" holds: absolute `moves` (what the gesture emits)
  // or a `{ ids, dx, dy }` translate. All layout writes coalesce into one diff / one event.
  moveNodes(
    store,
    p: { moves?: { id: Id<"node">; x: number; y: number }[]; ids?: Id<"node">[]; dx?: number; dy?: number },
  ) {
    store.transact(() => {
      if (p.moves) {
        for (const m of p.moves) {
          store.update<import("./records.js").LayoutRecord>(layoutId(m.id), { x: m.x, y: m.y });
        }
      } else if (p.ids) {
        const dx = p.dx ?? 0;
        const dy = p.dy ?? 0;
        for (const id of p.ids) {
          const l = store.get<"layout">(layoutId(id)) as import("./records.js").LayoutRecord | undefined;
          if (l) store.update<import("./records.js").LayoutRecord>(layoutId(id), { x: l.x + dx, y: l.y + dy });
        }
      }
    });
  },

  // Multi-node resize — the non-interactive counterpart of the select tool's resize gesture (which
  // records an IntentEvent of THIS type). Absolute boxes (what the gesture emits each frame), so an
  // agent expresses the same intent a human does by dragging a corner. All layout writes coalesce into
  // one diff / one event, exactly like moveNodes.
  resizeNodes(store, p: { resizes: { id: Id<"node">; x: number; y: number; w: number; h: number }[] }) {
    store.transact(() => {
      for (const r of p.resizes) {
        store.update<import("./records.js").LayoutRecord>(layoutId(r.id), { x: r.x, y: r.y, w: r.w, h: r.h });
      }
    });
  },

  // Create-by-drag's non-interactive counterpart. The shape tool's draw gesture records an IntentEvent
  // of THIS type — a DISTINCT intent so provenance can tell a drawn shape from a note — and carries the
  // final box + colour in its end() payload, so replaying the event reconstructs the same node+layout
  // pair addNode would. Keeping "one mutation API, three clients" true for shapes (moveNodes/resizeNodes
  // already honour it). Delegates to addNode so the two never drift.
  addShape(store, p: { id?: Id<"node">; type?: string; color?: string; x?: number; y?: number; w?: number; h?: number; z?: number }) {
    defaultCommands.addNode!(store, p);
  },

  addEdge(store, p: { id?: Id<"edge">; from: Id<"node">; to: Id<"node">; type?: string }) {
    store.put([{ typeName: "edge", id: p.id ?? edgeId(), from: p.from, to: p.to, type: p.type ?? "links" }]);
  },

  removeEdge(store, p: { id: Id<"edge"> }) {
    store.remove([p.id]);
  },
};

// Next free stacking value = one above the current max layout z (0 when the board is empty). Derived
// from the data each time (not a counter) so it survives reload/snapshot and stays a function of the
// serializable state. O(N) — fine on the cold add/raise path, never on the drag hot path.
function nextZ(store: Store): number {
  let max = -1;
  for (const r of store.getSnapshot().records) {
    if (r.typeName === "layout" && r.z > max) max = r.z;
  }
  return max + 1;
}

function zOf(store: Store, id: Id<"node">): number {
  const l = store.get<"layout">(layoutId(id)) as import("./records.js").LayoutRecord | undefined;
  return l?.z ?? 0;
}

// Default colour for a new note: the next palette entry, cycled by how many notes already exist. Like
// nextZ, it's derived from the serializable state (not a hidden counter) so the spread is stable, and
// it gives a fresh board its bright variety without the caller having to choose.
function pickColor(store: Store): string {
  let count = 0;
  for (const r of store.getSnapshot().records) if (r.typeName === "node") count++;
  return NOTE_COLORS[count % NOTE_COLORS.length]!;
}
