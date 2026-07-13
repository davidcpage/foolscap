# The Jupyter (`.ipynb`) card

A small card-type (`app/card-types/ipynb/`) for **exploring and running** a repo's Jupyter notebooks on the
canvas — the use case that motivated it is browsing `.ipynb` files ahead of a possible translation to our
reactive [Notebook 2.0 format](notebook-card.md). It began read-only; a per-cell **Run** now drives a
server-side Jupyter kernel (Path B — the kernel broker + write-back; the executable design lives in
[`notebook-card.md`](notebook-card.md) §2 Path B). It is deliberately minimal — a file-backed view that can
execute cells, **not** a second reactive notebook engine (the two substrates stay separate by design).

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

## Interactive execution (Path B — server-driven kernel)

The card is no longer view-only: it runs a **real per-repo Python kernel server-side** and persists the
results back into the `.ipynb`, so the file stays the durable, agent-legible, shadow-git-versioned record
and the card is a live view over it. This is Path B from [notebook-card.md](notebook-card.md) §2 — a
server-owned kernel, the counterpart to the session model — chosen over a browser↔kernel bridge so the
**gateway token never leaves the server** (the browser only ever talks same-origin to the dev-server plugin).

**The pieces:**

- **Sidecar** (`app/jupyter-host.js`, the cousin of `session-host.js`): launches a detached
  `jupyter kernelgateway` on `127.0.0.1` with a random token, records it in a tmpdir **rendezvous**
  (`canvas-jupyter-host-<appDirKey>.json`, keyed off the app checkout like the session-host socket — never
  in the watched tree). Start-on-demand + probe + reclaim-stale; the gateway **survives a dev-server
  restart** (detached + rendezvous), though the kernel itself need not (a dead kernel is just re-started).
  Stop it with `npm run jupyter-host:stop`.
- **Broker** (`routes/kernel.ts` → `server-kernel.ts`, in the fs-plugin): a **kernel-per-notebook** keyed by
  `(board, node)` in `fsState.liveKernels`. It holds the upstream Jupyter WS, maps IOPub replies
  (`stream` / `execute_result` / `display_data` / `error` + `execution_count`) into nbformat outputs
  correlated by `parent_header.msg_id → cellId`, and drives it via REST: `POST /api/kernel/<nodeId>/{run,
  run-all,interrupt,restart,shutdown}`.
- **Write-back:** on each cell completion the broker read-modify-**merges** outputs into the `.ipynb` **by
  nbformat cell id** (never index) under an optimistic-concurrency **CAS** (`baseVersion` content hash,
  retry-on-conflict) so a concurrent edit can't be clobbered. It serializes through the codec's
  **full-fidelity** projection (`transformNotebook(text, { mode: "full" })` — no elision, strips the
  render-only `metadata.__foolscap`), never the lossy render/agent views. Notebooks predating nbformat 4.5
  cell ids are **normalized** once (ids assigned + persisted) so the id-keyed merge is stable.
- **Card affordances** (`card-types/ipynb/type.yaml` + `render.js`): a toolbar (Run all / Interrupt /
  Restart + a kernel-state dot) and a per-cell **Run** button, plus a **live status** feed
  `kernel:<nodeId>:<boardId>` (mirror `session:<id>`, board-scoped since a node id isn't unique across
  boards). The card reads status from the feed; the **durable outputs arrive via the file watch**
  re-rendering `fileContent` — the feed is only the live channel.

### Setup — this feature requires a repo Python env

The kernel runs in the repo's Python environment. The sidecar auto-detects it in order:
**repo `.venv` → conda (`$CONDA_PREFIX`) → poetry → system `jupyter` on PATH**. For a fresh checkout,
create the `.venv` (gitignored, disposable) and install Jupyter into it:

```sh
uv venv                                              # or: python3 -m venv .venv
uv pip install jupyter_kernel_gateway ipykernel      # or: .venv/bin/pip install …
```

If no env is found, `run`/`run-all` fail with an actionable error naming that command. (Python 3.14 works —
`jupyter_kernel_gateway` + `ipykernel` ship wheels; `uv venv` may select a slightly older CPython, which is
fine.)

## Two deliberate limits

- **HTML outputs are rendered RAW and UNSANITISED.** We build a real DOM node and embed it (the same
  live-node embedding the reactive notebook card uses for its output views), so DataFrames, styled tables,
  and HTML-emitting plots render faithfully. This is a **trusted-notebook assumption**: it is appropriate
  for notebooks you already trust on disk, and is *not* safe for untrusted input. The same assumption
  extends to executing a notebook you trust — the kernel runs with full machine access, like the
  `claude -p` sessions already on the board (local-trusted, kernel on `127.0.0.1`, token server-side).
- **The card SOURCE stays read-only (P1).** You can run cells and outputs persist, but editing cell source
  and adding/deleting/moving cells is **out of scope for P1** (parked as P2/P3), as are annotations. The
  card runs what is on disk; edit the `.ipynb` in your editor (or via an agent) and the watch re-renders.
