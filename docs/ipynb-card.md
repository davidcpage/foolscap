# The read-only Jupyter (`.ipynb`) card

A small card-type (`app/card-types/ipynb/`) for **exploring** a repo's Jupyter notebooks on the canvas —
the use case that motivated it is browsing `.ipynb` files ahead of a possible translation to our reactive
[Notebook 2.0 format](notebook-card.md). It is deliberately minimal, not a second notebook engine.

## What it is

- A file-backed **view**, exactly like the [file card](file-trees-on-canvas.md): the source is the `.ipynb`
  on disk, read off-log through the `fileContent` capability (`content.ts`), never `node.text`. A `.ipynb`
  auto-opens as this card via a dispatch branch in `loader.ts materializeAt` (the extension is the format —
  no content sniff, unlike the `.html` reactive-notebook path).
- `render.js` `JSON.parse`s the notebook and renders each cell: **markdown** through the shared
  `/vendor/markdown.js` prose codec, **code** through the shared `/vendor/highlight-lit.js` highlighter
  (with an `In [n]:` prompt), and **outputs** by `output_type` — `stream` and `text/plain` as `<pre>`,
  `image/png`/`image/jpeg` as an inline base64 `<img>`, `text/html` (and `image/svg+xml`) rendered raw,
  and `error` as an ANSI-stripped `<pre>`.
- Truncation is honored, not re-capped: `fileContent` is byte-bounded upstream, so a clipped notebook is
  invalid JSON. The card catches the parse failure and shows a clear "too large" / "couldn't parse" notice
  (using the `\n…` sentinel to tell the two apart), per the CLAUDE.md size-cap rule — it never adds a
  second cap.

## Two deliberate limits

- **HTML outputs are rendered RAW and UNSANITISED.** We build a real DOM node and embed it (the same
  live-node embedding the reactive notebook card uses for its output views), so DataFrames, styled tables,
  and HTML-emitting plots render faithfully. This is a **trusted-notebook assumption**: it is appropriate
  for notebooks you already trust on disk, and is *not* safe for untrusted input. The assumption is noted
  in `render.js`; sanitise there if it ever stops holding.
- **No execution / REPL.** There is no kernel, no cell-run, no editing — the card only displays what is
  already in the file's saved outputs. A REPL-style interaction mode is an interesting future direction
  (the human raised it) but is out of scope here, parked as a future thread.
