import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readBody, readBodyBuffer, readText, MAX_BYTES, MAX_NOTEBOOK_BYTES } from "../server-http.js";
import { transformNotebook, notebookHasElisionMarkers } from "../ipynb-codec.js";
import {
  safeResolve,
  isInternalPath,
  fileVersion,
  readFileWithVersion,
  EXCLUDE_DIRS,
  TEXT_EXT,
  IMAGE_EXT,
  IMAGE_MIME,
  MAX_ASSET_BYTES,
  openRootWatcher,
} from "../server-fs.js";
import { isStaleWrite } from "../cas-guard.js";
import { reanchorFile } from "../annotation-reanchor.js";
import { bundledRoleFileFor } from "../role-ledger.js";
import { exact, type RootRoute } from "./router.js";

// ── the filesystem-serving routes (god-file split, Phase 2) ─────────────────────────────────────────
// The ROOT-stage file/asset/watch surface: browse a directory (ls), read/write a text file, rename/move,
// delete, read/write an image asset, and the live SSE watch. Every handler here is confined to the resolved
// `root` the dispatcher's root gate already validated — these routes never touch cross-request state, so
// they reach nothing through ServerContext; the pure fs primitives (safeResolve / the visibility + extension
// gates / fileVersion / openRootWatcher) come from server-fs.ts, the transport helpers from server-http.ts.
// assetGate + fsMutGate stay HERE (concern-owned): they're the file-route-specific confinement envelopes,
// used by nothing else. Registered into ROOT_ROUTES in the SAME order/method the inline arms held.

function handleLs(res: ServerResponse, root: string, sub: string): void {
  const base = safeResolve(root, sub);
  if (!base) return sendJson(res, 400, { error: "bad path" });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    const rel = path.relative(root, path.join(base, e.name));
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name) && !isInternalPath(rel)) dirs.push(rel);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase()) && !isInternalPath(rel)) {
      files.push(rel);
    }
  }
  dirs.sort();
  files.sort();
  sendJson(res, 200, { path: sub, dirs, files });
}

// NOTEBOOK-AWARE read (.ipynb) — the file card's generic 128 KiB preview head-clips a notebook with base64
// image outputs into invalid JSON (blank card; unreadable agent read). Read against the generous
// MAX_NOTEBOOK_BYTES ceiling instead, then hand to the notebook codec, which serves two shapes of the same
// file: `notebook=render` (the card) keeps images and only drops WHOLE outputs past its budget; the default
// (a bare agent read) elides base64 images to markers and clamps huge text — both stay valid, parseable JSON.
// Beyond even the ceiling we fall back to head-truncation (truncated flag → card's existing "too large"
// notice); we never guess truncation from a parse failure — a malformed file is served verbatim.
function handleNotebookFile(res: ServerResponse, abs: string, rel: string, mode: "render" | "agent"): void {
  // Read ONCE (up to the notebook ceiling) and derive both the content and the version from that buffer —
  // a notebook is up to 32 MiB, so the old read-then-fileVersion pair was two 32 MiB sync reads per request.
  const raw = readFileWithVersion(abs, MAX_NOTEBOOK_BYTES);
  if (!raw) return sendJson(res, 404, { error: "not found" });
  if (raw.truncated) {
    // File exceeds even the notebook ceiling — the bytes are already clipped, so we can't parse/transform.
    // Serve the head-truncated content with the flag; the card shows "too large", an agent sees the flag.
    return sendJson(res, 200, { path: rel, content: raw.content, truncated: true, version: raw.version });
  }
  const { content, trimmed } = transformNotebook(raw.content, { mode });
  // BUG-2: a TRIMMED projection is NOT the on-disk bytes (images elided to markers / text clamped / whole
  // outputs dropped), so stamping the FULL-file hash would be a lie: a reader could echo it as baseVersion
  // and the CAS would pass, letting the lossy projection overwrite the real outputs. Poison the version to
  // null on any trimmed read, so a CAS-guarded write-back is refused (409, baseVersion:null vs the real hash
  // → stale) and the reader must re-read. Only an UNtrimmed read (content == the real bytes) carries a real
  // version (raw.version, from the same buffer) and is a safe CAS base. The write path (handleFileWrite) also
  // hard-rejects a body carrying elision markers, independent of the CAS, for a reader that omits baseVersion.
  sendJson(res, 200, { path: rel, content, truncated: false, trimmed, version: trimmed ? null : raw.version });
}

function handleFile(res: ServerResponse, root: string, rel: string, notebook: string | null): void {
  const abs = safeResolve(root, rel);
  // Apply the SAME gates handleLs uses, so a card can only read what the listing would have shown:
  // inside the root (safeResolve), not under an excluded dir (.git, node_modules, …), and only a
  // known text extension. Without this, /api/file would read any non-listed file in the root — a
  // secret with no text ext (.env, *.pem → blocked here), or anything under .git. 404, not 403, so
  // the endpoint never confirms a blocked file exists.
  const allowed =
    !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  if (allowed && path.extname(rel).toLowerCase() === ".ipynb")
    return handleNotebookFile(res, abs!, rel, notebook === "render" ? "render" : "agent");
  // Read ONCE and derive both the preview and the W12 content version from the same buffer (the read used
  // to hit disk twice — readText for the preview, fileVersion for the hash — 2N sync reads for N cards).
  const r = allowed ? readFileWithVersion(abs!) : null;
  if (!r) {
    // Role cards read `.canvas/roles/<id>/role.md` through this endpoint. On a board with no override the
    // file exists only as a bundled default (app/default-roles/) — serve that read-only so the card mirrors
    // the shipped role instead of hanging on "loading…", until an edit writes the board copy (copy-on-write).
    // Same text gates already applied via `allowed`; the fallback is only reached on a genuine miss.
    const bundled = allowed ? bundledRoleFileFor(rel) : null;
    const br = bundled ? readFileWithVersion(bundled) : null;
    if (bundled && br)
      return sendJson(res, 200, { path: rel, content: br.content, truncated: br.truncated, version: br.version });
    return sendJson(res, 404, { error: "not found" });
  }
  // W12: the content version lets a card echo it back as `baseVersion` on write (optimistic lock).
  sendJson(res, 200, { path: rel, content: r.content, truncated: r.truncated, version: r.version });
}

// WRITE a file's content (POST /api/file) — Phase-3 write-back, first consumer the notebook card's
// serialize-back (docs/notebook-card.md §13). Scoped to the SAME gates as the read (handleFile): inside
// the root (safeResolve), not internal (isInternalPath — .git, node_modules, and the shadow git-dirs under
// .canvas/roots/), and a known text extension — so a card can only write what the listing would have shown,
// and never into the shadow-git ledger's object store. Creates the parent dir if missing (the first notebook
// mints `notebooks/`). The repo watch then fires a `change`, refreshing the off-log content signal on every
// card viewing this path. (A file-backed `.canvas/` body — a sticky, a channel log — writes here too.)
async function handleFileWrite(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  rel: string,
  repoPath: string,
): Promise<void> {
  const abs = safeResolve(root, rel);
  const allowed =
    !!abs && !isInternalPath(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase());
  if (!allowed) return sendJson(res, 404, { error: "not found" }); // 404, like the read — never confirm a blocked path
  let body: { content?: unknown; baseVersion?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  if (typeof body.content !== "string") return sendJson(res, 400, { error: "content required" });
  const isNotebook = path.extname(rel).toLowerCase() === ".ipynb";
  // Bound the write at the one place a byte cap belongs (CLAUDE.md), keyed on extension to MATCH the read
  // ceiling: a `.ipynb` reads against MAX_NOTEBOOK_BYTES (image outputs run to MiB), so it must WRITE against
  // the same ceiling — else a full-fidelity notebook write-back over 128 KiB 413s and the card/kernel can't
  // save (BUG-2). Every other text file stays preview-sized at MAX_BYTES (a card's editable view).
  const writeCap = isNotebook ? MAX_NOTEBOOK_BYTES : MAX_BYTES;
  if (Buffer.byteLength(body.content, "utf8") > writeCap) return sendJson(res, 413, { error: "too large" });
  // BUG-2 hard guard: never let the lossy AGENT read projection round-trip back to disk. A bare `.ipynb` GET
  // elides base64 images to markers and clamps huge text; writing that body verbatim erases every real
  // output. Refuse a notebook write whose OUTPUTS carry those elision markers — independent of the CAS, so
  // it catches a writer that omits baseVersion too. 422 (well-formed but semantically unacceptable): the
  // caller must re-derive from the full notebook, never persist a read projection.
  if (isNotebook && notebookHasElisionMarkers(body.content))
    return sendJson(res, 422, {
      error:
        "notebook write carries output-elision markers from a lossy agent read projection — refusing to erase real outputs; edit the full notebook, do not write back the agent read",
      path: rel,
    });
  // W12 — optimistic-concurrency CAS: a write MAY carry `baseVersion` (the version it read). If it does and
  // the file has since moved, reject 409 with the current version + content so the writer can rebase — the
  // conflict IS the coordination (docs/simple-markdown-editor-lessons.md Idea 2). Opt-in: a write that omits
  // `baseVersion` (every caller today — notebook write-back, sticky/thread bodies) is unguarded, unchanged.
  if (body.baseVersion !== undefined) {
    const current = fileVersion(abs!);
    if (isStaleWrite(body.baseVersion, current)) {
      const r = current == null ? null : readText(abs!);
      return sendJson(res, 409, {
        error: "stale write: file changed since baseVersion — re-read and rebase",
        path: rel,
        currentVersion: current,
        content: r?.content ?? null,
        truncated: r?.truncated ?? false,
      });
    }
  }
  try {
    fs.mkdirSync(path.dirname(abs!), { recursive: true });
    fs.writeFileSync(abs!, body.content, "utf8");
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  // Self-heal any annotations this write moved (§4), so a viewing card's highlights track the new bytes
  // immediately rather than waiting for the next annotation read. Best-effort — a no-op for an unannotated
  // file, and never allowed to fail the write it rides on. (The agent's Edit tool bypasses this path and
  // hits the disk directly; the read-time reanchor covers that — this is the /api/file card-save fast path.)
  try {
    reanchorFile(repoPath, body.content, rel);
  } catch {
    /* reanchor is best-effort; the write already succeeded */
  }
  // Return the NEW version so a card can chain edits without a re-read (W12): the write's own next baseVersion.
  sendJson(res, 200, { path: rel, ok: true, version: fileVersion(abs!) });
}

// Shared confinement gate for IMAGE asset paths — the same envelope as the text read/write (inside the
// root, not internal per isInternalPath) but with the IMAGE_EXT gate instead of TEXT_EXT. Returns the
// absolute path or null. Both /api/asset read and write route through here, so neither can touch a non-image
// path; `.canvas/images/<name>` is the drop home (docs/canvas-home.md), reachable because isInternalPath
// excludes only `.canvas/roots/`.
function assetGate(root: string, rel: string): string | null {
  const abs = safeResolve(root, rel);
  if (!abs) return null;
  if (isInternalPath(rel)) return null; // Rule B: serves `.canvas/images`, refuses the shadow git-dirs
  return IMAGE_EXT.has(path.extname(rel).toLowerCase()) ? abs : null;
}

// READ a raw image asset (GET /api/asset) — streams the bytes with a mime'd Content-Type so an <img src>
// the image card renders resolves straight to the file on disk. 404 (never confirm a blocked path) when the
// gate refuses or the file is missing; the card shows its own broken-image tombstone on a failed load.
function handleAssetRead(res: ServerResponse, root: string, rel: string): void {
  const abs = assetGate(root, rel);
  if (!abs) return sendJson(res, 404, { error: "not found" });
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "Content-Type": IMAGE_MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store", // the (root, path) is stable but its bytes can be re-dropped; never stale
  });
  res.end(buf);
}

// WRITE an image asset (POST /api/asset, raw binary body) — the drop-on-canvas landing. Gated like the
// read; bounded at MAX_ASSET_BYTES (the one byte cap). NEVER clobbers: if the basename is taken it appends
// `-1`, `-2`, … and returns the FINAL path, so the client cards that path (a unique (root, path) → a unique
// node id). Creates the parent dir if missing (the first drop mints `.canvas/images/`).
async function handleAssetWrite(req: IncomingMessage, res: ServerResponse, root: string, rel: string): Promise<void> {
  if (!assetGate(root, rel)) return sendJson(res, 404, { error: "not found" });
  let buf: Buffer;
  try {
    buf = await readBodyBuffer(req, MAX_ASSET_BYTES);
  } catch {
    return sendJson(res, 400, { error: "bad body" });
  }
  if (buf.length === 0) return sendJson(res, 400, { error: "empty" });
  if (buf.length > MAX_ASSET_BYTES) return sendJson(res, 413, { error: "too large" });
  // Resolve a non-clobbering path: keep the dropped name, else `name-1.ext`, `name-2.ext`, …
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let finalRel = rel;
  let abs = assetGate(root, finalRel)!;
  for (let n = 1; fs.existsSync(abs); n++) {
    finalRel = `${stem}-${n}${ext}`;
    abs = assetGate(root, finalRel)!;
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { path: finalRel, ok: true });
}

// Shared confinement gate for the MUTATING fs endpoints (rename/delete). Same envelope as the read/write:
// inside the root (safeResolve), not internal (isInternalPath — .git, node_modules, and the shadow git-dirs
// under .canvas/roots/) — and NEVER the root directory itself (`rel === ""` would resolve to the checkout/
// worktree root, deleting or moving which is categorically out of a card's scope). Returns the absolute path
// or null. The TEXT_EXT gate is applied per-endpoint instead of here, because it only constrains FILES — a
// directory has no extension but is a legitimate rename/delete target (the listing shows folders too).
function fsMutGate(root: string, rel: string): string | null {
  if (!rel) return null; // the root dir itself is never a target
  const abs = safeResolve(root, rel);
  if (!abs || abs === root) return null;
  return isInternalPath(rel) ? null : abs;
}

// RENAME / MOVE a file or directory (POST /api/file/rename, body { from, to }) — the file-tree card's
// in-app rename (and move, since `rename ≡ move` at the fs layer: a `to` under a different parent moves it,
// and the parent is created if missing). Both ends pass fsMutGate; a FILE additionally requires a text
// extension on BOTH ends (a card only lists/edits text files, so it can't rename one into a hidden binary).
// Refuses to clobber: a pre-existing destination is 409, never an overwrite. The repo watch then fires
// unlink(from)+add(to), refreshing the off-log listings; the browser that issued the rename re-keys any
// PINNED card from the old (root, path) to the new one (loader.renameFileNodes) so it survives in place
// rather than tombstoning — the referential-integrity win an external Finder rename can't deliver.
async function handleFileRename(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  let body: { from?: unknown; to?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad json" });
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const src = fsMutGate(root, from);
  const dst = fsMutGate(root, to);
  if (!src || !dst) return sendJson(res, 404, { error: "not found" }); // 404, like the read — never confirm a blocked path
  let st: fs.Stats;
  try {
    st = fs.statSync(src);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (st.isFile()) {
    const ok = TEXT_EXT.has(path.extname(from).toLowerCase()) && TEXT_EXT.has(path.extname(to).toLowerCase());
    if (!ok) return sendJson(res, 404, { error: "not found" });
  }
  if (fs.existsSync(dst)) return sendJson(res, 409, { error: "destination exists" });
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true }); // a `to` in a new sub-folder is a move-into-folder
    fs.renameSync(src, dst);
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { ok: true, from, to, kind: st.isDirectory() ? "dir" : "file" });
}

// DELETE a file or directory (POST /api/file/delete?path=…) — the file-tree card's Shift+Delete. Gated by
// fsMutGate (and TEXT_EXT for a file, mirroring rename), then `fs.rm` (recursive for a directory). This is a
// real disk delete: a pinned card for the path is left to the watch's unlink → `gone` TOMBSTONE (slice D),
// which the user dismisses deliberately — the same "don't silently vanish a card" rule the loader follows.
// (No shadow-ledger restore yet — that ledger is still a design, docs/shadow-git-ledger.md — so a delete is
// presently as durable as `rm`; the undo story lands when the ledger does.)
function handleFileDelete(res: ServerResponse, root: string, rel: string): void {
  const abs = fsMutGate(root, rel);
  if (!abs) return sendJson(res, 404, { error: "not found" });
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (st.isFile() && !TEXT_EXT.has(path.extname(rel).toLowerCase()))
    return sendJson(res, 404, { error: "not found" }); // a non-text file is in no listing — out of scope
  try {
    fs.rmSync(abs, { recursive: st.isDirectory(), force: false });
  } catch (err) {
    return sendJson(res, 500, { error: String(err) });
  }
  sendJson(res, 200, { ok: true, path: rel, kind: st.isDirectory() ? "dir" : "file" });
}

// Server-Sent Events: hold the connection open and forward chokidar add/change/unlink as JSON frames.
// This is the reactive ingest path — an out-of-band edit (your editor, an agent, git pull) becomes a
// live event the canvas turns into a card update, with no polling. COMPAT path since the WS transport
// landed: the app subscribes over /api/ws (a standing SSE stream eats one of the browser's six
// per-host HTTP/1.1 connection slots — the pool-starvation bug), but the endpoint stays for external
// consumers and old tabs.
function handleWatch(req: IncomingMessage, res: ServerResponse, root: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);
  const close = openRootWatcher(root, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000); // keep proxies from closing the stream
  req.on("close", () => {
    clearInterval(ping);
    close();
  });
}

export const fileRootRoutes: RootRoute[] = [
  { match: exact("/api/ls"), run: (_req, res, url, _g, _boardId, _board, root) => handleLs(res, root, url.searchParams.get("path") ?? "") },
  { method: "POST", match: exact("/api/file/rename"), run: (req, res, _url, _g, _boardId, _board, root) => void handleFileRename(req, res, root) },
  { method: "POST", match: exact("/api/file/delete"), run: (_req, res, url, _g, _boardId, _board, root) => handleFileDelete(res, root, url.searchParams.get("path") ?? "") },
  {
    match: exact("/api/file"),
    run: (req, res, url, _g, _boardId, board, root) => {
      if (req.method === "POST") return void handleFileWrite(req, res, root, url.searchParams.get("path") ?? "", board.repoPath);
      return handleFile(res, root, url.searchParams.get("path") ?? "", url.searchParams.get("notebook"));
    },
  },
  {
    match: exact("/api/asset"),
    run: (req, res, url, _g, _boardId, _board, root) => {
      if (req.method === "POST") return void handleAssetWrite(req, res, root, url.searchParams.get("path") ?? "");
      return handleAssetRead(res, root, url.searchParams.get("path") ?? "");
    },
  },
  { match: exact("/api/watch"), run: (req, res, _url, _g, _boardId, _board, root) => handleWatch(req, res, root) },
];
