// Notification levels (P1, wakeable-substrate-plan W4): the shared wake-policy enum + the `wakesSeat`
// predicate every wakeable surface (thread, doc, timer) routes through. Pure — no fs, no server.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFICATION_LEVELS,
  isNotificationLevel,
  normLevel,
  wakesSeat,
} from "../notification-levels.js";

test("the enum is the closed set, loud→quiet", () => {
  assert.deepEqual([...NOTIFICATION_LEVELS], ["all", "mentions", "paused"]);
});

test("isNotificationLevel gates the exact set", () => {
  for (const l of ["all", "mentions", "paused"]) assert.equal(isNotificationLevel(l), true);
  for (const bad of ["ALL", "muted", "", null, undefined, 3, "mention"])
    assert.equal(isNotificationLevel(bad), false);
});

test("normLevel defaults unknown values to `all` (an unset seat wakes on everything — R2 default)", () => {
  assert.equal(normLevel("mentions"), "mentions");
  assert.equal(normLevel("paused"), "paused");
  assert.equal(normLevel("all"), "all");
  for (const bad of [undefined, null, "", "nonsense", 7]) assert.equal(normLevel(bad), "all");
});

test("a MENTION always wakes — the @-mention override reaches every level, even paused", () => {
  for (const l of ["all", "mentions", "paused", "garbage"])
    assert.equal(wakesSeat(l, { mentioned: true }), true, `mention wakes ${l}`);
  // A mention wakes regardless of the broadcast flag too.
  assert.equal(wakesSeat("paused", { mentioned: true, broadcast: true }), true);
});

test("a BROADCAST wakes only level `all`", () => {
  assert.equal(wakesSeat("all", { broadcast: true }), true);
  assert.equal(wakesSeat("mentions", { broadcast: true }), false);
  assert.equal(wakesSeat("paused", { broadcast: true }), false);
  // An unknown level normalizes to `all`, so a broadcast wakes it.
  assert.equal(wakesSeat(undefined, { broadcast: true }), true);
});

test("neither mentioned nor broadcast (an ambient/untagged event) wakes no one, at any level", () => {
  for (const l of ["all", "mentions", "paused"]) {
    assert.equal(wakesSeat(l, {}), false, `ambient never wakes ${l}`);
    assert.equal(wakesSeat(l), false, "no opts is ambient");
  }
});
