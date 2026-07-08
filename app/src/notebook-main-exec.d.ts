// Types for the main-thread execution realm (notebook-main-exec.js), so notebook-runtime.ts can import it.
// The runtime is the only consumer; tests import the .js directly (node-importable, no `self`/DOM at import).

/** Run one cell on the main thread; the value MAY be a live DOM node. Never throws — a run error is returned. */
export function runMainThreadCell(job: {
  source: string;
  inputs?: Record<string, unknown>;
  block?: boolean;
}): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;

/** Duck-type check: is this value a live DOM node (Element / SVG / Text / DocumentFragment)? */
export function isNode(v: unknown): v is Node;

/** Serialize a live node to the relay/agent-legible shape: `kind` (svg | dom | html) + `markup` (outerHTML). */
export function serializeView(node: Node): { kind: "svg" | "html" | "dom"; markup: string };

/** Clone-safe a NON-node value for exportsVal (twin of the worker's cloneSafe): a function → a source
 *  descriptor, a non-clonable value → a string, primitives/JSON-ish pass through. */
export function cloneSafe(value: unknown): unknown;
