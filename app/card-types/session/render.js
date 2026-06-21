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

const MAX_TURNS = 200; // bound the DOM against a pathological transcript. The card scrolls now (the
// interior-interaction seam), so this is high enough to show a real session in full — a historical
// card renders once (no live signals), so building a few hundred turns is cheap.

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
        blocks.push({ kind: "tool", name: b.name, hint: toolHint(b.input), result: r });
      }
      // tool_result blocks are rendered under their tool_use (above), not as their own turn
    }
    // a user message that was only tool_results contributes no turn
    if (blocks.length === 0) continue;
    turns.push({ role: role === "assistant" ? "claude" : "you", blocks });
  }

  return { turns, tools };
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

// Pull the first ```ask block out of an assistant text block. Returns {before, questions, after} only
// when the JSON is COMPLETE and valid — while the block is still streaming, JSON.parse fails and we
// return null so it renders as plain text until it closes (then flips to the widget).
const ASK_RE = /```ask[ \t]*\r?\n([\s\S]*?)\r?\n```/;
function extractAsk(text) {
  const m = ASK_RE.exec(text);
  if (!m) return null;
  let spec;
  try {
    spec = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const qs = Array.isArray(spec?.questions) ? spec.questions.filter((q) => q && q.question) : null;
  if (!qs || qs.length === 0) return null;
  return { before: text.slice(0, m.index), questions: qs, after: text.slice(m.index + m[0].length) };
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
  return html`
    <div class="ses-ask${onAnswer ? "" : " ses-ask-static"}">
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
    const ask = extractAsk(b.text);
    if (ask)
      return html`<div class="ses-text md-prose">
        ${ask.before.trim() ? renderMd(ask.before) : nothing}${renderAsk(ask.questions, onAnswer)}${ask.after.trim()
          ? renderMd(ask.after)
          : nothing}
      </div>`;
    return html`<div class="ses-text md-prose">${renderMd(b.text)}</div>`;
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
    // Truncation: a LIVE feed reports it directly ({content, truncated}); a STATIC/historical
    // transcript carries the loader's explicit sentinel, surfaced by eventsFor/trailing.
    const truncated = !!(live && live.truncated) || st.truncated || tail.truncated;
    const shown = turns.slice(0, MAX_TURNS);

    // `status` (running/idle/exited) is present ONLY for a registry-spawned process (slice 2's duplex)
    // — a slice-1 file-tail feed has no status, and a historical card has no feed. So it gates both the
    // status pill's detail and the INPUT row: you can only message a session the server actually owns.
    const status = live && live.status;
    // While a turn runs, the pill shows the live VERB (what the process is doing now — "Reading…",
    // "Running…", server-derived from the in-flight content block) instead of a bare "running"; idle
    // and exited stay steady labels. The `|| "Working"` covers the gap before the first stream frame.
    const verb = (live && live.verb) || "Working";
    const pill = status
      ? html`<span class="ses-live ses-${status}"
          >${status === "running" ? `● ${verb}…` : status === "idle" ? "○ idle" : "✕ exited"}</span
        >`
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
    const copyId = (e) => {
      const btn = e.currentTarget;
      Promise.resolve(navigator.clipboard?.writeText(sessionId)).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1200);
      });
    };

    return html`
      <div class="ses-head">
        <button class="ses-name" type="button" title="Copy session id" @click=${copyId}>
          ${clip(sessionId, 8)}
        </button>
        ${pill}${usagePill}
        <span class="ses-meta">
          ${turns.length} turns · ${tools} tools${truncated ? html`<span class="ses-trunc"> · ⚠ truncated</span>` : ""}
        </span>
      </div>
      <div class="ses-body" data-autoscroll data-text>
        ${shown.map((t, i) => {
          // The last claude turn of a LIVE session is the one that may hold a pending ```ask block —
          // grant its blocks the answer fn so its options are clickable; all others render read-only.
          const onAnswer = i === shown.length - 1 && active && t.role === "claude" ? answerAsk : null;
          return html`
            <div class="ses-turn ses-${t.role}">
              <div class="ses-role">${t.role}</div>
              ${t.blocks.map((b) => renderBlock(b, onAnswer))}
            </div>
          `;
        })}
        ${turns.length === 0 ? html`<div class="ses-empty">no turns</div>` : ""}
      </div>
      ${inputRow}${resumeRow}
    `;
  },
};
