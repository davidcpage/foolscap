// The BOARD MEMORY reader (plain ESM, runs under node --test; imported by vite-fs-plugin.ts).
//
// R4 (docs/claude-tag-lessons.md) + W3 (docs/wakeable-substrate-plan.md): one board-scoped memory file,
// `.canvas/memory.md`, curated by hand and rendered as an ordinary markdown file card so any human or agent
// can read and edit it. It is included in every spawned session's system prompt so settled decisions and
// norms are head context on every wake — "memory is a shared, inspectable object", canvas-native, with zero
// new machinery (it's just a file under the `.canvas/` home, shadow-versioned like the rest).
//
// The structure — "one fact per line, newest-first, links to per-topic markdown, lazy-loaded" — is a
// CONVENTION the brief states, not an enforced schema. Role memory hangs off this ONE index as linked
// markdown leaves under `.canvas/memory/`, pulled into context only when relevant; `role.md` stays the
// role's charter. So there is exactly one memory home per board (the index), and role-specific facts are
// linked leaves under it — one home per fact, no second lookup location.

import fs from "node:fs";
import path from "node:path";

// A generous HEAD cap: the index is meant to stay small (one fact per line, detail lives in lazy leaves),
// so 32KB is far above any healthy index. Per CLAUDE.md's size-cap discipline: bound at the read, in ONE
// place, and keep the HEAD for a top-down index read (not the tail — this isn't an append-only log we
// scroll to the bottom of; it's an index read top-first). The `truncated` flag surfaces if a cap ever bit.
const MAX_MEMORY_BYTES = 32 * 1024;

/** Absolute path to the board memory index under the board repo's `.canvas/` home. */
export function boardMemoryPath(repoPath) {
  return path.join(repoPath, ".canvas", "memory.md");
}

/**
 * Read the board memory index (`.canvas/memory.md`), HEAD-capped. Returns `{ content, truncated }`, or
 * null if the file is absent or unreadable. Best-effort — a memory read must never take down a spawn.
 */
export function readBoardMemory(repoPath) {
  try {
    const buf = fs.readFileSync(boardMemoryPath(repoPath));
    const truncated = buf.length > MAX_MEMORY_BYTES;
    return { content: buf.subarray(0, MAX_MEMORY_BYTES).toString("utf8"), truncated };
  } catch {
    return null; // no index yet (or unreadable) — the brief still states the convention
  }
}

// The convention block — stated whether or not an index exists yet, so the norm ("a durable fact goes on
// `.canvas/memory.md`; moving work stays in the thread") always reaches the session.
const CONVENTION = [
  "BOARD MEMORY. `.canvas/memory.md` is this board's shared, curated memory — the settled decisions and",
  "norms every session on this board should carry. It is an ordinary markdown file CARD: any human or agent",
  "can read it and edit it in place. Convention (a norm, not enforced code): one fact per line, newest-first,",
  "each line linking out to a per-topic markdown leaf under `.canvas/memory/` that you load ON DEMAND — read",
  "the leaf file (it's in your working directory) only when it's relevant, so the index stays small and the",
  "detail stays lazy. ROLE MEMORY lives as these linked leaves (e.g. `.canvas/memory/<role>.md`); the role's",
  "`role.md` stays its shared charter. To record a durable, settled fact, append a line to `.canvas/memory.md`",
  "(edit the file / card) and link a leaf if it needs detail — but keep MOVING work in the thread, not here",
  "(the index is for what's settled, not for status).",
].join("\n");

/**
 * The BOARD MEMORY block appended to a spawned session's system prompt. Always states the convention; when
 * `.canvas/memory.md` exists it EMBEDS the index content so the board's settled facts are head context
 * without a read (the linked leaves stay lazy). Pure function of the repo's current memory file.
 */
export function boardMemoryBrief(repoPath) {
  const mem = readBoardMemory(repoPath);
  if (!mem) {
    return CONVENTION + "\n\n(No `.canvas/memory.md` on this board yet — create one when its first settled " +
      "fact appears.)";
  }
  return CONVENTION + "\n\nThe current `.canvas/memory.md` (the index — read a linked leaf on demand):\n\n" +
    mem.content +
    (mem.truncated ? "\n\n[…index truncated at the byte cap — read the full `.canvas/memory.md` for the rest]" : "");
}
