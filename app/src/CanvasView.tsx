import { memo, useEffect, useMemo, useRef, useState } from "react";
import { layoutId, selectionBounds, type Box, type CameraState, type Id, type InteractionManager, type Vec } from "./lib";
import { NodeView } from "./NodeView";
import { useSignal, useSignalValue } from "./reactive";
import { acceptMembership, isAttentionEdge, MEMBER_OPEN, MEMBER_PENDING, removeMembership } from "./threads";
import { claimWheelGesture, wheelClaimableByCard } from "./interior";
import { HUD_CARDS, hudChrome, isHudCard } from "./hud";

// Per-type connector colour (driven inline; see EdgeLayer for why visuals aren't a CSS class). Amber =
// pending invite, green = open membership, blue = watch; the lilac fallback matches the system wires
// (type "input").
function edgeColor(type: string): string {
  return type === MEMBER_PENDING
    ? "#f59e0b"
    : type === MEMBER_OPEN
      ? "#10b981"
      : type === "watch:open"
        ? "#38bdf8"
        : "#c4b5fd";
}

// Stable selector for the zoom-only camera subscription (useSignalValue) — the layers that inverse-
// scale widths/handles by z but sit in page space don't need to wake on pan at all.
const camZ = (c: CameraState) => c.z;

// The page-space render layer — mirrored from app/src/CanvasView.tsx (the camera transform, dot grid,
// selection box, marquee, and the smooth-during/crisp-at-rest zoom hint are all engine-agnostic plumbing).
// The only change is that it maps file-card NodeViews. Pan/zoom re-renders this one container's transform;
// a drag re-renders the dragged NodeView alone; a filesystem change re-renders just the changed card.
//
// CanvasView itself does NOT subscribe to the camera. It used to — which meant every camera tick
// re-executed the nodes.map and handed React the entire card/edge/overlay tree to reconcile, an
// O(cards) pass per pan frame that changed nothing but the transform. The camera subscription lives
// in the leaf `Page` below instead: when only Page re-renders, its `children` prop is the SAME element
// array from CanvasView's last render, so React bails out of the whole subtree by identity.
export function CanvasView({ m, hudShown, hudEditing }: { m: InteractionManager; hudShown: boolean; hudEditing: boolean }) {
  const nodeQuery = useMemo(() => m.editor.store.query({ typeName: "node" }), [m]);
  const nodes = useSignal(nodeQuery);
  // Which agent attention-edge is selected for actions (accept / sever / send). App-local state, not the
  // engine's node Selection — these edges live in the same store but their action UI is a renderer concern.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  return (
    <>
      <GridLayer m={m} />
      <Page m={m} onPointerDown={() => setSelectedEdge(null)}>
        <EdgeLayer m={m} selectedEdge={selectedEdge} onSelectEdge={setSelectedEdge} />
        {nodes.map((n) => (
          <NodeView key={n.id} m={m} id={n.id} />
        ))}
        <SelectionOverlay m={m} />
        <MarqueeOverlay m={m} />
      </Page>
      <ScreenLayer m={m} hudShown={hudShown} hudEditing={hudEditing} />
      <EdgeActions m={m} edgeId={selectedEdge} onClose={() => setSelectedEdge(null)} />
    </>
  );
}

// The ONE camera-subscribed wrapper: owns the pan/zoom transform and nothing else. A press that
// reaches the page background (empty canvas, or bubbling up from a card) clears the edge selection;
// the edge hit-line stops its own press from bubbling here, so selecting an edge doesn't immediately
// deselect it. The `zooming` promotion is ZOOM-only on purpose — extending it to pan forced a full
// re-raster of the (huge) page layer at every gesture start/settle, which read as a lock-up.
function Page({ m, onPointerDown, children }: { m: InteractionManager; onPointerDown: () => void; children: React.ReactNode }) {
  const cam = useSignal(m.camera.signal);
  const zooming = useZooming(cam.z);
  return (
    <div
      className={zooming ? "page zooming" : "page"}
      style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  );
}

// The screen-space (viewport-anchored) layer — a sibling of `.page`, so it sits OUTSIDE the camera
// transform and its cards stay put under pan/zoom. It renders the floating cards (anchor "screen");
// `.page` above renders the rest (a NodeView shows in exactly one layer per its anchor). Subscribes to
// the layout query so a card that gets pinned/unpinned hops layers, and so a floating card it owns
// re-renders live as it's dragged. The layer itself is pointer-transparent (empty space falls through
// to the canvas); each floating card re-enables pointer events on itself.
function ScreenLayer({ m, hudShown, hudEditing }: { m: InteractionManager; hudShown: boolean; hudEditing: boolean }) {
  const store = m.editor.store;
  const layoutQuery = useMemo(() => store.query({ typeName: "layout" }), [store]);
  const layouts = useSignal(layoutQuery);
  const floating = layouts.filter((l) => l.anchor === "screen");
  // Two kinds of screen-anchored card share this layer AND the same frame (NodeView's ScreenCardFrame): HUD
  // chrome (usage/sessions/clock/channels — hud.ts), corner-locked and toggled as a group with the minimap,
  // and ordinary user-PINNED cards (the `p` key), draggable and always shown. Split them so the HUD toggle
  // only touches the former; both position from their own stored layout x/y/w/h now.
  const free = floating.filter((l) => !isHudCard(l.nodeId));
  // HUD cards render through the same frame with a chrome descriptor (frame style only); position comes from
  // the card's stored layout, seeded from the default-layout spec (hud-layout.js). Iterated in HUD_CARDS
  // order for a deterministic DOM order among equal z.
  const hud = hudShown
    ? HUD_CARDS.map((id) => floating.find((l) => l.nodeId === id)).filter((l): l is NonNullable<typeof l> => !!l)
    : [];
  if (free.length === 0 && hud.length === 0) return null;
  return (
    <div className="screen-layer">
      {free.map((l) => (
        <NodeView key={l.nodeId} m={m} id={l.nodeId} screen />
      ))}
      {hud.map((l) => {
        const chrome = hudChrome(l.nodeId);
        if (!chrome) return null;
        return <NodeView key={l.nodeId} m={m} id={l.nodeId} screen hud={chrome} hudEditing={hudEditing} />;
      })}
    </div>
  );
}

const ZOOM_SETTLE_MS = 160;
function useZooming(z: number): boolean {
  const [zooming, setZooming] = useState(false);
  const prevZ = useRef(z);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (z === prevZ.current) return;
    prevZ.current = z;
    setZooming(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setZooming(false), ZOOM_SETTLE_MS);
    return () => clearTimeout(timer.current);
  }, [z]);
  return zooming;
}

// The dot grid. Panning used to slide it via background-position — a FULL-VIEWPORT repaint every
// frame. Instead the div is oversized by one tile on each side and translated by the camera offset
// MODULO the tile size (same visible phase, since the pattern repeats every `step`), so a pan is a
// composited transform on a static raster; only zoom (which changes the tile size) still repaints.
const BASE = 24;
function GridLayer({ m }: { m: InteractionManager }) {
  const cam = useSignal(m.camera.signal);
  let step = BASE * cam.z;
  while (step < 18) step *= 4;
  while (step > 120) step /= 2;
  const mod = (v: number) => ((v % step) + step) % step;
  return (
    <div
      className="grid"
      style={{
        inset: -step,
        backgroundSize: `${step}px ${step}px`,
        transform: `translate(${mod(cam.x)}px, ${mod(cam.y)}px)`,
      }}
    />
  );
}

// Renders the authored wiring (EdgeRecords) as lines between card centers, under the cards. Subscribes
// to the edge query (wires appear/vanish with addEdge/removeEdge — including via undo) and to the layout
// query, so a dragged card's wires follow it live frame-by-frame on channel 1. System wires (type
// "input") keep the base dashed style and stay inert; agent attention-edges (msg:* / watch:*) get
// per-type styling (pending dashed / open solid) and a fat invisible hit-line so a click selects them.
// The in-flight connect-drag (alt-drag) draws as a preview line from the source card to the pointer.
function EdgeLayer({
  m,
  selectedEdge,
  onSelectEdge,
}: {
  m: InteractionManager;
  selectedEdge: string | null;
  onSelectEdge: (id: string) => void;
}) {
  const store = m.editor.store;
  const edgeQuery = useMemo(() => store.query({ typeName: "edge" }), [store]);
  const edges = useSignal(edgeQuery);
  const layoutQuery = useMemo(() => store.query({ typeName: "layout" }), [store]);
  useSignal(layoutQuery);
  // Only ZOOM affects this layer (stroke widths, below); positions are page-space under .page's
  // transform. Subscribing to the z projection alone lets every pan frame skip the layer entirely —
  // it used to re-render (and re-reconcile) every edge on every pan tick for no visual change.
  const z = useSignalValue(m.camera.signal, camZ);
  const connect = useSignal(m.connectDraw);
  // Stroke widths are in page space (drawn under .page's scale(z)); divide by z so each renders at a
  // constant screen px, the same trick ResizeHandles use — otherwise a thin connector vanishes zoomed out.
  const k = 1 / z;

  const previewA = connect && store.get<"layout">(layoutId(connect.from as Id<"node">));
  return (
    <>
      {edges.map((e) => {
        const a = store.get<"layout">(layoutId(e.from));
        const b = store.get<"layout">(layoutId(e.to));
        if (!a || !b) return null;
        const attention = isAttentionEdge(e.type);
        const selected = selectedEdge === e.id;
        const w = (selected ? 3 : attention ? (e.type === MEMBER_OPEN ? 2.2 : 1.9) : 1.6) * k;
        return (
          <EdgeLine
            key={e.id}
            id={e.id}
            x1={a.x + a.w / 2}
            y1={a.y + a.h / 2}
            x2={b.x + b.w / 2}
            y2={b.y + b.h / 2}
            color={edgeColor(e.type)}
            width={w}
            dash={e.type === MEMBER_OPEN ? undefined : `${6 * k} ${4 * k}`}
            glow={selected ? 3 * k : 0}
            hitWidth={attention ? 16 * k : 0}
            onSelect={attention ? onSelectEdge : undefined}
          />
        );
      })}
      {connect && previewA && (
        <EdgeLine
          x1={previewA.x + previewA.w / 2}
          y1={previewA.y + previewA.h / 2}
          x2={connect.to.x}
          y2={connect.to.y}
          color={connect.toNode ? "#10b981" : "#94a3b8"}
          width={2.2 * k}
          dash={connect.toNode ? undefined : `${4 * k} ${4 * k}`}
          glow={0}
          hitWidth={0}
        />
      )}
    </>
  );
}

// One edge as its OWN correctly-sized, absolutely-positioned SVG. A single shared 0×0 <svg> relying on
// overflow:visible does NOT paint its descendants in every browser (a zero-area root SVG is collapsed —
// the lines stay hit-testable but never show; that was the invisible-connector bug). Here the svg box is
// the line's bounding box padded by the (screen-constant) stroke/hit half-widths, so the line always sits
// inside a non-zero viewport. Positioned in page space (left/top), so it pans/zooms with .page like a card.
// Memoized (with the STABLE onSelectEdge setter + the edge id, never a per-render closure), so a layout
// commit — one card dragged, N-1 edges untouched — reconciles only the lines whose endpoints moved.
const EdgeLine = memo(function EdgeLine({
  id,
  x1,
  y1,
  x2,
  y2,
  color,
  width,
  dash,
  glow,
  hitWidth,
  onSelect,
}: {
  id?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  dash: string | undefined;
  glow: number;
  hitWidth: number;
  onSelect?: (id: string) => void;
}) {
  const pad = Math.max(width, hitWidth) / 2 + glow + 2;
  const left = Math.min(x1, x2) - pad;
  const top = Math.min(y1, y2) - pad;
  const boxW = Math.abs(x2 - x1) + 2 * pad;
  const boxH = Math.abs(y2 - y1) + 2 * pad;
  return (
    <svg
      style={{ position: "absolute", left, top, width: boxW, height: boxH, overflow: "visible", pointerEvents: "none" }}
    >
      <line
        x1={x1 - left}
        y1={y1 - top}
        x2={x2 - left}
        y2={y2 - top}
        style={{
          stroke: color,
          strokeWidth: width,
          strokeDasharray: dash,
          filter: glow ? `drop-shadow(0 0 ${glow}px ${color})` : undefined,
        }}
      />
      {hitWidth > 0 && onSelect && id != null && (
        <line
          x1={x1 - left}
          y1={y1 - top}
          x2={x2 - left}
          y2={y2 - top}
          style={{ stroke: "transparent", strokeWidth: hitWidth, pointerEvents: "stroke", cursor: "pointer" }}
          onPointerDown={(ev) => {
            ev.stopPropagation();
            onSelect(id);
          }}
        />
      )}
    </svg>
  );
})

// Channel-1 selection chrome. A MULTI-selection draws its group-extent box (no handles — the select
// tool only resizes a lone node). A SINGLE selection draws corner resize handles on its box: the node
// already shows `.selected`, so the handles are the only thing added, and they're what the tool's
// hitHandle geometry expects to find. Subscribes to selection + the layout query (so a live drag/resize
// frame re-fires it and the handles track the box) + the camera (handles are sized in screen px).
function SelectionOverlay({ m }: { m: InteractionManager }) {
  const ids = useSignal(m.selection.signal);
  const z = useSignalValue(m.camera.signal, camZ); // handles are sized by zoom; pan never moves them
  const store = m.editor.store;
  const layoutQuery = useMemo(() => store.query({ typeName: "layout" }), [store]);
  useSignal(layoutQuery);
  if (ids.size === 0) return null;
  // This overlay lives INSIDE .page (page-space). A floating (anchor "screen") card's layout x/y are
  // SCREEN pixels, so its bounds here would land at a wrong page point — the "detached handles off in
  // the distance" bug. Floating cards show selection via their own .node.selected ring instead, so
  // drop them from the box/handles entirely.
  const worldIds = [...ids].filter((id) => store.get<"layout">(layoutId(id as Id<"node">))?.anchor !== "screen");
  if (worldIds.length === 0) return null;
  const bounds = selectionBounds(store, worldIds);
  if (!bounds) return null;
  if (worldIds.length >= 2) return <div className="selection-box" style={rectStyle(bounds)} />;
  return <ResizeHandles box={bounds} z={z} />;
}

// The four corner grab dots. Drawn in page space (inside .page, so they pan/zoom with the card), but
// inverse-scaled by the camera zoom so each stays a constant HANDLE screen px — the visual twin of the
// tool's HANDLE_HIT ÷ z grab zone. Purely a projection: pointer-events:none, so the press falls through
// to the canvas and the interaction layer hit-tests the corner by geometry, never by DOM target.
const HANDLE = 10; // screen px
function ResizeHandles({ box, z }: { box: Box; z: number }) {
  const s = HANDLE / z;
  const half = s / 2;
  const corners: ReadonlyArray<readonly [string, number, number]> = [
    ["nw", box.x, box.y],
    ["ne", box.x + box.w, box.y],
    ["sw", box.x, box.y + box.h],
    ["se", box.x + box.w, box.y + box.h],
  ];
  return (
    <>
      {corners.map(([c, px, py]) => (
        <div
          key={c}
          className={`resize-handle resize-${c}`}
          style={{
            transform: `translate(${px - half}px, ${py - half}px)`,
            width: s,
            height: s,
            borderWidth: 1 / z,
          }}
        />
      ))}
    </>
  );
}

function MarqueeOverlay({ m }: { m: InteractionManager }) {
  const box = useSignal(m.marquee);
  if (!box) return null;
  return <div className="marquee" style={rectStyle(box)} />;
}

// The action popover for the selected attention-edge: accept/sever a pending proposal, or compose+send
// over an open one (the two-party handshake made tangible on the canvas). Positioned at the edge's
// midpoint in SCREEN space (a sibling of .page, so it doesn't pan/zoom-scale). Its root contains
// pointer/key/wheel events natively — the documented interior-input seam — so typing in the compose box
// never leaks to the canvas (Backspace→delete-selected, Space→hold-to-pan). All hooks run before the
// early returns so the order stays stable as the selection comes and goes.
function EdgeActions({ m, edgeId, onClose }: { m: InteractionManager; edgeId: string | null; onClose: () => void }) {
  const store = m.editor.store;
  const edgeQuery = useMemo(() => store.query({ typeName: "edge" }), [store]);
  useSignal(edgeQuery); // re-render when the edge's type changes (pending→open) or it's severed
  const layoutQuery = useMemo(() => store.query({ typeName: "layout" }), [store]);
  useSignal(layoutQuery); // track the endpoints as they move
  const cam = useSignal(m.camera.signal); // re-project the midpoint on pan/zoom
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    // Wheel is contained like the rest — except when the gesture isn't this popover's to claim
    // (interior.ts): the canvas already owns it, or the popover (which re-projects with the camera)
    // merely ended up under an un-aimed cursor.
    const stopWheel = (e: WheelEvent) => {
      if (!wheelClaimableByCard()) return;
      claimWheelGesture();
      e.stopPropagation();
    };
    el.addEventListener("pointerdown", stop);
    el.addEventListener("keydown", stop);
    el.addEventListener("wheel", stopWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", stop);
      el.removeEventListener("keydown", stop);
      el.removeEventListener("wheel", stopWheel);
    };
  }, [edgeId]);

  if (!edgeId) return null;
  const e = store.get<"edge">(edgeId as Id<"edge">);
  if (!e) return null; // severed elsewhere / undone while selected — nothing to act on
  const a = store.get<"layout">(layoutId(e.from));
  const b = store.get<"layout">(layoutId(e.to));
  if (!a || !b) return null;
  void cam; // referenced so the projection re-runs on camera change (the signal subscription above)
  const mid: Vec = { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 };
  const s = m.camera.pageToScreen(mid);
  const drop = () => { onClose(); };

  return (
    <div ref={rootRef} className="edge-actions" style={{ left: s.x, top: s.y }}>
      {e.type === MEMBER_PENDING && (
        <>
          <span className="edge-actions-label">invite pending</span>
          <button onClick={() => acceptMembership(m.editor, edgeId)}>Accept</button>
          <button onClick={() => { removeMembership(m.editor, edgeId); drop(); }}>Decline</button>
        </>
      )}
      {e.type === MEMBER_OPEN && (
        <>
          <span className="edge-actions-label">member</span>
          <button onClick={() => { removeMembership(m.editor, edgeId); drop(); }}>Leave</button>
        </>
      )}
    </div>
  );
}

const rectStyle = (b: Box) => ({
  transform: `translate(${b.x}px, ${b.y}px)`,
  width: b.w,
  height: b.h,
});
