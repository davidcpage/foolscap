// Behavioral repro for the phantom-tab over-count (thread node:thread:7bcc2c11).
//
// Stands up a REAL WebSocketServer on an alt port and mirrors attachWs()'s exact server-side handling —
// create a WsClient (with ?tab=), install the REAL installWsHeartbeat reaper, warn when the board's tab
// census (tabCountFor) is >1, and remove the client on ws.on("close"). It then simulates the human's
// symptom: repeatedly "switching boards" inside ONE browser tab, where each nav leaves the previous
// page's socket HALF-OPEN (close frame lost, socket wedged so it can't pong) — the exact ghost that used
// to stack under one board id.
//
// It prints the OLD counting (raw per-board socket count — what shipped) beside the NEW counting
// (tabCountFor, deduped by the stable ?tab= id) so the before/after is in one transcript, then waits out
// the reaper to show the wedged ghosts are actually terminated & removed.
//
// Run:  node test/phantom-tab-probe.mjs
import { registerHooks } from "node:module";
import { WebSocketServer, WebSocket } from "ws";

// Same .js→.ts resolve shim the hermetic test uses so vite-fs-plugin.ts's split-module imports resolve.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const ctx = await import("../server-context.ts");
const plugin = await import("../vite-fs-plugin.ts");

const st = globalThis.__canvasFsState;
const wsSet = ctx.getWsClients(st);
wsSet.clear();

const HEARTBEAT_MS = 300; // short so the reaper's ~2-tick reap is observable in seconds, not ~50s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OLD census = what shipped: every live per-board socket counts (ghosts included).
const oldCount = (boardId) => [...wsSet].filter((c) => c.boardId === boardId).length;

const warnings = [];
const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on("listening", r));
const port = wss.address().port;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const boardId = url.searchParams.get("board") ?? "board-a";
  const tab = url.searchParams.get("tab") ?? undefined;
  const client = { boardId, tab, watches: new Map(), send() {} };
  wsSet.add(client);

  const tabs = plugin.tabCountFor(boardId); // the NEW census the warning now uses
  if (tabs > 1) warnings.push({ boardId, tabs });

  const ping = plugin.installWsHeartbeat(ws, HEARTBEAT_MS); // the REAL reaper under test
  ws.on("close", () => {
    clearInterval(ping);
    wsSet.delete(client);
  });
});

// Open one browser-tab socket to a board. `wedge:true` simulates a lost-close-frame half-open: pause the
// underlying TCP so the ws lib stops reading — it can no longer auto-pong AND never sends a close frame,
// exactly the orphan a full-page board switch leaves behind.
function openTab(boardId, tab) {
  const c = new WebSocket(`ws://127.0.0.1:${port}/api/ws?board=${boardId}&tab=${tab}`);
  return new Promise((res) => c.on("open", () => res(c)));
}
function wedge(c) {
  c._socket.pause();
}

const TAB = "T1-one-browser-tab";
const boards = ["board-a", "board-b"];
const log = [];

console.log(`\n=== phantom-tab probe (heartbeat ${HEARTBEAT_MS}ms, one tab id "${TAB}") ===\n`);

let prev = null;
for (let i = 0; i < 5; i++) {
  const boardId = boards[i % 2];
  const c = await openTab(boardId, TAB);
  await sleep(30); // let the server register + run its census
  if (prev) wedge(prev); // the previous page's socket wedges half-open (board switch = full-page nav)
  prev = c;
  const old = oldCount(boardId);
  const now = plugin.tabCountFor(boardId);
  log.push({ switch: i + 1, boardId, oldCount: old, newCount: now });
  console.log(
    `switch #${i + 1} → ${boardId}: OLD would log "${old} tabs now live"` +
      `${old > 1 ? "  ⚠ PHANTOM" : ""}   |   NEW tabCountFor = ${now}${now > 1 ? "  ⚠" : "  ✓ one tab"}`,
  );
}

const ghostsBefore = wsSet.size;
console.log(`\nlingering server-side sockets before reaper runs: ${ghostsBefore} (4 wedged ghosts + 1 live)`);
console.log(`waiting out the reaper (~${HEARTBEAT_MS * 3}ms) …`);
await sleep(HEARTBEAT_MS * 4);
const ghostsAfter = wsSet.size;
console.log(`lingering server-side sockets after reaper: ${ghostsAfter}`);

console.log(`\n=== VERDICT ===`);
const anyPhantomWarned = log.some((r) => r.newCount > 1);
const oldWouldHaveWarned = log.filter((r) => r.oldCount > 1).length;
console.log(`OLD scheme: ${oldWouldHaveWarned}/5 switches would emit a phantom "N tabs now live" warning`);
console.log(`NEW scheme: phantom warnings across 5 switches = ${warnings.length} (expect 0)`);
console.log(`reaper removed the wedged ghosts: ${ghostsBefore} → ${ghostsAfter} sockets`);

wss.close();
for (const c of wss.clients) c.terminate();

const pass = !anyPhantomWarned && warnings.length === 0 && ghostsAfter < ghostsBefore;
console.log(`\n${pass ? "PASS ✓" : "FAIL ✗"}: repeated board switches in one tab no longer accumulate warnings.`);
process.exit(pass ? 0 : 1);
