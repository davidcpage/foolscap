// card-types/session/render.js — a historical agent session as a runtime-loaded template
// (agent-sessions-on-canvas.md §4, §12). The CODEC is the whole point of this card: fields.text is
// a raw Claude Code `.jsonl` transcript (one JSON event per line) and the parse below is the v1
// codec in its honest form — real JS, not a declarative layer, exactly as the file card's splitPath
// is. It lays the conversation out as TURNS with per-turn actor chrome and tool-call summaries.
//
// The interior SCROLLS, tool calls / thinking are click-to-disclose <details>, and (slice 2) a live
// registry-backed session takes typed INPUT — all three via the interior-interaction seam (wheel +
// arrow scroll, contained pointerdown on summary/input, src/interior.ts + NodeView). So this one card
// now proves the codec, the rendering vocabulary (turns, tool calls, thinking, actor styling), AND the
// full duplex of agent-sessions §3: live process output on the `session` feed + prompts back through
// the `sessionInput` capability (session-internal, never the canvas log — session-timelines §4).
import { html, nothing, render as litRender } from "/vendor/lit-html.js";
import { renderMd } from "/vendor/markdown.js";

// NO turn-count cap. Memory is bounded ONCE, upstream, by the BYTE caps on what reaches this codec
// (MAX_SESSION_BYTES for a static/file-tail transcript, MAX_SESSION_FEED_BYTES for a live one — both
// in vite-fs-plugin.ts, both keep the TAIL and flag `truncated`). A second cap here on the number of
// turns reduced no memory (the string is already byte-bounded) and only ever silently dropped turns —
// which is exactly how the "truncated before resume" bug hid where you left off. So we render every
// turn the byte-bounded content yields; the byte cap is the single, honest bound. See CLAUDE.md.

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// A tool_use's input is a JSON object; show the one field that reads as "what it did". Order matters
// — command for Bash, file_path for Read/Write/Edit, pattern for Grep, url for fetches.
function toolHint(input) {
  if (!input || typeof input !== "object") return "";
  return input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? "";
}

// A tool_result's content is a string or an array of {type:"text", text} blocks — normalize to text.
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join("\n");
  return "";
}

// The codec, split so the per-line JSON.parse runs ONCE per line over a session's life, not once per
// line per render (eventsFor, below). isConvEvent gates the lines we keep; buildTurns folds the kept
// events into the turns the layout walks. Tolerant by design — an unparseable line (a truncated tail,
// or a non-conversation event) is skipped, never thrown, so a clipped transcript still renders.
function isConvEvent(e) {
  return !!e && (e.type === "user" || e.type === "assistant");
}

// events → turns. tool_results live in the user message AFTER the tool_use; collect them first, keyed
// by id, so each tool_use can show its own outcome inline. Pure over the events array (no JSON.parse),
// so rebuilding it per render is cheap next to the parse it used to sit behind.
function buildTurns(events) {
  const resultById = new Map();
  for (const e of events) {
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === "tool_result") resultById.set(b.tool_use_id, b);
  }

  const turns = [];
  let tools = 0;
  for (const e of events) {
    const role = e.message?.role; // "user" | "assistant"
    const c = e.message?.content;

    if (typeof c === "string") {
      turns.push({ role: "you", blocks: [{ kind: "text", text: c }] });
      continue;
    }
    if (!Array.isArray(c)) continue;

    const blocks = [];
    for (const b of c) {
      if (b.type === "text" && b.text?.trim()) blocks.push({ kind: "text", text: b.text });
      else if (b.type === "thinking" && b.thinking?.trim()) blocks.push({ kind: "think", text: b.thinking });
      else if (b.type === "tool_use") {
        tools++;
        const r = resultById.get(b.id);
        // `input` is kept (not just the derived `hint`) so downstream projections that need real fields —
        // the task panel's reducer reads subject/taskId/status off it — don't have to reparse the events.
        blocks.push({ kind: "tool", name: b.name, hint: toolHint(b.input), input: b.input, result: r });
      }
      // tool_result blocks are rendered under their tool_use (above), not as their own turn
    }
    // a user message that was only tool_results contributes no turn
    if (blocks.length === 0) continue;
    turns.push({ role: role === "assistant" ? "claude" : "you", blocks });
  }

  return { turns, tools };
}

// ── touched-files activity (worktree-activity slice A) ────────────────────────────────────────────
// The agent's recent FILE activity, derived from the SAME tool_use blocks the turns already hold — no
// new feed, no backend: a file-operating tool's `hint` IS its path (toolHint prefers file_path/path).
// Keep the LAST touch of each distinct path (most-recent-first) so a re-read doesn't inflate the count;
// the strip shows recency by opacity. Color-by-worktree is slice C (it needs the board's root list, not
// known here yet) — v1 is honestly monochrome; the dots split into per-root hues once roots exist.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function base(p) {
  const s = String(p ?? "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
function touchedFiles(turns) {
  const at = new Map(); // path → {order, tool, written}; set() overwrites so the newest touch wins for recency
  let order = 0;
  for (const t of turns)
    for (const b of t.blocks)
      if (b.kind === "tool" && FILE_TOOLS.has(b.name) && b.hint) {
        // `written` is STICKY: once a path is edited it stays "written" even if later only read, since an
        // edited file is the one you care about. So OR it across touches rather than taking the last tool's.
        const prev = at.get(b.hint);
        at.set(b.hint, { order: order++, tool: b.name, written: (prev?.written ?? false) || WRITE_TOOLS.has(b.name) });
      }
  return [...at.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.order - a.order);
}

// ── task list (the TaskCreate/TaskUpdate todo panel) ──────────────────────────────────────────────
// Claude Code's task tools are a STATEFUL todo list mutated across many turns — each call is one
// mutation (create one task, flip one status), never a whole-list snapshot. The codec lays tool calls
// out inline in their turns, so a faithful "current tasks" panel can't read any single block; it FOLDS
// every task call in order into the live list, exactly as touchedFiles folds the file tools above.
// The wrinkle: TaskCreate's INPUT carries no id — the server assigns "Task #N" and only the tool_result
// echoes it ("Task #3 created successfully: …"). So a create is keyed by the id parsed from its result,
// with a creation-order fallback for a call still in flight (the server numbers creates 1,2,3… in the
// same order we see them, so the fallback matches the id a later TaskUpdate will reference). A
// status:"deleted" update drops the task; an update to an unseen id (history clipped before its create)
// makes a stub so the row still shows rather than silently vanishing.
// The mutation tools the panel SUPERSEDES — their inline rows are hidden from the turn body (the panel is
// now the single source of truth for task state, so a row-per-mutation pile would just duplicate it). Read
// tools (TaskList/TaskGet) stay inline: they're genuine actions the agent took, not list state.
const TASK_PANEL_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
const TASK_FIELDS = ["subject", "description", "activeForm", "status", "owner"];
function newTask(id, order) {
  return { id, subject: "", description: "", activeForm: "", status: "pending", owner: "", order };
}
function taskList(turns) {
  const byId = new Map(); // id → task; insertion/display order is creation order via `order`
  let order = 0;
  let createSeq = 0; // mirrors the server's "#N" numbering so an in-flight create (no result yet) still keys right
  for (const t of turns)
    for (const b of t.blocks) {
      if (b.kind !== "tool" || !b.input) continue;
      if (b.name === "TaskCreate") {
        createSeq++;
        const m = /#(\d+)/.exec(resultText(b.result?.content));
        const id = m ? m[1] : String(createSeq);
        if (!byId.has(id)) {
          const task = newTask(id, order++);
          for (const k of TASK_FIELDS) if (b.input[k] != null) task[k] = b.input[k];
          byId.set(id, task);
        }
      } else if (b.name === "TaskUpdate") {
        const id = b.input.taskId != null ? String(b.input.taskId) : null;
        if (!id) continue;
        if (b.input.status === "deleted") {
          byId.delete(id);
          continue;
        }
        let task = byId.get(id);
        if (!task) byId.set(id, (task = newTask(id, order++)));
        for (const k of TASK_FIELDS) if (b.input[k] != null) task[k] = b.input[k];
      }
    }
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

// ── colour by worktree (slice C) ──────────────────────────────────────────────────────────────────
// Map an absolute tool-call path onto one of the board's roots by LONGEST path-prefix, so a file under a
// worktree resolves to that worktree (not the canonical repo it may also sit beneath). The `roots`
// capability carries each root's stable `hue`; no match → the neutral default the CSS already paints
// (a single-root board, or a file outside every mounted root). This is what turns "which files" into
// "which WORKTREE", read off the dot colours without anyone declaring a session→worktree scope.
function rootForPath(roots, p) {
  let best = null;
  for (const r of roots) {
    if (!r.path) continue;
    if (p === r.path || p.startsWith(r.path + "/")) if (!best || r.path.length > best.path.length) best = r;
  }
  return best;
}
// The dot's inline style: recency opacity + the worktree hue. A WRITTEN file fills with the hue; a
// read-only file (the `.read` class) takes the hue as its ring colour. Returns null (no inline style,
// CSS default) only for an unmatched read dot, so single-root boards look exactly as before.
function dotStyle(f, roots, opacity) {
  const r = rootForPath(roots, f.path);
  const o = opacity != null ? `opacity:${opacity};` : "";
  if (!r) return o || null;
  return o + (f.written ? `background:${r.hue}` : `border-color:${r.hue}`);
}

// ── incremental parse (perf) ────────────────────────────────────────────────────────────────────
// A live session re-renders on every streamed delta, and the transcript only GROWS (the .jsonl is
// append-only; the file-tail feed is head-capped, so its prefix never changes). Re-running JSON.parse
// over the WHOLE transcript each frame was the card's real cost. So we cache per card: the events
// already parsed and the offset consumed (up to the last NEWLINE — a trailing partial line is a live
// mid-write, left for next time). Each render JSON.parses only the newly-appended complete lines.
// The cache is keyed by the `card` object (stable for one mount, GC'd on unmount) through a WeakMap,
// so it needs no slot in the template contract. A NON-append change — the live-registry feed's 512KB
// tail window sliding, a truncation toggle, a different transcript — is caught by a cheap 64-char
// head-signature check and falls back to a full reparse, so correctness never rests on append holding.
const parseCache = new WeakMap();

function eventsFor(card, raw) {
  let st = parseCache.get(card);
  const sig = raw.slice(0, 64);
  if (!st || raw.length < st.consumed || sig !== st.sig) {
    st = { sig, consumed: 0, events: [], truncated: false, turnsCache: null };
    parseCache.set(card, st);
  }
  if (raw.length > st.consumed) {
    const tail = raw.slice(st.consumed);
    const lastNl = tail.lastIndexOf("\n");
    if (lastNl >= 0) {
      for (const line of tail.slice(0, lastNl).split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          // Truncation is signalled EXPLICITLY by the loader's {type:"x-truncated"} sentinel (a capped
          // STATIC transcript) — the codec can't guess it: a failed-to-parse line is as likely a live
          // mid-write tail as a cut. The live feed reports `truncated` directly instead (see render).
          if (e.type === "x-truncated") st.truncated = true;
          else if (isConvEvent(e)) st.events.push(e);
        } catch {
          // a non-JSON / non-conversation line — skip it, keep what parsed
        }
      }
      st.consumed += lastNl + 1;
    }
  }
  return st;
}

// The trailing line after the last consumed newline: either a complete event not yet newline-terminated
// (show it now so the newest turn appears without waiting for the next write), the truncation sentinel
// (flag it), or a ragged mid-write tail (ignore — never throw, never false-flag). It is TRANSIENT:
// never cached or consumed, so when its newline arrives the consume path counts it once — no duplicate.
function trailing(st, raw) {
  const rest = raw.slice(st.consumed).trim();
  if (!rest) return { event: null, truncated: false };
  try {
    const e = JSON.parse(rest);
    if (e.type === "x-truncated") return { event: null, truncated: true };
    if (isConvEvent(e)) return { event: e, truncated: false };
  } catch {
    // ragged mid-write line — not yet a complete event
  }
  return { event: null, truncated: false };
}

// Turns memoized on the event count: a re-render with no new events (a status flip, the slash menu)
// reuses the built turns. A transient trailing event forces a rebuild but is never cached (its content
// changes as the line streams), so the cache only ever holds whole-line state.
function turnsFor(st, events, hasTransient) {
  if (!hasTransient && st.turnsCache && st.turnsCache.len === events.length) return st.turnsCache;
  const built = buildTurns(events);
  const cache = { len: events.length, turns: built.turns, tools: built.tools };
  if (!hasTransient) st.turnsCache = cache;
  return cache;
}

// ── interactive questions (the ```ask convention) ────────────────────────────────────────────────
// AskUserQuestion can't work headless (the CLI auto-cancels it — see vite-fs-plugin.ts ASK_CONVENTION),
// so a live session is steered to emit a fenced ```ask block (AskUserQuestion's own input shape) which
// we render as clickable options and answer back through the SAME input duplex as a typed prompt. The
// answer is phrased exactly like AskUserQuestion's tool_result ("Your questions have been answered: …")
// so the model continues naturally.

// Split an assistant text block into ordered segments — markdown prose and interactive ```ask widgets —
// so a turn carrying MORE THAN ONE ask fence renders EVERY one, not just the first. (The model is steered
// to put multiple questions in a single block's `questions` array, which is one widget that submits them
// together; but if it emits separate fences anyway, each becomes its own widget instead of the later ones
// leaking as raw JSON — the bug this replaced.) A fence becomes an {ask} segment only when its JSON is
// COMPLETE and valid; an incomplete (still-streaming, unclosed) or invalid fence is left in the prose run
// and renders as plain text until it closes, then flips to the widget — never dropped, never half-shown.
const ASK_RE = /```ask[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
function askSegments(text) {
  const segs = [];
  let last = 0;
  let m;
  ASK_RE.lastIndex = 0;
  while ((m = ASK_RE.exec(text))) {
    let qs = null;
    try {
      const spec = JSON.parse(m[1]);
      qs = Array.isArray(spec?.questions) ? spec.questions.filter((q) => q && q.question) : null;
    } catch {
      qs = null;
    }
    if (!qs || qs.length === 0) continue; // invalid/empty fence — leave it in the surrounding prose run
    if (m.index > last) segs.push({ kind: "md", text: text.slice(last, m.index) });
    segs.push({ kind: "ask", questions: qs });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ kind: "md", text: text.slice(last) });
  return segs;
}

// Gather the selections on submit and route them back. Native radio/checkbox/text inputs hold the form
// state — the seam already contains pointerdown on them (NodeView), and the turn has ENDED (idle) by the
// time the widget is interactive, so no streamed re-render races the user's input.
function submitAsk(e, questions, onAnswer) {
  const root = e.currentTarget.closest(".ses-ask");
  const parts = [];
  let missing = false;
  root.querySelectorAll(".ses-ask-q").forEach((qel, qi) => {
    const picks = [];
    qel.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked").forEach((i) => picks.push(i.value));
    const other = qel.querySelector(".ses-ask-other")?.value.trim();
    if (other) picks.push(other);
    if (picks.length === 0) missing = true;
    parts.push(`"${questions[qi].question}"="${picks.join(", ")}"`);
  });
  if (missing) return root.classList.add("ses-ask-warn"); // a question left unanswered — flag, don't send
  onAnswer(`Your questions have been answered: ${parts.join(", ")}. You can now continue with these answers in mind.`);
}

function renderAsk(questions, onAnswer) {
  const body = (q, qi) => html`
    <div class="ses-ask-q">
      <div class="ses-ask-head">${q.header || "Question"}</div>
      <div class="ses-ask-text">${q.question}</div>
      <div class="ses-ask-opts">
        ${(q.options || []).map(
          (o) =>
            html`<label class="ses-ask-opt">
              <input type=${q.multiSelect ? "checkbox" : "radio"} name=${"q" + qi} value=${o.label} ?disabled=${!onAnswer} />
              <span class="ses-ask-label">${o.label}</span>
              ${o.description ? html`<span class="ses-ask-desc">${o.description}</span>` : ""}
            </label>`,
        )}
        ${onAnswer
          ? html`<label class="ses-ask-opt ses-ask-otherrow">
              <span class="ses-ask-label">Other</span>
              <input class="ses-ask-other" type="text" placeholder="custom answer…" />
            </label>`
          : ""}
      </div>
    </div>
  `;
  // No onAnswer → a historical/already-answered block: the same layout, read-only (inputs disabled, no
  // submit), so the transcript still shows what was asked.
  //
  // keydown is contained at the widget root, exactly as the live `.ses-input` contains its own: the seam
  // (NodeView) only contains pointerdown + wheel natively, so a keydown in an interior input otherwise
  // bubbles to the canvas. Without this, Space hit the canvas's native key handler (input.ts
  // preventDefault → the space was swallowed AND hold-to-pan engaged) and Backspace/Delete reached the
  // app's onKeyDown, which deletes the SELECTED card — so editing a custom answer unmounted the very card
  // you were typing in. stopPropagation (never preventDefault) leaves native typing / radio toggling intact.
  return html`
    <div class="ses-ask${onAnswer ? "" : " ses-ask-static"}" @keydown=${(e) => e.stopPropagation()}>
      ${questions.map(body)}
      ${onAnswer
        ? html`<button class="ses-ask-submit" @click=${(e) => submitAsk(e, questions, onAnswer)}>send answer</button>`
        : ""}
    </div>
  `;
}

// renderBlock takes `onAnswer` (the live session's input fn) only for the LAST claude turn — that's the
// one whose ```ask block, if any, is awaiting a reply; earlier blocks render read-only.
function renderBlock(b, onAnswer) {
  if (b.kind === "text") {
    const segs = askSegments(b.text);
    // No ask fence (the common case) → one markdown prose run over the whole block.
    if (segs.length === 1 && segs[0].kind === "md")
      return html`<div class="ses-text md-prose">${renderMd(b.text)}</div>`;
    // One or more fences → prose / widget / prose … in order; every ask fence renders interactively.
    return html`<div class="ses-text md-prose">
      ${segs.map((s) =>
        s.kind === "ask" ? renderAsk(s.questions, onAnswer) : s.text.trim() ? renderMd(s.text) : nothing,
      )}
    </div>`;
  }

  // Thinking and tool calls are <details>: collapsed to a scannable summary line, click to disclose.
  // Click-to-toggle works because the host contains a pointerdown on a <summary> before it reaches
  // the canvas (interior-interaction seam, click half) — otherwise the canvas would start a drag.
  if (b.kind === "think")
    return html`
      <details class="ses-think">
        <summary>🧠 thinking</summary>
        <div class="ses-think-body">${b.text}</div>
      </details>
    `;

  // tool
  const err = b.result?.is_error;
  const glyph = b.result ? (err ? "✗" : "✓") : "";
  const out = b.result ? clip(resultText(b.result.content), 1000) : "";
  const head = html`
    <span class="ses-tool-name">⚙ ${b.name}</span>
    <span class="ses-tool-hint">${b.hint}</span>
    <span class="ses-tool-glyph">${glyph}</span>
  `;
  // With output → a disclosure; without (a tool call with no result) → a static row, so the toggle
  // never opens onto nothing.
  return out
    ? html`
        <details class="ses-tool${err ? " err" : ""}">
          <summary>${head}</summary>
          <pre class="ses-tool-out">${out}</pre>
        </details>
      `
    : html`<div class="ses-tool ses-tool-static${err ? " err" : ""}">${head}</div>`;
}

// ── slash-completion for the live input ──────────────────────────────────────────────────────────
// The harness advertises its skills in the session's init event; the server forwards their names on
// the `session` feed as `skills` (VERIFIED live: the on-disk .jsonl carries a `skill_listing`
// attachment, but the `-p --output-format stream-json` stream does NOT — the init event is the only
// live source). When the user types a leading `/foo`, we offer those as completions.
//
// The menu is owned IMPERATIVELY, against the grain of this otherwise-declarative card, and on purpose:
// the card re-renders on every streamed delta, but there's no per-card signal to hold "which option is
// highlighted" or "is the menu open" — that transient view state would be lost each frame. lit never
// re-touches a STATIC element's children, so the empty <div class="ses-complete"> the template renders
// survives those re-renders; we populate it with a nested litRender and track the selection with a
// .sel class in the DOM. Same category as scroll position (see templates.ts): ephemeral host-side view
// state, not part of the card data.

// Offer completion only for a single leading token starting with "/" (before any space): the user is
// naming a command, not writing prose that merely contains a slash. Returns the lowercased query, or
// null when the menu should stay closed.
function slashQuery(value) {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1].toLowerCase() : null;
}

// Prefix matches first, then substring; capped so a long skill list never covers the card.
function matchSkills(skills, q) {
  const pre = [];
  const sub = [];
  for (const s of skills) {
    const l = s.toLowerCase();
    if (l.startsWith(q)) pre.push(s);
    else if (l.includes(q)) sub.push(s);
  }
  return [...pre, ...sub].slice(0, 8);
}

const menuOf = (el) => el.closest(".ses-input-row")?.querySelector(".ses-complete") ?? null;

function closeMenu(menu) {
  if (!menu) return;
  menu.classList.remove("open");
  litRender(nothing, menu);
}

// Accept the named command: replace the leading token, leave a trailing space for the argument, keep
// focus, close the menu.
function accept(inputEl, name) {
  inputEl.value = "/" + name + " ";
  closeMenu(menuOf(inputEl));
  inputEl.focus();
}

function openMenu(inputEl, skills) {
  const menu = menuOf(inputEl);
  if (!menu) return;
  const q = slashQuery(inputEl.value);
  const matches = q == null ? [] : matchSkills(skills, q);
  if (matches.length === 0) return closeMenu(menu);
  litRender(
    matches.map(
      (name, i) => html`
        <div
          class="ses-opt${i === 0 ? " sel" : ""}"
          data-name=${name}
          @mousedown=${(e) => e.preventDefault()}
          @click=${() => accept(inputEl, name)}
        >
          /${name}
        </div>
      `,
    ),
    menu,
  );
  menu.classList.add("open");
}

// Move the highlight by ±1, wrapping, keeping the active option in view. Selection lives as a .sel
// class (DOM state — see the note above), so this neither rebuilds the menu nor needs a re-render.
function moveSel(menu, delta) {
  const opts = [...menu.querySelectorAll(".ses-opt")];
  if (opts.length === 0) return;
  let i = opts.findIndex((o) => o.classList.contains("sel"));
  if (i < 0) i = 0;
  opts[i].classList.remove("sel");
  i = (i + delta + opts.length) % opts.length;
  opts[i].classList.add("sel");
  opts[i].scrollIntoView({ block: "nearest" });
}

export default {
  contract: 1,
  render(card) {
    // LIVE vs static. When the `session` capability has a value the server is streaming this session
    // (agent-sessions §3): a {content, truncated, status?} that re-renders the card as it streams. It
    // SUPERSEDES the static fields.text but never writes back to it — the live transcript is
    // derived/channel-1, the file is the one source (session-timelines.md §1/§5), the canvas log is
    // untouched. With no feed (a plain historical transcript) we fall back to the field. Reading
    // card.signals.session here is what subscribes the card to the feed.
    const live = card.signals.session;
    const raw = (live ? live.content : card.fields.text) ?? "";
    // Incremental parse (eventsFor): only newly-appended lines are JSON.parsed each render, so a
    // streaming session no longer re-walks its whole transcript every frame.
    const st = eventsFor(card, raw);
    const tail = trailing(st, raw);
    const events = tail.event ? [...st.events, tail.event] : st.events;
    const { turns, tools } = turnsFor(st, events, !!tail.event);
    // Truncation is reported by the BYTE cap that actually cut content: a LIVE feed reports it directly
    // ({content, truncated}), a STATIC/historical transcript carries the loader's explicit sentinel
    // (eventsFor/trailing). The codec itself drops nothing — it renders every turn it's given.
    const truncated = !!(live && live.truncated) || st.truncated || tail.truncated;

    // `status` (running/idle/exited) is present ONLY for a registry-spawned process (slice 2's duplex)
    // — a slice-1 file-tail feed has no status, and a historical card has no feed. So it gates both the
    // status pill's detail and the INPUT row: you can only message a session the server actually owns.
    const status = live && live.status;
    // While a turn runs, the pill shows the live VERB (what the process is doing now — "Reading…",
    // "Running…", server-derived from the in-flight content block) instead of a bare "running"; idle
    // and exited stay steady labels. The `|| "Working"` covers the gap before the first stream frame.
    const verb = (live && live.verb) || "Working";

    // Phase-1 lifecycle banner: a bold status band across the card's top edge plus a tinted header
    // (style.css .ses-frame* / .ses-head[data-ses-state]), so you can triage a board of session cards at
    // a glance — which are busy, which are blocked on YOU, which have wound down. `running` is a calm
    // green working accent; `idle` defaults to the LOUD amber "waiting" band (your turn); everything
    // else — an `exited` process, a status-less file-tail feed, or a plain historical card reloaded from
    // its .jsonl after a server restart — is INACTIVE and reads muted grey.
    //
    // "inactive" = a session card with no live process driving it. The renderer can't infer this from a
    // bare file-tail feed: a status-less `{content}` feed is AMBIGUOUS — it's either a live tail of a
    // session the server doesn't own as a duplex (slice 1 → "● live") OR a dead transcript reloaded after
    // a restart. Only the server knows which (is the pid alive / file still growing), so it stamps
    // `ended:true` on the feed of a non-registry session. We treat as inactive: that explicit marker, or
    // a plain transcript card with NO feed at all (fields.text only — unambiguously historical). A
    // just-spawned card (no status, no text, no feed) stays bandless for the blink before its first frame.
    const inactive = !status && ((live && live.ended) || (!live && raw.trim().length > 0));

    // Phase-2 lifecycle: how the session WOUND DOWN, carried on the feed (from the live process we just
    // ended, or — after a restart — off the durable `.canvas/` marker the file-tail reads). It splits the
    // one muted "ended" state into three: a calm green "✓ done" (work declared finished via /done), a
    // neutral grey "✕ ended" (a clean /terminate teardown), and a LOUD red "✕ crashed" (the process died
    // on its own). A status `exited` or file-tail with no recorded reason keeps the old generic wording.
    const endReason = live && live.endReason;
    const ended = status === "exited" || inactive;
    const endFrame = endReason === "done" ? "done" : endReason === "crashed" ? "crashed" : "ended";
    // An idle session that named a peer in a channel @-tag is waiting on an AGENT, not you — the server
    // carries that as `waitingOn` (the tagged sids). It reads blue, a quieter "still in flight elsewhere"
    // rather than the loud amber "your turn". Cleared server-side the moment the session next runs.
    const waitingOnAgent = status === "idle" && !!(live && Array.isArray(live.waitingOn) && live.waitingOn.length);
    const frameState =
      status === "running"
        ? "working"
        : status === "idle"
          ? waitingOnAgent ? "waiting-agent" : "waiting"
          : ended ? endFrame : null;
    const frame = frameState ? html`<div class="ses-frame ses-frame-${frameState}"></div>` : "";

    // Pill mirrors the band so the two never disagree on one card: a live process shows its status (verb
    // while running, amber "waiting" idle); an ended one reads its end-reason ("✓ done" / "✕ crashed" /
    // neutral "✕ ended" / the bare "✕ exited"/"○ inactive" fallbacks); a status-less live tail stays green.
    const endPill = (fallbackLabel, fallbackClass) =>
      endReason === "done"
        ? html`<span class="ses-live ses-done">✓ done</span>`
        : endReason === "crashed"
          ? html`<span class="ses-live ses-exited">✕ crashed</span>`
          : endReason === "terminated"
            ? html`<span class="ses-live ses-inactive">✕ ended</span>`
            : html`<span class="ses-live ${fallbackClass}">${fallbackLabel}</span>`;
    const pill =
      status === "running"
        ? html`<span class="ses-live ses-running">● ${verb}…</span>`
        : status === "idle"
          ? waitingOnAgent
            ? html`<span class="ses-live ses-waiting-agent">○ waiting on agent</span>`
            : html`<span class="ses-live ses-idle">○ waiting</span>`
          : status === "exited"
            ? endPill("✕ exited", "ses-exited")
            : inactive
              ? endPill("○ inactive", "ses-inactive")
              : live
                ? html`<span class="ses-live">● live</span>`
                : "";

    // Live token counts for the current/last turn (server-folded from the stream's usage frames):
    // ↑ context size going in, ↓ output accrued. Shown for a live process while running or idle (the
    // counts persist after a turn ends), hidden once exited and for plain historical cards.
    const usage = live && live.usage;
    const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
    const usagePill =
      usage && status && status !== "exited"
        ? html`<span class="ses-usage" title="context in · output this turn"
            >↑${fmtTok(usage.input)} ↓${fmtTok(usage.output)}</span
          >`
        : "";

    // The INPUT half (agent-sessions §3; session-timelines §4): send a prompt into the live session
    // through the granted `sessionInput` capability — a session-internal POST, never the canvas log.
    // keydown stopPropagation keeps typing off the canvas shortcuts (v/h/arrows/⌘Z); the host contains
    // the pointerdown so focusing the field never starts a card drag (interior-interaction seam).
    const send = (text, el) => {
      text = String(text || "").trim();
      if (!text || !card.signals.sessionInput) return;
      card.signals.sessionInput(text);
      el.value = "";
    };
    // Answer an interactive ```ask block: route the assembled selection back through the input duplex,
    // exactly as a typed prompt would go (session-internal, never the canvas log). Granted only to the
    // last active claude turn's blocks (below) so a stale earlier question can't be answered twice.
    const answerAsk = (text) => card.signals.sessionInput && card.signals.sessionInput(text);
    // Bottom row. An ACTIVE live process (running/idle) gets the prompt input; a HISTORICAL or EXITED
    // session gets a "resume" button instead (slice 3 — recommence it live in place). Exited falls back
    // to the disabled input only when resume isn't granted, so the slice-2 behaviour is preserved.
    const active = status === "running" || status === "idle";
    const canResume = !!card.signals.sessionResume && (!status || status === "exited");

    // Recommence a historical/exited session as a live process in the SAME card (slice 3). The server
    // seeds the live feed from the .jsonl and `--resume`s; the feed then delivers a `status` and this
    // card re-renders into the input row. On failure (no transcript / no claude) re-enable the button.
    const resume = (btn) => {
      if (!card.signals.sessionResume) return;
      btn.disabled = true;
      btn.textContent = "resuming…";
      Promise.resolve(card.signals.sessionResume()).then((ok) => {
        if (!ok) {
          btn.disabled = false;
          btn.textContent = "▶ resume session";
        }
      });
    };
    const resumeRow = canResume
      ? html`
          <div class="ses-input-row ses-resume-row">
            <button class="ses-resume" @click=${(e) => resume(e.currentTarget)}>▶ resume session</button>
          </div>
        `
      : "";

    // The Phase-2 explicit "End session" control (head, shown only while the session is live and the
    // `sessionDone` capability is granted). Ending records `endReason:"done"` and frees the cap slot, so a
    // finished session reads "✓ done" instead of lingering as a live card — and ⌘Z can't touch it (it's a
    // session act, not the canvas log). It's recoverable (resume respawns and re-marks it live), but loud
    // enough to warrant a one-click ARM before it fires: the first click arms ("end?"), a second within the
    // window confirms. Imperative text mutation on a static-text button survives streamed re-renders (the
    // same lit property the resume button leans on), so the armed state isn't clobbered by a stream frame.
    const canEnd = !!card.signals.sessionDone && active;
    const end = (btn) => {
      if (!card.signals.sessionDone) return;
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.classList.add("armed");
        btn.textContent = "end?";
        clearTimeout(btn._disarm);
        btn._disarm = setTimeout(() => {
          btn.dataset.armed = "0";
          btn.classList.remove("armed");
          btn.textContent = "✓ end";
        }, 2500);
        return;
      }
      clearTimeout(btn._disarm);
      btn.disabled = true;
      btn.textContent = "ending…";
      Promise.resolve(card.signals.sessionDone()).then((ok) => {
        if (!ok) {
          btn.disabled = false;
          btn.dataset.armed = "0";
          btn.classList.remove("armed");
          btn.textContent = "✓ end";
        }
      });
    };
    const endBtn = canEnd
      ? html`<button class="ses-end" title="End this session — mark it done and free the slot" @click=${(e) => end(e.currentTarget)}>✓ end</button>`
      : "";

    // `/`-completion over the session's advertised skills (slice 2). Empty static menu container; its
    // contents are owned imperatively so they survive streamed re-renders (see the note above).
    const skills = Array.isArray(live?.skills) ? live.skills : [];
    const inputRow =
      card.signals.sessionInput && (active || (status === "exited" && !card.signals.sessionResume))
        ? html`
            <div class="ses-input-row">
              <div class="ses-complete"></div>
              <input
                class="ses-input"
                type="text"
                placeholder=${status === "exited" ? "session ended" : "message the session…  (/ for skills)"}
                ?disabled=${status === "exited"}
                @input=${(e) => openMenu(e.currentTarget, skills)}
                @blur=${(e) => closeMenu(menuOf(e.currentTarget))}
                @keydown=${(e) => {
                  e.stopPropagation();
                  const menu = menuOf(e.currentTarget);
                  const open = menu?.classList.contains("open");
                  if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    moveSel(menu, e.key === "ArrowDown" ? 1 : -1);
                  } else if (open && (e.key === "Tab" || e.key === "Enter")) {
                    // Tab/Enter accept the highlighted command — the user is still composing, not sending.
                    const name = menu.querySelector(".ses-opt.sel")?.dataset.name;
                    if (name) {
                      e.preventDefault();
                      accept(e.currentTarget, name);
                    }
                  } else if (open && e.key === "Escape") {
                    e.preventDefault();
                    closeMenu(menu);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    send(e.currentTarget.value, e.currentTarget);
                  }
                }}
              />
              <button
                ?disabled=${status === "exited"}
                @click=${(e) => {
                  const input = e.target.closest(".ses-input-row").querySelector("input");
                  send(input.value, input);
                }}
              >
                send
              </button>
            </div>
          `
        : "";

    // Copy the FULL session id to the clipboard — the head only shows it clipped, but the hash is the
    // thing you reach for to reference this session elsewhere. A button (so the host's seam contains
    // its pointerdown regardless of card selection — one click copies, never a card grab); a brief
    // .copied class flips the label to a ✓ without any per-card signal (transient DOM view state, same
    // category as the slash menu's selection). Closes over the full id, so it never enters the DOM.
    const sessionId = card.fields.title;

    // The touched-files activity strip (slice A): a collapsed disclosure under the head. Its <details>
    // open state survives streamed re-renders for the same reason the tool/thinking rows' do — lit never
    // binds `open`, so the user's toggle is left alone. Summary = recency-decaying dots + a count; open =
    // the path list (most-recent-first). Empty (no file tools yet) → nothing rendered.
    const touched = touchedFiles(turns);
    const recent = touched.slice(0, 8);
    // The board's roots (canonical + worktrees), each with a colour — for tinting the dots by worktree.
    // Guarded: a card without the `roots` capability (or a test mock) sees [], i.e. the neutral default.
    const roots = card.signals.roots || [];
    const activity = touched.length
      ? html`
          <details class="ses-activity">
            <summary title="files this session has touched — ● edited, ○ read · colour = worktree">
              <span class="ses-act-dots">
                ${recent.map(
                  (f, i) =>
                    html`<span
                      class="ses-act-dot${f.written ? "" : " read"}"
                      style=${dotStyle(f, roots, (1 - i * 0.09).toFixed(2))}
                    ></span>`,
                )}
              </span>
              <span class="ses-act-count">${touched.length} file${touched.length === 1 ? "" : "s"}</span>
            </summary>
            <div class="ses-act-list">
              ${touched.map(
                (f) => html`
                  <div class="ses-act-row" title=${f.path}>
                    <span class="ses-act-dot${f.written ? "" : " read"}" style=${dotStyle(f, roots, null)}></span>
                    <span class="ses-act-name">${base(f.path)}</span>
                    <span class="ses-act-tool">${f.tool}</span>
                  </div>
                `,
              )}
            </div>
          </details>
        `
      : "";

    // The task panel: the session's TaskCreate/TaskUpdate calls folded into their CURRENT state (taskList),
    // shown as a checklist under the activity strip — the equivalent of Claude Code's todo box, which the
    // raw inline tool rows can't convey (each is one mutation, not the running list). Open by default; lit
    // never binds `open`, so the literal attribute sets only the initial state and the user's collapse
    // survives streamed re-renders, like the activity/tool/thinking disclosures. Empty (no task calls yet)
    // → nothing rendered. A completed task dims + strikes through; the in_progress one shows its activeForm
    // ("Running tests") when given, else its subject.
    const tasks = taskList(turns);
    const tasksDone = tasks.filter((t) => t.status === "completed").length;
    const taskGlyph = (s) => (s === "completed" ? "✓" : s === "in_progress" ? "◐" : "○");
    const taskPanel = tasks.length
      ? html`
          <details class="ses-tasks" open>
            <summary title="this session's task list — TaskCreate / TaskUpdate, folded to current state">
              <span class="ses-tasks-label">tasks</span>
              <span class="ses-tasks-count">${tasksDone}/${tasks.length}</span>
            </summary>
            <div class="ses-tasks-list">
              ${tasks.map(
                (t) => html`
                  <div class="ses-task ses-task-${t.status}">
                    <span class="ses-task-glyph">${taskGlyph(t.status)}</span>
                    <span class="ses-task-subject" title=${t.description || t.subject}>
                      ${t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
                    </span>
                  </div>
                `,
              )}
            </div>
          </details>
        `
      : "";

    const copyId = (e) => {
      const btn = e.currentTarget;
      Promise.resolve(navigator.clipboard?.writeText(sessionId)).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1200);
      });
    };

    return html`
      ${frame}
      <div class="ses-head" data-ses-state=${frameState ?? "none"}>
        <button class="ses-name" type="button" title="Copy session id" @click=${copyId}>
          ${clip(sessionId, 8)}
        </button>
        ${pill}${usagePill}
        <span class="ses-meta">
          ${turns.length} turns · ${tools} tools${truncated ? html`<span class="ses-trunc"> · ⚠ truncated</span>` : ""}
        </span>
        ${endBtn}
      </div>
      ${activity}${taskPanel}
      <div class="ses-body" data-autoscroll data-text>
        ${turns.map((t, i) => {
          // Task-mutation rows are hidden inline (the task panel above carries that state). A turn left with
          // no visible blocks — e.g. one whose only act was a TaskUpdate — contributes nothing, so the role
          // chrome doesn't render onto an empty turn.
          const blocks = t.blocks.filter((b) => !(b.kind === "tool" && TASK_PANEL_TOOLS.has(b.name)));
          if (blocks.length === 0) return nothing;
          // The last claude turn of a LIVE session is the one that may hold a pending ```ask block —
          // grant its blocks the answer fn so its options are clickable; all others render read-only.
          const onAnswer = i === turns.length - 1 && active && t.role === "claude" ? answerAsk : null;
          return html`
            <div class="ses-turn ses-${t.role}">
              <div class="ses-role">${t.role}</div>
              ${blocks.map((b) => renderBlock(b, onAnswer))}
            </div>
          `;
        })}
        ${turns.length === 0 ? html`<div class="ses-empty">no turns</div>` : ""}
      </div>
      ${inputRow}${resumeRow}
    `;
  },
};
