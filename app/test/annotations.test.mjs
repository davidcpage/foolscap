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
  questionState,
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

// ── anchored async-ask: kind:"question", the answer event, derived question state (W1) ──────────────

test("fold: a plain create folds to kind:note (default), no question fields", () => {
  const [a] = foldAnnotations([create("anno:1")]);
  assert.equal(a.kind, "note", "a create with no kind is a note — back-compatible default");
  assert.ok(!("options" in a) && !("blocking" in a) && !("answered" in a));
  assert.equal(questionState(a), null, "a note has no question state");
});

test("fold: a question create carries kind/options/blocking; questionState is 'awaiting'", () => {
  const [a] = foldAnnotations([
    create("anno:1", {
      kind: "question",
      text: "Wake model for R2?",
      options: [{ label: "Always-wake" }, { label: "Tag-gated", description: "only @-mentions" }],
      blocking: true,
    }),
  ]);
  assert.equal(a.kind, "question");
  assert.deepEqual(a.options.map((o) => o.label), ["Always-wake", "Tag-gated"]);
  assert.equal(a.options[1].description, "only @-mentions");
  assert.equal(a.blocking, true);
  assert.equal(questionState(a), "awaiting", "unanswered, unresolved question awaits a human");
});

test("fold: an answer event marks answered, stamps `answer`, and rides `replies` with its choice", () => {
  const [a] = foldAnnotations([
    create("anno:1", { kind: "question", options: [{ label: "A" }, { label: "B" }] }),
    { ev: "answer", id: "anno:1", by: "human", choice: "B", text: "go with B — simpler", ts: 200 },
  ]);
  assert.equal(a.answered, true);
  assert.deepEqual(a.answer, { by: "human", choice: "B", text: "go with B — simpler", ts: 200 });
  assert.equal(a.replies.length, 1, "the answer shows in the conversation view too");
  assert.equal(a.replies[0].choice, "B");
  assert.equal(questionState(a), "answered", "answered but not yet resolved → needs an agent to apply");
});

test("fold: an answer with only a choice (no prose) folds to text:'' and stays answered", () => {
  const [a] = foldAnnotations([
    create("anno:1", { kind: "question", options: [{ label: "A" }] }),
    { ev: "answer", id: "anno:1", by: "human", choice: "A", ts: 200 },
  ]);
  assert.equal(a.answer.text, "");
  assert.equal(a.replies[0].text, "");
  assert.equal(questionState(a), "answered");
});

test("questionState: resolve supersedes → 'resolved'; a reopened-but-answered question stays 'answered'", () => {
  const base = [
    create("anno:1", { kind: "question" }),
    { ev: "answer", id: "anno:1", by: "human", text: "done", ts: 200 },
  ];
  const [resolved] = foldAnnotations([...base, { ev: "resolve", id: "anno:1", by: "s1", ts: 300 }]);
  assert.equal(questionState(resolved), "resolved", "the asker resolving supersedes answered");
  const [reopened] = foldAnnotations([
    ...base,
    { ev: "resolve", id: "anno:1", by: "s1", ts: 300 },
    { ev: "reopen", id: "anno:1", by: "s1", ts: 400 },
  ]);
  assert.equal(reopened.answered, true, "the answer still stands after reopen");
  assert.equal(questionState(reopened), "answered", "reopen clears resolved, not the recorded answer");
});

test("questionState: null for a note even if an answer event somehow lands on it", () => {
  const [a] = foldAnnotations([
    create("anno:1"), // a note
    { ev: "answer", id: "anno:1", by: "human", text: "stray", ts: 200 },
  ]);
  assert.equal(a.kind, "note");
  assert.equal(questionState(a), null, "only a kind:question has a question state");
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
