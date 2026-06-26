import type { Camera } from "./lib";

// Session-tier persistence (doc §8.4: session / document / log). The camera is where you're *looking*,
// not what the document *is* — so it deliberately lives here, in localStorage, SEPARATE from the
// document snapshot + intent log in idb.ts. It must never enter the authoritative history: panning to
// read a note isn't an edit, and replaying the log on another device shouldn't drag your viewport along.
// This is exactly how tldraw/Figma/Excalidraw treat camera (instance/session state, not the document).
// Camera is per-BOARD now: `canvas-notes:<boardId>:camera`. LEGACY_CAMERA_KEY is the pre-multi-board
// global key — read once as a fallback so the dev repo's resting pose carries over the rename. (No
// migration write-back: the pose re-saves under the board key on the next pan, and a stale read is purely
// cosmetic.)
const LEGACY_CAMERA_KEY = "canvas-notes:camera";
function cameraKey(boardId: string): string {
  return `canvas-notes:${boardId}:camera`;
}

// Restore the last-known camera pose (if any) and keep persisting it on change. Writes are debounced
// because pan/zoom fire the camera handle on every frame and localStorage is synchronous — we only
// need the resting pose for the next boot, not every intermediate frame. Storage failures (private
// mode, quota, corrupt JSON) are swallowed: a lost viewport is cosmetic, never a data-loss event.
export function restoreAndPersistCamera(camera: Camera, boardId: string): void {
  const key = cameraKey(boardId);
  try {
    const raw = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_CAMERA_KEY);
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
        localStorage.setItem(key, JSON.stringify(camera.state));
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
