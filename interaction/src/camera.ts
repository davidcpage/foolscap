import type { Subscribable } from "./core.js";
import { Observable } from "./observable.js";
import { boxFromPoints, vec, type Box, type Vec } from "./geometry.js";

// The camera owns the screen↔page transform — the piece the browser spike never had (it rendered in
// page space with no pan/zoom). Convention: a uniform-scale affine, no rotation/skew (a notes canvas
// needs translate + zoom, nothing more), so we carry three scalars instead of a 3×3 matrix:
//
//   x, y  screen-space offset (pixels) of the page origin
//   z     zoom (screen pixels per page unit)
//
//   screen = page * z + offset        pageToScreen
//   page   = (screen - offset) / z    screenToPage
//
// State is session-tier (ephemeral, not in the record Store) and reactive via our own Observable, so
// a renderer subscribes to camera changes through the same `Subscribable<T>` seam as record handles.
export interface CameraState {
  x: number;
  y: number;
  z: number;
}

const DEFAULT_MIN_ZOOM = 0.1;
const DEFAULT_MAX_ZOOM = 8;

export class Camera {
  private obs: Observable<CameraState>;
  constructor(
    initial: CameraState = { x: 0, y: 0, z: 1 },
    private readonly minZoom = DEFAULT_MIN_ZOOM,
    private readonly maxZoom = DEFAULT_MAX_ZOOM,
  ) {
    this.obs = new Observable(initial);
  }

  /** Channel-1-style handle for the renderer (re-fires when the camera pose changes). */
  get signal(): Subscribable<CameraState> {
    return this.obs;
  }
  get state(): CameraState {
    return this.obs.get();
  }

  // ── transforms (pure; also exported as free functions for callers that hold a CameraState) ──
  pageToScreen(p: Vec): Vec {
    return pageToScreen(this.obs.get(), p);
  }
  screenToPage(s: Vec): Vec {
    return screenToPage(this.obs.get(), s);
  }
  /** Screen-space rect (e.g. a marquee drawn in screen px) → the page-space box it covers. */
  screenBoxToPage(a: Vec, b: Vec): Box {
    return boxFromPoints(this.screenToPage(a), this.screenToPage(b));
  }

  // ── mutations ───────────────────────────────────────────────────────────────────────
  /** Pan by a screen-pixel delta (the hand tool / two-finger scroll path). */
  panBy(dxScreen: number, dyScreen: number): void {
    const c = this.obs.get();
    this.obs.set({ x: c.x + dxScreen, y: c.y + dyScreen, z: c.z });
  }

  /**
   * Zoom by a factor while keeping the page point under `anchorScreen` fixed (pinch / ctrl-wheel).
   * Solve for the offset that maps the anchor's pre-zoom page point back to the same screen pixel.
   */
  zoomBy(factor: number, anchorScreen: Vec): void {
    const c = this.obs.get();
    const z = clamp(c.z * factor, this.minZoom, this.maxZoom);
    if (z === c.z) return;
    const pageAtAnchor = screenToPage(c, anchorScreen);
    this.obs.set({
      x: anchorScreen.x - pageAtAnchor.x * z,
      y: anchorScreen.y - pageAtAnchor.y * z,
      z,
    });
  }

  set(state: CameraState): void {
    this.obs.set({ ...state, z: clamp(state.z, this.minZoom, this.maxZoom) });
  }
  reset(): void {
    this.obs.set({ x: 0, y: 0, z: 1 });
  }
}

export function pageToScreen(c: CameraState, p: Vec): Vec {
  return vec(p.x * c.z + c.x, p.y * c.z + c.y);
}
export function screenToPage(c: CameraState, s: Vec): Vec {
  return vec((s.x - c.x) / c.z, (s.y - c.y) / c.z);
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
