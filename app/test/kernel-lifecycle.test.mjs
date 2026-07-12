// Kernel lifecycle (BUG-3) — the two leak-guards in server-kernel.ts, exercised WITHOUT a live dev server
// or a real Jupyter gateway: the single-flight start guard (two fast Runs must not race two kernels) and the
// restart-orphan reconcile sweep (the detached gateway survives a dev-server restart while `liveKernels`
// does not, so kernels from before the restart must be reaped). The sweep runs against a fake gateway — a
// throwaway http server speaking just the /api/kernels GET+DELETE the reconcile needs.
//
// server-kernel.ts imports its neighbours by the Vite/tsc `.js`-specifier convention; node --test resolves
// raw, so the resolve hook rewrites a relative `.js` import to its `.ts` sibling when only the `.ts` exists
// (mirroring middleware-hermetic.test.mjs). Registered before the dynamic import so the chain resolves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import http from "node:http";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context); // a real hand-authored .js module — resolve as-is
      } catch {
        return nextResolve(specifier.slice(0, -3) + ".ts", context); // only a .ts sibling exists (a split module)
      }
    }
    return nextResolve(specifier, context);
  },
});

const { singleFlight, reconcileGatewayKernels } = await import("../server-kernel.ts");

// ── single-flight start guard ───────────────────────────────────────────────────────────────────────

test("singleFlight collapses concurrent starts for one key onto a single factory run", async () => {
  const inflight = new Map();
  let calls = 0;
  const factory = () => {
    calls++;
    return new Promise((r) => setTimeout(() => r(`kernel-${calls}`), 20));
  };

  // Two concurrent calls for the SAME key → the factory runs ONCE, both callers get the same promise/result.
  const [a, b] = await Promise.all([
    singleFlight(inflight, "board\0nb", factory),
    singleFlight(inflight, "board\0nb", factory),
  ]);
  assert.equal(calls, 1, "the second concurrent Run must not start a second kernel");
  assert.equal(a, "kernel-1");
  assert.equal(b, a);

  // The slot clears when the start settles, so a later Run starts fresh rather than reusing a stale promise.
  assert.equal(inflight.has("board\0nb"), false, "the in-flight slot clears once the start settles");
  await singleFlight(inflight, "board\0nb", factory);
  assert.equal(calls, 2);
});

test("singleFlight keeps distinct keys independent", async () => {
  const inflight = new Map();
  let calls = 0;
  const factory = () => {
    calls++;
    return new Promise((r) => setTimeout(() => r("ok"), 10));
  };
  await Promise.all([singleFlight(inflight, "a", factory), singleFlight(inflight, "b", factory)]);
  assert.equal(calls, 2, "two different notebooks each get their own kernel");
});

test("singleFlight clears the slot even when the factory rejects", async () => {
  const inflight = new Map();
  await assert.rejects(singleFlight(inflight, "x", () => Promise.reject(new Error("gateway down"))));
  assert.equal(inflight.has("x"), false, "a failed start must not wedge the key forever");
});

// ── restart-orphan reconcile sweep ──────────────────────────────────────────────────────────────────

// A minimal fake kernel gateway: lists a fixed set of kernels and records every DELETE. Optionally fails the
// list request to exercise the best-effort skip path.
function fakeGateway({ kernels, failList = false }) {
  const deleted = [];
  const token = "test-token";
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `token ${token}`) {
      res.writeHead(403);
      return res.end();
    }
    if (req.method === "GET" && req.url === "/api/kernels") {
      if (failList) {
        res.writeHead(500);
        return res.end("boom");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(kernels.map((id) => ({ id, name: "python3" }))));
    }
    if (req.method === "DELETE" && req.url.startsWith("/api/kernels/")) {
      deleted.push(decodeURIComponent(req.url.slice("/api/kernels/".length)));
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        gw: { baseUrl: `http://127.0.0.1:${port}`, token },
        deleted,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("reconcile reaps exactly the gateway kernels the broker no longer tracks", async () => {
  const { gw, deleted, close } = await fakeGateway({ kernels: ["keep", "orphan-1", "orphan-2"] });
  try {
    // Broker still tracks "keep" (a live re-eval-surviving kernel); the other two are pre-restart orphans.
    const reaped = await reconcileGatewayKernels(gw, new Set(["keep"]));
    assert.deepEqual(reaped.sort(), ["orphan-1", "orphan-2"]);
    assert.deepEqual(deleted.sort(), ["orphan-1", "orphan-2"], "the tracked kernel is never deleted");
  } finally {
    await close();
  }
});

test("reconcile after a clean restart (empty registry) reaps every gateway kernel", async () => {
  const { gw, deleted, close } = await fakeGateway({ kernels: ["a", "b", "c"] });
  try {
    const reaped = await reconcileGatewayKernels(gw, new Set());
    assert.deepEqual(reaped.sort(), ["a", "b", "c"]);
    assert.deepEqual(deleted.sort(), ["a", "b", "c"]);
  } finally {
    await close();
  }
});

test("reconcile is a no-op when the broker already tracks everything (a re-eval, not a restart)", async () => {
  const { gw, deleted, close } = await fakeGateway({ kernels: ["a", "b"] });
  try {
    const reaped = await reconcileGatewayKernels(gw, new Set(["a", "b"]));
    assert.deepEqual(reaped, []);
    assert.deepEqual(deleted, [], "nothing is deleted when every gateway kernel is still live");
  } finally {
    await close();
  }
});

test("reconcile skips the sweep (deletes nothing) when the gateway can't be listed", async () => {
  const { gw, deleted, close } = await fakeGateway({ kernels: ["a"], failList: true });
  try {
    const reaped = await reconcileGatewayKernels(gw, new Set());
    assert.deepEqual(reaped, [], "a failed list must not guess — leave kernels put");
    assert.deepEqual(deleted, []);
  } finally {
    await close();
  }
});
