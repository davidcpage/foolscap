import type { CameraState } from "./lib";

// The camera unwind stack — the app pushes the current pose onto it before every programmatic jump (fit,
// step back, a peek dive), and `back()` (the backtick key) pops it, so bouncing out of a jump returns you
// to where you were looking. EPHEMERAL and SESSION-tier: a back-stack is a within-session affordance (not
// something you'd want resurrected stale on the next boot), and it's where you're looking, not what the
// document is — so it never touches the intent log.
//
// (Numbered saved-view slots used to live here too, persisted to localStorage and drawn as frames on the
// minimap; they were retired in favour of hold-`z` peek navigation, which covers the same "jump around a
// big board" need without a save/recall keymap to remember.)

const HISTORY_CAP = 30; // unwind depth; old entries fall off the bottom

export class ViewStore {
  private history: CameraState[] = [];

  /** Record the pose you're leaving, so `back()` can return to it. Caps the stack depth. */
  pushHistory(state: CameraState): void {
    this.history.push({ ...state });
    if (this.history.length > HISTORY_CAP) this.history.shift();
  }
  /** Pop the most recent pushed pose (undefined when the stack is empty). */
  back(): CameraState | undefined {
    return this.history.pop();
  }
  get depth(): number {
    return this.history.length;
  }
}
