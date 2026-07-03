// permission-prompt-mcp.js — the stdio MCP server behind `--permission-prompt-tool` (plain ESM, runs
// under bare `node` and node --test; no deps, like session-host.js). ONE tool, `permission_prompt`:
// when a canvas session's tool call falls outside its allow-list, the Claude Code CLI calls this tool
// instead of auto-denying (the headless default). We relay the request to the dev server
// (POST CANVAS_PERMISSION_URL), which HOLDS the connection until a human clicks allow/deny on the
// session card (the §16 ask/reply held-response pattern) or the hold times out. The CLI's contract for
// the tool's reply is a JSON-stringified decision in the text content:
//   {"behavior":"allow","updatedInput":{...}}  |  {"behavior":"deny","message":"..."}
//
// Fail CLOSED, loudly: any relay failure (dev server down mid-restart, hold timed out, bad response)
// returns a deny whose message says the human never saw the request — so the agent knows to retry
// later or ask in its thread, rather than treating it as a human "no".
//
// Spawned BY the claude child itself (via --mcp-config), one per session, with the target baked into
// env: CANVAS_PERMISSION_URL (the absolute /api/permission/request endpoint) + CANVAS_SESSION_ID.

import process from "node:process";

const URL_ = process.env.CANVAS_PERMISSION_URL ?? "";
const SID = process.env.CANVAS_SESSION_ID ?? "";
// Client-side backstop only — the SERVER's hold timeout (PERMISSION_HOLD_MS) is the one that fires in
// practice and carries the honest "no human answered" message. This abort exists so a wedged route
// can't hang the tool call forever; keep it above the server hold.
const FETCH_TIMEOUT_MS = Number(process.env.CANVAS_PERMISSION_FETCH_TIMEOUT_MS) || 11 * 60_000;

const TOOL = {
  name: "permission_prompt",
  description:
    "Relays a Claude Code permission prompt to the session's canvas card and waits for the human's allow/deny.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name"],
  },
};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const reply = (id, result) => send({ id, result });
const replyErr = (id, code, message) => send({ id, error: { code, message } });

const deny = (message) => ({ behavior: "deny", message });

// Ask the dev server; the POST is HELD until the human decides or the server's hold times out.
async function decide(args) {
  const { tool_name, input, tool_use_id } = args ?? {};
  if (!URL_ || !SID)
    return deny("canvas permission relay misconfigured (no URL/session id) — the human never saw this request");
  let resp;
  try {
    resp = await fetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SID, toolName: String(tool_name ?? ""), input: input ?? {}, toolUseId: tool_use_id }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return deny(
      `canvas permission relay unreachable (${err?.name === "TimeoutError" ? "timed out" : String(err?.message ?? err)}) — ` +
        "the human never saw this request; try again later or ask in your thread",
    );
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  if (!resp.ok || !body || typeof body !== "object")
    return deny(
      `canvas permission relay error (HTTP ${resp.status}${body?.error ? `: ${body.error}` : ""}) — ` +
        "the human never saw this request; try again later or ask in your thread",
    );
  if (body.behavior === "allow") return { behavior: "allow", updatedInput: body.updatedInput ?? input ?? {} };
  return deny(typeof body.message === "string" && body.message ? body.message : "denied by the human on the canvas");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id == null) return; // a notification (notifications/initialized etc.) — nothing to answer
  switch (method) {
    case "initialize":
      return reply(id, {
        // Echo the client's protocol version — this server's surface (one tool, text results) is the
        // stable core every MCP revision shares, so claiming the client's version keeps the handshake
        // permissive without a vendored version table.
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "canvas-permission", version: "1.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) return replyErr(id, -32602, `unknown tool: ${params?.name}`);
      const decision = await decide(params?.arguments);
      return reply(id, { content: [{ type: "text", text: JSON.stringify(decision) }] });
    }
    default:
      return replyErr(id, -32601, `method not found: ${method}`);
  }
}

// MCP stdio framing: one JSON-RPC message per newline-delimited line (same splitter shape as
// session-host-protocol's, inlined so this file stays dependency-free for --mcp-config to point at).
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not ours to police — skip a ragged line, keep serving
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0)); // the claude child closed us — session over
