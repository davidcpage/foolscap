import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.js";
import { Store } from "../src/store.js";
import { UndoManager } from "../src/undo.js";
import {
  Persistence,
  MemoryEventStore,
  MemorySnapshotStore,
} from "../src/persist.js";
import type { LayoutRecord, NodeRecord } from "../src/records.js";

// Spin up an editor whose log IS the persistence layer, attach the snapshot half, return the lot.
// A huge debounce means snapshots are written ONLY on an explicit flush() — deterministic for tests
// (the real debounce behaviour gets its own test below).
function makeApp(events = new MemoryEventStore(), snapshots = new MemorySnapshotStore()) {
  const persistence = new Persistence({ events, snapshots, debounceMs: 1e9 });
  const editor = new Editor({ log: persistence });
  persistence.attach(editor.store);
  return { editor, persistence, events, snapshots };
}

test("onPending (§3.1 inspectable outbound queue): count rises per queued edit, drains to 0 as writes settle", async () => {
  const pendings: number[] = [];
  const persistence = new Persistence({ events: new MemoryEventStore(), snapshots: new MemorySnapshotStore(), debounceMs: 1e9, onPending: (n) => pendings.push(n) });
  const editor = new Editor({ log: persistence });
  persistence.attach(editor.store);
  editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a" } });
  editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b" } });
  // The count rises SYNCHRONOUSLY at commit time (the write is enqueued before it awaits the backend), so
  // the queue depth is honest the instant an edit is made — the pill never lags the backlog.
  assert.deepEqual(pendings, [1, 2], "two edits queued → pending rose 1 then 2");
  await persistence.whenIdle();
  assert.equal(pendings.at(-1), 0, "both durable writes settled → drained to 0");
  assert.ok(pendings.includes(2), "peaked at the queue depth (2)");
});

test("a fresh store reloads identically through the durable backends", async () => {
  const events = new MemoryEventStore();
  const snapshots = new MemorySnapshotStore();

  const a = makeApp(events, snapshots);
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", title: "A", x: 1, y: 2 } });
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b", title: "B", x: 3, y: 4 } });
  a.editor.commit({ type: "setTitle", actor: "human", payload: { id: "node:a", title: "A2" } });
  await a.persistence.flush();

  // A brand-new store + persistence over the SAME backends = a page reload.
  const persistence2 = new Persistence({ events, snapshots });
  const store2 = new Store();
  const res = await persistence2.hydrate(store2);

  assert.equal(res.fresh, false);
  assert.equal((store2.get<"node">("node:a") as NodeRecord).title, "A2");
  assert.equal((store2.get<"node">("node:b") as NodeRecord).title, "B");
  assert.equal((store2.get<"layout">("layout:node:b") as LayoutRecord).y, 4);
  assert.equal(store2.version, a.editor.store.version);
  // the readable history survived the reload too (the in-memory mirror is rebuilt from the log)
  assert.equal(persistence2.all().length, 3);

  // the timeline CONTINUES across the reload: a fresh commit lands at the next seq, not at 1
  const editor2 = new Editor({ store: store2, log: persistence2 });
  const evt = editor2.commit({ type: "setTitle", actor: "human", payload: { id: "node:a", title: "A3" } });
  assert.equal(evt.seq, 4);
});

test("LOG is authoritative: a snapshot older than the log is repaired by replaying the tail", async () => {
  const events = new MemoryEventStore();
  const snapshots = new MemorySnapshotStore();

  // Simulate a crash: two commits get snapshotted, two more land in the log only (no later snapshot).
  const a = makeApp(events, snapshots);
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", x: 0, y: 0 } });
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b", x: 0, y: 0 } });
  await a.persistence.flush(); // snapshot now reflects version 2
  a.editor.commit({ type: "moveNode", actor: "human", payload: { id: "node:a", x: 99, y: 0 } });
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:c", x: 0, y: 0 } });
  // The per-append event writes settle, but NO new snapshot is taken — the crash scenario: the log is
  // complete on disk, the snapshot is stale.
  await a.persistence.whenIdle();

  const snap = await snapshots.load();
  assert.equal(snap!.version, 2, "snapshot is stale (pre-crash)");

  const store2 = new Store();
  const res = await new Persistence({ events, snapshots }).hydrate(store2);

  assert.equal(res.replayed, 2, "the two post-snapshot events were replayed");
  assert.equal((store2.get<"layout">("layout:node:a") as LayoutRecord).x, 99, "tail move applied");
  assert.ok(store2.get<"node">("node:c"), "tail add applied");
  assert.equal(store2.version, 4);
});

test("the hydration tail is keyed on seq, NOT parent: a stale-causal-basis event still replays", async () => {
  const events = new MemoryEventStore();
  const snapshots = new MemorySnapshotStore();

  const a = makeApp(events, snapshots);
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", x: 0, y: 0 } });
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b", x: 0, y: 0 } });
  await a.persistence.flush(); // snapshot covers seq 1–2

  // An optimistic/merged commit landing AFTER the snapshot but BASED on version 0 (parent lags
  // commit order). Today's hard tryCommit can't produce this; the log contract must survive the
  // §10.2 policies that will. Appended directly, as a conflict-policy apply path would.
  const c: NodeRecord = { id: "node:c", typeName: "node", type: "note", title: "C", text: "", color: "yellow" };
  a.persistence.append({
    id: "evt:stale",
    ts: Date.now(),
    parent: 0, // causal basis far behind the snapshot's version
    type: "addNode",
    actor: "agent",
    payload: { id: "node:c" },
    diff: { added: { "node:c": c }, updated: {}, removed: {} },
  });
  await a.persistence.whenIdle(); // event durably logged, snapshot NOT refreshed

  const store2 = new Store();
  const res = await new Persistence({ events, snapshots }).hydrate(store2);
  assert.equal(res.replayed, 1, "the stale-parent event was replayed (a parent filter would drop it)");
  assert.ok(store2.get("node:c"), "the agent's committed work survived the reload");
});

test("a pre-watermark snapshot (no seq stamp) falls back to the linear parent filter", async () => {
  const events = new MemoryEventStore();
  const snapshots = new MemorySnapshotStore();

  const a = makeApp(events, snapshots);
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", x: 0, y: 0 } });
  const legacy = a.editor.store.getSnapshot(); // version 1, no seq — what an old build persisted
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b", x: 0, y: 0 } });
  await a.persistence.whenIdle();
  await snapshots.save(legacy);

  const store2 = new Store();
  const res = await new Persistence({ events, snapshots }).hydrate(store2);
  assert.equal(res.replayed, 1, "only the post-snapshot event replays under the legacy filter");
  assert.ok(store2.get("node:a"), "from the snapshot");
  assert.ok(store2.get("node:b"), "from the tail");
});

test("boot from snapshot + EMPTY tail adopts the watermark (no seq-0 rollback)", async () => {
  // The app's boot payload ships only the POST-watermark tail; when the snapshot has absorbed everything
  // (watermark == last seq — the common case) that tail is EMPTY, so the fresh Persistence sees an empty
  // event store. The watermark must still be adopted from the snapshot, or the mirror's lastSeq would be
  // 0 and the next debounced save would stamp a watermark BELOW the stored one (a stale rollback — the
  // remote store rejects it 409 every boot) and the next gesture would restart the timeline at seq 1.
  const events = new MemoryEventStore();
  const snapshots = new MemorySnapshotStore();
  const a = makeApp(events, snapshots);
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", x: 0, y: 0 } });
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b", x: 0, y: 0 } });
  await a.persistence.flush();
  assert.equal((await snapshots.load())!.seq, 2, "snapshot watermark is the last event's seq");

  // Boot with the snapshot but an EMPTY tail (the absorbed prefix is not fed to the client Persistence).
  const p2 = new Persistence({ events: new MemoryEventStore(), snapshots });
  const store2 = new Store();
  const res = await p2.hydrate(store2);
  assert.equal(res.replayed, 0, "nothing to replay — the snapshot covers it all");
  assert.ok(store2.get("node:a") && store2.get("node:b"), "hydrated from the snapshot alone");

  // The timeline CONTINUES above the adopted watermark — the next gesture is seq 3, not a reset to 1.
  const editor2 = new Editor({ store: store2, log: p2 });
  const ev = editor2.commit({ type: "setTitle", actor: "human", payload: { id: "node:a", title: "A2" } });
  assert.equal(ev.seq, 3, "next seq sits above the adopted watermark, not reset to 1");

  // …and the debounced save stamps that watermark — never below the stored one (no stale-409 rollback).
  p2.attach(store2);
  await p2.flush();
  assert.equal((await snapshots.load())!.seq, 3, "the save stamps a watermark ahead of the boot one");
});

test("snapshot + tail replay == full replay from an empty log (no snapshot)", async () => {
  // Build the same history twice: once with a snapshot cache, once log-only; final states must match.
  const cmds: { type: string; payload: any }[] = [
    { type: "addNode", payload: { id: "node:a", x: 1, y: 1 } },
    { type: "addNode", payload: { id: "node:b", x: 2, y: 2 } },
    { type: "moveNode", payload: { id: "node:a", x: 10, y: 10 } },
    { type: "removeNode", payload: { id: "node:b" } },
    { type: "setTitle", payload: { id: "node:a", title: "kept" } },
  ];

  const withSnap = makeApp();
  for (const c of cmds) withSnap.editor.commit({ ...c, actor: "human" });
  await withSnap.persistence.flush();
  const s1 = new Store();
  await new Persistence({ events: withSnap.events, snapshots: withSnap.snapshots }).hydrate(s1);

  const events2 = new MemoryEventStore();
  const logOnly = new Persistence({ events: events2 }); // NO snapshot backend
  const e2 = new Editor({ log: logOnly });
  for (const c of cmds) e2.commit({ ...c, actor: "human" });
  await logOnly.flush(); // drain the durable write chain before reading the backend back
  const s2 = new Store();
  await new Persistence({ events: events2 }).hydrate(s2);

  const norm = (s: Store) =>
    JSON.stringify(s.getSnapshot().records.sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(norm(s1), norm(s2));
  assert.ok(!s1.get("node:b"), "removed node stays removed through both paths");
});

test("hydrate reports fresh=true when nothing is persisted (host should seed)", async () => {
  const p = new Persistence({ events: new MemoryEventStore(), snapshots: new MemorySnapshotStore() });
  const res = await p.hydrate(new Store());
  assert.equal(res.fresh, true);
  assert.equal(res.version, 0);
  assert.equal(res.replayed, 0);
});

test("debounce coalesces a burst of edits into ONE snapshot write; flush forces it", async () => {
  let saves = 0;
  const snapshots = new MemorySnapshotStore();
  const countingSnapshots = {
    load: () => snapshots.load(),
    save: (s: any) => {
      saves++;
      return snapshots.save(s);
    },
    clear: () => snapshots.clear(),
  };
  const persistence = new Persistence({
    events: new MemoryEventStore(),
    snapshots: countingSnapshots,
    debounceMs: 50,
  });
  const editor = new Editor({ log: persistence });
  persistence.attach(editor.store);

  for (let i = 0; i < 5; i++) {
    editor.commit({ type: "addNode", actor: "human", payload: { id: `node:${i}`, x: i, y: 0 } });
  }
  assert.equal(saves, 0, "debounced: no save mid-burst");
  await persistence.flush();
  assert.equal(saves, 1, "the whole burst collapsed to one snapshot write");
});

test("hydrate emits nothing on channel 2, so it doesn't pollute undo on reload", async () => {
  const a = makeApp();
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", x: 0, y: 0 } });
  a.editor.commit({ type: "addNode", actor: "human", payload: { id: "node:b", x: 0, y: 0 } });
  await a.persistence.flush();

  const store2 = new Store();
  let ch2 = 0;
  store2.listen(() => ch2++);
  await new Persistence({ events: a.events, snapshots: a.snapshots }).hydrate(store2);
  assert.equal(ch2, 0, "loadSnapshot does not emit a diff");

  // a freshly-attached UndoManager after hydrate has nothing to undo (the loaded board isn't undoable)
  const undo = new UndoManager(store2);
  assert.equal(undo.canUndo, false);
});

// ── stage-2 tab semantics (design §9 stage 2 / §10): a server-committed bus diff ingested over the wire ──
// The server now owns command authority: the tab receives a committed DIFF + the server's authoritative
// seq (not the command) and applies it via applyDiffAsChange(diff,"remote") + persistence.adoptSeq(seq)
// (agentBus.ts). This proves the three properties that keeps: not re-logged (one event per command, minted
// at the server), not undoable by a human ⌘Z (source "remote"), and the seq is adopted so the tab's next
// locally-minted gesture can't collide with a bus seq.
test("stage-2: a remote (server bus) diff is applied but NOT re-logged, NOT undoable, and its seq is adopted", () => {
  const { editor, persistence } = makeApp();
  const undo = new UndoManager(editor.store);

  // The tab's own human gesture: logged locally (seq 1), undoable.
  editor.commit({ type: "addNode", actor: "human", payload: { id: "node:a", title: "A" } });
  assert.equal(persistence.all().length, 1, "the human gesture is in the tab's log");

  // A server BUS command the tab never sees as a command — only its diff arrives, carrying the server's
  // authoritative seq (the server is now at seq 4 after other bus commits this tab didn't log).
  const nodeB: NodeRecord = { typeName: "node", id: "node:b", type: "note", title: "B", text: "", color: "blue" };
  const busDiff = { added: { "node:b": nodeB }, updated: {}, removed: {} };
  editor.store.applyDiffAsChange(busDiff, "remote");
  persistence.adoptSeq(4);

  assert.ok(editor.store.get("node:b"), "the remote (bus) diff is applied to the store");
  assert.equal(persistence.all().length, 1, "a remote diff is NOT re-logged by the tab (the server already appended it)");

  // Seq adoption (§10): the tab's NEXT locally-minted seq sits ABOVE the adopted server seq (4), so a human
  // gesture echoed to the server can't be handed a seq a bus command already used.
  const ev = editor.commit({ type: "setTitle", actor: "human", payload: { id: "node:b", title: "B2" } });
  assert.equal(ev.seq, 5, "the next gesture mints seq 5, above the adopted server watermark of 4");

  // A human ⌘Z pops the human gestures, never the remote change.
  undo.undo(); // reverts setTitle B2 → B
  assert.equal(editor.store.get<"node">("node:b")?.title, "B", "undo reverted the human setTitle");
  assert.ok(editor.store.get("node:b"), "the remote-added node itself survives undo");
});
