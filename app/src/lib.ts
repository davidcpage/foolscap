// Single seam onto the two engine packages. The whole discipline is that the renderer reaches the
// engines through exactly this public surface and never touches them: file cards are ordinary nodes
// (type: "file"), so nothing here or in core/interaction changes. @tldraw/state is never imported; it
// resolves transitively from core/node_modules (one copy).
export * from "../../core/src/index.js";
export * from "../../interaction/src/index.js";
