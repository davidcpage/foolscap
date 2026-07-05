// auto-wake.js (P2/W5, wakeable-substrate-plan): the server-spawn-from-record CORE — the single-flight
// claim registry that stops a wake storm fanning out into duplicate workers, and the pure qualification
// predicates that decide whether an annotation activity clears a watcher's level (reusing W4's wakesSeat).
// The actual spawn (ensureLiveSession) is wired + live-smoke-tested in vite-fs-plugin.ts; here we cover the
// pure logic that gates it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  docSurfaceKey,
  seatSurfaceKey,
  claimSurface,
  releaseSurface,
  surfaceClaimant,
  isSurfaceClaimed,
  clearAllClaims,
  annotationWakeClass,
  qualifyingWatchers,
  shouldReapIdle,
} from "../auto-wake.js";

// ── surface keys ────────────────────────────────────────────────────────────────────────────────────
test("surface keys are distinct per surface and stable", () => {
  assert.equal(docSurfaceKey("docs/x.md"), "doc:docs/x.md");
  assert.equal(seatSurfaceKey("node:thread:abc", "Coordinator"), "thread:node:thread:abc#Coordinator");
  assert.notEqual(docSurfaceKey("docs/x.md"), docSurfaceKey("docs/y.md"));
});

// ── single-flight claim registry ──────────────────────────────────────────────────────────────────────
test("claim / release round-trip; release only frees a claim the SAME sid holds", () => {
  clearAllClaims();
  const key = docSurfaceKey("docs/a.md");
  assert.equal(isSurfaceClaimed(key), false);
  assert.equal(surfaceClaimant(key), null);

  claimSurface(key, "sid-1");
  assert.equal(isSurfaceClaimed(key), true);
  assert.equal(surfaceClaimant(key), "sid-1");

  // A stale worker (sid-2) must NOT free sid-1's live claim.
  assert.equal(releaseSurface(key, "sid-2"), false);
  assert.equal(surfaceClaimant(key), "sid-1");

  // The holder frees its own.
  assert.equal(releaseSurface(key, "sid-1"), true);
  assert.equal(isSurfaceClaimed(key), false);
  // A second release is a harmless no-op.
  assert.equal(releaseSurface(key, "sid-1"), false);
});

test("a supersede overwrites the claimant; the superseded sid can no longer release it", () => {
  clearAllClaims();
  const key = seatSurfaceKey("node:thread:t", "Impl");
  claimSurface(key, "old");
  claimSurface(key, "new"); // deliberate supersede (caller cleared a dead claim first)
  assert.equal(surfaceClaimant(key), "new");
  assert.equal(releaseSurface(key, "old"), false); // old can't free new's slot
  assert.equal(releaseSurface(key, "new"), true);
});

test("clearAllClaims resets the whole registry", () => {
  claimSurface(docSurfaceKey("docs/z.md"), "s");
  clearAllClaims();
  assert.equal(isSurfaceClaimed(docSurfaceKey("docs/z.md")), false);
});

// ── annotation wake class ───────────────────────────────────────────────────────────────────────────
test("annotationWakeClass: answer=addressed(mention), note=broadcast, everything else wakes no one", () => {
  assert.deepEqual(annotationWakeClass("answer"), { mentioned: true, broadcast: false });
  assert.deepEqual(annotationWakeClass("note"), { mentioned: false, broadcast: true });
  // A fresh question awaits a HUMAN — no agent wake (no-op-spawn avoidance); ditto reply/resolve/etc.
  for (const k of ["question", "reply", "resolve", "reanchor", "thread", "", "whatever"])
    assert.deepEqual(annotationWakeClass(k), { mentioned: false, broadcast: false }, `kind=${k}`);
});

// ── qualification (the wakesSeat gate, one surface over) ──────────────────────────────────────────────
const W = (role, level, state = "active") => ({ role, level, state, by: "human", createdAt: 1 });

test("a NOTE (broadcast) wakes only `all`-level watchers", () => {
  const watchers = [W("A", "all"), W("B", "mentions"), W("C", "paused")];
  const woken = qualifyingWatchers(watchers, "note").map((w) => w.role);
  assert.deepEqual(woken, ["A"]);
});

test("an ANSWER (addressed/mention) wakes watchers at EVERY level — the @-mention override", () => {
  const watchers = [W("A", "all"), W("B", "mentions"), W("C", "paused")];
  const woken = qualifyingWatchers(watchers, "answer").map((w) => w.role);
  assert.deepEqual(woken, ["A", "B", "C"]);
});

test("a PAUSED-state watcher is muted for a broadcast even at level `all` (effective level = paused)", () => {
  // watcherEffectiveLevel collapses a paused *state* to `paused`, so a note (broadcast) no longer wakes it…
  const paused = [W("A", "all", "paused")];
  assert.deepEqual(qualifyingWatchers(paused, "note"), []);
  // …but an answer (mention) still overrides the pause.
  assert.deepEqual(qualifyingWatchers(paused, "answer").map((w) => w.role), ["A"]);
});

test("the ask-armed seat pattern: a `mentions` watcher wakes on the ANSWER, not on the question/comment", () => {
  const askArmed = [W("ask", "mentions")];
  assert.deepEqual(qualifyingWatchers(askArmed, "note"), []); // a comment doesn't wake it
  assert.deepEqual(qualifyingWatchers(askArmed, "question"), []); // nor a fresh question
  assert.deepEqual(qualifyingWatchers(askArmed, "answer").map((w) => w.role), ["ask"]); // the answer does
});

test("no watchers, or a non-triggering kind → nobody qualifies (never throws on null)", () => {
  assert.deepEqual(qualifyingWatchers(null, "note"), []);
  assert.deepEqual(qualifyingWatchers(undefined, "answer"), []);
  assert.deepEqual(qualifyingWatchers([W("A", "all")], "question"), []);
});

// ── R1 keep-alive reap decision ───────────────────────────────────────────────────────────────────────
const KEEP = 5 * 60_000;
const NOW = 1_000_000_000;

test("shouldReapIdle: an auto-wake worker idle past the keep-alive window is reaped", () => {
  assert.equal(shouldReapIdle({ autoWake: true, status: "idle", idleSince: NOW - KEEP }, NOW, KEEP), true);
  assert.equal(shouldReapIdle({ autoWake: true, status: "idle", idleSince: NOW - KEEP - 1 }, NOW, KEEP), true);
});

test("shouldReapIdle: NOT reaped while inside the window, or mid-turn, or with no idle stamp", () => {
  assert.equal(shouldReapIdle({ autoWake: true, status: "idle", idleSince: NOW - 60_000 }, NOW, KEEP), false); // fresh idle
  assert.equal(shouldReapIdle({ autoWake: true, status: "running", idleSince: NOW - KEEP }, NOW, KEEP), false); // working
  assert.equal(shouldReapIdle({ autoWake: true, status: "idle", idleSince: undefined }, NOW, KEEP), false); // never idled
});

test("shouldReapIdle: a human card / the looping Coordinator (no autoWake) is NEVER reaped", () => {
  assert.equal(shouldReapIdle({ status: "idle", idleSince: NOW - KEEP * 10 }, NOW, KEEP), false);
  assert.equal(shouldReapIdle({ autoWake: false, status: "idle", idleSince: NOW - KEEP * 10 }, NOW, KEEP), false);
  assert.equal(shouldReapIdle(null, NOW, KEEP), false);
  assert.equal(shouldReapIdle(undefined, NOW, KEEP), false);
});
