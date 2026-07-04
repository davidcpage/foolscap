// Auto-reanchor (docs/doc-annotations.md §4): the server-side anchor-maintenance loop. The properties
// under test are the safety invariants the feature rests on: an unedited doc re-mints nothing (offset
// still hits), an edit that MOVES a quote re-mints it so the next read hits the fast path, a quote the
// edit rewrote is re-minted to its new span (fuzzy), a quote the edit DELETED is left orphaned (never
// mis-reanchored), resolved annotations are ignored, and the whole thing converges in one pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAnchor, resolveAnchor } from "../anchors.js";
import { appendAnnotationEvent, foldAnnotations, readAnnotationLog } from "../annotations.js";
import { planReanchors, reanchorFile } from "../annotation-reanchor.js";

const DOC = [
  "# Wake model",
  "",
  "Within a thread, a new message nudges every member, no tag required.",
  "",
  "The tag keeps the two jobs it does uniquely well: inviting a new member, and addressing a seat.",
].join("\n");

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reanchor-"));
}

// Seed a ledger with one create for `quote` anchored against `source`, return {repo, path, id}.
function seed(source, quote, extra = {}) {
  const repo = tmpRepo();
  const p = "docs/wake.md";
  const start = source.indexOf(quote);
  assert.ok(start >= 0, "test quote must exist in the source");
  const id = "anno:" + quote.slice(0, 6).replace(/\W/g, "");
  appendAnnotationEvent(repo, p, {
    ev: "create",
    id,
    path: p,
    anchor: makeAnchor(source, start, start + quote.length),
    text: "why?",
    author: "human",
    ts: 100,
    ...extra,
  });
  return { repo, path: p, id };
}

const currentAnchor = (repo, p, id) =>
  foldAnnotations(readAnnotationLog(repo, p)).find((a) => a.id === id)?.anchor;

test("unedited doc re-mints nothing — the offset fast path still hits", () => {
  const { repo, path: p, id } = seed(DOC, "every member");
  const r = reanchorFile(repo, DOC, p, { now: 200 });
  assert.deepEqual(r, { checked: 1, reanchored: [], orphaned: [] });
  // No reanchor event was appended.
  assert.deepEqual(readAnnotationLog(repo, p).map((e) => e.ev), ["create"]);
});

test("a quote moved by an edit above it is re-minted so the next resolve hits offset", () => {
  const { repo, path: p, id } = seed(DOC, "addressing a seat");
  const edited = "A new opening paragraph inserted at the very top.\n\n" + DOC;
  // Before reanchor: the stored offset is stale, so it resolves via the slower exact pass.
  assert.equal(resolveAnchor(edited, currentAnchor(repo, p, id)).method, "exact");
  const r = reanchorFile(repo, edited, p, { now: 200 });
  assert.deepEqual(r.reanchored, [id]);
  assert.equal(r.orphaned.length, 0);
  // After reanchor: the fresh anchor sits at its new offset — the fast path is restored.
  const res = resolveAnchor(edited, currentAnchor(repo, p, id));
  assert.equal(res.method, "offset");
  assert.equal(edited.slice(res.start, res.end), "addressing a seat");
  // The event is attributed to "system" with the injected clock.
  const ev = readAnnotationLog(repo, p).find((e) => e.ev === "reanchor");
  assert.equal(ev.by, "system");
  assert.equal(ev.ts, 200);
});

test("a quote the edit lightly rewrote is re-minted to its new span (fuzzy → offset)", () => {
  const { repo, path: p, id } = seed(DOC, "nudges every member, no tag required");
  // A small in-quote edit (required → needed): the exact quote is gone so exact fails, but the change
  // is well within the fuzzy threshold, so it resolves to the edited span rather than orphaning.
  const edited = DOC.replace("no tag required", "no tag needed");
  assert.equal(resolveAnchor(edited, currentAnchor(repo, p, id)).method, "fuzzy");
  const r = reanchorFile(repo, edited, p, { now: 200 });
  assert.deepEqual(r.reanchored, [id]);
  const res = resolveAnchor(edited, currentAnchor(repo, p, id));
  assert.equal(res.method, "offset", "re-minted anchor now hits the fast path");
  assert.match(edited.slice(res.start, res.end), /nudges every member.*no tag needed/);
});

test("a quote the edit DELETED is left orphaned — never mis-reanchored", () => {
  const { repo, path: p, id } = seed(DOC, "addressing a seat");
  const edited = DOC.replace(
    "The tag keeps the two jobs it does uniquely well: inviting a new member, and addressing a seat.",
    "The tag is invite-only now.",
  );
  const r = reanchorFile(repo, edited, p, { now: 200 });
  assert.deepEqual(r, { checked: 1, reanchored: [], orphaned: [id] });
  assert.deepEqual(readAnnotationLog(repo, p).map((e) => e.ev), ["create"], "no reanchor event for an orphan");
});

test("resolved annotations are skipped entirely", () => {
  const { repo, path: p, id } = seed(DOC, "addressing a seat");
  appendAnnotationEvent(repo, p, { ev: "resolve", id, by: "human", ts: 150 });
  const edited = "shift the whole doc down\n\n" + DOC;
  const r = reanchorFile(repo, edited, p, { now: 200 });
  assert.deepEqual(r, { checked: 0, reanchored: [], orphaned: [] });
});

test("a deleted/blocked source orphans every open annotation and re-mints nothing", () => {
  const { repo, path: p, id } = seed(DOC, "every member");
  const r = reanchorFile(repo, null, p, { now: 200 });
  assert.deepEqual(r, { checked: 1, reanchored: [], orphaned: [id] });
  assert.deepEqual(readAnnotationLog(repo, p).map((e) => e.ev), ["create"]);
});

test("reanchoring converges in one pass — a second run is a no-op", () => {
  const { repo, path: p, id } = seed(DOC, "addressing a seat");
  const edited = "prepend\n\n" + DOC;
  const first = reanchorFile(repo, edited, p, { now: 200 });
  assert.deepEqual(first.reanchored, [id]);
  const second = reanchorFile(repo, edited, p, { now: 300 });
  assert.deepEqual(second.reanchored, [], "nothing left to do on the second pass");
  // Exactly one reanchor event was ever written.
  assert.equal(readAnnotationLog(repo, p).filter((e) => e.ev === "reanchor").length, 1);
});

test("planReanchors is pure and returns the resolution method that proved the drift", () => {
  const start = DOC.indexOf("addressing a seat");
  const annos = [
    { id: "a1", resolved: false, anchor: makeAnchor(DOC, start, start + "addressing a seat".length) },
  ];
  const edited = "top\n\n" + DOC;
  const plan = planReanchors(edited, annos);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, "a1");
  assert.equal(plan[0].from, "exact");
  // Purity: the input anchors are untouched.
  assert.equal(annos[0].anchor.offset, start);
});
