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

test("fitBox centers the box and scales it to fill the padded viewport", () => {
  const cam = new Camera();
  // A 100×100 page box in an 800×600 viewport with no padding → z = min(800/100, 600/100) = 6,
  // capped here at maxZoom 4. The box center (50,50) lands at the viewport center (400,300).
  cam.fitBox({ x: 0, y: 0, w: 100, h: 100 }, 800, 600, { pad: 0, maxZoom: 4 });
  assert.equal(cam.state.z, 4);
  const center = cam.pageToScreen(vec(50, 50));
  assert.ok(vecDist(center, vec(400, 300)) < 1e-9, "box center maps to viewport center");
});

test("fitBox fills the limiting axis with padding and no zoom cap", () => {
  const cam = new Camera();
  // A wide 400×100 box in 800×600 with 0 pad: limited by width → z = 800/400 = 2.
  cam.fitBox({ x: 0, y: 0, w: 400, h: 100 }, 800, 600, { pad: 0 });
  assert.equal(cam.state.z, 2);
  // 10% padding on each side shrinks the usable viewport to 80%: z = (800*0.8)/400 = 1.6.
  cam.fitBox({ x: 0, y: 0, w: 400, h: 100 }, 800, 600, { pad: 0.1 });
  assert.ok(Math.abs(cam.state.z - 1.6) < 1e-9);
});

test("fitBox is a no-op for a zero-area viewport or box", () => {
  const cam = new Camera({ x: 7, y: 7, z: 1 });
  cam.fitBox({ x: 0, y: 0, w: 100, h: 100 }, 0, 0);
  assert.deepEqual(cam.state, { x: 7, y: 7, z: 1 });
  cam.fitBox({ x: 0, y: 0, w: 0, h: 0 }, 800, 600);
  assert.deepEqual(cam.state, { x: 7, y: 7, z: 1 });
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
