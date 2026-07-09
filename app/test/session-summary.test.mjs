import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionSummaryFromText, userText } from "../session-summary.js";

const aiTitle = (t) => JSON.stringify({ type: "ai-title", aiTitle: t });
const userMsg = (t) => JSON.stringify({ type: "user", message: { content: t } });
const asstMsg = (t) => JSON.stringify({ type: "assistant", message: { content: t } });
const toolResult = () =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "..." }] } });

test("userText: string, text-parts array, and non-text envelopes", () => {
  assert.equal(userText("  hi  "), "hi");
  assert.equal(userText([{ type: "text", text: " a " }, { type: "text", text: "b" }]), "a b");
  assert.equal(userText([{ type: "tool_result", content: "x" }]), null); // a tool-result is not a turn
  assert.equal(userText(""), null);
});

test("title prefers the LAST ai-title; counts cover every record", () => {
  const text = [
    userMsg("first human prompt"),
    aiTitle("stale early title"),
    asstMsg("ok"),
    userMsg("second prompt"),
    aiTitle("fresh late title"),
    asstMsg("done"),
  ].join("\n");
  const s = sessionSummaryFromText(text);
  assert.equal(s.title, "fresh late title"); // last ai-title wins, not the first
  assert.equal(s.turns, 2); // two text-carrying user records
  assert.equal(s.messages, 4); // 2 user + 2 assistant
});

test("title falls back to the first human prompt (≤80 chars) when no ai-title", () => {
  const long = "x".repeat(200);
  const s = sessionSummaryFromText([userMsg(long), asstMsg("y")].join("\n"));
  assert.equal(s.title, "x".repeat(80));
  assert.equal(s.turns, 1);
});

test("tool-result envelopes count as messages but not turns", () => {
  const s = sessionSummaryFromText([userMsg("real"), toolResult(), asstMsg("a")].join("\n"));
  assert.equal(s.turns, 1); // only the prose user record
  assert.equal(s.messages, 3); // both user records + the assistant
});

// The regression this fixes: a transcript larger than the old MAX_SESSION_BYTES head-slice (4MB). A
// head-slice returned the STALE early title and UNDERCOUNTED turns (everything past 4MB was dropped); the
// whole-file scan sees the fresh late title and the full count. We synthesise >4MB of assistant padding
// between an early and a late title, plus turns on both sides of the boundary.
test("no head-slice: title + counts stay correct past 4MB", () => {
  const HEAD_CAP = 4 * 1024 * 1024;
  const pad = asstMsg("p".repeat(1024)); // ~1KB assistant records as bulk
  const padCount = Math.ceil(HEAD_CAP / (pad.length + 1)) + 100; // comfortably past the old cap
  const lines = [aiTitle("stale early title"), userMsg("early turn")];
  for (let i = 0; i < padCount; i++) lines.push(pad);
  lines.push(userMsg("late turn"), aiTitle("fresh late title"));
  const text = lines.join("\n");
  assert.ok(Buffer.byteLength(text) > HEAD_CAP, "fixture must exceed the old head-slice cap");

  const s = sessionSummaryFromText(text);
  assert.equal(s.title, "fresh late title"); // a head-slice would have kept "stale early title"
  assert.equal(s.turns, 2); // both user turns counted; a head-slice would have missed the late one
  assert.equal(s.messages, 2 + padCount); // every record, not just the pre-4MB head
});
