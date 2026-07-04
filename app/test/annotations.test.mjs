// The annotation ledger (docs/doc-annotations.md §5): one append-only jsonl per annotated file under
// `.canvas/annotations/`, folded to current state at read. The thread ledger's sibling — same
// encoded-name convention, same byte-bounded ragged-tolerant tail read; the difference under test is
// the fold (create/reply/resolve/reopen/reanchor/thread) and that `orphaned` is nowhere in it
// (derived at read time upstream, never stored).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canvasAnnotationsDir,
  appendAnnotationEvent,
  readAnnotationLog,
  foldAnnotations,
  listAnnotatedPaths,
} from "../annotations.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "annotations-"));
}
const anchor = { exact: "the quoted span", prefix: "before ", suffix: " after", offset: 42 };
const create = (id, extra = {}) => ({
  ev: "create", id, path: "docs/foo.md", anchor, text: "why not X?", author: "human", ts: 100, ...extra,
});

test("events round-trip through the ledger and land under .canvas/annotations/ with an encoded name", () => {
  const repo = tmpRepo();
  const p = "docs/dir with space/foo.md";
  assert.deepEqual(readAnnotationLog(repo, p), [], "no file → empty, not a throw");
  assert.equal(appendAnnotationEvent(repo, p, create("anno:1", { path: p })), true);
  assert.equal(appendAnnotationEvent(repo, p, { ev: "reply", id: "anno:1", from: "s1", text: "because Y", ts: 200 }), true);
  assert.deepEqual(readAnnotationLog(repo, p).map((e) => e.ev), ["create", "reply"]);
  // The slash-bearing path is percent-encoded into the filename and recoverable by decode.
  const f = path.join(canvasAnnotationsDir(repo), encodeURIComponent(p) + ".jsonl");
  assert.ok(fs.existsSync(f), "log lives under .canvas/annotations/ with an encoded name");
  assert.deepEqual(listAnnotatedPaths(repo), [p]);
});

test("fold: the full lifecycle — create, reply, resolve, reopen, reanchor, thread", () => {
  const moved = { exact: "the quoted span", prefix: "rewritten ", suffix: " context", offset: 7 };
  const folded = foldAnnotations([
    create("anno:1"),
    { ev: "reply", id: "anno:1", from: "s1", text: "because Y — see §3", ts: 200 },
    { ev: "reply", id: "anno:1", from: "human", text: "got it", ts: 300 },
    { ev: "resolve", id: "anno:1", by: "human", ts: 400 },
    { ev: "reopen", id: "anno:1", by: "human", ts: 500 },
    { ev: "reanchor", id: "anno:1", anchor: moved, by: "s2", ts: 600 },
    { ev: "thread", id: "anno:1", thread: "node:thread:esc", ts: 700 },
  ]);
  assert.equal(folded.length, 1);
  const a = folded[0];
  assert.equal(a.id, "anno:1");
  assert.equal(a.text, "why not X?");
  assert.equal(a.author, "human");
  assert.deepEqual(a.replies.map((r) => r.from), ["s1", "human"]);
  assert.equal(a.resolved, false, "reopen undoes resolve");
  assert.equal(a.resolvedBy, undefined, "reopen clears the resolver stamp");
  assert.deepEqual(a.anchor, moved, "reanchor replaces the selector (provenance stays in the log)");
  assert.equal(a.thread, "node:thread:esc");
  assert.ok(!("orphaned" in a), "orphaned is derived at read time, never part of the fold");
});

test("fold: resolve sticks with its resolver when not reopened", () => {
  const [a] = foldAnnotations([create("anno:1"), { ev: "resolve", id: "anno:1", by: "s1", ts: 200 }]);
  assert.equal(a.resolved, true);
  assert.equal(a.resolvedBy, "s1");
  assert.equal(a.resolvedTs, 200);
});

test("fold: events for an unseen id are dropped; a duplicate create doesn't clobber (first wins)", () => {
  const folded = foldAnnotations([
    { ev: "reply", id: "anno:ghost", from: "s1", text: "reply to a chopped create", ts: 100 },
    create("anno:1"),
    create("anno:1", { text: "a replayed different text", ts: 999 }),
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].text, "why not X?", "the birth record wins");
});

test("fold: annotations come back in creation order, independent ids kept apart", () => {
  const folded = foldAnnotations([
    create("anno:1", { ts: 100 }),
    create("anno:2", { ts: 200, text: "and Z?" }),
    { ev: "resolve", id: "anno:1", by: "human", ts: 300 },
  ]);
  assert.deepEqual(folded.map((a) => [a.id, a.resolved]), [["anno:1", true], ["anno:2", false]]);
});

test("readAnnotationLog tolerates a ragged first line (a tail-cut / torn mid-write append)", () => {
  const repo = tmpRepo();
  const p = "docs/foo.md";
  fs.mkdirSync(canvasAnnotationsDir(repo), { recursive: true });
  fs.writeFileSync(
    path.join(canvasAnnotationsDir(repo), encodeURIComponent(p) + ".jsonl"),
    `"anchor":{"exact":"chopped"}}\n${JSON.stringify(create("anno:2"))}\n`,
  );
  assert.deepEqual(readAnnotationLog(repo, p).map((e) => e.id), ["anno:2"]);
});

test("listAnnotatedPaths: missing dir → [], non-decodable strays skipped, sorted", () => {
  const repo = tmpRepo();
  assert.deepEqual(listAnnotatedPaths(repo), []);
  appendAnnotationEvent(repo, "docs/b.md", create("anno:1", { path: "docs/b.md" }));
  appendAnnotationEvent(repo, "docs/a.md", create("anno:2", { path: "docs/a.md" }));
  fs.writeFileSync(path.join(canvasAnnotationsDir(repo), "not%GGours.jsonl"), "junk\n");
  fs.writeFileSync(path.join(canvasAnnotationsDir(repo), "README.txt"), "also not ours\n");
  assert.deepEqual(listAnnotatedPaths(repo), ["docs/a.md", "docs/b.md"]);
});
