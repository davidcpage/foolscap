// The channel ledger: durable `.canvas/channels/` storage that survives a COLD restart (the in-memory
// channelLogs only survives a hot re-eval) and backs the channels-list rail. The sessions ledger's twin.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canvasChannelsDir,
  appendChannelLine,
  readChannelLog,
  readChannelMeta,
  upsertChannelMeta,
  listChannels,
} from "../channel-ledger.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chan-ledger-"));
}
const msg = (seq, text, extra = {}) => ({ seq, ts: seq * 10, from: "s1", text, ...extra });

test("a message log round-trips and lands under the board's .canvas/ home", () => {
  const repo = tmpRepo();
  const id = "node:chan:abc";
  assert.deepEqual(readChannelLog(repo, id), [], "no file → empty, not a throw");
  appendChannelLine(repo, id, msg(1, "hello"));
  appendChannelLine(repo, id, msg(2, "world", { kind: "ask" }));
  assert.deepEqual(readChannelLog(repo, id), [msg(1, "hello"), msg(2, "world", { kind: "ask" })]);
  // The colon-bearing channel id is percent-encoded into the filename (a colon isn't a safe filename).
  const f = path.join(canvasChannelsDir(repo), encodeURIComponent(id) + ".jsonl");
  assert.ok(fs.existsSync(f), "log lives under .canvas/channels/ with an encoded name");
});

test("readChannelLog tolerates a ragged first line (a tail-cut / torn mid-write append)", () => {
  const repo = tmpRepo();
  const id = "node:chan:ragged";
  fs.mkdirSync(canvasChannelsDir(repo), { recursive: true });
  // A chopped leading line (as a byte-bounded tail read would leave) followed by whole records.
  fs.writeFileSync(
    path.join(canvasChannelsDir(repo), encodeURIComponent(id) + ".jsonl"),
    `q":"partial"}\n${JSON.stringify(msg(5, "intact"))}\n`,
  );
  assert.deepEqual(readChannelLog(repo, id), [msg(5, "intact")], "the unparseable first line is skipped");
});

test("upsertChannelMeta writes createdAt once and refreshes title/activity", () => {
  const repo = tmpRepo();
  const id = "node:chan:m";
  assert.equal(readChannelMeta(repo, id), null, "no marker → null");
  upsertChannelMeta(repo, id, { title: "planning", text: "the topic", lastSeq: 1, lastTs: 100 });
  const first = readChannelMeta(repo, id);
  assert.equal(first.chanId, id);
  assert.equal(first.createdAt, 100, "createdAt seeds from the first activity ts");
  // A later append refreshes title/lastSeq/lastTs but must NOT move createdAt.
  upsertChannelMeta(repo, id, { title: "planning v2", lastSeq: 7, lastTs: 500 });
  const second = readChannelMeta(repo, id);
  assert.equal(second.createdAt, 100, "createdAt is written once, not clobbered");
  assert.equal(second.title, "planning v2");
  assert.equal(second.lastSeq, 7);
  assert.equal(second.text, "the topic", "an absent field keeps its prior value (merge, not replace)");
});

test("a declared-intents index on the marker survives activity upserts (the work-intent act relies on it)", () => {
  const repo = tmpRepo();
  const id = "node:chan:wi";
  // The intent handler writes the full latest-per-member map onto the marker…
  upsertChannelMeta(repo, id, { intents: { s1: { intent: "working", ts: 100 } }, lastSeq: 1, lastTs: 100 });
  // …and every ordinary post's activity upsert (lastSeq/lastTs/title) must shallow-merge AROUND it, not
  // clobber it — the property that makes the marker a safe home for the index.
  upsertChannelMeta(repo, id, { title: "build", lastSeq: 2, lastTs: 200 });
  assert.deepEqual(readChannelMeta(repo, id).intents, { s1: { intent: "working", ts: 100 } });
  // A later declaration replaces the map wholesale — the latest intent per member wins.
  upsertChannelMeta(repo, id, {
    intents: { s1: { intent: "blocked:human", ts: 300, note: "need a nod" }, s2: { intent: "done", ts: 300 } },
  });
  const final = readChannelMeta(repo, id);
  assert.equal(final.intents.s1.intent, "blocked:human");
  assert.equal(final.intents.s2.intent, "done");
  assert.equal(final.title, "build", "the intent upsert keeps the activity fields");
});

test("listChannels returns every marked channel, newest activity first", () => {
  const repo = tmpRepo();
  upsertChannelMeta(repo, "node:chan:old", { title: "old", lastSeq: 1, lastTs: 100 });
  upsertChannelMeta(repo, "node:chan:new", { title: "new", lastSeq: 1, lastTs: 900 });
  upsertChannelMeta(repo, "node:chan:mid", { title: "mid", lastSeq: 1, lastTs: 500 });
  // A bare .jsonl with no marker (a torn write that never upserted) must NOT appear — the marker is the index.
  appendChannelLine(repo, "node:chan:nomarker", msg(1, "orphan log"));
  const ids = listChannels(repo).map((m) => m.chanId);
  assert.deepEqual(ids, ["node:chan:new", "node:chan:mid", "node:chan:old"]);
});

test("a missing channels dir yields an empty list, not a throw", () => {
  const repo = tmpRepo();
  assert.deepEqual(listChannels(repo), []);
});
