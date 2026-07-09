// Parse a session transcript (JSONL) into a human-legible label + counts for the sessions dropdown.
// Pure over the FULL transcript text — the caller (vite-fs-plugin.ts `sessionSummary`) reads the file and
// mtime-caches, so this parses each transcript at most once.
//
// SCAN THE WHOLE TEXT — never a head/tail slice. A transcript is append-only, and both a head- and a
// tail-slice corrupt this summary in different ways (the CLAUDE.md "kept the wrong end" footgun):
//   - `turns`/`messages` are WHOLE-FILE counts; any slice undercounts (the head misses recent turns, the
//     tail misses early ones).
//   - the title prefers the LAST `ai-title` (the session refines it as it grows) with the FIRST human prompt
//     as fallback — the last title lives at the TAIL, the first prompt at the HEAD, so a single slice can
//     never see both. (A head-slice, the old bug, hid the freshest title behind the stale opening one.)
// Memory is bounded at the byte READ (MAX_SESSION_BYTES in vite-fs-plugin.ts), not by dropping content here.

// The human-typed text of a `user` record's content (string, or the text parts of a content array), trimmed;
// null when there's no actual prose (a tool-result envelope carries no `text` part, so it isn't a "turn").
export function userText(content) {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p) => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text.trim())
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

// `title` prefers the agent-written `ai-title` (last one wins), else the first human prompt (≤80 chars), else
// null. `turns` counts user records carrying real text; `messages` counts every user+assistant record.
export function sessionSummaryFromText(text) {
  let aiTitle = null;
  let firstPrompt = null;
  let turns = 0;
  let messages = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) {
      aiTitle = o.aiTitle.trim();
    } else if (o.type === "user" || o.type === "assistant") {
      messages++;
      if (o.type === "user") {
        const t = userText(o.message?.content);
        if (t) {
          turns++;
          if (firstPrompt === null) firstPrompt = t;
        }
      }
    }
  }
  const title = aiTitle ?? (firstPrompt ? firstPrompt.slice(0, 80) : null);
  return { title, turns, messages };
}
