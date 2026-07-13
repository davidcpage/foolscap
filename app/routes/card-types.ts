import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson, readText } from "../server-http.js";
import { CARD_TYPES_DIR } from "../server-fs.js";
import { exact, type GlobalRoute } from "./router.js";

// ── card types (card-types-as-data.md §3/§7: type definitions are data in the folder) ──────────
// The type registry's server half, lifted out of the god-file (Phase 1). The route handlers live here; the
// WATCH feed (server-orchestration.ts) and the HMR guard (the god-file) are the other consumers. The folder
// path itself (CARD_TYPES_DIR) lives in server-fs.ts with the other stateless fs primitives, so an engine
// consumer imports it from a sibling engine/helper rather than from this route module (the wrong-direction
// edge the split removed). The extraction leans only on stateless helpers (sendJson + readText from
// server-http.ts): no shared cross-request state, so no ServerContext dependency.

// List card-types/*/ (type.yaml + the render.js the browser will import()). A missing folder is an empty
// registry, not an error. type.yaml is read via the shared preview-bounded readText (a config file is tiny).
export function handleCardTypesList(res: ServerResponse): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(CARD_TYPES_DIR, { withFileTypes: true });
  } catch {
    // no card-types folder yet — an empty registry, not an error
  }
  const types = entries
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const yaml = readText(path.join(CARD_TYPES_DIR, e.name, "type.yaml"));
      return yaml ? [{ type: e.name, yaml: yaml.content }] : [];
    });
  sendJson(res, 200, { types });
}

// Serve card-types/* RAW — straight off disk, Cache-Control: no-store, never through Vite's
// transform pipeline. The pipeline caches per module and only Vite's own watcher invalidates that
// cache, so a feed-triggered re-import racing that watcher could be served the PREVIOUS code (the
// "save twice" dropped-update bug — two independent chokidars, no ordering). A template is runtime
// data under the v1 contract — plain ESM importing only /vendor/lit-html.js — so the bundler has
// nothing to add: read the file, send it, fresh every request. Read in FULL (not via readText, whose
// MAX_BYTES preview cap is for file-card bodies) — a template is code the browser must parse, and a
// truncated module is a syntax error.
export function handleCardTypeAsset(res: ServerResponse, pathname: string): void {
  const rel = decodeURIComponent(pathname.slice("/card-types/".length));
  const abs = path.resolve(CARD_TYPES_DIR, rel);
  if (!abs.startsWith(CARD_TYPES_DIR + path.sep)) return sendJson(res, 400, { error: "bad path" });
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "Content-Type": abs.endsWith(".js") ? "text/javascript" : "text/plain",
    "Cache-Control": "no-store",
  });
  res.end(content);
}

export const cardTypeRoutes: GlobalRoute[] = [
  { match: exact("/api/card-types"), run: (_req, res) => handleCardTypesList(res) },
];
