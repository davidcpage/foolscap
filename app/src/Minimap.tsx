import { useMemo, useRef } from "react";
import { boxCenter, worldBounds, type Box, type Id, type InteractionManager } from "./lib";
import { useSignal } from "./reactive";
import { sessionListSignal } from "./content";
import { STATUS_COLOR, type SessionStatus } from "./session-status";

// The minimap — an ordinary HUD card since the P3 unification (was separate DOM chrome). It renders in the
// ScreenLayer through the SAME unified ScreenCardFrame as every other HUD card (NodeView dispatches the
// `minimap` node type here), so it toggles with the HUD group, drags/resizes in Alt-held edit mode, and takes
// the shared `.hud-frame > .node` panel chrome. Its body shows the plain map (card rects + the board edges
// between them + the viewport frustum) and pressing/dragging the map recenters the camera. Two behaviours the
// DOM-parent move (out of the canvas-sibling shell, into the frame) had to preserve:
//   • click-to-pan: the svg claims its own pointer via setPointerCapture. Outside edit mode the ScreenCardFrame
//     is LOCKED and binds no pointerdown listener, so the svg's own onPointerDown runs and the pan works; the
//     frame's locked mousedown-preventDefault (keeping canvas focus, as the old shell did) is a mouse event and
//     never touches the pointer capture. In edit mode the frame's NATIVE pointerdown fires first and
//     stopPropagation pre-empts React's root-delegated svg handler, so the frame drag wins over a pan — the two
//     don't fight.
//   • screen→page projection: recenter() uses getScreenCTM(), which reflects the svg's ACTUAL on-screen box, so
//     it holds regardless of which DOM parent the svg sits under.
// Being unmounted by the ScreenLayer when the HUD is hidden preserves the old perf win: the body subscribes to
// the camera and rebuilds an SVG rect per card every pan/zoom frame, so it must not run while the map is off.

export function MinimapCard({
  m,
  id,
  box,
  selected,
}: {
  m: InteractionManager;
  id: Id<"node">;
  box: React.CSSProperties;
  selected: boolean;
}) {
  const store = m.editor.store;
  const layoutQuery = useMemo(() => store.query({ typeName: "layout" }), [store]);
  const layouts = useSignal(layoutQuery);
  const nodeQuery = useMemo(() => store.query({ typeName: "node" }), [store]);
  const nodes = useSignal(nodeQuery);
  const edgeQuery = useMemo(() => store.query({ typeName: "edge" }), [store]);
  const edges = useSignal(edgeQuery);
  useSignal(m.camera.signal); // re-project rects + frustum as the camera pans/zooms
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.id, n.color);
    return map;
  }, [nodes]);
  const typeOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.id, n.type);
    return map;
  }, [nodes]);

  // The session lifecycle band, painted as a coloured strip across the top of each session card so a
  // zoomed-out glance at the map shows which sessions are working / waiting-on-you / wound-down — the
  // minimap-scale echo of the card's own band. Joined node→status by the session card convention (a
  // session node's `title` IS its session id, the key /api/sessions rows carry).
  const sessions = useSignal(sessionListSignal);
  const statusOf = useMemo(() => {
    const byId = new Map<string, SessionStatus>();
    for (const s of sessions ?? []) if (s.status) byId.set(s.id, s.status);
    const map = new Map<string, SessionStatus>(); // keyed by NODE id, for the layout loop below
    for (const n of nodes) {
      if (n.type !== "session") continue;
      const st = byId.get(n.title);
      if (st) map.set(n.id, st);
    }
    return map;
  }, [sessions, nodes]);

  const world = useMemo(() => layouts.filter((l) => l.anchor !== "screen"), [layouts]);
  // The plain card rects don't move with the camera (page-space coords; only the frustum re-projects),
  // so keep the element array stable across camera ticks — React bails per-rect by identity instead of
  // reconciling one rect per card per pan frame.
  const cardRects = useMemo(
    () =>
      world.map((l) => {
        const cls = `minimap-card c-${colorOf.get(l.nodeId) ?? "blue"}`;
        // The clock card reads as a CIRCLE in the minimap (it's a clock face), so it's recognisable at a
        // glance; every other card is a plain rect. Radius = half the smaller dimension, centred on the rect.
        if (typeOf.get(l.nodeId) === "clock") {
          return (
            <circle key={l.nodeId} className={cls} cx={l.x + l.w / 2} cy={l.y + l.h / 2} r={Math.min(l.w, l.h) / 2} />
          );
        }
        return <rect key={l.nodeId} className={cls} x={l.x} y={l.y} width={l.w} height={l.h} />;
      }),
    [world, colorOf, typeOf],
  );
  // The board edges, drawn as thin lines between the centres of the two cards they connect — painted
  // UNDER the card rects (first in document order). Same page-space coords as the rects; an edge whose
  // endpoint has no world layout (a screen-anchored or missing node) is skipped.
  const edgeLines = useMemo(() => {
    const center = new Map<string, { cx: number; cy: number }>();
    for (const l of world) center.set(l.nodeId, { cx: l.x + l.w / 2, cy: l.y + l.h / 2 });
    return edges.flatMap((e) => {
      const a = center.get(e.from);
      const b = center.get(e.to);
      if (!a || !b) return [];
      return [<line key={e.id} className="minimap-edge" x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} />];
    });
  }, [world, edges]);
  const wb = worldBounds(store, (l) => l.anchor === "screen");
  const view = m.visibleBox();
  // Drawn extent = content ∪ current viewport (so the frustum stays in frame even parked in empty
  // space), then padded.
  const ext = padBox(unionBox(wb, view) ?? { x: 0, y: 0, w: 1, h: 1 }, 0.06);
  const labelSize = Math.max(ext.w, ext.h) * 0.045;

  // ── interaction (plain React — we're outside the canvas subtree) ──
  const recenter = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const wpt = pt.matrixTransform(ctm.inverse()); // screen → page, viewBox + aspect inverted for us
    const vb = m.visibleBox();
    if (!vb) return;
    m.cancelFly();
    const z = m.camera.state.z;
    const sc = m.camera.pageToScreen(boxCenter(vb)); // screen coords of the viewport centre
    m.camera.set({ x: sc.x - wpt.x * z, y: sc.y - wpt.y * z, z });
  };
  const onDown = (e: React.PointerEvent) => {
    recenter(e.clientX, e.clientY);
    dragging.current = true;
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) recenter(e.clientX, e.clientY);
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    svgRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div data-node-id={id} className={`node minimap${selected ? " selected" : ""}`} style={box}>
      <div className="minimap-head">minimap</div>
      <svg
        ref={svgRef}
        className="minimap-svg"
        viewBox={`${ext.x} ${ext.y} ${ext.w} ${ext.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {edgeLines}
        {cardRects}
        {world.map((l) => {
            const st = statusOf.get(l.nodeId);
            if (!st) return null;
            // A status strip across the card's top edge — sized to a fraction of the card but floored to
            // labelSize so it never collapses to sub-pixel on a small card. `waiting` (and `crashed`) get
            // the pulse class so the one state demanding a human pulls the eye, as it does on the card.
            const barH = Math.min(Math.max(l.h * 0.2, labelSize * 0.6), l.h);
            const pulse = st === "waiting" ? " minimap-status-pulse" : "";
            return (
              <rect
                key={`s-${l.nodeId}`}
                className={`minimap-status${pulse}`}
                x={l.x}
                y={l.y}
                width={l.w}
                height={barH}
                fill={STATUS_COLOR[st]}
              />
            );
          })}
        {view && <rect className="minimap-frustum" x={view.x} y={view.y} width={view.w} height={view.h} />}
      </svg>
    </div>
  );
}

const unionBox = (a: Box | null, b: Box | null): Box | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const padBox = (b: Box, frac: number): Box => {
  const px = b.w * frac;
  const py = b.h * frac;
  return { x: b.x - px, y: b.y - py, w: b.w + 2 * px, h: b.h + 2 * py };
};
