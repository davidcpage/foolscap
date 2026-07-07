// permission-prompt-mcp.js contract: the stdio JSON-RPC surface the Claude Code CLI drives
// (initialize / tools/list / tools/call) and the relay's decision mapping — allow passes the input
// back as updatedInput, everything that goes wrong (bad HTTP, unreachable server, server deny)
// comes back as a fail-closed DENY whose message says the human never saw the request.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const SCRIPT = new URL("../permission-prompt-mcp.js", import.meta.url).pathname;

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}/api/permission/request`;

// Spawn the relay and speak newline-delimited JSON-RPC at it, correlating replies by id.
function startMcp(env) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
      waiters.delete(msg.id);
    }
  });
  return {
    call: (msg, timeoutMs = 15000) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for reply ${msg.id}`)), timeoutMs);
        waiters.set(msg.id, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
      }),
    notify: (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"),
    kill: () => child.kill(),
  };
}

// The CLI's contract: the decision is a JSON string in the tool result's text content.
const decisionOf = (reply) => JSON.parse(reply.result.content[0].text);

test("handshake: initialize echoes the client's protocol version; tools/list serves the one tool", async () => {
  const mcp = startMcp({ CANVAS_PERMISSION_URL: "http://127.0.0.1:9/x", CANVAS_SESSION_ID: "sid-1" });
  try {
    const init = await mcp.call({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools, "advertises the tools capability");
    mcp.notify({ method: "notifications/initialized" }); // must be silently absorbed, not answered
    const list = await mcp.call({ id: 2, method: "tools/list" });
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, "permission_prompt");
    const ping = await mcp.call({ id: 3, method: "ping" });
    assert.deepEqual(ping.result, {});
    const unknown = await mcp.call({ id: 4, method: "resources/list" });
    assert.equal(unknown.error.code, -32601, "unknown methods get a JSON-RPC error, not a hang");
  } finally {
    mcp.kill();
  }
});

test("allow: the relay POSTs session+tool+input and maps the server's allow to updatedInput", async () => {
  const posted = [];
  const srv = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posted.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ behavior: "allow" }));
    });
  });
  const mcp = startMcp({ CANVAS_PERMISSION_URL: urlOf(srv), CANVAS_SESSION_ID: "sid-1" });
  try {
    const input = { command: "git push origin main" };
    const reply = await mcp.call({
      id: 5,
      method: "tools/call",
      params: { name: "permission_prompt", arguments: { tool_name: "Bash", input, tool_use_id: "tu_1" } },
    });
    const d = decisionOf(reply);
    assert.equal(d.behavior, "allow");
    assert.deepEqual(d.updatedInput, input, "allow echoes the original input back (the CLI's contract)");
    assert.deepEqual(posted[0], { session: "sid-1", toolName: "Bash", input, toolUseId: "tu_1" });
  } finally {
    mcp.kill();
    srv.close();
  }
});

test("deny: the human's message rides through; a server updatedInput overrides on allow", async () => {
  let n = 0;
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        n++ === 0
          ? { behavior: "deny", message: "not this branch" }
          : { behavior: "allow", updatedInput: { command: "echo safe" } },
      ),
    );
  });
  const mcp = startMcp({ CANVAS_PERMISSION_URL: urlOf(srv), CANVAS_SESSION_ID: "sid-1" });
  try {
    const denied = decisionOf(
      await mcp.call({ id: 6, method: "tools/call", params: { name: "permission_prompt", arguments: { tool_name: "Bash", input: {} } } }),
    );
    assert.deepEqual(denied, { behavior: "deny", message: "not this branch" });
    const rewritten = decisionOf(
      await mcp.call({ id: 7, method: "tools/call", params: { name: "permission_prompt", arguments: { tool_name: "Bash", input: { command: "rm -rf" } } } }),
    );
    assert.deepEqual(rewritten, { behavior: "allow", updatedInput: { command: "echo safe" } });
  } finally {
    mcp.kill();
    srv.close();
  }
});

test("fail closed: HTTP errors and an unreachable server both deny, saying the human never saw it", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not a live canvas session" }));
  });
  const mcp = startMcp({ CANVAS_PERMISSION_URL: urlOf(srv), CANVAS_SESSION_ID: "sid-1" });
  try {
    const d = decisionOf(
      await mcp.call({ id: 8, method: "tools/call", params: { name: "permission_prompt", arguments: { tool_name: "Bash" } } }),
    );
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /404/);
    assert.match(d.message, /never saw/);
  } finally {
    mcp.kill();
    srv.close();
  }

  // Nothing listening at all (the dev server mid-restart): still a deny, not a hang or a crash.
  const dead = startMcp({ CANVAS_PERMISSION_URL: "http://127.0.0.1:1/api/permission/request", CANVAS_SESSION_ID: "sid-1" });
  try {
    const d = decisionOf(
      await dead.call({ id: 9, method: "tools/call", params: { name: "permission_prompt", arguments: { tool_name: "Bash" } } }),
    );
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /unreachable/);
  } finally {
    dead.kill();
  }

  // Misconfigured env (no URL) — the same closed-by-default posture.
  const bare = startMcp({ CANVAS_PERMISSION_URL: "", CANVAS_SESSION_ID: "" });
  try {
    const d = decisionOf(
      await bare.call({ id: 10, method: "tools/call", params: { name: "permission_prompt", arguments: { tool_name: "Bash" } } }),
    );
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /misconfigured/);
  } finally {
    bare.kill();
  }
});

test("unknown tool name is a JSON-RPC error (the CLI should never see a fabricated decision)", async () => {
  const mcp = startMcp({ CANVAS_PERMISSION_URL: "http://127.0.0.1:9/x", CANVAS_SESSION_ID: "sid-1" });
  try {
    const reply = await mcp.call({ id: 11, method: "tools/call", params: { name: "other_tool", arguments: {} } });
    assert.equal(reply.error.code, -32602);
  } finally {
    mcp.kill();
  }
});
