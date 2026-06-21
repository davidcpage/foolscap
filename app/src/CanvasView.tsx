import { useEffect, useMemo, useRef, useState } from "react";
import { layoutId, selectionBounds, type Box, type CameraState, type InteractionManager } from "./lib";
import { NodeView } from "./NodeView";
import { useSignal } from "./reactive";

// The page-space render layer — mirrored from app/src/CanvasView.tsx (the camera transform, dot grid,
// selection box, marquee, and the smooth-during/crisp-at-rest zoom hint are all engine-agnostic plumbing).
// The only change is that it maps file-card NodeViews. Pan/zoom re-renders this one container's transform;
// a drag re-renders the dragged NodeView alone; a filesystem change re-renders just the changed card.
export function CanvasView({ m }: { m: InteractionManager }) {
  const cam = useSignal(m.camera.signal);
  const nodeQuery = useMemo(() => m.editor.store.query({ typeName: "node" }), [m]);
  const nodes = useSignal(nodeQuery);
  const zooming = useZooming(cam.z);

  return (
    <>
      <GridLayer cam={cam} />
      <div
        className={zooming ? "page zooming" : "page"}
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}
      >
        <EdgeLayer m={m} />
        {nodes.map((n) => (
          <NodeView key={n.id} m={m} id={n.id} />
        ))}
        <SelectionOverlay m={m} />
        <MarqueeOverlay m={m} />
      </div>
    </>
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

const BASE = 24;
function GridLayer({ cam }: { cam: CameraState }) {
  let step = BASE * cam.z;
  while (step < 18) step *= 4;
  while (step > 120) step /= 2;
  return (
    <div
      className="grid"
      style={{ backgroundSize: `${step}px ${step}px`, backgroundPosition: `${cam.x}px ${cam.y}px` }}
    />
  );
}

// Renders the authored wiring (EdgeRecords) as dashed lines between card centers, under the cards.
// Subscribes to the edge query (wires appear/vanish with addEdge/removeEdge — including via undo) and
// to the layout query, so a dragged card's wires follow it live frame-by-frame on channel 1.
function EdgeLayer({ m }: { m: InteractionManager }) {
  const store = m.editor.store;
  const edgeQuery = useMemo(() => store.query({ typeName: "edge" }), [store]);
  const edges = useSignal(edgeQuery);
  const layoutQuery = useMemo(() => store.query({ typeName: "layout" }), [store]);
  useSignal(layoutQuery);
  if (edges.length === 0) return null;
  return (
    <svg className="edge-layer">
      {edges.map((e) => {
        const a = store.get<"layout">(layoutId(e.from));
        const b = store.get<"layout">(layoutId(e.to));
        if (!a || !b) return null;
        return (
          <line
            key={e.id}
            x1={a.x + a.w / 2}
            y1={a.y + a.h / 2}
            x2={b.x + b.w / 2}
            y2={b.y + b.h / 2}
          />
        );
      })}
    </svg>
  );
}

// Channel-1 selection chrome. A MULTI-selection draws its group-extent box (no handles — the select
// tool only resizes a lone node). A SINGLE selection draws corner resize handles on its box: the node
// already shows `.selected`, so the handles are the only thing added, and they're what the tool's
// hitHandle geometry expects to find. Subscribes to selection + the layout query (so a live drag/resize
// frame re-fires it and the handles track the box) + the camera (handles are sized in screen px).
function SelectionOverlay({ m }: { m: InteractionManager }) {
  const ids = useSignal(m.selection.signal);
  const cam = useSignal(m.camera.signal);
  const layoutQuery = useMemo(() => m.editor.store.query({ typeName: "layout" }), [m]);
  useSignal(layoutQuery);
  if (ids.size === 0) return null;
  const bounds = selectionBounds(m.editor.store, ids);
  if (!bounds) return null;
  if (ids.size >= 2) return <div className="selection-box" style={rectStyle(bounds)} />;
  return <ResizeHandles box={bounds} z={cam.z} />;
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

const rectStyle = (b: Box) => ({
  transform: `translate(${b.x}px, ${b.y}px)`,
  width: b.w,
  height: b.h,
});
