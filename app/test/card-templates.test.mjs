import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The headless contract test (card-types-as-data.md §5.5): the replacement for the dual-renderer
// guard, run for EVERY type folder. A template that renders against a plain mock `card` in node —
// no React, no Solid, no browser — cannot be coupled to any shell.

const root = new URL("../", import.meta.url);
const typeDirs = fs
  .readdirSync(new URL("card-types/", root), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

test("every card type ships type.yaml + render.js", () => {
  assert.ok(typeDirs.length >= 3, `found only [${typeDirs}]`);
  for (const t of typeDirs) {
    fs.statSync(new URL(`card-types/${t}/type.yaml`, root));
    fs.statSync(new URL(`card-types/${t}/render.js`, root));
  }
});

// Acceptance #4: the import graph IS the capability boundary. A module may import the vendored
// substrate (anything under /vendor/ — lit-html, the shared markdown codec) and nothing else — not
// core, not interaction, not the shell, and no relative reach into a sibling card type.
for (const t of typeDirs) {
  test(`${t} template imports only the vendored substrate`, () => {
    const src = fs.readFileSync(new URL(`card-types/${t}/render.js`, root), "utf8");
    const imports = [...src.matchAll(/import\s[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const imp of imports)
      assert.ok(imp.startsWith("/vendor/"), `${t} imports ${imp} — outside the /vendor/ substrate`);
  });
}

// Acceptance #3: render against a mock card capability object, no shell at all. lit-html's html``
// tag builds a TemplateResult without touching the DOM (only render-to-container does), so the
// only shimming node needs is the handful of document calls the module makes at import time.
globalThis.document = {
  createComment: () => ({}),
  createElement: () => ({ content: {} }),
  createTextNode: () => ({}),
  createTreeWalker: () => ({}),
};

// The browser resolves /vendor/* against the dev server; node has no server, so point the vendored
// specifiers at the files on disk. lit-html → its file URL; the markdown codec → a data: module whose
// OWN lit-html import is likewise rewritten (so the prose codec loads without a server too).
const litUrl = new URL("vendor/lit-html.js", root).href;
const toVendorData = (src) =>
  "data:text/javascript," + encodeURIComponent(src.replaceAll('"/vendor/lit-html.js"', `"${litUrl}"`));
const mdUrl = toVendorData(fs.readFileSync(new URL("vendor/markdown.js", root), "utf8"));
// The notebook template imports the vendored format parser; it depends on no DOM (string-based, so it
// loads under node without a DOMParser) and imports nothing, so the same data:-URL rewrite suffices.
const nbFmtUrl = toVendorData(fs.readFileSync(new URL("vendor/notebook-format.js", root), "utf8"));

async function loadTemplate(type) {
  const src = fs.readFileSync(new URL(`card-types/${type}/render.js`, root), "utf8");
  const rewritten = src
    .replaceAll('"/vendor/lit-html.js"', `"${litUrl}"`)
    .replaceAll('"/vendor/markdown.js"', `"${mdUrl}"`)
    .replaceAll('"/vendor/notebook-format.js"', `"${nbFmtUrl}"`);
  return (await import("data:text/javascript," + encodeURIComponent(rewritten))).default;
}

test("clock template renders headless against a mock card", async () => {
  const mod = await loadTemplate("clock");
  assert.equal(mod.contract, 1);

  // 15s past the minute → second hand at 90°. The clock is a frameless face only — no digital readout
  // or badge head — so the tick drives the hands and nothing else. The mock card is the whole world the
  // template sees: fields + the granted `now` signal, nothing else.
  const fixedNow = new Date(2026, 5, 10, 9, 30, 15).getTime();
  const card = { fields: { title: "clock", text: "", color: "purple" }, signals: { now: fixedNow } };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("rotate(90 50 50)"), "second hand angle");
  assert.ok(out.includes("clock-face"));
  assert.ok(!out.includes("file-head"), "no digital-readout head");
});

test("note template renders its fields, and only its fields", async () => {
  const mod = await loadTemplate("note");
  assert.equal(mod.contract, 1);

  const card = { fields: { title: "plan", text: "ship the codec", color: "yellow" }, signals: {} };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("plan"), "title");
  assert.ok(out.includes("ship the codec"), "body text");
  assert.ok(out.includes("note-body"));
});

test("sticky template renders editable title + body, and degrades read-only without its grant", async () => {
  const mod = await loadTemplate("sticky");
  assert.equal(mod.contract, 1);

  // Granted all three WRITE capabilities (as buildCard supplies them for the sticky type): the title
  // input and body textarea carry the persisted fields and are NOT read-only — you can type into them —
  // and the colour swatch row renders, one button per NOTE_COLORS, with the current colour marked.
  const card = {
    fields: { title: "groceries", text: "- [ ] milk\n- [ ] eggs", color: "yellow" },
    signals: { setTitle: () => {}, setText: () => {}, setColor: () => {} },
  };
  const out = flatten(mod.render(card));
  assert.ok(out.includes("sticky-title"), "title input");
  assert.ok(out.includes("sticky-body"), "body textarea");
  assert.ok(out.includes("groceries"), "title field shown");
  assert.ok(out.includes("- [ ] milk"), "body field shown");
  assert.ok(!out.includes("?readonly=true"), "editable when the write capabilities are granted");

  // The swatch row: a button for every NOTE_COLORS value, and the current colour (yellow) selected.
  assert.ok(out.includes("sticky-swatch-row"), "swatch row renders with the setColor grant");
  for (const c of ["yellow", "pink", "blue", "green", "orange", "purple"])
    assert.ok(out.includes(`c-${c}`), `swatch for ${c}`);
  assert.ok(out.includes("c-yellow selected"), "the current colour is marked selected");

  // No grant (a misconfigured type or the headless mount beat before capabilities resolve): the card
  // must still render its fields, just read-only — never throw for a missing capability — and the
  // swatch row is absent (nothing to commit a colour through).
  const noGrant = flatten(mod.render({ fields: { title: "x", text: "y", color: "yellow" }, signals: {} }));
  assert.ok(noGrant.includes("?readonly=true"), "read-only without the write capabilities");
  assert.ok(noGrant.includes("x") && noGrant.includes("y"), "still shows fields read-only");
  assert.ok(!noGrant.includes("sticky-swatch"), "no swatch row without the setColor grant");
});

test("file template applies the v1 codec: path → basename / dir / kind", async () => {
  const mod = await loadTemplate("file");
  assert.equal(mod.contract, 1);

  // Content rides the off-log `fileContent` capability (content.ts), not node.text. With the signal
  // present it supersedes the static field; the field is only the pre-signal fallback (empty now).
  const card = {
    fields: { title: "core/src/store.ts", text: "", color: "blue" },
    signals: { fileContent: "export const x = 1;" },
  };
  const out = flatten(mod.render(card));
  assert.ok(out.includes('file-name">store.ts<'), "basename");
  assert.ok(out.includes("core/src/"), "directory meta line");
  assert.ok(out.includes('file-ext">ts<'), "kind from extension");
  assert.ok(out.includes("export const x = 1;"), "content from the off-log signal");

  // The signal supersedes a (legacy/stale) static field; and with no signal the field is the fallback,
  // so a card still renders headlessly / for the beat before the signal resolves.
  const sup = flatten(
    mod.render({ fields: { title: "a.ts", text: "stale", color: "blue" }, signals: { fileContent: "fresh off disk" } }),
  );
  assert.ok(sup.includes("fresh off disk") && !sup.includes("stale"), "signal supersedes the static field");
  const fallback = flatten(mod.render({ fields: { title: "a.ts", text: "from the field", color: "blue" }, signals: {} }));
  assert.ok(fallback.includes("from the field"), "falls back to fields.text without the signal");

  // Codec edges: alias (.markdown → md), extensionless and dotfiles → "file", no dir line at root.
  const md = flatten(mod.render({ fields: { title: "notes.markdown", text: "", color: "yellow" }, signals: {} }));
  assert.ok(md.includes('file-ext">md<'), "kind alias");
  assert.ok(!md.includes("file-dir"), "no dir line for a root file");
  const dot = flatten(mod.render({ fields: { title: ".gitignore", text: "", color: "purple" }, signals: {} }));
  assert.ok(dot.includes('file-ext">file<'), "dotfile is kind 'file'");
});

test("file template renders a .md card as PROSE (shared markdown codec), other kinds as a raw <pre>", async () => {
  const mod = await loadTemplate("file");

  // A markdown file's content goes through the same /vendor/markdown.js codec the session card uses:
  // block + inline structure, every leaf still an escaped lit text binding (no <pre> dump, no raw HTML).
  const src = "## Title\n\nsome **bold** and `code`\n\n- a\n- b";
  const md = flatten(mod.render({ fields: { title: "notes/plan.md", text: "", color: "yellow" }, signals: { fileContent: src } }));
  assert.ok(md.includes("file-md") && md.includes("md-prose"), "md body wears the prose classes, not the raw <pre>");
  assert.ok(!md.includes("file-body</pre>") && md.includes('class="md-h md-h2"'), "## renders as a heading, not literal text");
  assert.ok(md.includes("<strong>bold</strong>") && md.includes("md-icode"), "inline markdown renders");
  assert.ok(md.includes("<ul") && md.includes(">a<") && md.includes(">b<"), "a list renders");

  // A non-prose kind is untouched: source dumped verbatim into the whitespace-preserving raw preview.
  const ts = flatten(mod.render({ fields: { title: "a.ts", text: "", color: "blue" }, signals: { fileContent: "const x = 1; // ## not a heading" } }));
  assert.ok(ts.includes('<pre class="file-body" data-text>'), "code stays a raw <pre>");
  assert.ok(ts.includes("## not a heading") && !ts.includes("md-h"), "no markdown parsing for a .ts file");
});

test("directory template is an in-card tree: dirListing(path) per level, treeState expands, every row drags / folders also expand", async () => {
  const mod = await loadTemplate("directory");
  assert.equal(mod.contract, 1);

  // dirListing is now a CALLABLE keyed by PATH (the off-log /api/ls projection — content.ts), NOT
  // node.text: a folder card's children come from disk, never the durable log. It's called for the root
  // and for each EXPANDED sub-folder. treeState holds the (ephemeral, off-log) expand-set.
  const tree = {
    "interaction/src": { dirs: ["interaction/src/tools"], files: ["interaction/src/camera.ts", "interaction/src/input.ts"] },
    "interaction/src/tools": { dirs: [], files: ["interaction/src/tools/select.ts"] },
  };
  let open; // treeState value — starts undefined (nothing expanded)
  const card = {
    fields: { title: "interaction/src", text: "", color: "purple" },
    signals: {
      dirListing: (_root, p) => tree[p],
      treeState: { get: () => open, set: (v) => { open = v; } },
      fsOpen: () => {},
    },
    root: "repo", // single-root mode; treeState keys are (root, path) — see the expand step below
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes('file-name">src/<'), "header shows the folder basename");
  assert.ok(out.includes("interaction/src/") && out.includes("3 items"), "dir line: full path + item count");
  assert.ok(out.includes(">tools<"), "sub-dir basename as a row");
  assert.ok(out.includes(">camera.ts<") && out.includes(">input.ts<"), "file basenames as rows");
  assert.ok(out.includes('dir-ext">ts<'), "file kind from extension");
  assert.ok(!out.includes(">select.ts<"), "a collapsed sub-folder hides its children");

  // Promotion is the drag-out gesture (§9): every row is draggable from anywhere, contained from the
  // canvas drag (data-interactive, so the grab drags the path OUT, not the whole card). A FOLDER row
  // ALSO clicks-to-expand — the two coexist — and every row shows a persistent .dir-grip drag cue so
  // the drag affordance isn't lost under the expand affordance.
  assert.ok(out.includes('draggable="true"'), "rows are draggable for drag-out promotion");
  assert.ok(out.includes('data-interactive="1"'), "rows are contained from the canvas pointer seam");
  assert.ok(out.includes("dir-sub"), "a sub-dir row is marked distinct from a file row");
  assert.ok(out.includes("dir-grip"), "every row carries a persistent drag-out grip cue");

  // Double-click is the drag-out's keyboard-free twin, on FILE rows only — the tooltip teaches it. The
  // @dblclick handler is an event listener (not in the flattened string), so the contract test checks
  // the documented affordance, like it does for drag. Folders keep click=expand and aren't double-openable.
  assert.ok(out.includes("double-click or drag onto the canvas to open as a card"), "file rows document double-click open");
  assert.ok(out.includes("click to expand · drag onto the canvas to pin"), "folder rows keep click=expand / drag=pin (no double-open)");

  // Expand the sub-folder (treeState carries the open path) → its children drill IN, in place, rather
  // than spawning a separate card. This is the §B in-card tree behaviour.
  open = new Set(["repo" + String.fromCharCode(0) + "interaction/src/tools"]); // treeState key is (root, path) joined by NUL
  const expanded = flatten(mod.render(card));
  assert.ok(expanded.includes(">select.ts<"), "an expanded sub-folder reveals its children in the card");

  // While a listing is loading (dirListing returns undefined) the card shows a placeholder, never throws
  // — the headless mount / pre-fetch beat. An empty folder renders its own marker.
  const blank = { get: () => undefined, set: () => {} };
  const loading = flatten(mod.render({ fields: { title: "x", text: "", color: "purple" }, signals: { dirListing: () => undefined, treeState: blank } }));
  assert.ok(loading.includes("loading…"), "no listing yet → loading placeholder");
  const empty = flatten(mod.render({ fields: { title: "x", text: "", color: "purple" }, signals: { dirListing: () => ({ dirs: [], files: [] }), treeState: blank } }));
  assert.ok(empty.includes("empty folder"), "a folder with no children → empty marker");
});

test("sessions template lists the off-log session list, each row draggable, with a refresh action", async () => {
  const mod = await loadTemplate("sessions");
  assert.equal(mod.contract, 1);

  // sessionList is the off-log /api/sessions projection (content.ts) — the browser card's body, NOT
  // node.text. Each row drags out to open that session (the §C drag-out promotion). A titled session
  // shows its ai-title; an untitled one falls back to its id (truncated, monospaced).
  const sessions = [
    { id: "a1b2c3d4-1111", mtime: Date.now() - 5000, bytes: 2048, title: "Refactor the loader", turns: 7 },
    { id: "e5f6a7b8-2222", mtime: Date.now() - 90 * 60 * 1000, bytes: 512, title: null, turns: 1 },
  ];
  let refreshed = 0;
  const card = {
    fields: { title: "", text: "", color: "blue" },
    signals: { sessionList: sessions, sessionRefresh: () => refreshed++, sessionDelete: () => {}, sessionOpen: () => {} },
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("sessions"), "header label");
  assert.ok(out.includes('file-ext">2<'), "count badge reflects the list length");
  assert.ok(out.includes("Refactor the loader"), "a titled session shows its ai-title");
  assert.ok(out.includes("e5f6a7b8") && out.includes("ses-row-mono"), "an untitled session falls back to its id, monospaced");
  assert.ok(out.includes("7 turns"), "the meta line shows the turn count");
  assert.ok(out.includes("1 turn ·"), "singular turn label");
  assert.ok(out.includes("2 KB") && out.includes("512 B"), "byte sizes formatted");

  // Every row is draggable (the drag-out promotion) and contained from the canvas drag (data-interactive,
  // so grabbing a row drags it OUT, not the whole card).
  assert.ok(out.includes('draggable="true"'), "rows are draggable");
  assert.ok(out.includes('data-interactive="1"'), "rows are contained from the canvas pointer seam");

  // Each row is FOCUSABLE (tabindex) so a click selects it — that focus is the cue Shift+Delete hides it
  // from this list (sessionDelete). The tooltip teaches the otherwise-hidden gesture. (The keydown itself
  // is an event listener, not in the flattened string — the contract test checks presence, like drag.)
  assert.ok(out.includes('tabindex="0"'), "rows are focusable → selectable for the hide gesture");
  assert.ok(out.includes("Shift+Delete"), "the row tooltip documents the hide gesture");
  assert.ok(out.includes("double-click or drag onto the canvas to open"), "the row tooltip documents double-click open (the drag-out's twin)");

  // The refresh control is present with the grant, and routes through the capability.
  assert.ok(out.includes("ses-refresh"), "refresh button renders when sessionRefresh is granted");
  card.signals.sessionRefresh();
  assert.equal(refreshed, 1, "refresh is dispatched through the granted capability");

  // While the first fetch is in flight (sessionList undefined) → a loading placeholder, never a throw;
  // an empty list → its own marker; and without the refresh grant the button is absent.
  const loading = flatten(mod.render({ fields: { title: "", text: "", color: "blue" }, signals: {} }));
  assert.ok(loading.includes("loading…"), "no list yet → loading placeholder");
  assert.ok(!loading.includes("ses-refresh"), "no refresh button without the grant");
  const empty = flatten(mod.render({ fields: { title: "", text: "", color: "blue" }, signals: { sessionList: [] } }));
  assert.ok(empty.includes("no sessions on disk"), "an empty list → empty marker");
});

test("channels template highlights a WAITING thread (user waiting-state + you-pill, Phase 2) and offers click-to-transport", async () => {
  const mod = await loadTemplate("channels");
  assert.equal(mod.contract, 1);

  // channelList is the off-log /api/threads projection (content.ts). Phase 2 adds the board owner's
  // per-thread waiting signal — youWaiting / youWaitingCount, server-derived (handleThreads → humanWaiting),
  // the same signal the thread card's "you" pill uses. A waiting row is highlighted (the `waiting` class,
  // amber in CSS) and carries a count badge; a click on it transports the human to that thread card via the
  // channelOpen capability (fly-to-if-present, else open). One waiting + one calm thread in the list.
  let opened = null;
  const channels = [
    { chanId: "node:thread:aa", title: "Needs you", text: "brief a", messages: 6, mtime: Date.now() - 4000, youWaiting: true, youWaitingCount: 2 },
    { chanId: "node:thread:bb", title: "All quiet", text: "brief b", messages: 3, mtime: Date.now() - 90_000, youWaiting: false, youWaitingCount: 0 },
  ];
  const card = {
    fields: { title: "", text: "", color: "purple" },
    signals: { channelList: channels, channelRefresh: () => {}, channelOpen: (id) => { opened = id; } },
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("threads"), "header label");
  assert.ok(out.includes("Needs you") && out.includes("All quiet"), "both threads listed by title");

  // Exactly the waiting row wears the `waiting` class and the count badge — the calm one does not.
  assert.equal((out.match(/ses-row waiting/g) || []).length, 1, "only the waiting thread gets the waiting highlight");
  assert.equal((out.match(/ses-row-wait/g) || []).length, 1, "only the waiting thread shows a count badge");
  assert.ok(out.includes('ses-row-wait" title="messages awaiting you">2<'), "the badge shows the awaiting count");

  // The waiting row's tooltip documents the one-click transport (the calm row keeps the double-click hint).
  assert.ok(out.includes("2 messages await you — click to go to this thread"), "waiting row documents click-to-transport");
  assert.ok(out.includes("double-click or drag onto the canvas to open this thread"), "calm row keeps the double-click/drag hint");

  // The transport routes through the channelOpen capability (loader.openChannel flies to the card if it
  // already exists, else opens it) — the same action the double-click open uses. Drive it directly, as the
  // sessions test drives sessionRefresh, since the render-string path doesn't fire lit event bindings.
  card.signals.channelOpen("node:thread:aa", "Needs you", "brief a");
  assert.equal(opened, "node:thread:aa", "channelOpen transports to the clicked thread");

  // Singular count wording, and a thread with no waiting fields at all (older server) draws no highlight.
  const one = flatten(mod.render({
    fields: { title: "", text: "", color: "purple" },
    signals: { channelList: [{ chanId: "node:thread:cc", title: "One", text: "", messages: 1, mtime: Date.now(), youWaiting: true, youWaitingCount: 1 }], channelOpen: () => {} },
  }));
  assert.ok(one.includes("1 message await you — click to go to this thread"), "singular 'message' wording");
  const legacy = flatten(mod.render({
    fields: { title: "", text: "", color: "purple" },
    signals: { channelList: [{ chanId: "node:thread:dd", title: "Legacy", text: "", messages: 2, mtime: Date.now() }], channelOpen: () => {} },
  }));
  assert.ok(!legacy.includes("ses-row waiting") && !legacy.includes("ses-row-wait"), "a thread without the youWaiting field is not highlighted");
});

test("session template applies the jsonl codec: turns, tool calls with results, thinking", async () => {
  const mod = await loadTemplate("session");
  assert.equal(mod.contract, 1);

  // Real transcript shape (agent-sessions-on-canvas.md §4): a user string prompt, an assistant turn
  // with thinking + text + a tool_use, and the tool_result in the FOLLOWING user message keyed by id.
  const jsonl = [
    { type: "user", message: { role: "user", content: "rename the folder" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should check the memory dir" },
          { type: "text", text: "I'll check the memory situation." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la projects" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "drwxr-xr-x canvas", is_error: false }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  const card = { fields: { title: "ea3c6948", text: jsonl, color: "blue" }, signals: {} };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("rename the folder"), "user prompt turn");
  assert.ok(out.includes("I'll check the memory situation."), "assistant text");
  assert.ok(out.includes("I should check the memory dir"), "thinking block");
  assert.ok(out.includes("Bash"), "tool name");
  assert.ok(out.includes("ls -la projects"), "tool hint from input.command");
  assert.ok(out.includes("drwxr-xr-x canvas"), "tool_result paired by id and rendered inline");
  assert.ok(out.includes("2 turns"), "tool_result-only user message contributes no turn");

  // Disclosure: tool calls (with output) and thinking render as <details>/<summary> so they collapse.
  assert.ok(out.includes("<details") && out.includes("<summary"), "tool/thinking are disclosures");

  // Truncation is flagged from the loader's explicit sentinel (the server byte-capped the file)...
  const capped = jsonl + '\n{"type":"x-truncated"}';
  const cout = flatten(mod.render({ fields: { title: "x", text: capped, color: "blue" }, signals: {} }));
  assert.ok(cout.includes("⚠ truncated"), "sentinel flags a capped transcript");

  // ...but a ragged trailing line on its own (a LIVE session caught mid-write) must NOT throw and
  // must NOT cry truncated — the default session is often still running, and guessing false-positives.
  const partial = jsonl + '\n{"type":"assistant","message":{"role":"assist';
  const pout = flatten(mod.render({ fields: { title: "x", text: partial, color: "blue" }, signals: {} }));
  assert.ok(!pout.includes("truncated"), "a live mid-write tail is not flagged");
  // Empty content renders the head + an empty marker, never crashes (the headless mount case).
  const empty = flatten(mod.render({ fields: { title: "x", text: "", color: "blue" }, signals: {} }));
  assert.ok(empty.includes("0 turns") && empty.includes("no turns"), "empty session");
});

test("session template folds TaskCreate/TaskUpdate into a current-state task panel", async () => {
  const mod = await loadTemplate("session");
  // TaskCreate's input has no id — the server assigns "Task #N" and only the tool_result echoes it; a
  // later TaskUpdate references that numeric id. The reducer must pair create→result→update across turns,
  // flip status, drop a deleted task, and show the running list as a checklist (not the raw inline rows).
  const ev = [];
  const create = (id, subject, description) => {
    const tid = `c${id}`;
    ev.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: tid, name: "TaskCreate", input: { subject, description } }] },
    });
    ev.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: `Task #${id} created successfully: ${subject}` }] },
    });
  };
  const update = (id, input) => {
    const tid = `u${id}-${input.status ?? "x"}`;
    ev.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: tid, name: "TaskUpdate", input: { taskId: String(id), ...input } }] },
    });
    ev.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: `Updated task #${id}` }] } });
  };
  create(1, "Write pyproject.toml", "minimal hatchling pyproject");
  create(2, "Add console script", "wire the entry point");
  create(3, "Delete me", "created in error");
  update(1, { status: "completed" });
  update(2, { status: "in_progress", activeForm: "Adding the console script" });
  update(3, { status: "deleted" });

  const jsonl = ev.map((e) => JSON.stringify(e)).join("\n");
  const out = flatten(mod.render({ fields: { title: "task1234", text: jsonl, color: "blue" }, signals: {} }));

  assert.ok(out.includes("ses-tasks"), "the task panel renders");
  assert.ok(out.includes("1/2"), "count reflects 1 completed of 2 live tasks (deleted one is gone)");
  assert.ok(out.includes("Write pyproject.toml") && out.includes("ses-task-completed"), "task #1 shows completed");
  assert.ok(out.includes("Adding the console script") && out.includes("ses-task-in_progress"), "in_progress shows activeForm");
  assert.ok(!out.includes("Delete me"), "a status:deleted task is dropped from the panel");

  // No task tools → no panel (the common case must not render an empty checklist).
  const plain = [{ type: "user", message: { role: "user", content: "hi" } }].map((e) => JSON.stringify(e)).join("\n");
  const pout = flatten(mod.render({ fields: { title: "x", text: plain, color: "blue" }, signals: {} }));
  assert.ok(!pout.includes("ses-tasks"), "no task panel when the session used no task tools");
});

test("session template renders EVERY turn (no turn-count cap) — bounding is the upstream byte caps' job", async () => {
  // The codec must not silently drop turns: that was the "truncated before resume" bug, where a head
  // turn-slice hid where you left off. Memory is bounded once, upstream, by the byte caps on what the
  // feed delivers (MAX_SESSION_BYTES / MAX_SESSION_FEED_BYTES, both tail-kept + flagged); the codec
  // renders everything it's given — newest AND oldest — and only flags truncation when a BYTE cap says
  // it cut (live.truncated / the x-truncated sentinel), never by guessing from turn count.
  const mod = await loadTemplate("session");
  const N = 500; // a long transcript: every turn still renders, no cap drops any
  const jsonl = Array.from({ length: N }, (_, i) =>
    JSON.stringify({ type: "user", message: { role: "user", content: `PROMPT_${i}` } }),
  ).join("\n");

  const out = flatten(mod.render({ fields: { title: "x", text: jsonl, color: "blue" }, signals: {} }));
  assert.ok(out.includes("PROMPT_0"), "the oldest turn is rendered");
  assert.ok(out.includes("PROMPT_499"), "the newest turn (where you left off) is rendered");
  assert.ok(out.includes(`${N} turns`), "the head count is the true total");
  assert.ok(!out.includes("⚠ truncated"), "no byte cap bit, so nothing is flagged truncated");

  // A byte cap that DID cut is still flagged honestly, via the live feed's own signal.
  const capped = flatten(
    mod.render({ fields: { title: "x", text: jsonl, color: "blue" }, signals: { session: { content: jsonl, truncated: true } } }),
  );
  assert.ok(capped.includes("⚠ truncated"), "the feed's truncated flag still surfaces");
});

test("session template parses a streaming transcript incrementally without duplicating turns", async () => {
  const mod = await loadTemplate("session");

  const ev = (role, text) =>
    JSON.stringify({ type: role === "you" ? "user" : "assistant", message: { role: role === "you" ? "user" : "assistant", content: [{ type: "text", text }] } });

  // ONE card object reused across renders — this is what arms the per-card incremental cache (a fresh
  // object each render, as the other tests use, always full-parses). The feed value grows append-only.
  const card = { fields: { title: "s", text: "", color: "blue" }, signals: { session: { content: "", truncated: false } } };

  // First frame: two complete lines + a trailing newline so both are consumed.
  card.signals.session.content = ev("you", "first prompt") + "\n" + ev("claude", "first reply") + "\n";
  let out = flatten(mod.render(card));
  assert.ok(out.includes("first prompt") && out.includes("first reply"), "initial turns render");
  assert.ok(out.includes("2 turns"), "two turns after first frame");

  // Append a third line (no trailing newline yet — a live mid-write): the new turn shows transiently
  // and the earlier turns are NOT duplicated.
  card.signals.session.content += ev("claude", "second reply");
  out = flatten(mod.render(card));
  assert.ok(out.includes("second reply"), "appended turn appears before its newline lands");
  assert.equal((out.match(/first prompt/g) || []).length, 1, "no duplication of already-parsed turns");
  assert.ok(out.includes("3 turns"), "three turns with the transient tail");

  // The newline lands: the transient line is now consumed exactly once (still three turns, not four).
  card.signals.session.content += "\n";
  out = flatten(mod.render(card));
  assert.ok(out.includes("3 turns"), "completing the line does not double-count it");

  // A capped live feed still flags truncation via the direct flag, not a sentinel in the content.
  card.signals.session.truncated = true;
  out = flatten(mod.render(card));
  assert.ok(out.includes("⚠ truncated"), "live truncated flag surfaces");
});

test("session template live-tails the `session` feed, superseding the static field (slice 1)", async () => {
  const mod = await loadTemplate("session");

  const stale = JSON.stringify({ type: "user", message: { role: "user", content: "the old static turn" } });
  const liveJsonl = JSON.stringify({ type: "user", message: { role: "user", content: "a freshly streamed turn" } });

  // The `session` capability holds the live {content, truncated} the server tails off the .jsonl.
  // It supersedes fields.text (derived/channel-1; session-timelines.md §5) and flips the live pill on.
  const card = {
    fields: { title: "b0f4111d-22f4-452d", text: stale, color: "blue" },
    signals: { session: { content: liveJsonl, truncated: false } },
  };
  const out = flatten(mod.render(card));
  assert.ok(out.includes("a freshly streamed turn"), "live feed content is rendered");
  assert.ok(!out.includes("the old static turn"), "stale fields.text is NOT shown when the feed is live");
  assert.ok(out.includes("ses-live"), "the live pill is shown");
  assert.ok(out.includes("b0f4111d"), "the long session id is displayed truncated");
  assert.ok(!out.includes("b0f4111d-22f4"), "...and not in full");

  // A capped live feed flags ⚠ truncated via the same sentinel path as the static loader cap.
  const capped = flatten(
    mod.render({ fields: { title: "x", text: "", color: "blue" }, signals: { session: { content: liveJsonl, truncated: true } } }),
  );
  assert.ok(capped.includes("⚠ truncated"), "a capped live feed is flagged truncated");
});

test("session template shows the duplex input + status only for a registry-backed live session (slice 2)", async () => {
  const mod = await loadTemplate("session");
  const turn = JSON.stringify({ type: "user", message: { role: "user", content: "go" } });

  // A registry-backed feed carries `status` AND the card is granted `sessionInput`: the input row and
  // a status-specific pill render. A turn-granular FILE-TAIL feed (slice 1) carries no status, so no
  // input row appears — you can only message a session the server actually owns.
  const fileTail = flatten(
    mod.render({ fields: { title: "x", text: "", color: "blue" }, signals: { session: { content: turn, truncated: false } } }),
  );
  assert.ok(!fileTail.includes("ses-input"), "no input row for a status-less (file-tail) feed");
  assert.ok(fileTail.includes("● live"), "file-tail feed shows the plain live pill");

  const sent = [];
  const live = {
    fields: { title: "abcd1234", text: "", color: "blue" },
    signals: { session: { content: turn, truncated: false, status: "running" }, sessionInput: (t) => sent.push(t) },
  };
  const out = flatten(mod.render(live));
  assert.ok(out.includes("ses-input"), "registry-backed session shows the input row");
  // A running turn shows a live VERB (defaulting to "Working" until the server folds the first frame),
  // not a bare "running"; a verb + usage from the feed surface in the pill and the token readout.
  assert.ok(out.includes("● Working…"), "running pill defaults to the Working verb");
  const verbed = flatten(
    mod.render({
      ...live,
      signals: { ...live.signals, session: { content: turn, truncated: false, status: "running", verb: "Reading", usage: { input: 24100, output: 1200 } } },
    }),
  );
  assert.ok(verbed.includes("● Reading…"), "the live verb shows in the running pill");
  assert.ok(verbed.includes("↑24k") && verbed.includes("↓1.2k"), "the per-turn token counts render");
  // Slash-completion surface: the static menu container the imperative menu populates is present, and
  // the placeholder advertises it. The menu's interactive fill/nav needs a real DOM (verified in the
  // browser); here we just lock the wiring that headless render can see.
  assert.ok(out.includes("ses-complete"), "the slash-completion menu container renders");
  assert.ok(out.includes("/ for skills"), "the input hints at slash-completion");

  // The static-string render path doesn't exercise lit event bindings, so drive sessionInput directly
  // through the same guard the @click/@keydown handlers use: blank input is a no-op, real text sends.
  const send = (text) => {
    text = String(text || "").trim();
    if (!text || !live.signals.sessionInput) return;
    live.signals.sessionInput(text);
  };
  send("   ");
  assert.deepEqual(sent, [], "blank input does not send");
  send("hello session");
  assert.deepEqual(sent, ["hello session"], "real input is sent through the capability");

  // An exited session disables the row (no sending into a dead process).
  const exited = flatten(
    mod.render({
      fields: { title: "x", text: "", color: "blue" },
      signals: { session: { content: turn, truncated: false, status: "exited" }, sessionInput: () => {} },
    }),
  );
  assert.ok(exited.includes("✕ exited"), "exited status pill");
  assert.ok(exited.includes("session ended"), "exited input shows the 'session ended' placeholder");
  assert.ok(exited.includes("disabled=true"), "input/button bound disabled when exited");
});

test("session template offers resume-in-place for a historical/exited session (slice 3)", async () => {
  const mod = await loadTemplate("session");
  const turn = JSON.stringify({ type: "user", message: { role: "user", content: "an earlier prompt" } });

  // A card granted `sessionResume` with NO active process (a historical/file-tail feed: status-less)
  // shows the resume control instead of an input row — recommence it live in place (unify-on-resume).
  let resumed = 0;
  const card = {
    fields: { title: "abcd1234", text: turn, color: "blue" },
    signals: { session: { content: turn, truncated: false }, sessionResume: () => (resumed++, Promise.resolve(true)) },
  };
  const out = flatten(mod.render(card));
  assert.ok(out.includes("ses-resume"), "historical session shows the resume control");
  assert.ok(out.includes("resume session"), "...labelled to recommence");
  assert.ok(!out.includes("ses-input "), "no input row until the session is live");

  // A pure static historical card (no feed at all) is resumable too.
  const stat = flatten(mod.render({ fields: { title: "x", text: turn, color: "blue" }, signals: { sessionResume: () => Promise.resolve(true) } }));
  assert.ok(stat.includes("ses-resume"), "a static transcript card is resumable");

  // When the process EXITED and resume is granted, the dead input is replaced by resume (not the
  // disabled 'session ended' row — that fallback is only for cards without the resume capability).
  const exited = flatten(
    mod.render({
      fields: { title: "x", text: "", color: "blue" },
      signals: { session: { content: turn, truncated: false, status: "exited" }, sessionInput: () => {}, sessionResume: () => Promise.resolve(true) },
    }),
  );
  assert.ok(exited.includes("ses-resume"), "an exited session with resume shows the resume control");
  assert.ok(!exited.includes("session ended"), "...not the disabled input fallback");

  // An ACTIVE (running) session shows the input row, never resume.
  const running = flatten(
    mod.render({
      fields: { title: "x", text: "", color: "blue" },
      signals: { session: { content: turn, truncated: false, status: "running" }, sessionInput: () => {}, sessionResume: () => Promise.resolve(true) },
    }),
  );
  assert.ok(running.includes("ses-input"), "a running session shows the input row");
  assert.ok(!running.includes("ses-resume"), "...and not the resume control");

  // The capability is the same per-card action shape as sessionInput — a bound fn the template calls.
  void card.signals.sessionResume();
  assert.equal(resumed, 1, "resume is dispatched through the granted capability");
});

test("session template renders markdown in turn text (block + inline), but not in tool output", async () => {
  const mod = await loadTemplate("session");

  const md = [
    "## Plan",
    "",
    "Here is **bold**, *italic*, `inline code`, and a [link](https://example.com).",
    "",
    "- first item",
    "- second with `code`",
    "  - nested bullet",
    "",
    "1. ordered one",
    "2. ordered two",
    "",
    "- [ ] todo",
    "- [x] done",
    "",
    "> a quote",
    "",
    "```js",
    "const x = 1; // **not** bold in code",
    "```",
    "",
    "identifiers like file_path stay literal",
  ].join("\n");

  const jsonl = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: md }] },
  });
  const out = flatten(mod.render({ fields: { title: "s", text: jsonl, color: "blue" }, signals: {} }));

  // Block structure
  assert.ok(out.includes("md-h md-h2") && out.includes(">Plan<"), "## → heading");
  assert.ok(out.includes("<ul") && out.includes("<ol"), "both list kinds render");
  assert.ok(out.includes("nested bullet") && out.match(/<ul[\s\S]*<ul/), "indented item nests a list");
  assert.ok(out.includes("<blockquote"), "blockquote renders");
  assert.ok(out.includes("<pre") && out.includes("const x = 1;"), "fenced code renders");
  assert.ok(out.includes("☐") && out.includes("☑"), "task boxes render");

  // Inline structure
  assert.ok(out.includes("<strong>bold</strong>"), "**bold**");
  assert.ok(out.includes("<em>italic</em>"), "*italic*");
  assert.ok(out.includes("md-icode") && out.includes(">inline code<"), "`inline code`");
  assert.ok(out.includes('href="https://example.com"') || out.includes("href=https://example.com"), "[link](url)");

  // Things markdown must NOT mangle
  assert.ok(out.includes("file_path stay literal"), "intra-word underscores are not emphasis");
  // Code-fence content is not re-parsed as markdown: the literal ** survives, no <strong> from it.
  assert.ok(out.includes("**not** bold in code"), "markdown inside a code fence stays literal");

  // Tool OUTPUT is raw text, never markdown — a `**` in a tool result must not become <strong>.
  const tool = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "raw **stars** here" }] },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const tout = flatten(mod.render({ fields: { title: "s", text: tool, color: "blue" }, signals: {} }));
  assert.ok(tout.includes("raw **stars** here"), "tool output keeps literal ** (no markdown)");
  assert.ok(!tout.includes("<strong>stars"), "tool output is not markdown-rendered");
});

test("session template renders GFM tables (alignment, ragged rows), not bare pipe text", async () => {
  const mod = await loadTemplate("session");

  const md = [
    "| Name | Score | Note |",
    "| :--- | ----: | :--: |",
    "| alice | 10 | **good** |",
    "| bob | 3 |",
    "",
    "a | b without a delimiter row stays prose",
  ].join("\n");

  const jsonl = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: md }] },
  });
  const out = flatten(mod.render({ fields: { title: "s", text: jsonl, color: "blue" }, signals: {} }));

  // Table structure
  assert.ok(out.includes("md-table"), "table renders");
  assert.ok(out.includes("<thead") && out.includes("<th") && out.includes(">Name<"), "header row");
  assert.ok(out.includes("<tbody") && out.includes(">alice<"), "body row");
  // Alignment from the delimiter row (left / right / center).
  assert.ok(out.includes("text-align:right"), "----: → right align");
  assert.ok(out.includes("text-align:center"), ":--: → center align");
  // Inline markdown still applies inside cells.
  assert.ok(out.includes("<strong>good</strong>"), "inline markdown inside a cell");
  // A ragged (short) row normalises to the column count — no throw, missing cell is empty.
  assert.ok(out.includes(">bob<"), "ragged row still renders its cells");

  // A pipe line with NO delimiter row is not a table — it stays a paragraph, not a table cell.
  assert.ok(out.match(/<p class="md-p">[^<]*without a delimiter row stays prose/), "bare pipes stay prose");
});

test("session template renders a ```ask block as an interactive question widget (the AskUserQuestion stand-in)", async () => {
  const mod = await loadTemplate("session");
  const askJson =
    '{"questions":[{"question":"Which color?","header":"Color","multiSelect":false,' +
    '"options":[{"label":"red","description":"warm"},{"label":"blue","description":"cool"}]}]}';
  const text = "Pick one:\n\n```ask\n" + askJson + "\n```";
  const turn = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

  // LAST claude turn of a LIVE session (status active + sessionInput granted) → interactive: the raw
  // fence is consumed, options render as radios (single-select), and a submit button appears.
  const live = flatten(
    mod.render({
      fields: { title: "abcd1234", text: "", color: "blue" },
      signals: { session: { content: turn, truncated: false, status: "idle" }, sessionInput: () => {} },
    }),
  );
  assert.ok(live.includes("ses-ask") && !live.includes("ses-ask-static"), "interactive ask widget renders");
  assert.ok(!live.includes("```ask"), "the raw ask fence is consumed, not shown as a code block");
  assert.ok(live.includes("type=radio"), "single-select options render as radios");
  assert.ok(live.includes("value=red") && live.includes("value=blue"), "the option labels render");
  assert.ok(live.includes("ses-ask-submit"), "an interactive widget has a submit button");
  // The widget contains keydown so a Space typed into the custom-answer field isn't swallowed by the
  // canvas's hold-to-pan handler and a Backspace doesn't reach the app's delete-selected-card shortcut
  // (which used to unmount the very card being typed in). Same containment the live `.ses-input` does.
  assert.match(
    live,
    /class="ses-ask"\s*@keydown=[^\n]*stopPropagation/,
    "the ask widget contains keydown (Space/Backspace must not reach the canvas)",
  );

  // A historical card (no feed, no sessionInput) → read-only: same layout, static class, no submit.
  const hist = flatten(mod.render({ fields: { title: "s", text: turn, color: "blue" }, signals: {} }));
  assert.ok(hist.includes("ses-ask-static"), "a historical ask renders read-only");
  assert.ok(!hist.includes("ses-ask-submit"), "no submit on a read-only ask");

  // A still-STREAMING ask block (JSON not yet closed) must NOT render the widget — it stays text until
  // the fence completes and the JSON parses, so a half-streamed block can't show clickable garbage.
  const partial = "Pick one:\n\n```ask\n{\"questions\":[{\"question\":\"Whi";
  const pturn = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: partial }] } });
  const streaming = flatten(
    mod.render({
      fields: { title: "abcd1234", text: "", color: "blue" },
      signals: { session: { content: pturn, truncated: false, status: "running" }, sessionInput: () => {} },
    }),
  );
  assert.ok(!streaming.includes("ses-ask-submit"), "an incomplete ask block does not render the widget yet");
});

test("session template renders multiple questions — one array AND two separate ```ask fences", async () => {
  const mod = await loadTemplate("session");
  const liveRender = (text) => {
    const turn = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    return flatten(
      mod.render({
        fields: { title: "abcd1234", text: "", color: "blue" },
        signals: { session: { content: turn, truncated: false, status: "idle" }, sessionInput: () => {} },
      }),
    );
  };
  const askq = (s) => (s.match(/ses-ask-q/g) || []).length;

  // The intended form: TWO questions in ONE block's `questions` array → both render in one widget.
  const arrayJson = JSON.stringify({
    questions: [
      { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "red" }, { label: "blue" }] },
      { question: "Which size?", header: "Size", multiSelect: false, options: [{ label: "S" }, { label: "L" }] },
    ],
  });
  const oneBlock = liveRender("Two things:\n\n```ask\n" + arrayJson + "\n```");
  assert.equal(askq(oneBlock), 2, "both questions of a single multi-question block render");
  assert.ok(oneBlock.includes(">Color<") && oneBlock.includes(">Size<"), "each question keeps its own header");

  // The defensive case: TWO SEPARATE ```ask fences in one turn → BOTH render as widgets (the old codec
  // honored only the first and dumped the second as raw JSON), and no raw fence leaks into the output.
  const j1 = JSON.stringify({ questions: [{ question: "Which color?", header: "Color", options: [{ label: "red" }] }] });
  const j2 = JSON.stringify({ questions: [{ question: "Which size?", header: "Size", options: [{ label: "S" }] }] });
  const twoBlocks = liveRender("First:\n\n```ask\n" + j1 + "\n```\n\nSecond:\n\n```ask\n" + j2 + "\n```");
  assert.equal(askq(twoBlocks), 2, "two separate ask fences both render as widgets");
  assert.ok(!twoBlocks.includes("```ask"), "no raw ask fence leaks through as text");
  assert.ok(twoBlocks.includes(">Color<") && twoBlocks.includes(">Size<"), "both fences' questions are interactive");
});

test("usage template renders the account plan bars from the `usage` feed", async () => {
  const mod = await loadTemplate("usage");
  assert.equal(mod.contract, 1);

  // The shape the server publishes on the `usage` feed (Anthropic's OAuth usage endpoint + our envelope).
  // seven_day_opus null → that bar is omitted (a plan that hasn't touched Opus this week).
  const usage = {
    five_hour: { utilization: 14, resets_at: "2026-06-20T19:29:00+00:00" },
    seven_day: { utilization: 2, resets_at: "2026-06-24T16:59:00+00:00" },
    seven_day_sonnet: { utilization: 0, resets_at: "2026-06-23T03:00:00+00:00" },
    seven_day_opus: null,
    error: null,
  };
  const out = flatten(mod.render({ fields: { title: "", text: "", color: "green" }, signals: { usage } }));

  assert.ok(out.includes("Current session"), "5-hour window label");
  assert.ok(out.includes("Current week (all models)"), "weekly all-models label");
  assert.ok(out.includes("14% used"), "5-hour utilization");
  assert.ok(out.includes("2% used"), "weekly utilization");
  assert.ok(out.includes("width:14%"), "bar fill tracks utilization");
  assert.ok(out.includes("Resets"), "reset line shown");
  assert.ok(!out.includes("Current week (Sonnet)"), "Sonnet window is not shown");
  assert.ok(!out.includes("Current week (Opus)"), "an absent (null) Opus window draws no bar");

  // Not signed in → an explanatory note, no bars, never a throw.
  const noauth = flatten(
    mod.render({ fields: { title: "", text: "", color: "green" }, signals: { usage: { error: "no-credentials" } } }),
  );
  assert.ok(noauth.includes("Not signed in"), "no-credentials note");
  assert.ok(!noauth.includes("% used"), "no bars without data");

  // A transient error WITH last-good windows still draws bars + a staleness pill (never blanks).
  const stale = flatten(
    mod.render({
      fields: { title: "", text: "", color: "green" },
      signals: { usage: { ...usage, error: "rate-limited" } },
    }),
  );
  assert.ok(stale.includes("14% used"), "last-good bars survive a rate-limit");
  assert.ok(stale.includes("rate-limited"), "staleness pill shown");

  // Untitled with no session → the secondary token gauge is absent, plan bars stand alone.
  assert.ok(!out.includes("this session"), "no session gauge when untitled");

  // extra_usage (pay-as-you-go overage) renders as its own bar when enabled, formatted as currency
  // from minor units (2000 + decimal_places 2 → £20.00); absent/disabled → no extra-usage row.
  const withExtra = flatten(
    mod.render({
      fields: { title: "", text: "", color: "green" },
      signals: {
        usage: {
          ...usage,
          extra_usage: { is_enabled: true, used_credits: 350, monthly_limit: 2000, decimal_places: 2, currency: "GBP" },
        },
      },
    }),
  );
  assert.ok(withExtra.includes("Extra usage"), "extra-usage bar shown when enabled");
  assert.ok(withExtra.includes("£3.50") && withExtra.includes("£20.00"), "minor units formatted as currency");
  assert.ok(withExtra.includes("width:18%"), "extra-usage fill = used/limit");
  assert.ok(!out.includes("Extra usage"), "no extra-usage row when the field is absent");
});

test("usage template adds the per-session token gauge when titled with a live session", async () => {
  const mod = await loadTemplate("usage");
  const turn = JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-4-8[1m]", usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 50000 } },
  });

  // Plan feed present AND a live session feed → both sections render.
  const out = flatten(
    mod.render({
      fields: { title: "abcd1234", text: "", color: "green" },
      signals: {
        usage: { five_hour: { utilization: 10, resets_at: "2026-06-20T19:29:00+00:00" }, error: null },
        session: { content: turn, status: "running" },
      },
    }),
  );
  assert.ok(out.includes("Current session"), "plan bars still render");
  assert.ok(out.includes("this session"), "session gauge appears for a live session");
  assert.ok(out.includes("● running"), "session status pill");
  assert.ok(out.includes("1.0M"), "the [1m] model assumes a 1M-token context window");
});

test("weather template renders current conditions from the off-log `weather` capability, keyed by title", async () => {
  const mod = await loadTemplate("weather");
  assert.equal(mod.contract, 1);

  // `weather` is a CALLABLE keyed by the location query (the card's title), exactly the shape
  // `dirListing` uses — the off-log /api/weather projection (weather.ts), NOT node.text. The header is
  // an editable location committed through setTitle (like the sticky's title).
  const data = {
    q: "London",
    resolved: true,
    name: "London",
    admin1: "England",
    country: "United Kingdom",
    current: { temperature: 17.4, apparentTemperature: 16.1, humidity: 72, windSpeed: 11, weatherCode: 2, isDay: true },
    units: { temperature: "°C", windSpeed: "km/h" },
    error: null,
  };
  let titled;
  const card = {
    fields: { title: "London", text: "", color: "blue" },
    signals: { weather: (q) => (q === "London" ? data : undefined), setTitle: (v) => (titled = v) },
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("weather-loc"), "editable location input renders");
  assert.ok(out.includes("London") && out.includes("England") && out.includes("United Kingdom"), "resolved place line");
  assert.ok(out.includes("17°C"), "temperature rounded with its unit");
  assert.ok(out.includes("Partly cloudy"), "WMO code 2 → label");
  assert.ok(out.includes("⛅"), "WMO code 2 (day) → glyph");
  assert.ok(out.includes("16°C"), "feels-like row");
  assert.ok(out.includes("72%"), "humidity row");
  assert.ok(out.includes("11 km/h"), "wind row");
  assert.ok(!out.includes("?readonly=true"), "editable when setTitle is granted");

  // Day/night swaps the clear-sky glyph (code 0).
  const night = flatten(
    mod.render({
      fields: { title: "Oslo", text: "", color: "blue" },
      signals: {
        weather: () => ({ ...data, name: "Oslo", current: { ...data.current, weatherCode: 0, isDay: false } }),
        setTitle: () => {},
      },
    }),
  );
  assert.ok(night.includes("🌙") && night.includes("Clear sky"), "clear sky at night → moon glyph");

  // Empty title → the hint, no lookup, never a throw (the fresh-card / headless case).
  const hint = flatten(mod.render({ fields: { title: "", text: "", color: "blue" }, signals: { weather: () => undefined, setTitle: () => {} } }));
  assert.ok(hint.includes("Type a city"), "empty title shows the location hint");

  // A title in flight (weather() undefined) → loading; an unresolved place → a not-found message. Neither throws.
  const loading = flatten(mod.render({ fields: { title: "Atlantis", text: "", color: "blue" }, signals: { weather: () => undefined, setTitle: () => {} } }));
  assert.ok(loading.includes("Loading Atlantis"), "pending lookup shows a loading line");
  const missing = flatten(
    mod.render({ fields: { title: "Atlantis", text: "", color: "blue" }, signals: { weather: () => ({ q: "Atlantis", resolved: false, error: "not-found" }), setTitle: () => {} } }),
  );
  assert.ok(missing.includes("Couldn't find"), "an unresolved place shows a not-found message");

  // setTitle is the per-card write action a location edit commits through.
  card.signals.setTitle("Tokyo");
  assert.equal(titled, "Tokyo", "the location commits through the granted setTitle capability");
});

test("notebook template views a .html file: prose, module cells with wiring/policy + Run + output, feeds the graph", async () => {
  const mod = await loadTemplate("notebook");
  assert.equal(mod.contract, 1);

  // Source rides the off-log `fileContent` capability (content.ts), an Observable Notebooks 2.0 `.html`
  // file — NOT node.text. The template deserializes it (vendored notebook-format.js) into cells, hands the
  // graph to the scheduler via `syncCells`, and reads results from `cellOutputs`.
  const htmlSrc = [
    "<!doctype html>",
    "<notebook>",
    "  <title>Hello, notebook</title>",
    '  <script id="a1" type="text/markdown">',
    "    # Hello, notebook",
    "  </script>",
    '  <script id="a2" type="module" data-out="x">',
    "    21",
    "  </script>",
    '  <script id="a3" type="module" data-in="x" data-out="y">',
    "    x * 2",
    "  </script>",
    '  <script id="a4" type="module" data-in="x" data-policy="manual">',
    "    Array.from({length: x}, (_, i) => i * i)",
    "  </script>",
    "</notebook>",
  ].join("\n");

  const ran = [];
  let synced = null;
  const card = {
    fields: { title: "notebooks/hello.html", text: "", color: "green" },
    signals: {
      fileContent: htmlSrc,
      cellOutputs: { a2: { status: "ok", value: 21 }, a3: { status: "ok", value: 42 } },
      syncCells: (cells) => (synced = cells),
      runCell: (id) => ran.push(id),
      writeFile: () => {},
    },
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes('file-name">hello.html<'), "basename in the head");
  assert.ok(out.includes('file-ext">notebook<'), "type label");
  assert.ok(out.includes(">Hello, notebook<"), "the markdown cell renders as PROCESSED prose (heading text, '#' consumed)");
  assert.ok(out.includes("md-h1") || out.includes("md-h "), "the '# …' becomes a heading element, not raw source");
  assert.ok(out.includes("nb-md-prose"), "markdown cell wears the prose class, not a code box");
  assert.ok(!out.includes("nb-md-source"), "a markdown cell shows prose by default, not the raw-edit textarea");
  // Only DELAYED cells (manual/debounced) carry a Run button + status badge — a4 is manual. Standard (auto)
  // cells re-run on defocus, so a2/a3 get no Run button and no "ok" badge; their output pane is the signal.
  assert.ok((out.match(/nb-run/g) || []).length === 1, "a Run button only on the delayed (manual) cell, not the auto cells");
  assert.ok(!out.includes("nb-status nb-ok"), "no 'ok' status badge on a standard (auto) cell");
  assert.ok(out.includes(">21<"), "a2 output value renders");
  assert.ok(out.includes(">42<"), "a3 (downstream) output value renders");

  // Wiring is DISPLAY-ONLY now (the editable in/out boxes were removed; authoring moves into the cell code).
  // Explicit declarations still render as chips: a2 defines x (→ x), a3 reads x + defines y (↓ x, → y). Only
  // the policy stays editable when writeFile is granted (the click-to-cycle button).
  assert.ok(!out.includes("nb-wire-input"), "the editable wiring boxes are gone");
  assert.ok(out.includes("nb-policy-btn"), "policy is a click-to-cycle button");
  assert.ok(out.includes("→ x"), "a2's explicit define (x) shows as a chip");
  assert.ok(out.includes("↓ x") && out.includes("→ y"), "a3's explicit read (x) and define (y) show as chips");

  // syncCells got the parsed graph, including wiring + policy, module cells carrying their declarations.
  assert.ok(Array.isArray(synced) && synced.length === 4, "all cells (incl. markdown) handed to the scheduler");
  const a3 = synced.find((c) => c.id === "a3");
  assert.deepEqual(a3.inNames, ["x"], "a3 imports x");
  assert.deepEqual(a3.outNames, ["y"], "a3 exports y");
  const a4 = synced.find((c) => c.id === "a4");
  assert.equal(a4.policy, "manual", "a4's policy reaches the scheduler");

  // The Run button routes through the granted capability with just the cell id (the runtime holds source).
  card.signals.runCell("a4");
  assert.deepEqual(ran, ["a4"], "Run dispatches runCell(cellId)");

  // A stale cell (inputs changed, awaiting a trigger) is a DELAYED-cell concept — a4 is manual. Its bar
  // shows the stale badge while keeping the last value visible.
  const stale = flatten(
    mod.render({ ...card, signals: { ...card.signals, cellOutputs: { a4: { status: "ok", value: 42, stale: true } } } }),
  );
  assert.ok(stale.includes("nb-status nb-stale") && stale.includes("stale — inputs changed"), "a delayed cell shows the stale badge");
  assert.ok(stale.includes(">42<"), "a stale cell still shows its last value");

  // A running auto cell shows "running…" in its OUTPUT PANE (no bar); a running delayed cell also gets the
  // bar's running badge. An error renders to a string, never a crash.
  const running = flatten(
    mod.render({ ...card, signals: { ...card.signals, cellOutputs: { a2: { running: true }, a4: { running: true } } } }),
  );
  assert.ok(running.includes("running…"), "running state shown in the output pane");
  assert.ok(running.includes("nb-status nb-running"), "a delayed cell also shows the running badge");
  const errOut = flatten(
    mod.render({ ...card, signals: { ...card.signals, cellOutputs: { a2: { status: "error", error: "ReferenceError: oops is not defined" } } } }),
  );
  assert.ok(errOut.includes("oops is not defined") && errOut.includes("nb-out-error"), "error output shown, styled");

  // No signals at all → falls back to fields.text, renders headlessly (no syncCells call), never throws.
  const empty = flatten(mod.render({ fields: { title: "x.html", text: "", color: "green" }, signals: {} }));
  assert.ok(empty.includes('file-ext">notebook<'), "renders the head without any signals");
});

test("notebook template shows INFERRED wiring (step-4a) as a muted hint where no data-in/data-out is written", async () => {
  const mod = await loadTemplate("notebook");

  // Two module cells with NO data-in/data-out: `x = 21` defines x, `y = x * 2` reads x + defines y. The
  // runtime (acorn) does the inference and reports it back through cellOutputs as inReads/inDefines; the
  // template only DISPLAYS it (it never parses JS). So we feed the inferred wiring via the cellOutputs mock.
  const htmlSrc = [
    "<!doctype html>",
    "<notebook>",
    "  <title>inferred</title>",
    '  <script id="a2" type="module">',
    "    x = 21",
    "  </script>",
    '  <script id="a3" type="module">',
    "    y = x * 2",
    "  </script>",
    "</notebook>",
  ].join("\n");
  const cellOutputs = {
    a2: { status: "ok", value: 21, inDefines: ["x"] },
    a3: { status: "ok", value: 42, inReads: ["x"], inDefines: ["y"] },
  };

  // Wiring is DISPLAY-ONLY (the editable boxes were removed). Inferred reads AND defines render as the italic
  // nb-wire-inf chip — the same way whether or not the card can write. a2 defines x (→ x); a3 reads x (↓ x)
  // and defines y (→ y).
  for (const signals of [
    { fileContent: htmlSrc, cellOutputs, syncCells: () => {}, writeFile: () => {} }, // writable
    { fileContent: htmlSrc, cellOutputs }, // read-only
  ]) {
    const o = flatten(mod.render({ fields: { title: "inferred.html", text: "", color: "green" }, signals }));
    assert.ok(!o.includes("nb-wire-input"), "no editable wiring boxes");
    assert.ok(o.includes("nb-wire-inf"), "inferred wiring renders as the italic chip");
    assert.ok(o.includes("→ x") && o.includes("→ y"), "inferred defines (x, y) shown as → chips");
    assert.ok(o.includes("↓ x"), "the inferred read (x) is shown as a ↓ chip");
  }

  // A cell with an EXPLICIT data-out renders the plain (non-italic) define chip, not the inferred one.
  const explicitSrc = htmlSrc.replace('<script id="a3" type="module">', '<script id="a3" type="module" data-out="y">');
  const overridden = flatten(mod.render({ fields: { title: "x.html", text: "", color: "green" }, signals: { fileContent: explicitSrc, cellOutputs: { a3: { status: "ok", value: 42, inDefines: ["y"] } }, writeFile: () => {} } }));
  assert.ok(/nb-wire nb-out" title="defines">→ y/.test(overridden), "explicit data-out → plain define chip, not the inferred one");

  // An inferred CROSS-card import (step-4b, an `import` statement) renders as a muted ↓ chip labelled
  // name←path, the same way the runtime reports it via cellOutputs.inImports.
  const crossOutputs = { a3: { status: "ok", value: 3, inImports: [{ name: "df", path: "./notebook1", export: "df" }] } };
  const cross = flatten(mod.render({ fields: { title: "x.html", text: "", color: "green" }, signals: { fileContent: htmlSrc, cellOutputs: crossOutputs, writeFile: () => {} } }));
  assert.ok(/nb-wire nb-in nb-wire-inf[^>]*>↓ df←\.\/notebook1#df/.test(cross), "inferred cross-card import shown as a muted name←path chip");
});

test("notebook template renders a reactive markdown cell's INTERPOLATED output as prose (`${ }`)", async () => {
  const mod = await loadTemplate("notebook");
  // A text/markdown cell with a `${ }` interpolation (Observable Notebook Kit 2.0) is scheduled like a code
  // cell: the runtime compiles it to a template literal, runs it, and its OUTPUT VALUE is the interpolated
  // prose STRING — which the card renders as markdown. The template doesn't run anything; we feed the
  // computed string via the cellOutputs mock, exactly as the runtime would after a run.
  const htmlSrc = [
    "<!doctype html>",
    "<notebook>",
    "  <title>Live</title>",
    '  <script id="a1" type="module" data-out="total">',
    "    42",
    "  </script>",
    '  <script id="a2" type="text/markdown">',
    "    ## Sales: ${total}",
    "  </script>",
    "</notebook>",
  ].join("\n");
  // a2's run produced the interpolated string "## Sales: 42".
  const cellOutputs = { a2: { status: "ok", value: "## Sales: 42" } };
  const out = flatten(
    mod.render({ fields: { title: "live.html", text: "", color: "green" }, signals: { fileContent: htmlSrc, cellOutputs, syncCells: () => {}, writeFile: () => {} } }),
  );
  assert.ok(out.includes("nb-md-prose"), "the markdown cell still renders as prose, not a code box");
  assert.ok(out.includes(">Sales: 42<"), "the INTERPOLATED value (42) renders, with the heading '##' consumed");
  assert.ok(!out.includes("${total}"), "the raw ${total} source is NOT shown once interpolated");

  // An interpolation error keeps the document readable (raw source as prose) and surfaces the error notice.
  const errored = flatten(
    mod.render({ fields: { title: "live.html", text: "", color: "green" }, signals: { fileContent: htmlSrc, cellOutputs: { a2: { status: "error", error: "ReferenceError: total is not defined" } }, syncCells: () => {}, writeFile: () => {} } }),
  );
  assert.ok(errored.includes("nb-md-error") && errored.includes("total is not defined"), "an interpolation error shows a muted notice");

  // Before the first run (no output), the raw source shows as prose — a brief, harmless transient.
  const pristine = flatten(
    mod.render({ fields: { title: "live.html", text: "", color: "green" }, signals: { fileContent: htmlSrc, cellOutputs: {}, syncCells: () => {}, writeFile: () => {} } }),
  );
  assert.ok(pristine.includes("nb-md-prose"), "a not-yet-run interpolated cell still renders (its raw source)");
});

// Reassemble a TemplateResult (and nested results/arrays in its values) into a flat string.
function flatten(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (value.strings && value.values)
    return value.strings.reduce((acc, s, i) => acc + (i ? flatten(value.values[i - 1]) : "") + s, "");
  return String(value);
}

// Permission prompts (permission-prompt-tool): a held tool call rides the feed as `permissions`; the
// card renders allow/deny rows through the `sessionPermission` capability and paints the LOUD waiting
// band even though the process is mid-turn — blocked on a human is the band's whole reason to exist.
test("session template surfaces held permission prompts: allow/deny rows + the waiting band", async () => {
  const mod = await loadTemplate("session");
  const turn = JSON.stringify({ type: "user", message: { role: "user", content: "go" } });
  const decided = [];
  const perm = { id: "p1", toolName: "Bash", input: { command: "git push origin main" }, ts: 1 };
  const card = {
    fields: { title: "abcd1234", text: "", color: "blue" },
    signals: {
      session: { content: turn, truncated: false, status: "running", permissions: [perm] },
      sessionInput: () => {},
      sessionPermission: (id, behavior) => decided.push([id, behavior]),
    },
  };
  const out = flatten(mod.render(card));
  assert.ok(out.includes("ses-perms"), "the permission block renders");
  assert.ok(out.includes("Bash"), "the gated tool's name shows");
  assert.ok(out.includes("git push origin main"), "the tool-hint (command) shows");
  assert.ok(out.includes("⚠ permission"), "the pill flips to the permission warning");
  assert.ok(out.includes("ses-frame-waiting"), "the loud waiting band paints despite status=running");

  // The buttons route through the capability with the prompt's id — the server resolves the rest.
  card.signals.sessionPermission(perm.id, "allow");
  assert.deepEqual(decided, [["p1", "allow"]]);

  // No `sessionPermission` grant → no actionable rows (a mock/degraded mount can't answer, so don't
  // offer); a feed frame without `permissions` (prompt resolved) drops back to the plain live pill.
  const ungranted = flatten(mod.render({ ...card, signals: { ...card.signals, sessionPermission: undefined } }));
  assert.ok(!ungranted.includes("ses-perms"), "no block without the sessionPermission capability");
  const cleared = flatten(
    mod.render({ ...card, signals: { ...card.signals, session: { content: turn, truncated: false, status: "running" } } }),
  );
  assert.ok(!cleared.includes("ses-perms"), "a resolved prompt leaves with its feed frame");
  assert.ok(cleared.includes("● Working…"), "…and the pill returns to the live verb");
});

// worktree-activity slices A/C: the session card's touched-files activity strip — derived from the same
// tool_use blocks as the turns — dedupes by path (newest touch wins), marks edited files as written
// (sticky even after a later read), and colours each dot by the WORKTREE the absolute path falls under.
test("session activity strip: dedupes touched files, distinguishes read/write, colours by worktree", async () => {
  const mod = await loadTemplate("session");
  const jsonl = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/main/src/a.ts" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/repo/wt/src/b.ts" } },
          { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/repo/wt/src/b.ts" } }, // re-read → still written
        ],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const roots = [
    { id: "repo", name: "main", path: "/repo/main", branch: "", head: "", hue: "hsl(10 60% 55%)" },
    { id: "wt", name: "wt", path: "/repo/wt", branch: "feat", head: "", hue: "hsl(200 60% 55%)" },
  ];
  const out = flatten(mod.render({ fields: { title: "sess", text: jsonl, color: "blue" }, signals: { roots }, root: "repo" }));

  assert.ok(out.includes("2 files"), "b.ts counted once across its edit + re-read");
  assert.ok(out.includes("a.ts") && out.includes("b.ts"), "basenames in the expanded list");
  assert.ok(out.includes("background:hsl(200 60% 55%)"), "edited file fills with its WORKTREE hue (written)");
  assert.ok(out.includes("border-color:hsl(10 60% 55%)"), "read-only file takes the canonical hue as a ring");
});

// worktree-activity slice B/C: a root-level tree card (path "", card.root = a worktree id) shows the
// worktree's name + branch and its colour swatch, looked up from the `roots` capability by card.root.
test("directory root-level head shows the worktree name, branch, and colour swatch", async () => {
  const mod = await loadTemplate("directory");
  const roots = [{ id: "wt", name: "feature-tree", path: "/repo/wt", branch: "feat-x", head: "", hue: "hsl(123 60% 55%)" }];
  const card = {
    fields: { title: "", text: "", color: "purple" },
    signals: { dirListing: () => ({ dirs: [], files: [] }), treeState: { get: () => new Set(), set() {} }, roots },
    root: "wt",
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("feature-tree"), "worktree name in the head (not the bare path)");
  assert.ok(out.includes("feat-x"), "branch in the ext slot");
  assert.ok(out.includes("hsl(123 60% 55%)"), "root colour swatch");
});

// worktree-activity (combined file-tree card): card.root === "roots" lists every board root (canonical +
// worktrees) as a colour-swatched, drillable, drag-outable top-level row — reactively off the `roots` cap.
test("directory combined mode lists every root, colour-swatched and drag-outable", async () => {
  const mod = await loadTemplate("directory");
  const roots = [
    { id: "repo", name: "main", path: "/r/main", branch: "", head: "", hue: "hsl(10 60% 55%)" },
    { id: "wt", name: "feature", path: "/r/wt", branch: "feat-x", head: "", hue: "hsl(200 60% 55%)" },
  ];
  const card = {
    fields: { title: "", text: "", color: "purple" },
    signals: { dirListing: () => ({ dirs: [], files: [] }), treeState: { get: () => new Set(), set() {} }, roots },
    root: "roots",
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("file tree") && out.includes("2 roots"), "header names the combined tree + root count");
  assert.ok(out.includes(">main<") && out.includes(">feature<"), "every root listed as a top-level row");
  assert.ok(out.includes("feat-x"), "a worktree's branch shown on its row");
  assert.ok(out.includes("hsl(10 60% 55%)") && out.includes("hsl(200 60% 55%)"), "each root row swatched by its hue");
  assert.ok(out.includes("dir-root-row") && out.includes('draggable="true"'), "root rows drag out to their own card");
});

// worktree-activity slice D: a pinned card whose backing is deleted/removed shows a TOMBSTONE (kept +
// marked), not a silent removal (files) or a stuck "loading…" (folders/worktrees).
test("file card tombstones a deleted file (gone) instead of vanishing", async () => {
  const mod = await loadTemplate("file");
  const out = flatten(
    mod.render({ fields: { title: "core/src/store.ts", text: "", color: "blue" }, signals: { gone: true }, root: "repo" }),
  );
  assert.ok(out.includes("file-gone"), "tombstone styling");
  assert.ok(out.includes("store.ts") && out.includes("deleted on disk"), "names the deleted file");
});

test("directory card tombstones when its worktree root is gone (root absent from the loaded roots)", async () => {
  const mod = await loadTemplate("directory");
  // roots loaded (non-empty) but card.root not among them → the worktree was removed.
  const roots = [{ id: "repo", name: "main", path: "/r", branch: "", head: "", hue: "hsl(1 60% 55%)" }];
  const card = {
    fields: { title: "", text: "", color: "purple" },
    signals: { dirListing: () => undefined, treeState: { get: () => new Set(), set() {} }, roots, gone: false },
    root: "ghost-wt",
  };
  const out = flatten(mod.render(card));
  assert.ok(out.includes("file-gone") && out.includes("worktree removed"), "worktree-removed tombstone");
});

// agent-roles.md: the roles browser card — the channels/sessions card's twin. Lists this board's roles
// (the off-log `rolesList` projection), swatches each by its colour key, derives a LIVE-INSTANCE count from
// the `sessionList` capability (a client-side join on roleId — no backend presence), and offers an EXPLICIT
// per-row Launch button (roleLaunch) rather than a costly double-click spawn.
test("roles template lists roles with colour swatches, a derived live count, and an explicit launch action", async () => {
  const mod = await loadTemplate("roles");
  assert.equal(mod.contract, 1);

  const roles = [
    { roleId: "oracle", name: "Oracle", colour: "purple" },
    { roleId: "generalist", name: "Generalist", colour: "blue" },
  ];
  // Two live sessions under Oracle (one working, one waiting), one wound-down (ended → NOT counted), and a
  // bare session with no roleId — so Oracle's derived count is 2 and Generalist's is 0 (no badge).
  const sessions = [
    { id: "s1", roleId: "oracle", status: "working" },
    { id: "s2", roleId: "oracle", status: "waiting" },
    { id: "s3", roleId: "oracle", status: "ended" },
    { id: "s4", roleId: null, status: "working" },
  ];
  let launched = null;
  let refreshed = 0;
  const card = {
    fields: { title: "", text: "", color: "orange" },
    signals: {
      rolesList: roles,
      sessionList: sessions,
      rolesRefresh: () => refreshed++,
      roleLaunch: (id) => (launched = id),
    },
  };
  const out = flatten(mod.render(card));

  assert.ok(out.includes("roles"), "header label");
  assert.ok(out.includes('file-ext">2<'), "count badge reflects the number of roles");
  assert.ok(out.includes("Oracle") && out.includes("Generalist"), "role names rendered");
  assert.ok(out.includes("role-swatch c-purple") && out.includes("role-swatch c-blue"), "swatch tinted by the colour key");
  assert.ok(out.includes("● 2"), "Oracle's derived live count = 2 (working+waiting, the ended one excluded)");
  assert.ok(!out.includes("● 0"), "a role with no live sessions shows no count badge");

  // Launch is an explicit button routing through the capability with the row's roleId.
  assert.ok(out.includes("role-launch"), "launch button renders when roleLaunch is granted");
  card.signals.roleLaunch("oracle");
  assert.equal(launched, "oracle", "launch is dispatched with the role id");
  card.signals.rolesRefresh();
  assert.equal(refreshed, 1, "refresh routes through the granted capability");

  // In-flight (rolesList undefined) → loading, never a throw; empty → its own marker; no launch grant → no button.
  const loading = flatten(mod.render({ fields: { title: "", text: "", color: "orange" }, signals: {} }));
  assert.ok(loading.includes("loading…"), "no list yet → loading placeholder");
  assert.ok(!loading.includes("role-launch"), "no launch button without the grant");
  const empty = flatten(mod.render({ fields: { title: "", text: "", color: "orange" }, signals: { rolesList: [] } }));
  assert.ok(empty.includes("no roles yet"), "an empty list → empty marker");
});

// agent-roles.md 2b: the role EDIT card — a structured view over role.md. The HOST parses role.md with the
// shared codec and hands the card a `roleDoc` ({roleId,name,colour,charter}); the card renders name (read-only),
// a colour swatch row (current ringed), and an editable charter, saving edits back through `roleSave`.
test("role template renders the charter as formatted markdown by default, flips to an editor on edit", async () => {
  const mod = await loadTemplate("role");
  assert.equal(mod.contract, 1);

  // A tiny stand-in for the per-card `treeState` ephemeral view-state signal (get/set), so the test can drive
  // the edit⇄preview toggle exactly as a click would.
  const editState = (init) => {
    let v = init;
    return { get: () => v, set: (n) => (v = n) };
  };

  let saved = null;
  const card = {
    fields: { title: ".canvas/roles/oracle/role.md", text: "", color: "orange" },
    signals: {
      roleDoc: { roleId: "oracle", name: "Oracle", colour: "purple", charter: "# Oracle\n\nAnswer in file:line." },
      roleSave: (doc) => (saved = doc),
      treeState: editState(undefined),
    },
  };

  // Default (not editing): the charter is rendered PROSE, not a raw textarea — the markdown heading became an
  // <h1>, and the editor chrome (textarea / colour swatches) is absent until the user clicks edit.
  const preview = flatten(mod.render(card));
  assert.ok(preview.includes("Oracle"), "the role name is shown");
  assert.ok(preview.includes("role-name"), "name rendered as a (read-only) heading, not an input");
  assert.ok(preview.includes("Answer in file:line."), "the charter text is shown");
  assert.ok(preview.includes("role-charter-view") && preview.includes("md-prose"), "charter rendered as formatted markdown");
  assert.ok(preview.includes("md-h1"), "the markdown # heading is formatted (md-h1), not left as raw text");
  assert.ok(!preview.includes("<textarea"), "no raw textarea in the default (preview) view");
  assert.ok(!preview.includes("role-swatch-row"), "colour picker hidden until editing");
  assert.ok(preview.includes("role-save"), "an edit button with the save grant");

  // Editing: treeState true → the raw textarea + colour swatches appear so the markdown can be edited.
  card.signals.treeState.set(true);
  const editView = flatten(mod.render(card));
  assert.ok(editView.includes("<textarea"), "editing → the raw charter textarea");
  assert.ok(editView.includes("Answer in file:line."), "the charter text rides into the textarea");
  assert.ok(editView.includes("role-swatch-row"), "the colour swatch row renders while editing");
  for (const c of ["yellow", "pink", "blue", "green", "orange", "purple"])
    assert.ok(editView.includes(`c-${c}`), `a swatch for ${c}`);
  assert.ok(editView.includes("c-purple selected"), "the current colour (purple) is marked selected");

  // Direct dispatch through the capability (the DOM-gathering click handlers aren't exercised headless, but
  // the capability is the contract): a save carries the {roleId,name,colour,charter} shape the host serialises.
  card.signals.roleSave({ roleId: "oracle", name: "Oracle", colour: "green", charter: "New charter." });
  assert.deepEqual(saved, { roleId: "oracle", name: "Oracle", colour: "green", charter: "New charter." });

  // No roleDoc yet (first file read in flight) → a loading state, never a throw.
  const loading = flatten(mod.render({ fields: { title: ".canvas/roles/oracle/role.md", text: "", color: "orange" }, signals: {} }));
  assert.ok(loading.includes("loading…"), "no doc yet → loading placeholder");

  // No roleSave grant (a read-only mount) → always the formatted view, no editing chrome, but the doc still
  // renders (never throw for a missing capability — the sticky card's degrade rule).
  const ro = flatten(mod.render({
    fields: { title: ".canvas/roles/oracle/role.md", text: "", color: "orange" },
    signals: { roleDoc: { roleId: "oracle", name: "Oracle", colour: "purple", charter: "# x" } },
  }));
  assert.ok(ro.includes("role-charter-view") && ro.includes("md-h1"), "read-only mount still renders formatted markdown");
  assert.ok(!ro.includes("<textarea"), "no editable textarea without the save grant");
  assert.ok(ro.includes("Oracle") && ro.includes("role-name"), "still shows the role read-only");
  assert.ok(!ro.includes("role-swatch-row"), "no colour picker without the save grant");
  assert.ok(!ro.includes("role-save"), "no edit/save button without the grant");
});
