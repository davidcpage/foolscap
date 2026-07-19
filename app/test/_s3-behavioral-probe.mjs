// S3-a behavioral proof (NOT part of the gate — a throwaway end-to-end probe driven against a live server
// serving this worktree). Proves the two S3-a headline behaviors:
//   (1) a human gesture commit in one tab reaches a SECOND tab over the bus with no reload, and the
//       ORIGIN tab is excluded from its own rebroadcast (D6);
//   (3) a session whose card is CLOSED / never existed can still /join (D7 ledger-first membership) and
//       then post as a ledger member.
// Run: node app/test/_s3-behavioral-probe.mjs  (with a server on $HOST, default 5199).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// Resolve the core engine's `./x.js` specifiers to their `.ts` sources (node strips types), same shim the
// hermetic tests use — needed for the proof-#2 import of core's Store below.
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && spec.endsWith(".js")) {
      try {
        return next(spec, ctx);
      } catch {
        return next(spec.slice(0, -3) + ".ts", ctx);
      }
    }
    return next(spec, ctx);
  },
});

const HOST = process.env.HOST || "http://127.0.0.1:5199";
const WS = HOST.replace(/^http/, "ws");
const j = (b) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

const scratch = path.join(os.tmpdir(), "s3-probe-board");
fs.mkdirSync(scratch, { recursive: true });
const boardId = (await (await fetch(`${HOST}/api/boards`, j({ repoPath: scratch, noSessions: true }))).json()).boardId;
await fetch(`${HOST}/api/board/persist?board=${boardId}`, { method: "DELETE" }); // clean slate

// Open a WS and collect bus frames. Resolves the socket once open.
function openTab(tab) {
  const sock = new WebSocket(`${WS}/api/ws?board=${boardId}&tab=${tab}`);
  sock.bus = [];
  sock.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.ch === "bus") sock.bus.push(f);
  };
  return new Promise((res) => (sock.onopen = () => res(sock)));
}

const nodeId = "node:s3probe-" + Math.random().toString(36).slice(2, 8);
const record = { typeName: "node", id: nodeId, type: "text", x: 10, y: 20, w: 100, h: 40 };
const diff = { added: { [nodeId]: record }, updated: {}, removed: {} };

// ── (1) broadcast + origin exclusion ────────────────────────────────────────────────────────────────
const tabA = await openTab("A");
const tabB = await openTab("B");
await new Promise((r) => setTimeout(r, 200)); // let any replay settle

// Tab A commits a human gesture event via the durable /event echo, carrying its ?tab=A id.
const ev = { id: "evt:probe1", ts: Date.now(), parent: 0, seq: 1, type: "addNode", payload: { id: nodeId }, actor: "user", diff };
const evRes = await (await fetch(`${HOST}/api/board/persist/event?board=${boardId}&tab=A`, j({ event: ev }))).json();
assert.equal(typeof evRes.seq, "number", "the server assigns an authoritative seq");
await new Promise((r) => setTimeout(r, 300)); // let the broadcast land

const bGotIt = tabB.bus.find((f) => f.diff?.added?.[nodeId]);
const aGotIt = tabA.bus.find((f) => f.diff?.added?.[nodeId]);
assert.ok(bGotIt, "PROOF #1: the second tab received the human edit's diff over the bus (no reload)");
assert.equal(bGotIt.seq, evRes.seq, "the broadcast carries the authoritative seq the origin adopts");
assert.ok(!aGotIt, "PROOF #1: the ORIGIN tab was EXCLUDED from its own rebroadcast (D6)");

// And the edit is durably visible on a fresh read (server store folded it).
const canvas = await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json();
assert.ok(canvas.snapshot.records.some((r) => r.id === nodeId), "the committed record is in the server store");

// ── (3) closed-card /join — D7 ledger-first membership ──────────────────────────────────────────────
const threadId = "node:thread:s3probe-" + Math.random().toString(36).slice(2, 6);
// Put a thread card on the board (mint the save seq from the live counter — never hardcode).
const curSeq = (await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json()).snapshot.seq ?? 0;
await fetch(`${HOST}/api/board/persist/snapshot?board=${boardId}`, j({ snapshot: { seq: curSeq + 1, version: 3, records: [{ typeName: "node", id: threadId, type: "thread", title: "S3 probe" }] } }));

// A sid with NO session card on the board joins. Pre-D7 this 400'd ("no session card"); D7 makes it a
// valid ledger member.
const sid = "s3probe-headless-sid";
const joinRes = await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/join?board=${boardId}`, j({ from: sid }));
assert.equal(joinRes.status, 200, "PROOF #3: a cardless session /joins — the session-card gate is gone (D7)");

// And it is now a real member — a ledger-first /message from it lands (not 403/404).
const msgRes = await fetch(`${HOST}/api/thread/${encodeURIComponent(threadId)}/message?board=${boardId}`, j({ from: sid, text: "cardless member speaking" }));
assert.equal(msgRes.status, 200, "PROOF #3: the cardless member posts as a real ledger member");

// ── (2) reconnect GAP-FILL convergence — S3-b/D4 ────────────────────────────────────────────────────
// A tab is up and caught up, its socket DROPS, peers commit while it's down, it RECONNECTS and gap-fills.
// This drives the REAL server /log?since + the REAL client foldCatchUp against a local core Store, and
// asserts convergence — proof #2 end to end.
const { Store } = await import("../../core/src/store.ts");
const { foldCatchUp } = await import("../src/bus-convergence.ts");

// A tiny watermark holder standing in for Persistence's watermark()/adoptSeq (the client mirror).
const mirror = { seq: 0, watermark() { return this.seq; }, adoptSeq(s) { this.seq = Math.max(this.seq, s); } };
const tabStore = new Store();

// The tab is caught up to the board's current head (as after a boot).
const head = (await (await fetch(`${HOST}/api/canvas?board=${boardId}`)).json()).snapshot.seq ?? 0;
mirror.adoptSeq(head);

// Socket is DOWN. Three peer commits land while the tab can't see them.
const missedIds = [];
for (let i = 0; i < 3; i++) {
  const out = await (await fetch(`${HOST}/api/command?board=${boardId}`, j({ type: "addNode", actor: "user", payload: { type: "note", title: `gap-${i}` } }))).json();
  missedIds.push(out.id);
}
// Before catch-up the tab's store is empty of those records (it never received the diffs).
assert.ok(missedIds.every((id) => !tabStore.get(id)), "pre-reconnect: the tab missed every peer commit");

// RECONNECT → gap-fill: fetch since(watermark) and fold in seq order (the catchUp loop, one pass suffices).
const gap = (await (await fetch(`${HOST}/api/board/persist/log?board=${boardId}&since=${mirror.watermark()}`)).json()).events;
const applied = foldCatchUp(gap, tabStore, mirror);
assert.ok(applied >= 3, "PROOF #2: the gap-fill applied the missed events");
for (const id of missedIds) assert.ok(tabStore.get(id), `PROOF #2: the reconnected tab converged — ${id} is present`);
assert.equal(mirror.watermark(), head + 3, "the watermark advanced to the board head with no reload");

tabA.close();
tabB.close();
console.log("S3-a+b BEHAVIORAL PROOF PASSED:");
console.log(`  #1 human edit reached tab B (seq ${bGotIt.seq}), origin tab A excluded, durable in server store`);
console.log(`  #2 dropped connection → 3 peer commits missed → since(${head}) gap-fill → store converged (watermark ${mirror.watermark()})`);
console.log(`  #3 cardless /join → 200 (was 400 pre-D7), member posts a message → 200`);
