import type { CameraState } from "./lib";

// Saved camera views + an unwind stack — the keyboard-driven wayfinding that lets you set up a few
// vantage points and bounce between them, so navigating a big board stops being a mouse chore.
//
// Two distinct stores, both SESSION-tier (where you're looking, not what the document is — same stance
// as session.ts's camera persistence, never the intent log):
//   • slots 1–9  — named-ish vantage points you save deliberately (Alt+N) and recall (N). PERSISTED to
//     localStorage per board, so your views survive a reload like the resting camera does.
//   • history    — an unwind stack the app pushes the current pose onto before every programmatic jump
//     (fit, recall, back); `back()` pops it. EPHEMERAL (a back-stack is a within-session affordance,
//     not something you'd want resurrected stale on the next boot).
//
// Storage failures are swallowed throughout: a lost view is cosmetic, never a data-loss event — the
// exact contract restoreAndPersistCamera follows.

export const MAX_SLOT = 9; // digit keys 1–9
const HISTORY_CAP = 30; // unwind depth; old entries fall off the bottom

function slotsKey(boardId: string): string {
  return `canvas-notes:${boardId}:views`;
}

export class ViewStore {
  private slots = new Map<number, CameraState>();
  private history: CameraState[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly boardId: string) {
    this.load();
  }

  /** Notify on a slot change — the minimap HUD subscribes so its view-frames update live on a save. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ── saved slots (persisted) ──
  /** Save a pose to slot n (1–9). Overwrites; persists immediately (a save is rare, not a hot path). */
  save(n: number, state: CameraState): void {
    if (n < 1 || n > MAX_SLOT) return;
    this.slots.set(n, { ...state });
    this.persist();
    this.emit();
  }
  /** Forget a saved slot (its frame disappears). */
  clear(n: number): void {
    if (this.slots.delete(n)) {
      this.persist();
      this.emit();
    }
  }
  /** Every saved view as [slot, pose] pairs, ascending — for drawing the numbered frames. */
  entries(): [number, CameraState][] {
    return this.filled().map((n) => [n, this.slots.get(n)!]);
  }
  /** The pose in slot n, or undefined if that slot is empty. */
  recall(n: number): CameraState | undefined {
    return this.slots.get(n);
  }
  /** The filled slot numbers, ascending — for a UI hint of which views exist. */
  filled(): number[] {
    return [...this.slots.keys()].sort((a, b) => a - b);
  }

  // ── unwind stack (ephemeral) ──
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

  // ── persistence ──
  private load(): void {
    try {
      const raw = localStorage.getItem(slotsKey(this.boardId));
      if (!raw) return;
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const n = Number(k);
          if (n >= 1 && n <= MAX_SLOT && isCameraState(v)) this.slots.set(n, v);
        }
      }
    } catch {
      /* ignore unreadable / corrupt storage */
    }
  }
  private persist(): void {
    try {
      const obj: Record<string, CameraState> = {};
      for (const [n, s] of this.slots) obj[n] = s;
      localStorage.setItem(slotsKey(this.boardId), JSON.stringify(obj));
    } catch {
      /* ignore unwritable storage */
    }
  }
}

function isCameraState(v: unknown): v is CameraState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).x === "number" &&
    typeof (v as Record<string, unknown>).y === "number" &&
    typeof (v as Record<string, unknown>).z === "number"
  );
}
