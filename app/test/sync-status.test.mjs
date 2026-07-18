// S3-c offline UX (design §9 stage 3, §3.4): the sync-status pill label derivation. The pill is
// unobtrusive-but-honest — hidden when online-and-synced, and it NEVER silently hides a queued edit (the
// truncation doctrine): a non-zero pending is always surfaced, offline or draining.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && spec.endsWith(".js")) {
      try {
        return next(spec, ctx);
      } catch {
        return next(spec.slice(0, -3) + ".ts", ctx);
      }
    }
    return next(spec, ctx);
  },
});

const { syncPillLabel } = await import("../src/sync-status.ts");

test("syncPillLabel: online + synced shows NOTHING (unobtrusive)", () => {
  assert.equal(syncPillLabel({ connected: true, pending: 0 }), null);
});

test("syncPillLabel: connected but draining shows the in-flight count", () => {
  assert.equal(syncPillLabel({ connected: true, pending: 3 }), "syncing 3…");
});

test("syncPillLabel: offline with a backlog surfaces the pending count (never a silent drop)", () => {
  assert.equal(syncPillLabel({ connected: false, pending: 1 }), "offline — 1 edit pending");
  assert.equal(syncPillLabel({ connected: false, pending: 5 }), "offline — 5 edits pending");
});

test("syncPillLabel: offline with nothing queued is a quiet reconnecting note", () => {
  assert.equal(syncPillLabel({ connected: false, pending: 0 }), "reconnecting…");
});
