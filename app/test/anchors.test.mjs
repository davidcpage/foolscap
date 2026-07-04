// The annotation anchor module (docs/doc-annotations.md §3): TextQuoteSelector resolution against a
// markdown source — offset fast path, exact search disambiguated by context, bounded fuzzy, and the
// null that means ORPHAN (surfaced loud upstream, never dropped). The properties under test are the
// ones the standoff bet rests on: an unedited doc always resolves, a typical agent revision usually
// resolves, and a gone quote orphans rather than mis-anchoring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAnchor, resolveAnchor } from "../anchors.js";

const doc = [
  "# Channel discipline",
  "",
  "The renderer reads channel 1 only, persistence and undo consume channel 2, and one gesture",
  "emits exactly one channel-3 IntentEvent. Don't cross these wires.",
  "",
  "The store is hidden behind Subscribable<T> so the engines never learn about the renderer.",
].join("\n");

test("makeAnchor mints a selector that resolves back to its own range (the round-trip)", () => {
  const start = doc.indexOf("persistence and undo");
  const anchor = makeAnchor(doc, start, start + "persistence and undo".length);
  assert.equal(anchor.exact, "persistence and undo");
  assert.equal(anchor.offset, start);
  const r = resolveAnchor(doc, anchor);
  assert.deepEqual(r, { start, end: start + anchor.exact.length, method: "offset" });
});

test("a stale offset falls through to the exact pass (text inserted above the quote)", () => {
  const start = doc.indexOf("Don't cross these wires");
  const anchor = makeAnchor(doc, start, start + "Don't cross these wires".length);
  const edited = "A new intro paragraph.\n\n" + doc; // everything shifts; offset now points mid-word
  const r = resolveAnchor(edited, anchor);
  assert.ok(r, "still resolves");
  assert.equal(r.method, "exact");
  assert.equal(edited.slice(r.start, r.end), "Don't cross these wires");
});

test("an ambiguous quote is disambiguated by its prefix/suffix context", () => {
  // "channel" appears many times; anchor the one inside "channel-3 IntentEvent".
  const start = doc.indexOf("channel-3");
  const anchor = makeAnchor(doc, start, start + "channel".length);
  // Break the offset hint so only context can pick the right hit.
  const shifted = "x".repeat(7) + doc;
  const r = resolveAnchor(shifted, anchor);
  assert.ok(r);
  assert.equal(shifted.slice(r.start, r.end + 2), "channel-3", "the context-matched occurrence wins");
});

test("a lightly edited quote resolves fuzzily (the agent-revision case)", () => {
  const quote = "the engines never learn about the renderer";
  const start = doc.indexOf(quote);
  const anchor = makeAnchor(doc, start, start + quote.length);
  const edited = doc.replace("never learn about", "never ever learn about");
  const r = resolveAnchor(edited, anchor);
  assert.ok(r, "a small in-quote edit must not orphan");
  assert.equal(r.method, "fuzzy");
  const got = edited.slice(r.start, r.end);
  assert.ok(got.includes("never ever learn about"), `matched span covers the edit: ${JSON.stringify(got)}`);
});

test("a reflowed quote (newline for space) resolves fuzzily", () => {
  const quote = "one gesture\nemits exactly one channel-3 IntentEvent";
  const start = doc.indexOf(quote);
  assert.ok(start >= 0, "fixture sanity");
  const anchor = makeAnchor(doc, start, start + quote.length);
  const rewrapped = doc.replace(quote, quote.replace("\n", " ").replace("channel-3 ", "channel-3\n"));
  const r = resolveAnchor(rewrapped, anchor);
  assert.ok(r, "a rewrap must not orphan");
});

test("a deleted quote orphans (null), and never mis-anchors to unrelated text", () => {
  const quote = "The store is hidden behind Subscribable<T>";
  const start = doc.indexOf(quote);
  const anchor = makeAnchor(doc, start, start + quote.length);
  const edited = doc.replace(/The store.*renderer\./s, "Totally different closing paragraph.");
  assert.equal(resolveAnchor(edited, anchor), null);
});

test("context seeds recover a heavily edited quote whose surroundings survive", () => {
  // The quote's own text is rewritten beyond its seeds, but prefix+suffix are intact and the
  // replacement is within the edit-distance budget of the original.
  const quote = "persistence and undo consume channel 2";
  const start = doc.indexOf(quote);
  const anchor = makeAnchor(doc, start, start + quote.length);
  const edited = doc.replace(quote, "persistence and undo consume channel 9");
  const r = resolveAnchor(edited, anchor);
  assert.ok(r);
  assert.equal(edited.slice(r.start, r.end), "persistence and undo consume channel 9");
});

test("degenerate anchors are orphans, not throws", () => {
  assert.equal(resolveAnchor(doc, null), null);
  assert.equal(resolveAnchor(doc, {}), null);
  assert.equal(resolveAnchor(doc, { exact: "" }), null);
  assert.equal(resolveAnchor("", { exact: "anything" }), null);
  // A quote past the fuzzy size cap that no longer matches exactly is an orphan by design.
  const huge = "z".repeat(600);
  assert.equal(resolveAnchor(doc, { exact: huge }), null);
});

test("resolution is pure string-in/range-out (no anchor mutation)", () => {
  const anchor = Object.freeze(makeAnchor(doc, 2, 20));
  assert.ok(resolveAnchor(doc, anchor));
});
