import { memo, useEffect, useMemo, useRef } from "react";
import { layoutId, type Id, type InteractionManager, type LayoutRecord, type NodeRecord } from "./lib";
import { useSignal } from "./reactive";
import { nowSignal } from "./clock";
import { feedSignal, shortSha, timeAgo, type GitHead, type HnStory } from "./feeds";
import { formatEventTime, logSignal } from "./provenance";
import { summarizeDiff } from "./lib";
import { buildCard, mountTemplate, templatesSignal, type CardTemplate } from "./templates";
import { scrollableFromTarget } from "./interior";

// The spike's own node renderer — the ONLY thing that differs from app/'s NodeView. Every card
// subscribes to the SAME two per-entity channel-1 handles (layout for position/size, node for
// title/color), so a move or recolour re-renders only THAT card — the live-update path rides the
// exact per-entity reactivity the engines already give. File/session CONTENT rides its own off-log
// signal (content.ts / the session feed), read inside the template, so a filesystem change refreshes
// just that one body without ever touching the log. Interiors
// are migrating to runtime-loaded templates (card-types/, doc §7): clock, note, and file live
// there now; the remaining hardcoded views below each go the same way as their capabilities
// (inputs, log view) land in the contract, until this file is just box + dispatch.
export const NodeView = memo(function NodeView({ m, id }: { m: InteractionManager; id: Id<"node"> }) {
  const store = m.editor.store;
  const layoutSub = useMemo(() => store.getSignal<"layout">(layoutId(id)), [store, id]);
  const nodeSub = useMemo(() => store.getSignal<"node">(id), [store, id]);

  const layout: LayoutRecord | undefined = useSignal(layoutSub);
  const node: NodeRecord | undefined = useSignal(nodeSub);
  const selected = useSignal(m.selection.signal).has(id);
  // The card-type registry: a channel-1 handle like any other, so a template loading (or being
  // live-edited on disk and re-imported) re-renders exactly the cards of that type.
  const templates = useSignal(templatesSignal);

  if (!layout || !node) return null;

  const box = {
    transform: `translate(${layout.x}px, ${layout.y}px)`,
    width: layout.w,
    height: layout.h,
    zIndex: layout.z,
  };

  // Runtime-loaded card types (card-types-as-data.md §7) take precedence over the hardcoded views
  // below: if card-types/{type}/ defines a template, the host renders the box (SAME layout
  // subscription — logged spatial state, it drags like any card) and the template renders the
  // interior. The clock lives here now: its body reads the off-log nowSignal through a granted
  // capability, the tick re-renders one interior and commits nothing — same proof, but the proof
  // is now data in the folder instead of code in this file.
  const template = templates.get(node.type);
  if (template)
    return <TemplateCard m={m} id={id} template={template} box={box} selected={selected} />;

  // Feed cards: same shape as the clock — logged spatial state, off-log body (feeds.ts signals).
  if (node.type === "githead") return <GitHeadView box={box} selected={selected} />;
  if (node.type === "hn") return <HnView box={box} selected={selected} />;
  if (node.type === "computed") return <ComputedView m={m} id={id} box={box} selected={selected} />;
  if (node.type === "provenance") return <ProvenanceView m={m} box={box} selected={selected} />;

  // Lenient fallback (design-note cost #4): a typed card whose template hasn't loaded — or failed
  // to — renders a placeholder shell, never crashes and never hard-fails the card. Note and file
  // cards land here for the beat between mount and the registry's first load, then swap to their
  // templates.
  return (
    <div className={`node feed c-${node.color}${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <span className="file-name">{node.title}</span>
        <span className="file-ext">{node.type}</span>
      </div>
      <div className="feed-body feed-waiting">no template for type "{node.type}"…</div>
    </div>
  );
});

// The repo's HEAD commit, live off the githead feed. The meta line re-renders each minute-ish via the
// clock signal so "Xm ago" stays honest without the feed having to re-publish.
function GitHeadView({ box, selected }: { box: React.CSSProperties; selected: boolean }) {
  const head = useSignal(feedSignal<GitHead>("githead"));
  useSignal(nowSignal); // keep the relative timestamp ticking
  return (
    <div className={`node feed c-green${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <span className="file-name">git HEAD</span>
        <span className="file-ext">off-log feed</span>
      </div>
      {head ? (
        <div className="feed-body">
          <div className="feed-big mono">{shortSha(head.sha)}</div>
          <div className="feed-line">{head.message}</div>
          <div className="feed-meta">
            {head.author} · {timeAgo(head.ts)}
          </div>
        </div>
      ) : (
        <div className="feed-body feed-waiting">waiting for feed…</div>
      )}
    </div>
  );
}

// The current HN #1 — the one true-internet feed, for flavour. Identical plumbing to the HEAD card.
function HnView({ box, selected }: { box: React.CSSProperties; selected: boolean }) {
  const story = useSignal(feedSignal<HnStory>("hn"));
  return (
    <div className={`node feed c-orange${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <span className="file-name">HN top story</span>
        <span className="file-ext">off-log feed</span>
      </div>
      {story ? (
        <div className="feed-body">
          <div className="feed-line feed-title">{story.title}</div>
          <div className="feed-meta">
            {story.score} points · by {story.by}
          </div>
        </div>
      ) : (
        <div className="feed-body feed-waiting">waiting for feed…</div>
      )}
    </div>
  );
}

// The computed card: "time since last commit" = clock × git HEAD. Its INPUTS are resolved through the
// authored EdgeRecords pointing at it (a reactive edge query — wiring changes re-render this card),
// and each wired input's TYPE names an off-log signal — a tiny evaluator over named inputs, no formula
// language. The output is derived per render and stored nowhere: authored wiring on the log, flowing
// value off it. Unplug a wire (delete/undo an edge) and the card visibly degrades to "missing input".
function ComputedView({
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
  const edgeQuery = useMemo(
    () => store.query({ typeName: "edge", where: (e) => e.to === id && e.type === "input" }),
    [store, id],
  );
  const edges = useSignal(edgeQuery);
  // Hooks are unconditional, so both input signals are always subscribed; the EDGES decide which ones
  // the evaluation is allowed to see.
  const now = useSignal(nowSignal);
  const head = useSignal(feedSignal<GitHead>("githead"));

  const wired = new Set(edges.map((e) => store.get<"node">(e.from)?.type));
  const missing = ["clock", "githead"].filter((t) => !wired.has(t));

  let body: React.ReactNode;
  if (missing.length > 0) {
    body = <div className="feed-body feed-waiting">unwired — missing input: {missing.join(", ")}</div>;
  } else if (!head) {
    body = <div className="feed-body feed-waiting">waiting for git HEAD…</div>;
  } else {
    body = (
      <div className="feed-body">
        <div className="feed-big">{formatSince(now - head.ts)}</div>
        <div className="feed-line">since last commit</div>
        <div className="feed-meta">= clock × git HEAD, wired by {edges.length} edges</div>
      </div>
    );
  }
  return (
    <div className={`node feed c-pink${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <span className="file-name">time since last commit</span>
        <span className="file-ext">computed</span>
      </div>
      {body}
    </div>
  );
}

// Channel 3, live on the canvas — the demo's money shot. While the clock ticks, the feeds churn and
// the computed card counts, THIS card re-renders only when the intent log grows (logSignal's growth
// check): the channel discipline demos itself by standing still. Newest first, actor badged.
function ProvenanceView({
  m,
  box,
  selected,
}: {
  m: InteractionManager;
  box: React.CSSProperties;
  selected: boolean;
}) {
  const { events, total } = useSignal(logSignal(m.editor));
  return (
    <div className={`node feed c-purple${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <span className="file-name">intent log</span>
        <span className="file-ext">channel 3</span>
      </div>
      <div className="prov-body">
        {events.map((e) => (
          <div key={e.seq} className="prov-row">
            <span className="prov-time">{formatEventTime(e.ts)}</span>
            <span className={`actor-badge actor-${e.actor}`}>{e.actor}</span>
            <span className="prov-type">{e.type}</span>
            <span className="prov-diff">{summarizeDiff(e.diff)}</span>
          </div>
        ))}
      </div>
      <div className="prov-meta">{total} events · one per gesture, none per tick</div>
    </div>
  );
}

function formatSince(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

// The template host: React renders the BOX (position/size off the layout signal, selection ring,
// type class for folder-level theming) and hands the template one container div for the interior.
// The split is the disjoint-state invariant at the component level — a drag updates this
// component's style prop on the host hot path; the template's lit-html render runs only when a
// Subscribable it actually read changes. React never reconciles the container's children, so the
// two renderers share the card without fighting.
function TemplateCard({
  m,
  id,
  template,
  box,
  selected,
}: {
  m: InteractionManager;
  id: Id<"node">;
  template: CardTemplate;
  box: React.CSSProperties;
  selected: boolean;
}) {
  const store = m.editor.store;
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const nodeSub = useMemo(() => store.getSignal<"node">(id), [store, id]);
  const node = useSignal(nodeSub);
  const mount = useRef<ReturnType<typeof mountTemplate> | null>(null);
  const applied = useRef(template);

  // Mount the lit interior ONCE for this card. Deliberately NOT keyed on `template`: a template
  // hot-reload (editing card-types/<type>/render.js on disk) hands this card a NEW template object,
  // but remounting would destroy a focused <input>, stealing focus mid-type. The swap is handled in
  // place by the effect below.
  useEffect(() => {
    if (!ref.current) return;
    const m0 = mountTemplate(
      ref.current,
      template,
      buildCard(nodeSub, template.capabilities, { id, editor: m.editor }),
    );
    mount.current = m0;
    applied.current = template;
    return () => {
      m0.dispose();
      mount.current = null;
    };
    // `template` is intentionally excluded — see above; the swap effect handles a hot-reload in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSub, id, m.editor]);

  // A template hot-reload re-renders the interior IN PLACE via lit's diffing, which preserves the DOM
  // (and a live input's focus + caret) — the registry handing this card's type a new module never
  // tears the card down. Skipped on first run (the mount above already rendered this template).
  useEffect(() => {
    if (applied.current === template) return;
    applied.current = template;
    mount.current?.setTemplate(
      template,
      buildCard(nodeSub, template.capabilities, { id, editor: m.editor }),
    );
  }, [template, nodeSub, id, m.editor]);

  // The interior-interaction seam, as NATIVE listeners (React's synthetic stopPropagation can't stop
  // the canvas's native listeners on its container). Both contain an event before it reaches the
  // canvas, so the shared interaction engine is untouched.
  //   wheel: when over a scrollable region, contain it — the canvas doesn't zoom, the browser
  //     scrolls the region natively. Over a non-scrollable card it bubbles, so zoom-over-a-card works.
  //   pointerdown: when on an interactive control (a <summary> toggle, link, button, or a text
  //     input/textarea), contain it — the canvas never starts a drag and never captures the pointer,
  //     so the native click fires: a <details> toggles, a session input focuses for typing. Read-only
  //     text marked [data-text] is contained ONLY once the card is selected, so the native selection
  //     runs (drag-to-select, ⌘C) instead of a card drag; until then a press there bubbles and
  //     selects/drags the whole card, keeping a file card "drag from anywhere". Elsewhere in the card
  //     it bubbles, so drag-from-body is unchanged.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      // ctrl+wheel is pinch-zoom — leave it for the canvas even over a scrollable card.
      if (!e.ctrlKey && scrollableFromTarget(e.target, host)) e.stopPropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // Genuine interactive controls are contained regardless of selection — clicking one is
      // unambiguous and never a card grab. (The sticky's title/body are inputs and so land here too;
      // CSS makes them pointer-transparent until the card is selected, so the FIRST click selects the
      // card and reaches the canvas, and only a click on the already-selected card focuses them.)
      if (t.closest("summary, a, button, input, textarea, [data-interactive]")) {
        e.stopPropagation();
        return;
      }
      // Read-only text becomes selectable/copyable only once the card is selected. Selection lives as
      // a live class on this same host element across re-renders, so reading it here is current state,
      // not a stale closure.
      if (host.classList.contains("selected") && t.closest("[data-text]")) e.stopPropagation();
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("pointerdown", onPointerDown);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);
  // lit owns .tpl-interior's children and React never reconciles past it (display:contents keeps
  // them direct flex items of the box).
  return (
    <div
      ref={hostRef}
      data-node-id={id}
      className={`node ${template.type} c-${node?.color ?? "grey"}${template.chrome === "bare" ? " bare" : ""}${selected ? " selected" : ""}`}
      style={box}
    >
      <div className="tpl-interior" ref={ref} />
    </div>
  );
}
