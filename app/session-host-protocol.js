// The session-host wire protocol (plain ESM, runs under node --test; shared by session-host.js, the
// dev-server client, and vite-fs-plugin.ts).
//
// ndjson over a unix domain socket: one JSON object per \n-terminated line, both directions. Requests
// carry a client-minted `req` counter for reply correlation; events (`line`, `exit`) carry none. See
// session-host.js for the op set and semantics.

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const PROTOCOL_VERSION = 4;

/**
 * The host's socket, checkout-scoped (one sidecar per app checkout, like one dev server) but living in
 * tmpdir, NOT the checkout: a unix socket inside a watched tree is fatal — chokidar/Vite fs.watch() a
 * socket file and the resulting unhandled FSWatcher error takes the whole dev server down (observed:
 * errno -102 UNKNOWN on the .sock). Keyed by the resolved app dir so parallel checkouts stay isolated,
 * and short enough for macOS's 104-char sun_path limit.
 */
export function sessionHostSocketPath(appDir) {
  const key = crypto.createHash("sha256").update(path.resolve(appDir)).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `canvas-session-host-${key}.sock`);
}

/** The host's log file, next to the socket. `*.log` is already gitignored. */
export function sessionHostLogPath(appDir) {
  return path.join(appDir, ".session-host.log");
}

/**
 * Incremental \n-splitter for a stream of ndjson (a child's stdout, or a protocol socket). Returns the
 * chunk consumer; blank lines are skipped; a trailing partial line waits in the buffer for its newline.
 * (Extracted from the dev-server plugin's stdout wiring so both ends split identically.)
 */
export function makeLineSplitter(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

/**
 * Does this stdout line end a turn? The busy-bit fold: a session is busy from a user-message write until
 * its `result` event. Cheap `includes` pre-filter, then a parse to confirm the `type` is top-level (a
 * `result` inside a nested string must not flip the bit).
 */
export function isResultLine(line) {
  if (!line.includes('"type":"result"')) return false;
  try {
    return JSON.parse(line).type === "result";
  } catch {
    return false;
  }
}

/**
 * Does this stdin write start a turn? Only a `user` message does — a `control_request` (interrupt) rides
 * the same stdin without opening a turn.
 */
export function isUserWrite(data) {
  try {
    return JSON.parse(data).type === "user";
  } catch {
    return false;
  }
}
