// Single seam onto @canvas/core. Every other file in this package imports core types/classes from
// HERE, so the one cross-package relative path lives in exactly one place. The interaction layer is
// a *client* of the core's write authority (Editor) and reactive handles (Store/Subscribable) — it
// never reaches past the public surface, and it never imports the signals library (@tldraw/state)
// directly: session-tier state (camera/selection/tool) uses our own Observable instead (see
// ./observable.ts), which keeps this package dependency-light and proves the Subscribable seam is
// genuinely library-agnostic (a stated design goal).
export * from "../../core/src/index.js";
