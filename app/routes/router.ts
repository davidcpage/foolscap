import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardInfo } from "../vite-fs-plugin.js";

// ── the shared route-table vocabulary (god-file split, Phase 1) ────────────────────────────────────
// The matcher combinators + the three staged route shapes, lifted out of vite-fs-plugin.ts so a route
// handler extracted into its own `routes/<concern>.ts` module can declare its registrations in the SAME
// vocabulary the dispatcher iterates. The dispatcher (still in vite-fs-plugin.ts) imports each module's
// exported route array and spreads it into the corresponding stage table — nothing about the three-stage
// GLOBAL/BOARD/ROOT gate changes; this is just where the shape now lives so both sides can name it.
//
// Type-only import of BoardInfo from the god-file mirrors server-context.ts — a types-only cycle, erased
// at runtime, so it introduces no load-order hazard.

// A path matcher: capture groups (or [] for a plain match); null = no match.
export type RouteMatch = (pathname: string) => string[] | null;
export const exact = (p: string): RouteMatch => (path) => (path === p ? [] : null);
export const oneOf = (...ps: string[]): RouteMatch => (path) => (ps.includes(path) ? [] : null);
export const prefix = (p: string): RouteMatch => (path) => (path.startsWith(p) ? [] : null);
export const re = (r: RegExp): RouteMatch => (path) => {
  const m = r.exec(path);
  return m ? m.slice(1) : null;
};

// STAGE 1 — tried before the shared board gate; a board-scoped global route calls reqBoard() itself.
export interface GlobalRoute {
  method?: string;
  match: RouteMatch;
  run: (req: IncomingMessage, res: ServerResponse, url: URL, g: string[]) => void;
}
// STAGE 2 — reached only after the shared board gate resolved `board`/`boardId`.
export interface BoardRoute {
  method?: string;
  match: RouteMatch;
  run: (req: IncomingMessage, res: ServerResponse, url: URL, g: string[], boardId: string, board: BoardInfo) => void;
}
// STAGE 3 — reached only after the shared root gate resolved the confined `root` dir.
export interface RootRoute {
  method?: string;
  match: RouteMatch;
  run: (req: IncomingMessage, res: ServerResponse, url: URL, g: string[], boardId: string, board: BoardInfo, root: string) => void;
}
