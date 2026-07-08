// Types for node-cascade.js (T3c — removeNode edge cascade). See the .js for the rationale.

/** The ids of every edge in `records` with `nodeId` as either endpoint (from OR to). */
export function connectedEdgeIds(
  records: Array<Record<string, unknown>> | null | undefined,
  nodeId: string,
): string[];
