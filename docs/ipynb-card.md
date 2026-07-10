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
- Size is **notebook-aware** at the server (`app/ipynb-codec.js`, wired into `/api/file` via
  `routes/files.ts`), because a notebook with base64 image outputs is easily megabytes and the generic
  128 KiB file-preview cap would head-clip it into invalid JSON (a blank "too large" card, and an
  unreadable agent read). `/api/file` reads a `.ipynb` against a generous `MAX_NOTEBOOK_BYTES` ceiling
  (server-http.ts) and serves two shapes of the same file, one memory bound honored (CLAUDE.md size-cap
  rule — the codec then elides at the STRUCTURE level, never a second byte cap):
  - **RENDER** (`?notebook=render`, what the card requests via `content.ts`/`loader.ts`): keep every
    image; only if the serialized notebook exceeds a generous render budget are WHOLE outputs dropped
    (largest first, never a byte-clip), so the JSON stays valid and the card never blanks. A drop is
    flagged in `metadata.__foolscap` and `render.js` shows a small "outputs elided" banner.
  - **AGENT** (the default, a bare `/api/file`): elide each base64 raster-image payload to a
    `<image/png output elided: N bytes>` marker and clamp oversized text/stream/traceback outputs to a
    head + marker, keeping cell **source** intact and the JSON valid + parseable. `trimmed` is flagged in
    the response envelope.
- The card still keeps its own parse guard: beyond even the notebook ceiling `/api/file` falls back to
  head-truncation (the `\n…` sentinel → "too large"), and a genuinely malformed file is served verbatim
  → "couldn't parse". The card never guesses truncation from a parse failure.
- **Out of scope (noted, not precluded):** a Claude Code session that Reads the `.ipynb` straight off disk
  bypasses the server, so it still sees raw base64 — an explicit agent tool-call to view image outputs is
  a possible future direction, deliberately left open by the codec's structure.

## Two deliberate limits

- **HTML outputs are rendered RAW and UNSANITISED.** We build a real DOM node and embed it (the same
  live-node embedding the reactive notebook card uses for its output views), so DataFrames, styled tables,
  and HTML-emitting plots render faithfully. This is a **trusted-notebook assumption**: it is appropriate
  for notebooks you already trust on disk, and is *not* safe for untrusted input. The assumption is noted
  in `render.js`; sanitise there if it ever stops holding.
- **No execution / REPL.** There is no kernel, no cell-run, no editing — the card only displays what is
  already in the file's saved outputs. A REPL-style interaction mode is an interesting future direction
  (the human raised it) but is out of scope here, parked as a future thread.
