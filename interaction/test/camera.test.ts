import { test } from "node:test";
import assert from "node:assert/strict";
import { Camera } from "../src/camera.js";
import { vec, vecDist } from "../src/geometry.js";

test("screen↔page round-trips at any pose", () => {
  const cam = new Camera({ x: 30, y: -20, z: 2 });
  const p = vec(17, 42);
  const back = cam.screenToPage(cam.pageToScreen(p));
  assert.ok(vecDist(p, back) < 1e-9);
});

test("panBy shifts the offset; page point under a fixed screen pixel moves", () => {
  const cam = new Camera();
  cam.panBy(50, 20);
  assert.deepEqual(cam.state, { x: 50, y: 20, z: 1 });
});

test("zoomBy keeps the page point under the anchor fixed", () => {
  const cam = new Camera({ x: 0, y: 0, z: 1 });
  const anchor = vec(100, 100);
  const pageBefore = cam.screenToPage(anchor);
  cam.zoomBy(2, anchor);
  const pageAfter = cam.screenToPage(anchor);
  assert.equal(cam.state.z, 2);
  assert.ok(vecDist(pageBefore, pageAfter) < 1e-9, "anchor's page point is invariant under zoom");
});

test("zoom clamps to [min, max]", () => {
  const cam = new Camera({ x: 0, y: 0, z: 1 }, 0.5, 4);
  cam.zoomBy(100, vec(0, 0));
  assert.equal(cam.state.z, 4);
  cam.zoomBy(0.0001, vec(0, 0));
  assert.equal(cam.state.z, 0.5);
});

test("camera signal fires on change", () => {
  const cam = new Camera();
  let fired = 0;
  const off = cam.signal.subscribe(() => fired++);
  cam.panBy(1, 1);
  cam.panBy(2, 2);
  assert.equal(fired, 2);
  off();
});
