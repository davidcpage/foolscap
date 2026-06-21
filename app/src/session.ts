import type { Camera } from "./lib";

// Session-tier persistence (doc §8.4: session / document / log). The camera is where you're *looking*,
// not what the document *is* — so it deliberately lives here, in localStorage, SEPARATE from the
// document snapshot + intent log in idb.ts. It must never enter the authoritative history: panning to
// read a note isn't an edit, and replaying the log on another device shouldn't drag your viewport along.
// This is exactly how tldraw/Figma/Excalidraw treat camera (instance/session state, not the document).
const CAMERA_KEY = "canvas-notes:camera";

// Restore the last-known camera pose (if any) and keep persisting it on change. Writes are debounced
// because pan/zoom fire the camera handle on every frame and localStorage is synchronous — we only
// need the resting pose for the next boot, not every intermediate frame. Storage failures (private
// mode, quota, corrupt JSON) are swallowed: a lost viewport is cosmetic, never a data-loss event.
export function restoreAndPersistCamera(camera: Camera): void {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    if (raw) {
      const c = JSON.parse(raw) as unknown;
      if (isCameraState(c)) camera.set(c);
    }
  } catch {
    /* ignore unreadable / corrupt storage */
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  camera.signal.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(CAMERA_KEY, JSON.stringify(camera.state));
      } catch {
        /* ignore unwritable storage */
      }
    }, 200);
  });
}

function isCameraState(v: unknown): v is { x: number; y: number; z: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).x === "number" &&
    typeof (v as Record<string, unknown>).y === "number" &&
    typeof (v as Record<string, unknown>).z === "number"
  );
}
