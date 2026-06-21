import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiff, invertDiff, isEmptyDiff, squashDiffs, type RecordsDiff } from "../src/diff.js";
import type { AnyRecord, LayoutRecord, NodeRecord } from "../src/records.js";

const node = (id: string, title: string): NodeRecord => ({ typeName: "node", id: `node:${id}`, type: "note", title, text: "", color: "yellow" });
const layout = (id: string, x: number): LayoutRecord => ({ typeName: "layout", id: `layout:node:${id}`, nodeId: `node:${id}`, x, y: 0, w: 1, h: 1, z: 0 });

test("invertDiff swaps add/remove and flips updates", () => {
  const a = node("a", "v1");
  const a2 = node("a", "v2");
  const b = node("b", "b");
  const d: RecordsDiff = { added: { [b.id]: b }, updated: { [a.id]: [a, a2] }, removed: {} };
  const inv = invertDiff(d);
  assert.deepEqual(inv.removed, { [b.id]: b });
  assert.deepEqual(inv.updated, { [a.id]: [a2, a] });
  assert.deepEqual(inv.added, {});
});

test("apply then apply-inverse round-trips a record map", () => {
  const map = new Map<string, AnyRecord>();
  const a = node("a", "v1");
  map.set(a.id, a);
  const a2 = node("a", "v2");
  const b = node("b", "b");
  const d: RecordsDiff = { added: { [b.id]: b }, updated: { [a.id]: [a, a2] }, removed: {} };

  applyDiff(map, d);
  assert.equal((map.get(a.id) as NodeRecord).title, "v2");
  assert.ok(map.has(b.id));

  applyDiff(map, invertDiff(d));
  assert.equal((map.get(a.id) as NodeRecord).title, "v1");
  assert.ok(!map.has(b.id));
});

test("squashDiffs: add then update → single add with final value", () => {
  const a1 = layout("a", 1);
  const a2 = layout("a", 2);
  const d1: RecordsDiff = { added: { [a1.id]: a1 }, updated: {}, removed: {} };
  const d2: RecordsDiff = { added: {}, updated: { [a1.id]: [a1, a2] }, removed: {} };
  const sq = squashDiffs([d1, d2]);
  assert.deepEqual(Object.keys(sq.added), [a1.id]);
  assert.equal((sq.added[a1.id] as LayoutRecord).x, 2);
  assert.deepEqual(sq.updated, {});
});

test("squashDiffs: add then remove → no-op", () => {
  const a = node("a", "a");
  const d1: RecordsDiff = { added: { [a.id]: a }, updated: {}, removed: {} };
  const d2: RecordsDiff = { added: {}, updated: {}, removed: { [a.id]: a } };
  assert.ok(isEmptyDiff(squashDiffs([d1, d2])));
});

test("squashDiffs: 60 drag frames coalesce to one update", () => {
  const frames: RecordsDiff[] = [];
  let prev = layout("a", 0);
  for (let i = 1; i <= 60; i++) {
    const next = layout("a", i);
    frames.push({ added: {}, updated: { [prev.id]: [prev, next] }, removed: {} });
    prev = next;
  }
  const sq = squashDiffs(frames);
  assert.deepEqual(Object.keys(sq.updated), [prev.id]);
  assert.equal((sq.updated[prev.id]![0] as LayoutRecord).x, 0); // from = first frame
  assert.equal((sq.updated[prev.id]![1] as LayoutRecord).x, 60); // to = last frame
});
