// Which BOARD this tab is for. A board is a target repo with a stable, server-derived id (its repo
// realpath hashed — see boardIdentity in vite-fs-plugin.ts); the browser keys its IndexedDB + camera on
// that id so a board is its own persistence universe, independent of which dev-server port served it.
//
// Selection: `?repo=<abs-path>` mounts that repo and opens its board; no param opens the default board
// (the dev repo). Since one tab is exactly one board, the resolved boardId is an AMBIENT per-page value —
// the file/watch APIs read it via activeBoardId() rather than threading it through every call.

export interface Board {
  boardId: string;
  name: string;
  // The dev repo's board — the one that historically owned the global `canvas-notes` DB. Only this board
  // adopts that legacy data on first boot; a freshly-mounted repo must NOT inherit it.
  isDefault: boolean;
}

// Fall back to a fixed local id if the board API is unreachable (server down, offline). This keeps the
// app bootable — it just persists under a generic board until the server can name the real one. Treated as
// default so a legacy DB still migrates in the offline case.
const FALLBACK: Board = { boardId: "default", name: "board", isDefault: true };

// The resolved board for this page. Set once by resolveBoard() before the engine builds or any card
// fetches content, then read ambiently by the file/watch APIs (one tab = one board).
let active: Board = FALLBACK;
export function activeBoardId(): string {
  return active.boardId;
}

interface BoardResponse {
  boardId: string;
  name: string;
  default?: boolean;
}
function toBoard(b: BoardResponse): Board {
  return { boardId: b.boardId, name: b.name, isDefault: !!b.default };
}

export async function resolveBoard(): Promise<Board> {
  active = await selectBoard();
  return active;
}

async function selectBoard(): Promise<Board> {
  const repo = new URLSearchParams(location.search).get("repo");
  try {
    if (repo) {
      // Mount the requested repo (idempotent server-side) and open its board.
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoPath: repo }),
      });
      if (res.ok) return toBoard((await res.json()) as BoardResponse);
      console.error("[board] mount failed:", await res.text());
      // fall through to the default board rather than failing to boot
    }
    const res = await fetch("/api/boards");
    if (res.ok) {
      const { boards } = (await res.json()) as { boards: BoardResponse[] };
      const chosen = boards.find((b) => b.default) ?? boards[0];
      if (chosen) return toBoard(chosen);
    }
  } catch {
    /* server unreachable — fall through to the local fallback */
  }
  return FALLBACK;
}
