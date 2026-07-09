import type { IncomingMessage } from "node:http";
import type { BoardInfo, CanvasFsState, LiveSession, RootInfo } from "./vite-fs-plugin.js";

// ── the ServerContext seam ────────────────────────────────────────────────────────────────────────
// The second seam of the god-file split (server-http.ts is the first). Where server-http.ts holds the
// STATELESS helpers, this module is the single accessor a route handler uses to reach the SHARED,
// cross-request state it was closing over vite-fs-plugin.ts to get: the board registry, the live-session
// registry, the whole fsState singleton, and the state-dependent resolvers (reqBoard / rootDir /
// boardRoots / originOf) built on top of them.
//
// WHY an accessor and not a re-export of the maps: the load-bearing state is pinned on `globalThis` via
// `??=` (see CanvasFsState in vite-fs-plugin.ts) so it survives a Vite hot re-eval. A route module that
// imported the maps directly would still get the right (pinned) objects, but it would also have to import
// them from vite-fs-plugin.ts — the exact coupling this split exists to remove. Instead vite-fs-plugin.ts
// calls `setServerContext(...)` ONCE at module load with references to those same pinned singletons, and a
// later `routes/*.ts` handler calls `getServerContext()`. The context holder is itself globalThis-pinned,
// so a hot re-eval that re-runs vite-fs-plugin.ts (and re-calls setServerContext with the still-pinned
// singletons) never leaves a stale or half-built context behind.
//
// Phase 0 establishes this seam; the route handlers still live inline in vite-fs-plugin.ts and reach their
// state through the module scope directly, so the only consumer today is the wiring below. Phase 1+ lifts
// each handler into its own module, and THAT is where getServerContext() earns its keep.

export interface ServerContext {
  // The pinned singletons (identical objects to the ones vite-fs-plugin.ts holds).
  boards: Map<string, BoardInfo>;
  liveSessions: Map<string, LiveSession>;
  fsState: CanvasFsState;
  // The default board's id — the fallback when a request omits ?board=.
  defaultBoardId: string;
  // State-dependent resolvers (they read `boards` / the roots cache / lastKnownOrigin), so they belong on
  // the context rather than in the stateless server-http.ts module.
  reqBoard: (url: URL) => (BoardInfo & { boardId: string }) | null;
  rootDir: (boardId: string, rootId: string | null) => string | null;
  boardRoots: (boardId: string) => RootInfo[];
  originOf: (req: IncomingMessage) => string;
}

// Pin the holder on globalThis (like fsState) so a hot re-eval doesn't strand a stale context: the getter
// keeps working across the re-eval, and vite-fs-plugin.ts re-sets it during its own re-run regardless.
const holder = ((globalThis as { __canvasServerContext?: { ctx: ServerContext | null } }).__canvasServerContext ??= {
  ctx: null,
});

export function setServerContext(ctx: ServerContext): void {
  holder.ctx = ctx;
}

// Returns the live context. Throws if called before vite-fs-plugin.ts wired it — a programming error (a
// route module evaluated its handler before configureServer ran), never an expected runtime state.
export function getServerContext(): ServerContext {
  if (!holder.ctx) throw new Error("ServerContext not initialized — setServerContext must run at plugin load");
  return holder.ctx;
}
