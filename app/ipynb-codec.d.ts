// Types for ipynb-codec.js (plain ESM, runs under node --test). Hand-written so routes/files.ts can import
// the transform without allowJs. Keep in sync with the exports in ipynb-codec.js.

/** Per-output text-clamp budget (chars) for the agent path. */
export const DEFAULT_MAX_TEXT_CHARS: number;

/** Serialized-size budget (chars ≈ bytes) for the render path before whole outputs are dropped. */
export const DEFAULT_RENDER_BUDGET: number;

export interface TransformOpts {
  /**
   * "render" keeps images (drops whole outputs past the budget); "agent" (default) elides base64 + clamps
   * text; "full" is the full-fidelity identity projection for write-back (no elision/drop, strips the
   * render-only `metadata.__foolscap` banner flag) — the ONLY sanctioned write projection.
   */
  mode?: "render" | "agent" | "full";
  maxTextChars?: number;
  renderBudget?: number;
}

export interface TransformResult {
  /** Valid notebook JSON (transformed) when parsed; the ORIGINAL text unchanged when parsed=false. */
  content: string;
  /** Whether any image was elided / text clamped / output dropped. */
  trimmed: boolean;
  /** False when `text` wasn't valid notebook JSON (malformed or byte-clipped upstream). */
  parsed: boolean;
}

/** Transform a `.ipynb`'s raw JSON text for the card (render) or an agent read (agent, default). */
export function transformNotebook(text: string, opts?: TransformOpts): TransformResult;

/**
 * True if any OUTPUT in this notebook text carries an agent-projection elision marker (base64-image byte
 * marker or a text-clamp suffix) — i.e. the text is the lossy agent read projection, not a full notebook.
 * The BUG-2 write guard: refuse a `.ipynb` write body for which this is true, else the real outputs are
 * erased. Malformed / non-notebook JSON → false. Inspects only output fields, so a marker in cell source
 * never false-trips.
 */
export function notebookHasElisionMarkers(text: string): boolean;
