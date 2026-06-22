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

async function loadTemplate(type) {
  const src = fs.readFileSync(new URL(`card-types/${type}/render.js`, root), "utf8");
  const rewritten = src
    .replaceAll('"/vendor/lit-html.js"', `"${litUrl}"`)
    .replaceAll('"/vendor/markdown.js"', `"${mdUrl}"`);
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
      dirListing: (p) => tree[p],
      treeState: { get: () => open, set: (v) => { open = v; } },
    },
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

  // Expand the sub-folder (treeState carries the open path) → its children drill IN, in place, rather
  // than spawning a separate card. This is the §B in-card tree behaviour.
  open = new Set(["interaction/src/tools"]);
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
    signals: { sessionList: sessions, sessionRefresh: () => refreshed++ },
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

// Reassemble a TemplateResult (and nested results/arrays in its values) into a flat string.
function flatten(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (value.strings && value.values)
    return value.strings.reduce((acc, s, i) => acc + (i ? flatten(value.values[i - 1]) : "") + s, "");
  return String(value);
}
