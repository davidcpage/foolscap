import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── shared HTTP plumbing for the dev-server middleware ────────────────────────────────────────────
// The dependency-free helpers every route handler in vite-fs-plugin.ts reaches for. Extracted here (the
// first seam of the god-file split) so a route handler lifted into its own `routes/*.ts` module in a
// later phase can import these directly, instead of closing over vite-fs-plugin.ts internals. Everything
// in this module is PURE — it touches only its arguments (and the filesystem for the read helper), never
// cross-request state — so it needs none of the globalThis-pinned singletons (those live behind
// ServerContext in server-context.ts). Keep it that way: state-dependent helpers belong on the context.

// A subscriber to one of the server's SSE streams (feeds + the bus compat path). Just the parked
// response; the keep-alive/close bookkeeping is openSse's job.
export interface SseClient {
  res: ServerResponse;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The binary twin of readBody, for the image-asset write (raw bytes, not utf8). Bounded at `maxBytes`
// (the caller passes the same cap its handler enforces) so an oversized upload can't balloon memory
// before the length check — rejects mid-stream the moment it overruns.
export function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      len += c.length;
      if (len > maxBytes) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Open an SSE stream and add it to a client set, with the keep-alive ping + close bookkeeping all
// the streams here share. Returns the client handle.
export function openSse(req: IncomingMessage, res: ServerResponse, clients: Set<SseClient>): SseClient {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);
  const client: SseClient = { res };
  clients.add(client);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
  return client;
}

// The file-card preview byte cap: a file card shows a preview, not the whole file — 128KB shows the head
// of anything reasonable while bounding the one place a byte cap belongs (CLAUDE.md's size-cap rule: the
// byte read IS the memory bound). Shared by the read helper below and the file-write cap in the file
// routes — one source, imported, never re-declared.
export const MAX_BYTES = 128 * 1024;

// Read a file as utf8, head-truncated at MAX_BYTES with a `truncated` flag, or null if it can't be read.
// The stateless read primitive the file-card / card-type / bundled-role reads share (all preview-bounded);
// callers needing the FULL bytes (a template module, a CAS hash) read the file directly instead.
export function readText(abs: string): { content: string; truncated: boolean } | null {
  try {
    const buf = fs.readFileSync(abs);
    return { content: buf.subarray(0, MAX_BYTES).toString("utf8"), truncated: buf.length > MAX_BYTES };
  } catch {
    return null;
  }
}

// Parse an opt-in positive-integer window param (?limit= / ?bytes=); null when absent/invalid (⇒ uncapped,
// the default — no silent truncation for a caller that didn't ask for it).
export function windowParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
