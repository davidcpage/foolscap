import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vec, vecAdd, vecSub, vecScale, vecDist, vecLen,
  boxContainsPoint, boxIntersects, boxFromPoints, boxCenter, boxUnion,
  boxCorners, resizeBox, MIN_SIZE,
} from "../src/geometry.js";

test("vec arithmetic", () => {
  assert.deepEqual(vecAdd(vec(1, 2), vec(3, 4)), { x: 4, y: 6 });
  assert.deepEqual(vecSub(vec(3, 4), vec(1, 2)), { x: 2, y: 2 });
  assert.deepEqual(vecScale(vec(2, 3), 2), { x: 4, y: 6 });
  assert.equal(vecLen(vec(3, 4)), 5);
  assert.equal(vecDist(vec(0, 0), vec(3, 4)), 5);
});

test("box contains / intersects", () => {
  const b = { x: 0, y: 0, w: 100, h: 100 };
  assert.ok(boxContainsPoint(b, vec(50, 50)));
  assert.ok(boxContainsPoint(b, vec(0, 0))); // edge counts
  assert.ok(!boxContainsPoint(b, vec(101, 50)));
  assert.ok(boxIntersects(b, { x: 50, y: 50, w: 100, h: 100 }));
  assert.ok(!boxIntersects(b, { x: 200, y: 0, w: 10, h: 10 }));
});

test("boxFromPoints normalizes regardless of drag direction", () => {
  assert.deepEqual(boxFromPoints(vec(10, 10), vec(0, 0)), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(boxFromPoints(vec(0, 0), vec(10, 5)), { x: 0, y: 0, w: 10, h: 5 });
});

test("boxCenter and boxUnion", () => {
  assert.deepEqual(boxCenter({ x: 0, y: 0, w: 10, h: 20 }), { x: 5, y: 10 });
  assert.equal(boxUnion([]), null);
  assert.deepEqual(
    boxUnion([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }]),
    { x: 0, y: 0, w: 30, h: 30 },
  );
});

test("boxCorners gives the four page-space corners", () => {
  assert.deepEqual(boxCorners({ x: 10, y: 20, w: 100, h: 50 }), {
    nw: { x: 10, y: 20 },
    ne: { x: 110, y: 20 },
    sw: { x: 10, y: 70 },
    se: { x: 110, y: 70 },
  });
});

test("resizeBox se grows w/h, pins the nw corner", () => {
  const start = { x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual(resizeBox(start, "se", 30, 40), { x: 10, y: 20, w: 130, h: 90 });
});

test("resizeBox nw moves the top-left, pins the se corner", () => {
  const start = { x: 10, y: 20, w: 100, h: 50 };
  // drag the nw corner up-left by (-30, -40): the box grows, se corner (110, 70) stays put.
  const out = resizeBox(start, "nw", -30, -40);
  assert.deepEqual(out, { x: -20, y: -20, w: 130, h: 90 });
  assert.equal(out.x + out.w, 110); // se x unchanged
  assert.equal(out.y + out.h, 70); // se y unchanged
});

test("resizeBox clamps to MIN_SIZE without walking past the pinned edge", () => {
  const start = { x: 10, y: 20, w: 100, h: 50 };
  // overshoot the nw corner far past the se corner: w/h clamp to MIN_SIZE, se stays pinned.
  const out = resizeBox(start, "nw", 500, 500);
  assert.equal(out.w, MIN_SIZE.w);
  assert.equal(out.h, MIN_SIZE.h);
  assert.equal(out.x + out.w, 110); // right edge still pinned
  assert.equal(out.y + out.h, 70); // bottom edge still pinned
});
