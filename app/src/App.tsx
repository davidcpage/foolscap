import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Editor,
  InteractionManager,
  Persistence,
  UndoManager,
  bindDom,
  layoutId,
  vec,
  type Id,
  type InputEvent,
  type LayoutRecord,
} from "./lib";
import { IdbEventStore, IdbSnapshotStore, boardDbName, migrateLegacyBoard } from "./idb";
import { RemoteEventStore, RemoteSnapshotStore, fetchBoardPersist, importBoardPersist } from "./remote-store";
import { activeBoard, activeBoardId, boardHref, listBoards, resolveBoard, type BoardListing } from "./board";
import { ViewStore } from "./views";
import { restoreAndPersistCamera } from "./session";
import { onFeedsReconnect } from "./feeds";
import { refreshSessionList, rootsSignal, sessionListSignal } from "./content";
import { connectAgentBus } from "./agentBus";
import { connectToThread, createThread, isThreadNode, isSessionNode, MEMBER_OPEN } from "./threads";
import { CanvasView } from "./CanvasView";
import { useSignal } from "./reactive";
import { templatesSignal } from "./templates";
import {
  addClock,
  addComputedCard,
  addGitHeadCard,
  addHnCard,
  addFileTreeCard,
  addMinimapCard,
  addNotebookCard,
  addTextFileCard,
  defaultDocPath,
  addProvenanceCard,
  addSessionsCard,
  addChannelsCard,
  addStickyNote,
  addUsageCard,
  addWeatherCard,
  clearBoard,
  exportBoard,
  importBoard,
  interruptSelectedSession,
  materializeAt,
  materializeImageAt,
  openSession,
  openChannel,
  openRole,
  registerFileCommands,
  reprojectContent,
  spawnLiveSession,
  fetchRoles,
  addRolesCard,
  watchDataset,
  type Pos,
  type Role,
  type WatchEvent,
} from "./loader";
import { baseName } from "./fileTypes";
import { DEFAULT_HUD, resolveHudPosition } from "../hud-layout.js";
import { applyScrollKey, noteCameraMoved, notePointerAim, observeWheelGesture, scrollableIn } from "./interior";
import { bindPeek } from "./peek";
import { preserveViewState } from "./viewstate";

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]);

// Floating (screen-anchored) cards are chrome, not world content, so zoom-to-fit ignores them — without
// this a pinned minimap in the corner would warp "fit all" toward itself.
const isFloating = (l: LayoutRecord): boolean => l.anchor === "screen";

// The app. The engine is the UNCHANGED core + interaction, now DURABLY BACKED: its log is core's
// Persistence (server backends in remote-store.ts — the repo's own `.canvas/board/`) instead of the
// in-memory default, so the board you arrange survives a reload, in any browser. Spatial state (positions, selection, which cards) is the canvas's and persists;
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
async function createEngine(boardId: string, isDefault: boolean): Promise<Engine> {
  // The durable tier is the SERVER now (step 4: `<repo>/.canvas/board/` via remote-store.ts), so the
  // board travels with the repo and hydrates the same in any browser. IndexedDB is read exactly once
  // more per board — the adoption below — and left intact as a fallback, never written again.
  let boot = await fetchBoardPersist(boardId);
  if (boot.events.length === 0 && !boot.snapshot) {
    // Nothing server-side yet: adopt this browser's pre-step-4 state for the board, if any. The old
    // migration chain still applies first (legacy global DB → per-board DB, DEFAULT board only), so a
    // board last touched before per-board DBs existed adopts through both hops. The server refuses the
    // import once ANY state exists (another tab may have won the race) — re-fetch and trust it.
    const dbName = boardDbName(boardId);
    if (isDefault) await migrateLegacyBoard(dbName);
    const [events, snapshot] = await Promise.all([
      new IdbEventStore(dbName).loadAll(),
      new IdbSnapshotStore(dbName).load(),
    ]);
    if (events.length > 0 || snapshot) {
      await importBoardPersist(boardId, events, snapshot);
      boot = await fetchBoardPersist(boardId);
    }
  }
  const persistence = new Persistence({
    events: new RemoteEventStore(boardId, boot.events),
    snapshots: new RemoteSnapshotStore(boardId, boot.snapshot),
    onError: (e) => console.error("[persistence]", e),
  });
  const editor = new Editor({ log: persistence });
  registerFileCommands(editor); // the file-tree card's rename/move re-key (loader.renameFileNodes)
  await persistence.hydrate(editor.store);
  // A card type may pin its resize ratio (type.yaml `aspect`): the round clock stays square however you
  // drag a corner. The engine is card-type-blind, so resolve nodeId → type → template.aspect here and
  // hand the rule down — null for every type that doesn't ask, i.e. free resize as before. `aspect: auto`
  // (the image card) is content-driven rather than a fixed number: lock to the node's CURRENT w/h, which
  // was set to the image's own aspect at drop — so a corner drag scales the image and never reopens a gap.
  const m = new InteractionManager({
    editor,
    aspectLock: (nodeId) => {
      const node = editor.store.get<"node">(nodeId);
      if (!node) return null;
      const tpl = templatesSignal.get().get(node.type);
      if (tpl?.aspectAuto) {
        const layout = editor.store.get<"layout">(layoutId(nodeId as Id<"node">));
        return layout && layout.h > 0 ? layout.w / layout.h : null;
      }
      return tpl?.aspect ?? null;
    },
    // Alt-drag wiring (thread membership): the engine carries the gesture, the app owns the meaning. A
    // session card or a thread card can start/receive a wire; a drop between a session and a thread JOINS
    // that session (member:open) — the human drawing it is the consent for their own agent (§8).
    connectable: (nodeId) => isSessionNode(editor, nodeId) || isThreadNode(editor, nodeId),
    connect: (from, to) => connectToThread(editor, from, to),
    // Directed-edge selection rule (replaces the old move-with-thread reactor): selecting a THREAD card
    // also selects its OPEN member session cards, so the whole cluster group-drags as one ordinary
    // selection. `member:open` edges run session→thread, so a thread's members are the edge SOURCES whose
    // target is this node. ONE-WAY: only threads expand — a session returns nothing, so selecting a member
    // never pulls in its thread. Closed members have no canvas edge (display-only close removed it), so
    // they're naturally excluded here and instead follow via the relative-offset reopen (P2).
    expandSelection: (nodeId) => {
      if (!isThreadNode(editor, nodeId)) return [];
      const members: string[] = [];
      for (const r of editor.store.getSnapshot().records) {
        if (r.typeName === "edge" && r.type === MEMBER_OPEN && r.to === nodeId) members.push(r.from);
      }
      return members;
    },
  });
  restoreAndPersistCamera(m.camera, boardId);
  seedHud(m); // the HUD chrome (usage + sessions + clock + threads) isn't menu-spawnable, so ensure it exists on every board
  persistence.attach(editor.store);
  await persistence.flush();
  const undo = new UndoManager(editor.store);
  return { m, undo, persistence };
}

// How long Alt must be held before it means "edit the HUD" rather than "tap to toggle visibility". Short
// enough that a deliberate hold engages promptly, long enough that a quick show/hide tap never trips it.
const HUD_HOLD_MS = 250;

// Readable menu labels for the HUD singletons, keyed by the seed spec's card `type` (hud-layout.js). Used by
// the right-click menu's HUD section; the ids + set come from DEFAULT_HUD so this stays a pure display map.
const HUD_LABELS: Record<string, string> = {
  usage: "Usage",
  sessions: "Sessions",
  clock: "Clock",
  channels: "Threads",
  minimap: "Minimap",
  directory: "File Tree",
};

// The seeders for the HUD chrome cards, keyed by the default-layout spec's `type`. Each mints its stable
// singleton node (idempotent — a re-add on an existing id is skipped by the guard in seedHud).
const HUD_SEEDERS: Record<string, (m: InteractionManager) => void> = {
  usage: addUsageCard,
  sessions: addSessionsCard,
  clock: addClock,
  channels: addChannelsCard,
  minimap: addMinimapCard,
  directory: addFileTreeCard,
};

// Seat one HUD card at its default screen position/size — but ONLY when it isn't already an authoritative
// screen card. This is the P2 carry-over the P1 worker flagged: once drag/resize can move a HUD card, seedHud
// must SEED and MIGRATE, never OVERWRITE a user-set position (or the card snaps back to default on every
// reload — a move that doesn't stick). So:
//   • `fresh` (we just minted the node this load) → place it at the spec default (the seeder drops it at a
//     generic fallback spot + its own w/h; this normalizes it to the HUD slot).
//   • a LEGACY non-screen card (anchor !== "screen": a pre-unification world card) → migrate it into the
//     unified model at its default slot.
//   • a card ALREADY anchored to the screen → AUTHORITATIVE: its stored x/y/w/h is either the default we
//     seeded or a spot the user dragged/resized it to. Leave it exactly as-is — this is what makes a moved
//     HUD card persist across reload. (The one-time pre-unification migration of stale screen positions was
//     P1's job and is already done on any board that has loaded the P1 build.)
// Compare-then-commit within the seed/migrate branch so a board that already matches the default re-logs
// nothing (idempotent across reload + StrictMode).
function seatHudCard(
  m: InteractionManager,
  id: Id<"node">,
  pos: { x: number; y: number; w: number; h: number },
  fresh: boolean,
  ref: { w: number; h: number },
): void {
  const l = m.editor.store.get<"layout">(layoutId(id)) as LayoutRecord | undefined;
  if (!l) return;
  if (!fresh && l.anchor === "screen") {
    // Authoritative screen card — never overwrite its (possibly user-moved) position. But BACKFILL the
    // reference screen size ONCE for a legacy card seeded before per-card scaling existed (records.ts
    // refW/refH): it makes the card render native on this screen and the reference then persists like the
    // position does. A card that already has a reference is left entirely alone.
    if (l.refW == null || l.refH == null) {
      m.editor.commit({ type: "setAnchor", actor: "system", payload: { id, anchor: "screen", refW: ref.w, refH: ref.h } });
    }
    return;
  }
  // A fresh card (or a legacy non-screen card being migrated in) captures the current viewport as its
  // reference, so it seeds at scale 1 on this screen and shrinks only on a smaller one.
  const refMissing = l.refW == null || l.refH == null;
  if (l.anchor !== "screen" || l.x !== pos.x || l.y !== pos.y || l.w !== pos.w || l.h !== pos.h || refMissing) {
    m.editor.commit({ type: "setAnchor", actor: "system", payload: { id, anchor: "screen", ...pos, refW: ref.w, refH: ref.h } });
  }
}

// Ensure the HUD chrome exists and sits at its default layout on this board. Usage + sessions + clock + the
// Threads indicator (channels) are HUD elements (hud.ts) — so a board that never had them (a fresh one, or one
// cleared) still gets the corner chrome. The card SET and its default positions/sizes come from the seed spec
// (hud-layout.js); seatHudCard seeds a fresh card and migrates a legacy one but leaves a user-moved screen
// card alone. Idempotent: stable singleton ids mean no duplicate nodes, and the seat re-logs nothing once the
// board matches.
function seedHud(m: InteractionManager): void {
  const store = m.editor.store;
  const { w: viewportW, h: viewportH } = seedViewport();
  const ref = { w: viewportW, h: viewportH };
  for (const card of DEFAULT_HUD) {
    const id = card.id as Id<"node">;
    const fresh = !store.get<"node">(id);
    if (fresh) HUD_SEEDERS[card.type]?.(m); // create the missing chrome card (stable id)
    seatHudCard(m, id, resolveHudPosition(card, viewportW), fresh, ref);
  }
}

// The live viewport size (w/h) used both to place the width-relative HUD cards and to capture each seeded
// card's reference screen size (hud-layout.js hudCardScale). SSR/degenerate fallback mirrors the old
// seed-time width default so a headless seed stays deterministic.
function seedViewport(): { w: number; h: number } {
  const hasWindow = typeof window !== "undefined";
  return {
    w: hasWindow && window.innerWidth ? window.innerWidth : 1440,
    h: hasWindow && window.innerHeight ? window.innerHeight : 900,
  };
}

// Ensure ONE HUD singleton exists — the right-click menu's "reveal the singleton" action. A HUD singleton
// is normally always present (seedHud runs on every board load), but a user can delete its card; this
// re-mints it at its default slot on demand, reusing the same seed/seat path as seedHud so it's identical to
// a fresh board's. A NO-OP when the card is already present (stable id + compare-then-commit seat), so it
// never duplicates — the true-singleton guarantee. Making it VISIBLE (revealing a hidden HUD group) is the
// caller's job (it flips hudMode); this only guarantees existence at the right place.
function ensureHudCard(m: InteractionManager, id: string): void {
  const spec = DEFAULT_HUD.find((c) => c.id === id);
  if (!spec) return;
  const fresh = !m.editor.store.get<"node">(id as Id<"node">);
  if (fresh) HUD_SEEDERS[spec.type]?.(m);
  const { w: viewportW, h: viewportH } = seedViewport();
  // fresh → place at default; an existing (possibly user-moved) card is left where it is — reveal never re-seats.
  seatHudCard(m, id as Id<"node">, resolveHudPosition(spec, viewportW), fresh, { w: viewportW, h: viewportH });
}

// The async shell: it owns engine construction (hydration is async) and renders the board once ready.
// A ref guards against React StrictMode's dev-only double-invoke kicking off two engines.
export function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void resolveBoard()
      .then((board) => createEngine(board.boardId, board.isDefault))
      .then(setEngine);
  }, []);
  if (!engine) return <div className="app loading" />;
  return <Board {...engine} />;
}

function Board({ m, undo, persistence }: Engine) {
  // The fs-watch corner chip. Each event carries a monotonic `seq` so the render can `key` off it
  // (restarting the fade animation on a repeat event) and a timer can re-arm cleanly. It self-dismisses
  // (see the timeout effect below) — the chip is a glance, not standing chrome.
  const [lastEvent, setLastEvent] = useState<(WatchEvent & { seq: number }) | null>(null);
  const eventSeq = useRef(0);
  const pushEvent = useCallback((e: WatchEvent) => {
    setLastEvent({ ...e, seq: ++eventSeq.current });
  }, []);
  // Auto-fade: clear the chip a few seconds after the latest event. A new event replaces `lastEvent`
  // (new `seq`), which re-runs this effect and resets the timer, so the chip rides a burst then vanishes.
  useEffect(() => {
    if (!lastEvent) return;
    const t = setTimeout(() => setLastEvent(null), 2600);
    return () => clearTimeout(t);
  }, [lastEvent]);
  // The right-click add-menu: `screen` positions the popover (viewport px), `at` is the page-space drop
  // point so a chosen widget lands under the cursor. Null = closed.
  const [menu, setMenu] = useState<{ screen: Pos; at: Pos } | null>(null);

  // The camera unwind stack (views.ts), created once. A brief toast confirms a keyboard move with no
  // on-screen target (e.g. "nothing to go back to"), so a flicker of feedback matters.
  const views = useMemo(() => new ViewStore(), []);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const toastSeq = useRef(0);
  // Alt/Option drives the HUD, split by gesture (seq 20/22 interaction model):
  //  • TAP (press + release ALONE, quickly) → toggle the whole HUD GROUP On ↔ Off: the minimap plus the
  //    corner-pinned usage/sessions/clock/channels cards (hud.ts) show/hide as one. A simple explicit
  //    persistent toggle, no auto-show/fade — visibility is just where you left it. A tap is only a tap if
  //    nothing else happened while Alt was down (another key → a combo like an alt-drag wire) and it was
  //    released before the hold threshold.
  //  • HOLD (Alt down past HUD_HOLD_MS) → HUD EDIT MODE: while held, HUD cards drag/resize with fine grid
  //    snap (NodeView) and `p` toggles a card in/out of the HUD (onKeyDown). Outside the hold the HUD is
  //    fully inert. Editing needs the cards visible, so entering edit force-shows a hidden HUD and restores
  //    it on release — keeping the TAP the sole PERSISTENT visibility control (a hold never leaves the HUD
  //    in a new visibility state on its own).
  const [hudMode, setHudMode] = useState<0 | 1>(0);
  const [hudEdit, setHudEdit] = useState(false);
  const hudModeRef = useRef<0 | 1>(0);
  hudModeRef.current = hudMode;
  useEffect(() => {
    let altDown = false; // Alt physically held right now
    let tap = false; // Alt down with nothing else since → still a tap candidate
    let entered = false; // this Alt press crossed the hold threshold → edit mode engaged
    let forcedShow = false; // edit mode force-showed a hidden HUD → hide it again on release
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    const enterEdit = () => {
      entered = true;
      tap = false; // a hold is not a tap — releasing must not toggle visibility
      setHudEdit(true);
      if (!hudModeRef.current) { forcedShow = true; setHudMode(1); } // reveal the cards to edit them
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        if (e.repeat || altDown) return; // auto-repeat while held is not a fresh press
        altDown = true;
        entered = false;
        tap = true;
        clearHold();
        holdTimer = setTimeout(() => { if (altDown) enterEdit(); }, HUD_HOLD_MS);
      } else if (e.code === "KeyZ") {
        // The peek key (z, peek.ts) is EXEMPT — the HUD can still be toggled mid-peek: holding z auto-repeats
        // keydown, and each repeat would otherwise cancel the tap. Match e.CODE not e.key: while Alt is held
        // the repeating z arrives as an Option-MODIFIED char (e.key "Ω" on macOS), so an e.key check misses it.
      } else {
        // Any other key while Alt is down → the Alt press is a CHORD, not a tap: releasing Alt must not then
        // toggle visibility. This includes `p` (the in/out-of-HUD action, handled in onKeyDown): using the
        // Alt+p chord to pin a card leaves the HUD visibility exactly as it was.
        tap = false;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      altDown = false;
      clearHold();
      if (entered) {
        setHudEdit(false); // hold released → leave edit mode
        if (forcedShow) { setHudMode(0); forcedShow = false; } // restore the pre-edit hidden state
      } else if (tap) {
        setHudMode((v) => (v ? 0 : 1)); // a clean quick tap → toggle visibility
      }
      entered = false;
      tap = false;
    };
    const cancel = () => {
      // A pointer press (e.g. alt-drag wiring, or dragging a HUD card in edit mode) ends TAP candidacy only —
      // it must NOT end an engaged edit hold (dragging a card is the whole point of edit mode).
      tap = false;
    };
    const onBlur = () => {
      // Losing focus can swallow the Alt keyup, so reset everything: end the hold, edit mode, and restore a
      // force-shown HUD, so a blur mid-hold can't strand the HUD in edit mode or a surprise visible state.
      altDown = false;
      tap = false;
      entered = false;
      clearHold();
      setHudEdit(false);
      if (forcedShow) { setHudMode(0); forcedShow = false; }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointerdown", cancel);
    window.addEventListener("blur", onBlur);
    return () => {
      clearHold();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const flash = useCallback((text: string) => setToast({ text, seq: ++toastSeq.current }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1400);
    return () => clearTimeout(t);
  }, [toast]);

  // Persistent "your turn" stack: one chip per session currently WAITING (idle, blocked on you), derived
  // straight from live status. A chip appears when a session stops for you and CLEARS ITSELF the moment
  // that session is resolved — prompted back to working, picked up by a peer, or ended. No fade, no manual
  // dismiss: the stack IS the set of sessions awaiting you, so it can't be missed or go stale. waiting-agent
  // (blue, blocked on a peer) is excluded — it makes no demand on you. Read-only over /api/sessions; no
  // canvas write, so no re-wake loop. Click a chip to fly to that session's card (jumpToSession, below).
  const sessions = useSignal(sessionListSignal);
  const waiting = useMemo(() => (sessions ?? []).filter((s) => s.status === "waiting"), [sessions]);
  // Record where we're looking before any programmatic jump, so a step-back (`) can unwind it.
  const navigate = useCallback(
    (fn: () => void) => {
      views.pushHistory(m.camera.state);
      fn();
    },
    [views, m],
  );

  // Pin a card to the viewport / drop it back onto the canvas (the `p` key). Converts the box through
  // the camera so the card doesn't visibly jump on the toggle: pinning maps page→screen and scales the
  // size by the zoom; unpinning does the inverse. setAnchor is one undoable layout edit.
  const togglePin = useCallback(
    (id: Id<"node">) => {
      const l = m.editor.store.get<"layout">(layoutId(id)) as LayoutRecord | undefined;
      if (!l) return;
      const z = m.camera.state.z;
      if (l.anchor === "screen") {
        const p = m.camera.screenToPage({ x: l.x, y: l.y });
        m.editor.commit({
          type: "setAnchor",
          actor: "user",
          payload: { id, anchor: "world", x: Math.round(p.x), y: Math.round(p.y), w: Math.round(l.w / z), h: Math.round(l.h / z) },
        });
      } else {
        const s = m.camera.pageToScreen({ x: l.x, y: l.y });
        // Capture the current viewport as this card's reference screen size (records.ts refW/refH), so it
        // joins the HUD at scale 1 — native, consistent with the other current-reference cards and with the
        // ordinary card it just was. It only shrinks later if the window gets smaller than now (hud-layout.js).
        const { w: refW, h: refH } = seedViewport();
        m.editor.commit({
          type: "setAnchor",
          actor: "user",
          payload: { id, anchor: "screen", x: Math.round(s.x), y: Math.round(s.y), w: Math.round(l.w * z), h: Math.round(l.h * z), refW, refH },
        });
        // Pinning is subsumed by the HUD now (pinned cards render in the HUD group and toggle with it). If the
        // HUD is hidden, a freshly-pinned card would vanish on commit — so reveal the HUD, mirroring the way
        // spawning a hidden singleton reveals it (onRevealHud). No-op when the HUD is already shown.
        setHudMode(1);
      }
    },
    [m],
  );

  const canvasRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // Where a drag-out gesture began (screen point + the card it left), captured on dragstart. Dropping
  // back ON that card, or within a small radius of the grab point, ABORTS the promotion instead of
  // spawning a card — the bail-out for an accidental grab. Null when no drag-out is in flight.
  const dragOriginRef = useRef<{ x: number; y: number; nodeId: string | null } | null>(null);

  // Reactive node count — drives the empty-board hint (the only visible "how do I add things?" cue now
  // that the header is gone).
  const nodeQuery = useMemo(() => m.editor.store.query({ typeName: "node" }), [m]);
  const nodes = useSignal(nodeQuery);

  // Click a waiting-stack chip → fly to that session's card. A session node's `title` IS its session id
  // (the card convention), so we resolve the chip's sid to its on-canvas node, select it, and frame it
  // (via navigate so ` steps back out of the jump). If the session has no card on the board, say so rather
  // than jumping nowhere.
  const jumpToSession = useCallback(
    (sid: string) => {
      const node = nodes.find((n) => n.type === "session" && n.title === sid);
      if (!node) {
        flash("that session isn't on the canvas");
        return;
      }
      m.selection.set([node.id as Id<"node">]);
      navigate(() => m.fitSelection(isFloating));
    },
    [nodes, m, navigate, flash],
  );

  // A file watch PER ROOT (the canonical checkout + each git worktree) for the component's life. Each
  // only touches cards already on the board (loader gates it), so it's safe to run before any folder is
  // added. The root set can GROW mid-session (a worktree created by an agent or the CLI), so the watches
  // are (re)synced whenever rootsSignal changes; "repo" is always watched, even before /api/roots returns.
  useEffect(() => {
    const watches = new Map<string, () => void>();
    const sync = (): void => {
      const ids = new Set((rootsSignal.get() ?? []).map((r) => r.id));
      ids.add("repo");
      for (const id of ids) if (!watches.has(id)) watches.set(id, watchDataset(m, id, pushEvent));
      for (const [id, off] of watches) if (!ids.has(id)) (off(), watches.delete(id));
    };
    sync();
    const off = rootsSignal.subscribe(sync);
    return () => {
      off();
      for (const o of watches.values()) o();
    };
  }, [m]);

  // Refresh hydrated file/session content from disk once on boot (and re-arm session live-tails). Also
  // re-run it whenever the feed stream RECONNECTS: a cold server restart drops the per-session file-tails
  // (armed only by GET /api/session) and empties the feed cache, so a session card left open would stay
  // stale until reload/resume. Re-projecting on reconnect re-arms those tails and re-pulls the list —
  // what a page reload does, without the reload.
  useEffect(() => {
    void reprojectContent(m);
    return onFeedsReconnect(() => {
      void reprojectContent(m);
      refreshSessionList();
    });
  }, [m]);

  // Best-effort flush of the snapshot cache on close. Events are already durable per-commit, so even if
  // this misses, the next boot replays the log tail — this just keeps that next load on the fast path.
  useEffect(() => {
    const onUnload = () => void persistence.flush();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [persistence]);

  // Carry ephemeral view state (interior scroll, focused field + its caret/in-progress text) across a
  // full reload — chiefly the dev-server restart that a vite-fs-plugin.ts edit triggers. The camera
  // already survives via session.ts; this covers the rest so an agent iterating on that file doesn't
  // reset your scroll-back and half-typed message every save.
  useEffect(() => preserveViewState(), []);

  // The one DOM-coupled wire (same as app/): normalize native events into the interaction layer and keep
  // the manager's viewport size current so edge auto-scroll knows where the edges are.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.focus();
    const off = bindDom(el, (e: InputEvent) => m.dispatch(e));
    // The wheel-gesture latch's observer (interior.ts): capture phase sees every wheel in the canvas
    // subtree BEFORE any card's claim handler, which is what lets those handlers ask "is this event
    // continuing a gesture the canvas already owns?" when a pan slides their scroller under the cursor.
    el.addEventListener("wheel", observeWheelGesture, { capture: true, passive: true });
    // The aim-vs-arrival clocks (interior.ts): real pointer input marks hover as EARNED; any camera
    // motion (pan, dive, fit, agent fly) marks it as merely delivered. Cards only claim a fresh wheel
    // gesture from earned hover — so the nudge-pan right after a peek dive pans instead of scrolling
    // whatever card the dive landed the cursor on.
    const aim = () => notePointerAim();
    el.addEventListener("pointermove", aim, { capture: true, passive: true });
    el.addEventListener("pointerdown", aim, { capture: true, passive: true });
    const offCameraClock = m.camera.signal.subscribe(() => noteCameraMoved());
    // Hold-to-peek (peek.ts): hold z → fit-all, point the cursor at the target, release → dive back in
    // there at the zoom you left. A committed dive lands the pre-peek pose on the unwind stack, so `
    // steps back across it.
    const offPeek = bindPeek(el, m, { skipLayout: isFloating, onDive: (from) => views.pushHistory(from) });
    const sync = () => m.setViewport(el.clientWidth, el.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      off();
      offPeek();
      offCameraClock();
      el.removeEventListener("wheel", observeWheelGesture, { capture: true });
      el.removeEventListener("pointermove", aim, { capture: true });
      el.removeEventListener("pointerdown", aim, { capture: true });
      ro.disconnect();
    };
  }, [m, views]);

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
      } else if (e.code === "Backquote" && !meta) {
        // Step back through the unwind stack — bounce to wherever you were before the last jump.
        e.preventDefault();
        const prev = views.back();
        if (prev) m.flyTo(prev);
        else flash("nothing to go back to");
      } else if (!meta && /^Digit[1-9]$/.test(e.code)) {
        // The view keymap, on the number row (`code` not `key` so it's layout-proof — Shift mangles the
        // printed `key`): Shift+1 / Shift+2 → zoom to fit all / to selection (the tldraw pair). Bare and
        // Alt-modified digits are free (no saved-view slots).
        const n = Number(e.code.slice(5));
        if (e.shiftKey) {
          e.preventDefault();
          if (n === 1) navigate(() => m.fitAll(isFloating));
          else if (n === 2) navigate(() => m.fitSelection(isFloating));
        }
      } else if (e.code === "KeyP" && e.altKey && !meta) {
        // Toggle the single selected card in/out of the HUD — pin it into the viewport ⇄ drop it back on the
        // canvas (togglePin flips its anchor). Gated behind Alt-HELD (seq 22): the HUD's every mutation lives
        // behind one affordance, so a stray `p` while the HUD sits open can't accidentally pin a card. Matched
        // on e.CODE (the physical P), not e.key — while Alt is held e.key is an Option-modified char (π on
        // macOS), so an e.key check would miss it and the toggle would never fire.
        const ids = m.selection.ids();
        if (ids.length === 1) {
          e.preventDefault();
          togglePin(ids[0] as Id<"node">);
        }
      } else if (e.key === "v" || e.key === "V") m.setTool("select");
      else if (e.key === "h" || e.key === "H") m.setTool("hand");
    },
    [m, undo, deleteSelected, views, navigate, flash, togglePin],
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
  const CHANNEL_MIME = "application/x-canvas-channel";
  const ROLE_MIME = "application/x-canvas-role";
  // Screen-px radius around the grab point that counts as "dropped back where it started" → cancel.
  const DRAG_CANCEL_RADIUS = 48;
  const isOurDrag = (e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    return t.includes(FS_MIME) || t.includes(SESSION_MIME) || t.includes(CHANNEL_MIME) || t.includes(ROLE_MIME);
  };
  // An OS file drag (a screenshot/image dragged in from Finder) advertises the "Files" type. We accept it
  // in dragover so the browser fires `drop`, then filter to images in onDrop (the type isn't readable until
  // drop) — image-cards-on-canvas. A non-image file drop is simply ignored, no card.
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  // A drop is a CANCEL when it lands back on the source card, or within DRAG_CANCEL_RADIUS of the grab
  // point. dragstart bubbles up from the row's handler (which has already set the mime) to here, so we
  // read the grab point + originating card off the event itself — the templates stay untouched.
  const inCancelZone = (e: React.DragEvent) => {
    const o = dragOriginRef.current;
    if (!o) return false;
    if (o.nodeId) {
      const over = (e.target as HTMLElement)?.closest?.("[data-node-id]");
      if (over?.getAttribute("data-node-id") === o.nodeId) return true;
    }
    return Math.hypot(e.clientX - o.x, e.clientY - o.y) < DRAG_CANCEL_RADIUS;
  };
  const onDragStart = useCallback((e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    const src = (e.target as HTMLElement)?.closest?.("[data-node-id]");
    dragOriginRef.current = { x: e.clientX, y: e.clientY, nodeId: src?.getAttribute("data-node-id") ?? null };
  }, []);
  const onDragEnd = useCallback(() => {
    dragOriginRef.current = null;
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    // An external file drag (Files, not one of our internal mimes): accept it as a copy so `drop` fires.
    if (!isOurDrag(e)) {
      if (hasFiles(e)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
      return;
    }
    // In the cancel zone, leave the default (no-drop): the browser shows the universal no-drop cursor —
    // the clearest "release here to abort" cue — and never fires `drop`, so the release just cancels.
    // (The native snap-back-to-origin animation on release has a fixed duration JS can't tune, so we
    // accept it.) Outside the zone, accept the drop as a copy.
    if (inCancelZone(e)) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const el = canvasRef.current;
      if (!el) return;
      // Belt-and-suspenders: a release on the cancel-zone boundary can still fire here — abort it.
      if (inCancelZone(e)) {
        dragOriginRef.current = null;
        return;
      }
      dragOriginRef.current = null;
      const rect = el.getBoundingClientRect();
      const toPage = () => m.camera.screenToPage(vec(e.clientX - rect.left, e.clientY - rect.top));

      // An OS file drop (image-cards-on-canvas): land every dropped IMAGE as a repo file + image card. Each
      // is written under `.canvas/images/` and carded at the drop point, fanned out by a small step so a
      // multi-image drop doesn't stack into one spot. Non-image files are ignored (no card).
      const files = e.dataTransfer.files;
      if (files && files.length) {
        const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
        if (images.length) {
          e.preventDefault();
          const p = toPage();
          images.forEach((file, i) => {
            void materializeImageAt(m, file, Math.round(p.x + i * 24), Math.round(p.y + i * 24));
          });
          return;
        }
      }

      const fsRaw = e.dataTransfer.getData(FS_MIME);
      if (fsRaw) {
        e.preventDefault();
        let payload: { root?: string; path: string; kind: "file" | "dir" };
        try {
          payload = JSON.parse(fsRaw);
        } catch {
          return;
        }
        // A root row drags out as { root, path: "" } — a worktree's own tree card — so an empty path is
        // valid here (unlike a file/sub-folder). Older payloads without a root fall back to canonical.
        if (payload.path == null) return;
        const p = toPage();
        void materializeAt(m, payload.root ?? "repo", payload.path, payload.kind, Math.round(p.x), Math.round(p.y));
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
        return;
      }

      const chanRaw = e.dataTransfer.getData(CHANNEL_MIME);
      if (chanRaw) {
        e.preventDefault();
        let payload: { chanId: string; title?: string; text?: string };
        try {
          payload = JSON.parse(chanRaw);
        } catch {
          return;
        }
        if (!payload.chanId) return;
        const p = toPage();
        openChannel(m, payload.chanId, payload.title ?? "", payload.text ?? "", { x: Math.round(p.x), y: Math.round(p.y) });
        return;
      }

      const roleRaw = e.dataTransfer.getData(ROLE_MIME);
      if (roleRaw) {
        e.preventDefault();
        let payload: { roleId: string };
        try {
          payload = JSON.parse(roleRaw);
        } catch {
          return;
        }
        if (!payload.roleId) return;
        const p = toPage();
        openRole(m, payload.roleId, { x: Math.round(p.x), y: Math.round(p.y) });
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
      // Anchor at the raw cursor; CanvasMenu measures its own rendered size and clamps into the viewport
      // (re-clamping when the Board sub-list expands), so no hardcoded height guess is needed here.
      const screen = { x: e.clientX, y: e.clientY };
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
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu}
      >
        <CanvasView m={m} hudShown={!!hudMode} hudEditing={hudEdit} />
      </div>

      {/* The minimap is a HUD card now (node:minimap) — it renders in the ScreenLayer inside CanvasView with
          the rest of the HUD group and toggles with it (Alt tap), no longer a separate canvas sibling. */}

      {/* The only standing chrome: a faint cue on an empty board, since right-click is otherwise invisible. */}
      {nodes.length === 0 && (
        <div className="empty-hint">right-click anywhere to add a widget</div>
      )}

      {/* The live fs-watch indicator — an ephemeral corner chip that fades in, holds, then fades out and
          self-dismisses (see the auto-fade effect). `key={seq}` restarts the animation on each new event. */}
      {lastEvent && (
        <div className="event-chip" key={lastEvent.seq}>
          ← {lastEvent.type} <b>{baseName(lastEvent.path)}</b>
        </div>
      )}

      {/* Transient confirmation for a keyboard view action (save / recall / step-back). Centred top, a
          glance like the fs-watch chip; auto-clears via the toast effect. */}
      {toast && (
        <div className="view-toast" key={toast.seq}>
          {toast.text}
        </div>
      )}

      {/* Persistent "your turn" stack, top-centre: a chip per session waiting on you, each a light glassy
          pill with the amber waiting dot. Clears itself as sessions resolve; click a chip to fly to its
          card. A new chip slides in on mount (keyed by sid, so it animates only on arrival). Capped, with
          a "+N more" when many wait at once. */}
      {waiting.length > 0 && (
        <div className="waiting-stack">
          {waiting.slice(0, 4).map((s) => (
            <button
              key={s.id}
              className="waiting-chip"
              title="jump to this session"
              onMouseDown={(e) => e.preventDefault()} // keep canvas keyboard focus; the click still fires
              onClick={() => jumpToSession(s.id)}
            >
              <span className="session-headsup-dot" />
              <span className="waiting-hash">{s.id.slice(0, 8)}</span>
              {s.title && <span className="waiting-title">{s.title}</span>}
            </button>
          ))}
          {waiting.length > 4 && <div className="waiting-more">+{waiting.length - 4} more waiting</div>}
        </div>
      )}

      {menu && (
        <CanvasMenu
          m={m}
          screen={menu.screen}
          at={menu.at}
          onImport={() => importRef.current?.click()}
          onRevealHud={() => setHudMode(1)}
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

// The "New session" menu item, expanded into a ROLE PICKER (agent-roles.md). Click it to reveal the roles
// a session can be spawned "as" — "No role" (a bare session, the original behaviour) plus each role read
// from GET /api/roles, swatched by its colour. Picking one spawns a session under it (the server appends
// the role's charter to the prompt and stamps roleId/roleName), and the new card carries the friendly
// "<RoleName>.<short-sid>" name. Roles are fetched lazily on first expand (not on every menu open) and
// cached for the menu's life; the list degrades to just "No role" until the backend endpoint lands or if
// no roles exist, so the picker is always usable.
function NewSessionItem({
  m,
  at,
  run,
}: {
  m: InteractionManager;
  at: Pos;
  run: (fn: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<Role[] | null>(null); // null = not yet fetched
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && roles === null) void fetchRoles().then(setRoles);
  };
  const spawn = (roleId?: string) => run(() => void spawnLiveSession(m, at, roleId));
  return (
    <div className="menu-roles">
      <button className="menu-expand" aria-expanded={open} onClick={toggle}>
        <span>New session</span>
        <span className="menu-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="menu-rolelist">
          <button className="menu-roleopt" onClick={() => spawn()}>
            <span className="menu-roleswatch menu-roleswatch-none" />
            No role
          </button>
          {roles === null && <div className="menu-rolehint">loading roles…</div>}
          {roles?.map((r) => (
            <button key={r.roleId} className="menu-roleopt" onClick={() => spawn(r.roleId)}>
              <span className={`menu-roleswatch c-${r.colour ?? "blue"}`} style={swatchStyle(r.colour)} />
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The "New file" affordance (Slice 2 — create a markdown/text file from the canvas). Shares the role
// picker's expandable shell: the row expands to a title input and an editable path field pre-filled with
// `.canvas/docs/<slug>.md` (slug from the title). The path auto-tracks the title UNTIL the user edits it by
// hand (pathEdited), after which the title stops overwriting their choice — the common "type a title, take
// the default path" flow stays one gesture, and retargeting to e.g. `docs/foo.md` sticks. Confirm (Create
// or ↵) writes an empty file via addTextFileCard and drops the card, which gets the Slice-1 edit toggle for
// free; the menu closes only on success, so a rejected path (bad/blocked extension → 404) keeps the form
// open with an error instead of silently doing nothing.
function NewFileItem({
  m,
  at,
  onClose,
}: {
  m: InteractionManager;
  at: Pos;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [path, setPath] = useState(defaultDocPath(""));
  const [pathEdited, setPathEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) setTimeout(() => titleRef.current?.focus(), 0);
  };
  const onTitle = (v: string) => {
    setTitle(v);
    if (!pathEdited) setPath(defaultDocPath(v)); // path tracks the title until the user takes it over
    setError(null);
  };
  const onPath = (v: string) => {
    setPath(v);
    setPathEdited(true);
    setError(null);
  };
  const create = async () => {
    if (busy || !path.trim()) return;
    setBusy(true);
    setError(null);
    const ok = await addTextFileCard(m, path, at);
    setBusy(false);
    if (ok) onClose();
    else setError("Couldn’t create that file — check the path uses a text extension (.md, .txt, …).");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void create();
    }
  };
  return (
    <div className="menu-roles">
      <button className="menu-expand" aria-expanded={open} onClick={toggle}>
        <span>New file</span>
        <span className="menu-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="menu-rolelist menu-fileform">
          <input
            ref={titleRef}
            className="menu-fileinput"
            placeholder="Title"
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            onKeyDown={onKey}
          />
          <input
            className="menu-fileinput"
            placeholder="Path"
            value={path}
            onChange={(e) => onPath(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
          />
          <button className="menu-filecreate" disabled={busy || !path.trim()} onClick={() => void create()}>
            {busy ? "Creating…" : "Create"}
          </button>
          {error && <div className="menu-fileerror">{error}</div>}
        </div>
      )}
    </div>
  );
}

// The board switcher (multi-canvas). "Board: <name>" expands into every board the server knows — live
// mounts plus the durable registry it remounted on boot, so repos opened before a restart are still
// offered — with "Open repo…" to mount a new one by absolute path. Switching NAVIGATES: one tab is
// exactly one board (board.ts), so a switch is a page load, not a state change. The rows go through
// ?repo= (boardHref), which re-mounts idempotently — the same path a first open takes. Boards are
// refetched on every expand (mounts change between menu opens), and the current board's row is inert.
function BoardsItem() {
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardListing[] | null>(null); // null = not yet fetched
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void listBoards().then(setBoards);
  };
  const openRepo = () => {
    const p = window.prompt("Absolute path of the repo to open as a board:");
    if (p?.trim()) location.assign(`${location.pathname}?repo=${encodeURIComponent(p.trim())}`);
  };
  const current = activeBoardId();
  return (
    <div className="menu-roles">
      <button className="menu-expand" aria-expanded={open} onClick={toggle}>
        <span>
          Board: <b>{activeBoard().name}</b>
        </span>
        <span className="menu-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="menu-rolelist">
          {boards === null && <div className="menu-rolehint">loading boards…</div>}
          {boards?.map((b) => (
            <button
              key={b.boardId}
              className="menu-boardopt"
              disabled={b.boardId === current}
              title={b.repoPath}
              onClick={() => location.assign(boardHref(b))}
            >
              <span className="menu-boardname">{b.name}</span>
              {b.boardId === current && <span className="menu-boardtag">current</span>}
              {b.boardId !== current && b.isDefault && <span className="menu-boardtag">dev</span>}
            </button>
          ))}
          <button className="menu-boardopt menu-boardopen" onClick={openRepo}>
            Open repo…
          </button>
        </div>
      )}
    </div>
  );
}

// A role's colour may be a NOTE_COLORS key (styled via the `c-<key>` class) or an explicit CSS colour. We
// can't know which here, so when it doesn't look like a bare palette key we set it as an inline background
// too — the class covers the keys, the inline style covers raw colours, and one of them always paints.
function swatchStyle(colour?: string): React.CSSProperties | undefined {
  if (!colour) return undefined;
  return /[#(]/.test(colour) ? { background: colour } : undefined;
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
  onRevealHud,
  onClose,
}: {
  m: InteractionManager;
  screen: Pos;
  at: Pos;
  onImport: () => void;
  onRevealHud: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The rendered position, clamped so the whole popover stays inside the viewport. Starts at the cursor,
  // then a layout-effect measures the real menu box and pulls it in if it would spill off the right/bottom
  // (or top/left) edge. A ResizeObserver re-clamps whenever the menu's size changes — e.g. expanding the
  // Board sub-list — so the bottom rows stay reachable near the bottom edge. useLayoutEffect corrects the
  // position before paint, so there is no visible jump.
  const [pos, setPos] = useState<Pos>(screen);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const r = el.getBoundingClientRect();
      const margin = 8;
      const x = Math.max(margin, Math.min(screen.x, window.innerWidth - r.width - margin));
      const y = Math.max(margin, Math.min(screen.y, window.innerHeight - r.height - margin));
      setPos((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    window.addEventListener("resize", clamp);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [screen.x, screen.y]);
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
    <div className="canvas-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <div className="menu-list">
        <div className="menu-section">Session</div>
        <NewSessionItem m={m} at={at} run={run} />
        <button onClick={() => run(() => addRolesCard(m, at))}>Roles</button>
        <button onClick={() => run(() => void createThread(m.editor, at))}>New thread</button>
        {/* The HUD singletons (usage / sessions / clock / Threads) — true singletons: one instance, stable id.
            Each row is CHECKED when its card already exists (seedHud seeds them on every board load, so that's
            the normal state); a user who deleted one gets it re-minted at its default slot on click. Clicking
            never duplicates (ensureHudCard is a no-op when present) — it just guarantees the card exists and
            REVEALS the HUD group (onRevealHud) so a hidden HUD pops into view with the card in it. */}
        <div className="menu-section">HUD</div>
        {DEFAULT_HUD.map((spec) => {
          const exists = !!m.editor.store.get<"node">(spec.id as Id<"node">);
          return (
            <button
              key={spec.id}
              className="menu-singleton"
              onClick={() => run(() => { ensureHudCard(m, spec.id); onRevealHud(); })}
            >
              <span className="menu-check" aria-hidden="true">{exists ? "✓" : " "}</span>
              {HUD_LABELS[spec.type] ?? spec.type}
            </button>
          );
        })}
        <div className="menu-section">Files</div>
        <NewFileItem m={m} at={at} onClose={onClose} />
        {/* The root "File tree" is a HUD singleton now (listed under the HUD section above, checked/reveal);
            it's no longer a duplicable world card. Sub-folders are still pinned by dragging a row out. */}
        <button onClick={() => run(() => void addNotebookCard(m, at))}>Notebook</button>
        <div className="menu-section">Notes &amp; widgets</div>
        <button onClick={() => run(() => addStickyNote(m, at))}>Sticky note</button>
        {/* Clock + Usage live under the HUD section above (true singletons), not here — they're corner chrome,
            not duplicable world widgets. */}
        <button onClick={() => run(() => addGitHeadCard(m, at))}>Git HEAD</button>
        <button onClick={() => run(() => addHnCard(m, at))}>Hacker News</button>
        <button onClick={() => run(() => addWeatherCard(m, at))}>Weather</button>
        <button onClick={() => run(() => addComputedCard(m, at))}>Computed</button>
        <button onClick={() => run(() => addProvenanceCard(m, at))}>Intent log</button>
        <div className="menu-divider" />
        <div className="menu-section">Board</div>
        <BoardsItem />
        <button onClick={() => run(() => m.fitAll(isFloating))}>Zoom to fit <span className="menu-key">⇧1</span></button>
        <button onClick={() => run(() => exportBoard(m))}>Export…</button>
        <button onClick={() => { onImport(); onClose(); }}>Import…</button>
        <button onClick={() => run(() => clearBoard(m))}>Clear board</button>
      </div>
    </div>
  );
}
