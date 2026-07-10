// Types for bus-replay-buffer.js (Bug A/C persist-gap buffer). See the .js for the rationale.

/** A held bus command — the shape dispatchBusCommand broadcasts. */
export interface PendingBusCommand {
  type: string;
  payload?: Record<string, unknown>;
  actor?: string;
}

/** Command types worth buffering for replay (additive creation only). */
export const BUFFERABLE_BUS_TYPES: Set<string>;
/** The per-board buffer cap; oldest are evicted past it. */
export const MAX_PENDING_BUS_REPLAY: number;

/** Enqueue an additive creation command for `boardId`, or prune the buffered create a remove supersedes.
 *  Mutates `pending` (boardId → command[]) in place. Returns `{ buffered, dropped }`. */
export function bufferBusReplay(
  pending: Map<string, PendingBusCommand[]>,
  boardId: string,
  cmd: { type: string; payload?: Record<string, unknown>; actor?: string },
  maxLen?: number,
): { buffered: boolean; dropped: number };

/** Take + clear a board's buffered commands ([] when the map is null or the board has none). */
export function takeBusReplay(
  pending: Map<string, PendingBusCommand[]> | null | undefined,
  boardId: string,
): PendingBusCommand[];
