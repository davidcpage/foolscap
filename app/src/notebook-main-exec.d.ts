// Types for the main-thread execution realm (notebook-main-exec.js), so notebook-runtime.ts can import it.
// The runtime is the only consumer; tests import the .js directly (node-importable, no `self`/DOM at import).

/** Run one cell on the main thread; the value MAY be a live DOM node. Never throws — a run error is returned.
 *  `budgetMs` (when > 0) abandons an ASYNC run that hasn't settled within the budget, surfacing a "time budget
 *  exceeded" error rather than leaving the cell stuck "running" — a synchronous infinite loop is NOT catchable. */
export function runMainThreadCell(job: {
  source: string;
  inputs?: Record<string, unknown>;
  block?: boolean;
  budgetMs?: number;
}): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;

/** Duck-type check: is this value a live DOM node (Element / SVG / Text / DocumentFragment)? */
export function isNode(v: unknown): v is Node;

/** Serialize a live node to the relay/agent-legible shape: `kind` (svg | dom | html) + `markup` (outerHTML). */
export function serializeView(node: Node): { kind: "svg" | "html" | "dom"; markup: string };

/** Clone-safe a NON-node value for exportsVal (twin of the worker's cloneSafe): a function → a source
 *  descriptor, a non-clonable value → a string, primitives/JSON-ish pass through. */
export function cloneSafe(value: unknown): unknown;

/** Rehydrate a transported value: turn {__fn__} descriptors back into callables and deep-COPY arrays/objects
 *  (never mutating the input — this realm holds the runtime's shared exports). Preserves cycles in the copy. */
export function rehydrate(value: unknown, seen?: Map<unknown, unknown>): unknown;
