import fs from "node:fs";
import zlib from "node:zlib";
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

// Below this the gzip framing (headers + a CPU pass) costs more than the bytes it would save, so a
// small JSON response is sent uncompressed. The wins are the big payloads (the board persist boot +
// lazy-log reads); a tiny ack has nothing to gzip.
const GZIP_MIN_BYTES = 1400;

// Pass `req` to opt this response into transparent gzip when the client's Accept-Encoding allows it and
// the body clears GZIP_MIN_BYTES. Omitting `req` sends plain JSON exactly as before — every existing
// caller is unchanged; wire `req` through on the routes whose payloads are large/compressible (the
// board persist reads). gzipSync is fine here: it runs on already-bounded, infrequent (boot/lazy) reads,
// not a hot per-frame path.
export function sendJson(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  const accept = req?.headers["accept-encoding"];
  if (typeof accept === "string" && /\bgzip\b/.test(accept) && Buffer.byteLength(json) >= GZIP_MIN_BYTES) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.end(zlib.gzipSync(json));
    return;
  }
  res.end(json);
}

// ── Origin/Host allowlist (pre-push audit, MEDIUM) ────────────────────────────────────────────────
// The dev server binds loopback only, but two browser-reachable holes remain: (1) DNS rebinding — a
// hostile page served from a name that resolves to 127.0.0.1 reaches the API with a foreign Host, since
// the OS loopback bind never inspects the Host header; (2) any cross-origin page can no-cors POST to the
// state-changing endpoints (/api/session/spawn spawns a claude process, /api/command, /api/file writes,
// and via a live kernel /api/kernel/*/run runs Python) and open /api/ws for a full read of board/feed
// state. This gate closes both at the one shared HTTP dispatcher AND the WS upgrade:
//   - Host MUST be a loopback host (any port) — a DNS-rebind request carries a non-loopback Host, so this
//     alone defeats rebinding even on GETs that carry no Origin.
//   - If an Origin header is present it MUST be same-origin: a loopback host whose host:port equals the
//     Host header — blocks cross-origin browser fetches, including another local dev server on a diff port.
//   - NO Origin header ⇒ a non-browser client (curl, scripts/canvas, the agent bus, the session-host
//     sidecar, the contract tests) ⇒ allowed. Browsers ALWAYS attach Origin to cross-origin requests, to
//     every non-GET, and to WebSocket handshakes, so a missing Origin is never an attacker-controlled tab.
// Pure (headers in, boolean out) so it unit-tests without a live server.

// Loopback test on a Host / Origin-host value that MAY carry a :port and MAY be a bracketed IPv6 literal.
export function isLoopbackHost(hostPort: string): boolean {
  if (!hostPort) return false;
  let h = hostPort;
  const br = h.match(/^\[(.+)\](?::\d+)?$/); // [::1] or [::1]:5173 — unwrap without eating the inner colons
  if (br) h = br[1];
  else h = h.replace(/:\d+$/, ""); // ipv4 / hostname with an optional :port
  h = h.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// The shared allowlist decision for an HTTP request or a WS upgrade. `origin` / `host` are the raw header
// values (undefined when absent). See the block comment above for the threat model each clause closes.
export function originHostAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!host || !isLoopbackHost(host)) return false; // missing/foreign Host ⇒ reject (DNS-rebind guard)
  if (!origin) return true; // no Origin ⇒ non-browser client ⇒ allow
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false; // "null" / any non-URL Origin ⇒ reject
  }
  return isLoopbackHost(o.host) && o.host.toLowerCase() === host.toLowerCase(); // same-origin only
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

// A `.ipynb` is JSON that must PARSE intact to render (the ipynb card) or be legibly transformed (an
// agent read) — a 128 KiB head-clip yields invalid JSON, so notebooks read against this generous ceiling
// instead. This is the ONE byte bound for the notebook path (CLAUDE.md's size-cap rule): the notebook-aware
// codec (ipynb-codec.js) then elides/drops at the STRUCTURE level, never adding a second byte cap. A file
// beyond even this is genuinely pathological and falls back to head-truncation (card shows "too large").
export const MAX_NOTEBOOK_BYTES = 32 * 1024 * 1024;

// Read a file as utf8, head-truncated at `maxBytes` (default MAX_BYTES) with a `truncated` flag, or null if
// it can't be read. The stateless read primitive the file-card / card-type / bundled-role reads share (all
// preview-bounded); the notebook route passes MAX_NOTEBOOK_BYTES. Callers needing the FULL bytes (a template
// module, a CAS hash) read the file directly instead.
export function readText(abs: string, maxBytes: number = MAX_BYTES): { content: string; truncated: boolean } | null {
  try {
    const buf = fs.readFileSync(abs);
    return { content: buf.subarray(0, maxBytes).toString("utf8"), truncated: buf.length > maxBytes };
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

// Parse a NON-NEGATIVE-integer param (?since=); null when absent/invalid. Unlike windowParam, 0 is a valid
// value (?since=0 ⇒ replay from the very start of a channel), so this admits n >= 0 rather than n > 0.
export function nonNegParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The DEFAULT byte budget the inbox read (GET /api/inbox) bounds itself to when the caller passes no explicit
// &bytes. This is the ONE place the inbox payload is byte-bounded (CLAUDE.md size-caps doctrine: bound at the
// byte read, keep the TAIL, surface `truncated`) — so an agent NEVER needs a client-side `| head -c` (which
// consumes the read cursor and permanently loses the cut tail). Set to the same 128 KiB "err large" tier as
// MAX_BYTES: a normal worker's unread backlog is far under it (no truncation), while a pathological multi-MB
// backlog is bounded instead of blowing up the reader. A caller wanting a tighter window passes &bytes=; a
// caller who lost content re-reads with &since=<seq> (non-consuming replay) — neither needs client truncation.
export const DEFAULT_INBOX_BYTES = 128 * 1024;
