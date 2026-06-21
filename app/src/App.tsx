import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Editor,
  InteractionManager,
  Persistence,
  UndoManager,
  bindDom,
  vec,
  type InputEvent,
} from "./lib";
import { IdbEventStore, IdbSnapshotStore } from "./idb";
import { restoreAndPersistCamera } from "./session";
import { connectAgentBus } from "./agentBus";
import { CanvasView } from "./CanvasView";
import { useSignal } from "./reactive";
import { templatesSignal } from "./templates";
import {
  addClock,
  addComputedCard,
  addGitHeadCard,
  addHnCard,
  addFolderCard,
  addProvenanceCard,
  addSessionsCard,
  addStickyNote,
  addUsageCard,
  addWeatherCard,
  clearBoard,
  exportBoard,
  importBoard,
  interruptSelectedSession,
  materializeAt,
  openSession,
  reprojectContent,
  spawnLiveSession,
  watchDataset,
  type Pos,
  type WatchEvent,
} from "./loader";
import { baseName } from "./fileTypes";
import { applyScrollKey, scrollableIn } from "./interior";

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]);

// The app. The engine is the UNCHANGED core + interaction, now DURABLY BACKED: its log is core's
// Persistence (IndexedDB backends in idb.ts) instead of the in-memory default, so the board you arrange
// survives a reload. Spatial state (positions, selection, which cards) is the canvas's and persists;
// file/session CONTENT is a projection re-derived from disk on boot and kept live by the watch stream.
// That split is the whole experiment.
//
// The board is populated from the right-click add menu — new/old Claude Code sessions, a repo file tree,
// and the demo widgets, each added and removed per canvas — and from durable storage on a return visit.

interface Engine {
  m: InteractionManager;
  undo: UndoManager;
  persistence: Persistence;
}

// Build the engine, hydrating from durable storage first (mirrors app/'s persistence order):
//   1. editor whose LOG is the durable Persistence (every commit is an authoritative event write);
//   2. hydrate the store from the snapshot cache + replayed log tail (event-sourced — see persist.ts);
//   3. a fresh board stays EMPTY (you populate it from the Add menu); a returning one keeps its cards;
//   4. build the manager AFTER the store is populated, so its spatial index seeds from real records;
//   5. restore the camera pose, attach the snapshot half (debounced channel-2 saves), write a baseline;
//   6. wire undo last, so the hydrated board isn't undoable.
async function createEngine(): Promise<Engine> {
  const persistence = new Persistence({
    events: new IdbEventStore(),
    snapshots: new IdbSnapshotStore(),
    onError: (e) => console.error("[persistence]", e),
  });
  const editor = new Editor({ log: persistence });
  await persistence.hydrate(editor.store);
  // A card type may pin its resize ratio (type.yaml `aspect`): the round clock stays square however you
  // drag a corner. The engine is card-type-blind, so resolve nodeId → type → template.aspect here and
  // hand the rule down — null for every type that doesn't ask, i.e. free resize as before.
  const m = new InteractionManager({
    editor,
    aspectLock: (nodeId) => {
      const node = editor.store.get<"node">(nodeId);
      return (node && templatesSignal.get().get(node.type)?.aspect) ?? null;
    },
  });
  restoreAndPersistCamera(m.camera);
  persistence.attach(editor.store);
  await persistence.flush();
  const undo = new UndoManager(editor.store);
  return { m, undo, persistence };
}

// The async shell: it owns engine construction (hydration is async) and renders the board once ready.
// A ref guards against React StrictMode's dev-only double-invoke kicking off two engines.
export function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void createEngine().then(setEngine);
  }, []);
  if (!engine) return <div className="app loading" />;
  return <Board {...engine} />;
}

function Board({ m, undo, persistence }: Engine) {
  const [lastEvent, setLastEvent] = useState<WatchEvent | null>(null);
  // The right-click add-menu: `screen` positions the popover (viewport px), `at` is the page-space drop
  // point so a chosen widget lands under the cursor. Null = closed.
  const [menu, setMenu] = useState<{ screen: Pos; at: Pos } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // Reactive node count — drives the empty-board hint (the only visible "how do I add things?" cue now
  // that the header is gone).
  const nodeQuery = useMemo(() => m.editor.store.query({ typeName: "node" }), [m]);
  const nodes = useSignal(nodeQuery);

  // One repo-wide watch for the component's life — it only touches cards already on the board (loader
  // gates it), so it's safe to run before any folder is added and to leave running across adds/removes.
  useEffect(() => watchDataset(m, "repo", setLastEvent), [m]);

  // Refresh hydrated file/session content from disk once on boot (and re-arm session live-tails).
  useEffect(() => {
    void reprojectContent(m);
  }, [m]);

  // Best-effort flush of the snapshot cache on close. Events are already durable per-commit, so even if
  // this misses, the next boot replays the log tail — this just keeps that next load on the fast path.
  useEffect(() => {
    const onUnload = () => void persistence.flush();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [persistence]);

  // The one DOM-coupled wire (same as app/): normalize native events into the interaction layer and keep
  // the manager's viewport size current so edge auto-scroll knows where the edges are.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.focus();
    const off = bindDom(el, (e: InputEvent) => m.dispatch(e));
    const sync = () => m.setViewport(el.clientWidth, el.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      off();
      ro.disconnect();
    };
  }, [m]);

  // Bracket the manager's channel-2 subscriptions (spatial index) with the component lifecycle.
  useEffect(() => {
    m.start();
    return () => m.stop();
  }, [m]);

  // The agent bus: inbound commands (POST /api/command → SSE → editor.commit) and the debounced
  // outbound snapshot push that makes GET /api/canvas the agent's read side.
  useEffect(() => connectAgentBus(m), [m]);

  // Delete the selected cards (actor "user", so it's undoable). Edges touching a removed node go first,
  // so no wire ever dangles — the same edges-before-nodes order clearBoard uses.
  const deleteSelected = useCallback(() => {
    const ids = m.selection.ids();
    if (ids.length === 0) return;
    const sel = new Set<string>(ids);
    for (const r of m.editor.store.getSnapshot().records) {
      if (r.typeName === "edge" && (sel.has(r.from) || sel.has(r.to)))
        m.editor.commit({ type: "removeEdge", actor: "user", payload: { id: r.id } });
    }
    for (const id of ids) m.editor.commit({ type: "removeNode", actor: "user", payload: { id } });
    m.selection.clear();
  }, [m]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? undo.redo() : undo.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (m.selection.ids().length) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === "Escape") {
        // Interrupt the live Claude session in the selected session card — the keyboard half of the
        // session duplex's "stop". A no-op unless a single session card is selected (and the field isn't
        // focused — the input's keydown stops propagation, so typing's own Escape never reaches here).
        interruptSelectedSession(m);
      } else if (SCROLL_KEYS.has(e.key)) {
        // Arrow / page / home / end scroll the single selected card's interior (the keyboard half of
        // the interior-interaction seam — the wheel half lives on the card host). Falls through
        // silently when nothing scrollable is selected, so these keys stay free for other uses.
        const ids = m.selection.ids();
        if (ids.length === 1) {
          const host = document.querySelector(`[data-node-id="${CSS.escape(ids[0]!)}"]`);
          const sc = host && scrollableIn(host);
          if (sc && applyScrollKey(sc, e.key)) e.preventDefault();
        }
      } else if (e.key === "v" || e.key === "V") m.setTool("select");
      else if (e.key === "h" || e.key === "H") m.setTool("hand");
    },
    [m, undo, deleteSelected],
  );

  // Drag-out from a browser card: a row dragged out of a directory card (a file/sub-folder,
  // file-trees-on-canvas.md §9) or a sessions card (a historical session, Phase C) and dropped on the
  // canvas is promoted to an authored node AT the drop point. Each template sets its own mime on
  // dragstart — FS_MIME {path, kind} → materializeAt (a file/directory card); SESSION_MIME {id} →
  // openSession (a session card). The host converts the drop's screen point to page space (the same
  // rect-offset → camera.screenToPage path input.ts uses) and commits the node THERE. dragover must
  // preventDefault for the drop to fire, and only for our own mimes so a stray file/text drag is ignored.
  const FS_MIME = "application/x-canvas-fsnode";
  const SESSION_MIME = "application/x-canvas-session";
  const onDragOver = useCallback((e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if (t.includes(FS_MIME) || t.includes(SESSION_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const toPage = () => m.camera.screenToPage(vec(e.clientX - rect.left, e.clientY - rect.top));

      const fsRaw = e.dataTransfer.getData(FS_MIME);
      if (fsRaw) {
        e.preventDefault();
        let payload: { path: string; kind: "file" | "dir" };
        try {
          payload = JSON.parse(fsRaw);
        } catch {
          return;
        }
        if (!payload.path) return;
        const p = toPage();
        materializeAt(m, "repo", payload.path, payload.kind, Math.round(p.x), Math.round(p.y));
        return;
      }

      const sesRaw = e.dataTransfer.getData(SESSION_MIME);
      if (sesRaw) {
        e.preventDefault();
        let payload: { id: string };
        try {
          payload = JSON.parse(sesRaw);
        } catch {
          return;
        }
        if (!payload.id) return;
        const p = toPage();
        void openSession(m, payload.id, { x: Math.round(p.x), y: Math.round(p.y) });
      }
    },
    [m],
  );

  // Right-click (or ⌃-click / two-finger tap) on empty canvas opens the add menu AT the cursor, and the
  // chosen widget is placed there — the cursor is the placement, replacing the old header toolbar. A
  // right-click landing on a card is left alone (closest [data-node-id]) so cards keep their own context.
  // The popover is clamped so it never spills off the right/bottom edge.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-node-id]")) return;
      const el = canvasRef.current;
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = m.camera.screenToPage(vec(e.clientX - r.left, e.clientY - r.top));
      const screen = {
        x: Math.min(e.clientX, window.innerWidth - 232),
        y: Math.min(e.clientY, window.innerHeight - 372),
      };
      setMenu({ screen, at: { x: Math.round(at.x), y: Math.round(at.y) } });
    },
    [m],
  );

  const tool = useSignal(m.toolSignal);

  return (
    <div className="app">
      <div
        ref={canvasRef}
        className={`canvas tool-${tool}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={() => canvasRef.current?.focus()}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onContextMenu={onContextMenu}
      >
        <CanvasView m={m} />
      </div>

      {/* The only standing chrome: a faint cue on an empty board, since right-click is otherwise invisible. */}
      {nodes.length === 0 && (
        <div className="empty-hint">right-click anywhere to add a widget</div>
      )}

      {/* The live fs-watch indicator — an ephemeral corner chip (it only renders while an event is fresh). */}
      {lastEvent && (
        <div className="event-chip">
          ← {lastEvent.type} <b>{baseName(lastEvent.path)}</b>
        </div>
      )}

      {menu && (
        <CanvasMenu
          m={m}
          screen={menu.screen}
          at={menu.at}
          onImport={() => importRef.current?.click()}
          onClose={() => setMenu(null)}
        />
      )}

      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importBoard(m, f);
          e.target.value = ""; // reset so re-picking the same file fires onChange again
        }}
      />
    </div>
  );
}

// The right-click add menu — the single affordance for putting things on the board, replacing the
// header toolbar. Every item is placed at `at` (the click's page-space point) and drops ONE card; the
// browser cards (File tree, Sessions) then let you drill in and drag the specific file/session out (the
// Phase B/C move — no more in-menu choosers). Board admin (Export/Import/Clear) lives at the bottom, out
// of the way but reachable. Closes on a click outside or Escape, mirroring the old Menu popover.
function CanvasMenu({
  m,
  screen,
  at,
  onImport,
  onClose,
}: {
  m: InteractionManager;
  screen: Pos;
  at: Pos;
  onImport: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  // Run an add, then dismiss. The widgets take `at` so they land under the cursor; admin actions ignore it.
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  return (
    <div className="canvas-menu" ref={ref} style={{ left: screen.x, top: screen.y }}>
      <div className="menu-list">
        <div className="menu-section">Session</div>
        <button onClick={() => run(() => void spawnLiveSession(m, at))}>New session</button>
        <button onClick={() => run(() => addSessionsCard(m, at))}>Sessions</button>
        <div className="menu-section">Files</div>
        <button onClick={() => run(() => addFolderCard(m, "", at))}>File tree</button>
        <div className="menu-section">Notes &amp; widgets</div>
        <button onClick={() => run(() => addStickyNote(m, at))}>Sticky note</button>
        <button onClick={() => run(() => addClock(m, at))}>Clock</button>
        <button onClick={() => run(() => addGitHeadCard(m, at))}>Git HEAD</button>
        <button onClick={() => run(() => addHnCard(m, at))}>Hacker News</button>
        <button onClick={() => run(() => addUsageCard(m, at))}>Usage</button>
        <button onClick={() => run(() => addWeatherCard(m, at))}>Weather</button>
        <button onClick={() => run(() => addComputedCard(m, at))}>Computed</button>
        <button onClick={() => run(() => addProvenanceCard(m, at))}>Intent log</button>
        <div className="menu-divider" />
        <div className="menu-section">Board</div>
        <button onClick={() => run(() => exportBoard(m))}>Export…</button>
        <button onClick={() => { onImport(); onClose(); }}>Import…</button>
        <button onClick={() => run(() => clearBoard(m))}>Clear board</button>
      </div>
    </div>
  );
}
