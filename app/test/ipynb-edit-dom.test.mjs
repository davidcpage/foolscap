// ipynb edit-draft survival across a watch re-render (P2 requirement 5), proven END-TO-END against a real
// DOM: the card re-renders `fileContent` on every file-watch event (a kernel write-back, an external edit),
// and an IN-PROGRESS edit draft must survive that re-render with its value + caret intact. We mount the real
// ipynb template with lit-html into jsdom, type into a cell's editor (a dispatched input event), then
// re-render the SAME card with CHANGED file content (simulating a kernel output write-back AND an external
// source change) and assert: the SAME textarea node persists (focus/caret preserved) holding the DRAFT, not
// the disk source, while the rest of the card refreshes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.DocumentFragment = dom.window.DocumentFragment;

const root = new URL("../", import.meta.url);
const litUrl = new URL("vendor/lit-html.js", root).href;
const hljsUrl = new URL("vendor/highlight.js", root).href;
const toVendorData = (src) =>
  "data:text/javascript," +
  encodeURIComponent(src.replaceAll('"/vendor/lit-html.js"', `"${litUrl}"`).replaceAll('"/vendor/highlight.js"', `"${hljsUrl}"`));
const mdUrl = toVendorData(fs.readFileSync(new URL("vendor/markdown.js", root), "utf8"));
const hlLitUrl = toVendorData(fs.readFileSync(new URL("vendor/highlight-lit.js", root), "utf8"));

const { render } = await import(litUrl);
const ipynbSrc = fs
  .readFileSync(new URL("card-types/ipynb/render.js", root), "utf8")
  .replaceAll('"/vendor/lit-html.js"', `"${litUrl}"`)
  .replaceAll('"/vendor/markdown.js"', `"${mdUrl}"`)
  .replaceAll('"/vendor/highlight-lit.js"', `"${hlLitUrl}"`);
const mod = (await import("data:text/javascript," + encodeURIComponent(ipynbSrc))).default;

function nb(bbbSource, cccOutputs) {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: "python" } },
    cells: [
      { id: "aaa", cell_type: "markdown", source: ["# Notes"] },
      { id: "bbb", cell_type: "code", source: [bbbSource], outputs: [], execution_count: null },
      { id: "ccc", cell_type: "code", source: ["z = 1"], outputs: cccOutputs || [], execution_count: cccOutputs ? 5 : null },
    ],
  });
}

test("an in-progress edit draft survives a watch re-render (kernel write-back + external source change)", () => {
  const container = document.createElement("div");
  let editing = new Set(["bbb"]); // cell bbb is being edited
  const sent = [];
  const card = {
    fields: { title: "notebooks/t1.ipynb", text: "", color: "orange" }, // unique title → own draft slot
    signals: {
      fileContent: nb("print(1)"), // v1: bbb source on disk, no ccc output yet
      treeState: { get: () => editing, set: (v) => (editing = v) },
      notebookEdit: (op) => {
        sent.push(op);
        return Promise.resolve({ ok: true });
      },
    },
  };

  render(mod.render(card), container);
  const ta = container.querySelector('textarea.ipynb-edit[data-cell="bbb"]');
  assert.ok(ta, "the editing cell mounts a raw-source textarea");
  assert.equal(ta.value, "print(1)", "the editor opens seeded with the on-disk source");

  // The user types (dirties the textarea's live value) → the @input handler stashes it in the draft map.
  ta.value = "print('MY UNSAVED DRAFT')";
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  // A watch event fires: the kernel wrote an output onto cell ccc AND (worst case) bbb's on-disk source
  // changed underneath. The card re-renders `fileContent` — the crux moment for requirement 5.
  card.signals.fileContent = nb("print(1)  # CHANGED ON DISK", [{ output_type: "stream", name: "stdout", text: "ccc ran\n" }]);
  render(mod.render(card), container);

  const ta2 = container.querySelector('textarea.ipynb-edit[data-cell="bbb"]');
  assert.strictEqual(ta2, ta, "the SAME textarea node persists across the re-render (focus + caret preserved)");
  assert.equal(ta2.value, "print('MY UNSAVED DRAFT')", "the draft survives — NOT reset to the changed disk source");

  // Meanwhile the REST of the card refreshed from the new bytes: ccc's freshly-merged output is now shown.
  assert.match(container.textContent, /ccc ran/, "other cells refresh from the watch (ccc's new output appears)");

  // Committing writes the DRAFT (not the disk source) through notebookEdit, then leaves edit mode.
  ta2.dispatchEvent(new dom.window.Event("blur", { bubbles: true }));
  assert.deepEqual(sent.at(-1), { type: "editSource", cellId: "bbb", source: "print('MY UNSAVED DRAFT')" }, "commit persists the draft by cell id");
  assert.ok(!editing.has("bbb"), "committing leaves edit mode");
});

test("Escape cancels an edit without writing (the removal-blur is a guaranteed no-op)", () => {
  const container = document.createElement("div");
  let editing = new Set(["bbb"]);
  const sent = [];
  const card = {
    fields: { title: "notebooks/t2.ipynb", text: "", color: "orange" }, // unique title → own draft slot
    signals: {
      fileContent: nb("orig()"),
      treeState: { get: () => editing, set: (v) => (editing = v) },
      notebookEdit: (op) => {
        sent.push(op);
        return Promise.resolve({ ok: true });
      },
    },
  };
  render(mod.render(card), container);
  const ta = container.querySelector('textarea.ipynb-edit[data-cell="bbb"]');
  ta.value = "typed but abandoned";
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  // Esc → cancel: the draft is dropped BEFORE the re-render, so the removal-blur's commit sees no draft.
  const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  ta.dispatchEvent(esc);
  render(mod.render(card), container); // the cancel re-render (drops the textarea)
  ta.dispatchEvent(new dom.window.Event("blur", { bubbles: true })); // the removal-blur

  assert.equal(sent.length, 0, "Escape wrote nothing — the abandoned draft never reached disk");
  assert.ok(!editing.has("bbb"), "Escape left edit mode");
});
