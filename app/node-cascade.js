// T3c — removeNode cascades its edges server-side (docs/memory-and-guardrails-work.md §T3c). Deleting a
// node must tear down every edge that names it as an endpoint, so "delete edges before nodes" stops being a
// rule the operator carries. The browser store already cascades on removeNode (core/src/commands.ts), but
// the /api/command handler re-derives the same edge set here and emits a removeEdge for each BEFORE the
// removeNode — which makes the cascade client-independent (a stale tab can't reintroduce the rule) and lets
// the server clear its in-memory membership bridge for a removed session card.
//
// Pure logic in one module (like thread-tags.js / cas-guard.js) so the guard is unit-testable without a live
// server; the HTTP wiring (dispatch each removeEdge, then the removeNode) lives in vite-fs-plugin.ts.

// The ids of every edge with `nodeId` as either endpoint. Tolerant of a null/absent record set (→ []) and
// of non-edge / malformed records, so a lagging or empty snapshot yields "no edges", never a throw.
export function connectedEdgeIds(records, nodeId) {
  const out = [];
  for (const r of records ?? [])
    if (r && r.typeName === "edge" && typeof r.id === "string" && (r.from === nodeId || r.to === nodeId))
      out.push(r.id);
  return out;
}
