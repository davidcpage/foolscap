// S3-c render smoke: load the real app (worktree server on $HOST) in headless Chrome via raw CDP and assert
// it MOUNTS with no uncaught error / no React error boundary — catching a runtime break in the App.tsx
// SyncPill / reject-effect wiring that typecheck can't. Not a gate; a one-shot proof helper.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const HOST = process.env.HOST || "http://127.0.0.1:5199";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3c-cdp-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", "--no-first-run", `--user-data-dir=${userDir}`, "about:blank"]);
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} fs.rmSync(userDir, { recursive: true, force: true }); };

try {
  // Wait for the DevTools endpoint, then open a page target.
  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const targets = await (await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(`${HOST}/`), { method: "PUT" })).json();
      wsUrl = targets.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) throw new Error("Chrome CDP did not come up");

  const ws = new WebSocket(wsUrl);
  await new Promise((res) => (ws.onopen = res));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description || "exception");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error: " + (m.params.args?.map((a) => a.value ?? a.description).join(" ") ?? ""));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Runtime.enable");
  await send("Page.enable");
  await new Promise((r) => setTimeout(r, 3500)); // let the SPA hydrate the board

  const root = await send("Runtime.evaluate", { expression: "document.getElementById('root')?.childElementCount ?? 0", returnByValue: true });
  const surface = await send("Runtime.evaluate", { expression: "document.querySelectorAll('svg, canvas, [class*=hud], [class*=board]').length", returnByValue: true });
  ws.close();

  // Ignore benign network noise (a feed reconnect blip); fail on a real uncaught/React error.
  const real = errors.filter((e) => !/Failed to load resource|net::ERR|favicon|WebSocket/i.test(e));
  assertOk(root.result.value > 0, `#root mounted content (childElementCount=${root.result.value})`);
  assertOk(real.length === 0, `no uncaught/React errors (saw: ${JSON.stringify(real.slice(0, 3))})`);
  console.log(`  · rendered ${surface.result.value} surface element(s) (svg/canvas/hud/board)`);
  console.log("S3-c RENDER SMOKE PASSED: app mounted cleanly with the stage-3 App.tsx changes (SyncPill + reject effect)");
} finally {
  cleanup();
}

function assertOk(cond, msg) {
  if (!cond) { console.error("SMOKE FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("  ✓", msg);
}
