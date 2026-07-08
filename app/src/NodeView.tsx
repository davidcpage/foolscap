import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutId, type Id, type InteractionManager, type LayoutRecord, type NodeRecord } from "./lib";
import { useSignal } from "./reactive";
import { nowSignal } from "./clock";
import { feedSignal, shortSha, timeAgo, type GitHead, type HnStory } from "./feeds";
import { activeBoardId } from "./board";
import { formatEventTime, logSignal } from "./provenance";
import { summarizeDiff } from "./lib";
import { buildCard, mountTemplate, templatesSignal, type CardTemplate } from "./templates";
import { claimWheelGesture, scrollableFromTarget, wheelClaimableByCard } from "./interior";
import { MEMBER_OPEN, postToThread, setThreadHistory, setThreadPin } from "./threads";
import { openCanvasLink, openDocLink, resolveCanvasLink, resolveDocLink } from "./loader";
import { matchTagSpans } from "../thread-tags.js";
import { intentGlyph } from "../work-intent.js";
import { makeAnchor, resolveAnchor } from "../anchors.js";
import {
  annotationsSignal,
  anchorRangeIn,
  caretPointAt,
  docWatchersSignal,
  postAnnotationOp,
  rangeFromTextOffsets,
  setCardHighlights,
  textOffsetOf,
  type AnnotationInfo,
} from "./annotations";
import { fileContentSignal } from "./content";

// The spike's own node renderer — the ONLY thing that differs from app/'s NodeView. Every card
// subscribes to the SAME two per-entity channel-1 handles (layout for position/size, node for
// title/color), so a move or recolour re-renders only THAT card — the live-update path rides the
// exact per-entity reactivity the engines already give. File/session CONTENT rides its own off-log
// signal (content.ts / the session feed), read inside the template, so a filesystem change refreshes
// just that one body without ever touching the log. Interiors
// are migrating to runtime-loaded templates (card-types/, doc §7): clock, note, and file live
// there now; the remaining hardcoded views below each go the same way as their capabilities
// (inputs, log view) land in the contract, until this file is just box + dispatch.
export const NodeView = memo(function NodeView({ m, id, screen }: { m: InteractionManager; id: Id<"node">; screen?: boolean }) {
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

  // A floating (anchor "screen") card lives in the screen-space layer, NOT in `.page`. The two layers
  // both map the full node list, and each NodeView renders in exactly one of them: the `screen` flag
  // says which layer is asking. A world card asked-for-by the screen layer (or vice-versa) renders
  // nothing — so a pin/unpin (which flips `anchor`) just moves the card from one layer to the other.
  const floating = layout.anchor === "screen";
  if (floating !== !!screen) return null;

  // World box positions in PAGE space (inside `.page`'s pan/zoom transform). A floating card fills its
  // FloatingFrame, which carries the screen-pixel position; the card itself just stretches to it.
  const box: React.CSSProperties = screen
    ? { position: "absolute", inset: 0, zIndex: layout.z }
    : { transform: `translate(${layout.x}px, ${layout.y}px)`, width: layout.w, height: layout.h, zIndex: layout.z };

  // Runtime-loaded card types (card-types-as-data.md §7) take precedence over the hardcoded views
  // below: if card-types/{type}/ defines a template, the host renders the box (SAME layout
  // subscription — logged spatial state, it drags like any card) and the template renders the
  // interior. The clock lives here now: its body reads the off-log nowSignal through a granted
  // capability, the tick re-renders one interior and commits nothing — same proof, but the proof
  // is now data in the folder instead of code in this file.
  const template = templates.get(node.type);
  let card: React.ReactElement;
  if (template) {
    card = <TemplateCard m={m} id={id} template={template} box={box} selected={selected} />;
  } else if (node.type === "githead") {
    card = <GitHeadView id={id} box={box} selected={selected} />; // feed cards: logged box, off-log body (feeds.ts)
  } else if (node.type === "hn") {
    card = <HnView id={id} box={box} selected={selected} />;
  } else if (node.type === "computed") {
    card = <ComputedView m={m} id={id} box={box} selected={selected} />;
  } else if (node.type === "provenance") {
    card = <ProvenanceView m={m} id={id} box={box} selected={selected} />;
  } else if (node.type === "thread" || node.type === "channel") {
    // "thread" is the node type since threads-as-cards §8 step 2; "channel" is the carried-over legacy
    // type — the same card, so old boards render unchanged.
    card = <ThreadView m={m} id={id} node={node} box={box} selected={selected} />;
  } else {
    // Lenient fallback (design-note cost #4): a typed card whose template hasn't loaded — or failed
    // to — renders a placeholder shell, never crashes and never hard-fails the card. Note and file
    // cards land here for the beat between mount and the registry's first load, then swap to their
    // templates.
    card = (
      <div data-node-id={id} className={`node feed c-${node.color}${selected ? " selected" : ""}`} style={box}>
        <div className="file-head">
          <span className="file-name">{node.title}</span>
          <span className="file-ext">{node.type}</span>
        </div>
        <div className="feed-body feed-waiting">no template for type "{node.type}"…</div>
      </div>
    );
  }

  return screen ? <FloatingFrame m={m} id={id} layout={layout}>{card}</FloatingFrame> : card;
});

// The wrapper for a floating (screen-anchored) card: a screen-positioned box that the card fills. It
// owns the things the engine does for a WORLD card but won't for chrome — moving it, and keeping the
// press off the canvas. Per the interior-seam note, React's synthetic stopPropagation can't stop the
// canvas's NATIVE bindDom listener, so the drag is wired with native listeners: a pointerdown on the
// frame stops the canvas seeing it (no marquee behind the card), selects the card (so Delete / the
// pin-toggle key apply), and — once the pointer actually moves — opens ONE move gesture that coalesces
// every frame into a single diff / IntentEvent / undo step, exactly like a world drag. A press that
// lands on an interactive interior (an input, a button, the minimap's own map surface, which stops the
// event itself) never reaches this listener, so those keep their own behaviour.
function FloatingFrame({
  m,
  id,
  layout,
  children,
}: {
  m: InteractionManager;
  id: Id<"node">;
  layout: LayoutRecord;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const store = m.editor.store;
    const onDown = (e: PointerEvent) => {
      e.stopPropagation(); // the canvas's native listener must not also see this press
      m.selection.set([id]);
      // Read the live layout at grab time (the effect's `layout` closure would be one render stale).
      const l0 = store.get<"layout">(layoutId(id)) as LayoutRecord | undefined;
      if (!l0) return;
      const px = e.clientX;
      const py = e.clientY;
      let gesture: ReturnType<typeof m.editor.beginGesture> | null = null;
      const onMove = (ev: PointerEvent) => {
        const nx = Math.round(l0.x + (ev.clientX - px));
        const ny = Math.round(l0.y + (ev.clientY - py));
        gesture ??= m.editor.beginGesture("moveNode", "user"); // open lazily: a click with no move logs nothing
        gesture.update(() => store.update<LayoutRecord>(layoutId(id), { x: nx, y: ny }));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        gesture?.end({ ids: [id] }, "moveNode");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [m, id]);
  return (
    <div
      ref={ref}
      data-node-id={id}
      className="floating-frame"
      style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.h, zIndex: layout.z }}
    >
      {children}
    </div>
  );
}


// The repo's HEAD commit, live off the githead feed. The meta line re-renders each minute-ish via the
// clock signal so "Xm ago" stays honest without the feed having to re-publish.
function GitHeadView({ id, box, selected }: { id: Id<"node">; box: React.CSSProperties; selected: boolean }) {
  const head = useSignal(feedSignal<GitHead>("githead:" + activeBoardId()));
  useSignal(nowSignal); // keep the relative timestamp ticking
  return (
    <div data-node-id={id} className={`node feed c-green${selected ? " selected" : ""}`} style={box}>
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
function HnView({ id, box, selected }: { id: Id<"node">; box: React.CSSProperties; selected: boolean }) {
  const story = useSignal(feedSignal<HnStory>("hn"));
  return (
    <div data-node-id={id} className={`node feed c-orange${selected ? " selected" : ""}`} style={box}>
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
  const head = useSignal(feedSignal<GitHead>("githead:" + activeBoardId()));

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
    <div data-node-id={id} className={`node feed c-pink${selected ? " selected" : ""}`} style={box}>
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
  id,
  box,
  selected,
}: {
  m: InteractionManager;
  id: Id<"node">;
  box: React.CSSProperties;
  selected: boolean;
}) {
  const { events, total } = useSignal(logSignal(m.editor));
  return (
    <div data-node-id={id} className={`node feed c-purple${selected ? " selected" : ""}`} style={box}>
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

// The thread card (threads-as-cards.md — renamed from the channel card at §8 step 2): a task with a
// conversation attached; the conversation is the focus. Its `title` is the task; its `text` an optional
// BRIEF (blank by default — the first message can carry the framing). It lists its members (the member:*
// edges pointing at it), lets the human post to the fan-out, set a member's history visibility, and edits
// the brief/title inline. Membership is drawn (alt-drag a session onto it) or proposed by an agent;
// accept/leave live on the edge popover. This is a hardcoded React view (like the feed cards), so — unlike
// a template card — it must contain its own interior interactions: native listeners stop an input's
// pointerdown (focus, don't drag the card) and keydown (don't leak Space→pan / Backspace→delete) from
// reaching the canvas. Mirrors TemplateCard's seam.
type ThreadMsg = { seq: number; ts: number; from: string; text: string; kind?: "ask" | "intent"; intent?: string };
// A pinned message (R-PIN): a snapshot flagged as head context, rendered in the collapsible pinned tray.
type PinnedMsg = { seq: number; from: string; text: string; ts: number; pinnedBy?: string; pinnedAt?: number };
// A member's readable display handle: a role-spawned session carries a `.name` ("Coordinator.97acc4bc"); show it as
// "Coordinator.97…" (role + the first 2 of its sid hex) so a member reads as who they are, not a raw hash. No name
// (a plain non-role session) → the original 8-char sid prefix. The full sid stays on the pill's title attr.
function displayHandle(name: string | null | undefined, sid: string): string {
  if (!name || !name.trim()) return sid.slice(0, 8);
  const dot = name.indexOf(".");
  return dot < 0 ? name : `${name.slice(0, dot + 3)}…`;
}
// The human's own turns read as "you" (aligned with session cards, which label the human's turns `you`);
// a server-authored notice stays "system"; an agent shows its readable role handle / short sid.
const senderLabel = (from: string, name?: string | null) =>
  from === "human" ? "you" : from === "system" ? "system" : displayHandle(name, from);

function ThreadView({
  m,
  id,
  node,
  box,
  selected,
}: {
  m: InteractionManager;
  id: Id<"node">;
  node: NodeRecord;
  box: React.CSSProperties;
  selected: boolean;
}) {
  const store = m.editor.store;
  const ref = useRef<HTMLDivElement>(null);
  const edgeQuery = useMemo(
    () => store.query({ typeName: "edge", where: (e) => e.to === id && e.type.startsWith("member:") }),
    [store, id],
  );
  const edges = useSignal(edgeQuery);
  useSignal(useMemo(() => store.query({ typeName: "node" }), [store])); // member titles can change
  // The conversation lives off-log in the server's thread log, streamed on the thread:<id> feed (the same
  // machinery the session/githead cards use). This card is its legible home — the whole point of 4e.
  const feed = useSignal(feedSignal<{ messages: ThreadMsg[]; truncated?: boolean; pins?: PinnedMsg[] }>("thread:" + id));
  const msgs = feed?.messages ?? [];
  const pins = feed?.pins ?? [];
  const pinnedSeqs = useMemo(() => new Set(pins.map((p) => p.seq)), [pins]);

  const [description, setDescription] = useState(node.text);
  // Charter render/edit toggle: read mode shows the rendered markdown (MarkdownInline), a click flips to the
  // textarea, blur (or a record change underneath) commits + returns to read mode (Channel UI improvements).
  const [editingDesc, setEditingDesc] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);
  // Read-mode brief clamps to a few lines so a long brief can't eat the card's vertical space (Thread card UI);
  // a "show more/less" toggle expands it. `descOverflows` (measured only while clamped) decides whether the
  // toggle is needed at all; edit mode still auto-grows (below), unclamped.
  const [descExpanded, setDescExpanded] = useState(false);
  const [descOverflows, setDescOverflows] = useState(false);
  const descViewRef = useRef<HTMLDivElement>(null);
  // The pinned tray is a compact "📌 N" chip in the header that pops open a panel (Thread card UI) — never a
  // full-width amber block stranded mid-card below a long brief.
  const [pinsOpen, setPinsOpen] = useState(false);
  const [title, setTitle] = useState(node.title);
  const [post, setPost] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  // The history visibility last chosen for each member (sid → mode), for the per-member toggle's label.
  // It's the human's last action, not a read-back of the server cursor (which only "means" a mode at the
  // seeding instant), so it resets to the "full" default on reload — honest as a control, not a mirror.
  const [histMode, setHistMode] = useState<Record<string, "full" | "future">>({});
  // Tail-follow the conversation: scroll to the newest message when one arrives, UNLESS the user has
  // scrolled up to read history (then leave them put). `stick` tracks "is at the bottom", set on scroll.
  const logRef = useRef<HTMLDivElement>(null);
  const postInputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);
  // Re-seed the local edit fields when the record changes underneath us (an agent edited the description).
  useEffect(() => setDescription(node.text), [node.text]);
  useEffect(() => setTitle(node.title), [node.title]);
  // Does the clamped read-mode brief actually overflow (i.e. is there more to "show more")? Measured ONLY
  // while collapsed — when expanded the box is its full height, so we leave the last measurement standing
  // (that's what keeps the "show less" affordance visible). Re-runs when the brief text or edit mode changes.
  useEffect(() => {
    const el = descViewRef.current;
    if (!el || editingDesc || descExpanded) return;
    setDescOverflows(el.scrollHeight - el.clientHeight > 2);
  }, [description, editingDesc, descExpanded]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const interactive = (t: EventTarget | null) =>
      t instanceof Element && t.closest("input, textarea, button, [data-interactive]");
    const onPD = (e: PointerEvent) => { if (interactive(e.target)) e.stopPropagation(); };
    const onKD = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea")) e.stopPropagation();
    };
    // Wheel over the scrollable conversation log scrolls it, not the canvas (the same seam TemplateCard
    // uses) — unless the canvas owns the gesture, or the hover wasn't earned by pointing (interior.ts).
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || !wheelClaimableByCard()) return;
      if (scrollableFromTarget(e.target, host)) {
        claimWheelGesture();
        e.stopPropagation();
      }
    };
    host.addEventListener("pointerdown", onPD);
    host.addEventListener("keydown", onKD);
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("pointerdown", onPD);
      host.removeEventListener("keydown", onKD);
      host.removeEventListener("wheel", onWheel);
    };
  }, []);

  const members = edges
    .map((e) => {
      const n = store.get<"node">(e.from);
      return { edgeId: e.id, sid: n?.title ?? "?", name: n?.name ?? null, open: e.type === MEMBER_OPEN };
    })
    .sort((a, b) => Number(b.open) - Number(a.open));
  // Only OPEN members can be tagged/woken (a pending invite isn't a member server-side), so tags resolve and
  // highlight against these entries — by sid OR role name, exactly the set the server (thread-tags.js) wakes.
  const openMembers = members.filter((mem) => mem.open);
  const openEntries = openMembers.map((mem) => ({ sid: mem.sid, name: mem.name }));
  // The readable handle to show for a message's `from` sid (a current member's role name, else short sid).
  const nameForSid = (sid: string) => members.find((mem) => mem.sid === sid)?.name ?? null;
  // Drop an @tag into the post box and focus it (so a human never types a hash). Adds a leading space if
  // the box already has non-space content, and a trailing space so the next word doesn't fuse to the tag.
  const insertTag = (tag: string) => {
    setPost((p) => (p && !p.endsWith(" ") ? p + " " : p) + "@" + tag + " ");
    postInputRef.current?.focus();
  };

  const commitDescription = () => {
    if (description !== node.text) m.editor.commit({ type: "setText", actor: "user", payload: { id, text: description } });
  };
  // Grow the charter textarea to fit its content — no inner scroll/clip while editing (the human ask), to
  // match the auto-height read-mode render. Driven on every change and once on entering edit mode.
  const autosizeDesc = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  // Grow the multiline composer to fit its content up to a cap, then scroll internally — so a multi-paragraph
  // or list message composes without a cramped single line, but never eats the whole card (Thread card UI).
  const POST_MAX_H = 120;
  const autosizePost = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, POST_MAX_H)}px`;
  };
  const finishDescEdit = () => { commitDescription(); setEditingDesc(false); };
  useEffect(() => {
    if (!editingDesc) return;
    const el = descRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autosizeDesc(el);
  }, [editingDesc]);
  // Flip a member between full backlog and future-only, optimistically (the chip label follows the human's
  // click; the server is the source of truth for the cursor itself).
  const toggleHistory = async (sid: string) => {
    const next = (histMode[sid] ?? "full") === "full" ? "future" : "full";
    setHistMode((h) => ({ ...h, [sid]: next }));
    const r = await setThreadHistory(id, sid, next);
    setStatus(r.ok ? `${sid.slice(0, 8)}: ${next === "full" ? "full history" : "future only"}` : (r.error ?? "failed"));
  };
  const commitTitle = () => {
    const t = title.trim() || "thread";
    if (t !== node.title) m.editor.commit({ type: "setTitle", actor: "user", payload: { id, title: t } });
  };
  const send = async () => {
    const t = post.trim();
    if (!t) return;
    setStatus("sending…");
    const r = await postToThread(id, "human", t);
    if (r.ok) {
      setPost("");
      if (postInputRef.current) postInputRef.current.style.height = "auto"; // collapse the grown textarea
      setStatus("posted");
    } else setStatus(r.error ?? "failed");
  };
  // Pin/unpin a message as head context (R-PIN). The feed republishes the pins on success, so the tray and
  // the message's pin glyph update from the live feed — no local pin state to keep in sync.
  const togglePin = async (seq: number) => {
    const pinned = !pinnedSeqs.has(seq);
    const r = await setThreadPin(id, "human", seq, pinned);
    if (!r.ok) setStatus(r.error ?? "pin failed");
  };

  return (
    <div ref={ref} data-node-id={id} className={`node thread c-${node.color}${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <input
          className="chan-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        {pins.length > 0 && (
          // The pinned tray as a compact header chip: it reads "📌 N" and pops the pins panel over the card
          // (absolute, so it never strands as a full-width block mid-card below a long brief — Thread card UI).
          <div className="chan-pins-chip-wrap" data-interactive>
            <button
              className={`chan-pins-chip${pinsOpen ? " open" : ""}`}
              title="pinned head context — the thread's kept-in-view messages"
              onClick={() => setPinsOpen((o) => !o)}
            >
              📌 {pins.length}
            </button>
            {pinsOpen && (
              <div className="chan-pins-panel">
                {pins.map((p) => (
                  <div key={p.seq} className="chan-pin">
                    <span className="chan-msg-from" title={p.from}>{senderLabel(p.from, nameForSid(p.from))}</span>
                    <div className="chan-msg-text">{renderTaggedText(p.text, openEntries, m)}</div>
                    <button
                      className="chan-pin-toggle on"
                      title="unpin — remove from head context"
                      onClick={(e) => { e.stopPropagation(); void togglePin(p.seq); }}
                    >
                      📌
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="file-ext">thread</span>
      </div>
      {editingDesc ? (
        <textarea
          ref={descRef}
          className="chan-description"
          placeholder="add a brief (markdown — links open canvas cards)"
          value={description}
          onChange={(e) => { setDescription(e.target.value); autosizeDesc(e.target); }}
          onBlur={finishDescEdit}
          onKeyDown={(e) => { if (e.key === "Escape") { setDescription(node.text); setEditingDesc(false); } }}
        />
      ) : (
        <>
          <div
            ref={descViewRef}
            className={`chan-description chan-description-view${descExpanded ? "" : " clamped"}`}
            title="click to edit the brief"
            data-interactive
            onClick={() => setEditingDesc(true)}
          >
            {description.trim() ? (
              <MarkdownInline text={description} m={m} />
            ) : (
              <span className="chan-desc-empty">add a brief (markdown — links open canvas cards)</span>
            )}
          </div>
          {(descOverflows || descExpanded) && description.trim() && (
            <button
              className="chan-desc-more"
              data-interactive
              onClick={(e) => { e.stopPropagation(); setDescExpanded((v) => !v); }}
            >
              {descExpanded ? "show less" : "show more"}
            </button>
          )}
        </>
      )}
      <div className="chan-log" ref={logRef} onScroll={onLogScroll}>
        {feed?.truncated && (
          <span className="chan-empty">…earlier messages dropped (showing the most recent {msgs.length})</span>
        )}
        {msgs.length === 0 ? (
          <span className="chan-empty">no messages yet</span>
        ) : (
          // Walk the log, folding each RUN of consecutive system notices (joins/leaves) into one dim, centered
          // block so harness chatter recedes behind the human/agent conversation (Thread card UI). Conversation
          // turns and work-intent lines render individually; the human's own turns get the right-aligned `me`
          // bubble.
          (() => {
            const out: React.ReactNode[] = [];
            for (let i = 0; i < msgs.length; i++) {
              const mm = msgs[i];
              if (mm.kind !== "intent" && mm.from === "system") {
                const run = [];
                while (i < msgs.length && msgs[i].kind !== "intent" && msgs[i].from === "system") { run.push(msgs[i]); i++; }
                i--; // the for-loop will re-increment
                out.push(
                  <div key={`sys-${run[0].seq}`} className="chan-sysrun">
                    {run.map((s) => (
                      <div key={s.seq} className="chan-sysline">· {s.text} ·</div>
                    ))}
                  </div>,
                );
                continue;
              }
              if (mm.kind === "intent") {
                // A work-intent typed act (threads-as-cards §6): a small card-only status line — who declared
                // what stance toward this work — not a conversation turn. The glyph/tint carry the intent.
                out.push(
                  <div key={mm.seq} className={`chan-intent i-${(mm.intent ?? "").replace(":", "-")}`}>
                    <span className="chan-intent-glyph">{intentGlyph(mm.intent)}</span>
                    <span className="chan-msg-from" title={mm.from}>{senderLabel(mm.from, nameForSid(mm.from))}</span>
                    <span className="chan-intent-text">{mm.text}</span>
                    <span className="chan-msg-time">{formatEventTime(mm.ts)}</span>
                  </div>,
                );
                continue;
              }
              out.push(
                <div key={mm.seq} className={`chan-msg${mm.from === "human" ? " me" : ""}${pinnedSeqs.has(mm.seq) ? " pinned" : ""}`}>
                  <div className="chan-msg-head">
                    <span className="chan-msg-from" title={mm.from}>{senderLabel(mm.from, nameForSid(mm.from))}</span>
                    <span className="chan-msg-time">{formatEventTime(mm.ts)}</span>
                    <button
                      className={`chan-pin-toggle${pinnedSeqs.has(mm.seq) ? " on" : ""}`}
                      data-interactive
                      title={pinnedSeqs.has(mm.seq) ? "unpin — remove from head context" : "pin as head context (re-read on every wake)"}
                      onClick={(e) => { e.stopPropagation(); void togglePin(mm.seq); }}
                    >
                      📌
                    </button>
                  </div>
                  <div className="chan-msg-text">{renderMessageBody(mm.text, openEntries, m)}</div>
                </div>,
              );
            }
            return out;
          })()
        )}
      </div>
      <div className="chan-members">
        {members.length === 0 ? (
          <span className="chan-empty">no members — alt-drag a session card onto this channel to join it</span>
        ) : (
          members.map((mem) => {
            const mode = histMode[mem.sid] ?? "full";
            return (
              <span key={mem.edgeId} className={`chan-member${mem.open ? " open" : " pending"}`} title={mem.sid}>
                {mem.open ? (
                  <button
                    className="chan-member-tag"
                    title={`tag @${tagFor(mem, openMembers)} — notify this member`}
                    onClick={() => insertTag(tagFor(mem, openMembers))}
                  >
                    {displayHandle(mem.name, mem.sid)}
                  </button>
                ) : (
                  <>{displayHandle(mem.name, mem.sid)} (invited)</>
                )}
                {mem.open && (
                  <button
                    className="chan-hist"
                    title={`history: ${mode === "full" ? "full backlog" : "future only"} — click to ${mode === "full" ? "limit to new messages" : "replay the full backlog"}`}
                    onClick={(e) => { e.stopPropagation(); void toggleHistory(mem.sid); }}
                  >
                    {mode === "full" ? "all" : "new"}
                  </button>
                )}
              </span>
            );
          })
        )}
      </div>
      <div className="chan-post">
        <textarea
          ref={postInputRef}
          className="chan-post-input"
          rows={1}
          placeholder="post… Enter to send, Shift+Enter for a new line — @tag a member, @all for everyone"
          value={post}
          onChange={(e) => { setPost(e.target.value); autosizePost(e.target); }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline (so lists/paragraphs compose) — the actual bug the
            // human hit. preventDefault on the send path so the newline isn't also inserted.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <button onClick={() => void send()}>Send</button>
      </div>
      {status && <span className="chan-status">{status}</span>}
    </div>
  );
}

// The shortest unambiguous id-prefix to tag a member by (min 2 chars), e.g. `a9` when no other member
// shares it — what the member pill drops into the post box so a human never types a full hash. Falls back
// to the first 8-char segment if even that collides. Mirrors the server's prefix resolution (thread-tags.js).
function shortTag(sid: string, all: string[]): string {
  for (let len = 2; len < 8; len++) {
    const p = sid.slice(0, len).toLowerCase();
    if (all.every((o) => o === sid || !o.toLowerCase().startsWith(p))) return sid.slice(0, len);
  }
  return sid.slice(0, 8);
}

type TagEntry = { sid: string; name?: string | null };

// What to drop into the post box when a member pill is clicked. Prefer the READABLE role handle (`@Coordinator`) when
// the member has a name and that role prefix is unambiguous among current members; disambiguate to the full
// `Role.sid` handle on a role-name collision (two PMs); fall back to the shortest unambiguous sid prefix when
// the member is unnamed. Every form resolves server-side (thread-tags.js matches sid OR name prefix).
function tagFor(mem: TagEntry, open: TagEntry[]): string {
  if (mem.name && mem.name.trim()) {
    const dot = mem.name.indexOf(".");
    const role = dot < 0 ? mem.name : mem.name.slice(0, dot);
    const collides = open.some(
      (o) => o.sid !== mem.sid && o.name && o.name.toLowerCase().startsWith(role.toLowerCase()),
    );
    return collides ? mem.name : role;
  }
  return shortTag(mem.sid, open.map((o) => o.sid));
}

// Highlight the resolved @-tags inside a PLAIN-text run. A token is highlighted only if it would actually
// resolve — a keyword (@all/@human/…) or a prefix of a current member's sid OR role name — by delegating to
// the SERVER's own matcher (thread-tags.js `matchTagSpans`), so the highlight set never drifts from who a
// tag actually wakes. Highlight-in-place: the shown text equals the logged text.
function highlightTags(text: string, entries: TagEntry[]): React.ReactNode {
  const spans = matchTagSpans(text, entries);
  if (spans.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const sp of spans) {
    if (sp.start > last) parts.push(text.slice(last, sp.start));
    parts.push(
      <span key={key++} className="chan-tag">
        {text.slice(sp.start, sp.end)}
      </span>,
    );
    last = sp.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Render channel message text with inline markdown applied AND @-tags highlighted. Markdown is parsed over
// the WHOLE text (renderInline: [text](href) links, **bold**, `code`), and @-tags are highlighted WITHIN the
// resulting plain and bold runs. Parsing markdown first is what keeps a tag INSIDE a bold span (e.g.
// `**…tag @7505562d…**`) from splitting the `**…**` in two — an earlier version highlighted tags first and
// the split left the bold markers unpaired (literal `**`, runaway bold). Tags inside `code`/link labels stay
// literal by design (code is verbatim; a link's text is its label). Line breaks come for free from
// `.chan-msg-text { white-space: pre-wrap }`, so `\n` stays plain text — no <br> needed.
function renderTaggedText(text: string, entries: TagEntry[], m: InteractionManager): React.ReactNode {
  return renderInline(text, m, (run) => highlightTags(run, entries));
}

// Render a message body as readable BLOCKS rather than one pre-wrapped wall of text — the single biggest
// legibility lift for long agent posts, which tend to run on. Blank-line-separated runs become paragraphs
// with real spacing between them; consecutive `- `/`* `/`N.` lines become a bullet/number list. Inline
// markdown + @-tag highlighting still run per block via renderInline, so the tag-inside-bold protection
// documented on renderTaggedText is preserved. Kept deliberately small (paragraphs + lists) — headings and
// tables are rare in a thread post; the shared lit-html codec (vendor/markdown.js) is the wrong renderer
// here (raw target=_blank links, no canvas-link/tag handling).
function renderMessageBody(text: string, entries: TagEntry[], m: InteractionManager): React.ReactNode {
  const render = (run: string) => renderInline(run, m, (r) => highlightTags(r, entries));
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;
  const flushPara = () => {
    if (para.length) {
      blocks.push(<div className="chan-p" key={key++}>{render(para.join("\n"))}</div>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{render(it)}</li>);
      blocks.push(
        list.ordered
          ? <ol className="chan-md-list" key={key++}>{items}</ol>
          : <ul className="chan-md-list" key={key++}>{items}</ul>,
      );
      list = null;
    }
  };
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? numbered)![1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

// A tight, focused inline markdown renderer for the channel charter (Channel UI improvements). Deliberately
// NOT the lit-html vendor parser (app/vendor/markdown.js): that emits raw target=_blank links and is the
// wrong renderer for React. We handle exactly what a charter needs — [text](href), **bold**, `code`, and
// line breaks — and route link clicks through resolveCanvasLink/openCanvasLink so a link to a card ON the
// canvas FOCUSES that card instead of navigating away (http(s) hrefs stay ordinary external links). Links
// are the point; bold/code are a small courtesy. data-interactive keeps a click off the canvas-drag seam.
const MD_INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
// `renderText` (optional) transforms a PLAIN-text run before it's emitted — used by messages to highlight
// @-tags inside plain and bold spans. It defaults to identity, so the charter (MarkdownInline) is unchanged.
function renderInline(
  line: string,
  m: InteractionManager,
  renderText: (run: string) => React.ReactNode = (run) => run,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let mm: RegExpExecArray | null;
  MD_INLINE.lastIndex = 0;
  while ((mm = MD_INLINE.exec(line))) {
    if (mm.index > last) out.push(<Fragment key={key++}>{renderText(line.slice(last, mm.index))}</Fragment>);
    if (mm[1] !== undefined) {
      const href = mm[2];
      const link = resolveCanvasLink(href);
      if (link.external) {
        // stopPropagation so the click doesn't also bubble to the read-mode div's click-to-edit handler.
        out.push(
          <a
            key={key++}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            data-interactive
            onClick={(e) => e.stopPropagation()}
          >
            {mm[1]}
          </a>,
        );
      } else {
        out.push(
          <a
            key={key++}
            className="canvas-link"
            data-interactive
            title={`open ${href} on the canvas`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openCanvasLink(m, href); }}
          >
            {mm[1]}
          </a>,
        );
      }
    } else if (mm[3] !== undefined) {
      out.push(<strong key={key++}>{renderText(mm[3])}</strong>);
    } else if (mm[4] !== undefined) {
      out.push(<code key={key++}>{mm[4]}</code>);
    }
    last = mm.index + mm[0].length;
  }
  if (last < line.length) out.push(<Fragment key={key++}>{renderText(line.slice(last))}</Fragment>);
  return out;
}
function MarkdownInline({ text, m }: { text: string; m: InteractionManager }) {
  // Preserve the author's line breaks (a charter is a short prose block, not flowed paragraphs).
  return (
    <>
      {text.split("\n").map((line, li) => (
        <span key={li}>
          {li > 0 && <br />}
          {renderInline(line, m)}
        </span>
      ))}
    </>
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

// ── doc annotations (docs/doc-annotations.md §6, build-order step 2) ─────────────────────────────
// Highlight-and-comment on file cards, as HOST CHROME over the template's interior — the layer needs
// imperative DOM work over lit's rendered output (Ranges, the CSS Custom Highlight registry, caret
// hit-testing), which the template contract deliberately can't express, and it must never mutate the
// interior lit owns. So: an absolutely-positioned React sibling of .tpl-interior, all data through
// src/annotations.ts. Selection→selector minting is the one rendered-DOM → source mapping (doc §6,
// "the fiddly bit"), done once at creation: the selection's flat text offsets in [data-text] give a
// rendered-text quote, which resolveAnchor re-locates in the SOURCE (fuzzy absorbs the markdown
// syntax delta) so the stored anchor is source-true; if even fuzzy can't place it, the rendered
// quote is stored as-is and the server honestly reports it orphaned. Painting is the reverse, every
// render: each open anchor re-resolves against the CURRENT rendered text (annotations.anchorRangeIn).

// A client point → card-local coordinates (the card is CSS-transformed by the camera; the popover is
// positioned in the card's own pixel space, so divide the on-screen delta by the effective scale).
function cardLocalPoint(host: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = host.getBoundingClientRect();
  const scale = host.offsetWidth > 0 ? r.width / host.offsetWidth : 1;
  return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
}

const ANNO_POP_W = 260; // popover width (style.css .anno-pop) — used to clamp inside the card
// The role a card-armed "watch for comments" binds (P1/W4). The board's standing watcher; the CLI
// (`canvas anno watch --role`) can bind any role. W5 will spawn/wake this role on a qualifying comment.
const DEFAULT_WATCH_ROLE = "Coordinator";
const WATCH_LEVELS = ["all", "mentions", "paused"] as const;

function AnnotationsLayer({
  id,
  path,
  hostRef,
}: {
  id: Id<"node">;
  path: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const annos = useSignal(useMemo(() => annotationsSignal(path), [path]));
  const watchers = useSignal(useMemo(() => docWatchersSignal(path), [path]));
  const source = useSignal(useMemo(() => fileContentSignal("repo", path), [path]));
  const [openId, setOpenId] = useState<string | null>(null);
  const [popAt, setPopAt] = useState<{ x: number; y: number }>({ x: 12, y: 28 });
  // The floating "comment" affordance a fresh selection earns, carrying the selection's flat offsets.
  const [fab, setFab] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
  // The create popover (fab clicked): same offsets, plus the draft text.
  const [draft, setDraft] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
  const [draftText, setDraftText] = useState("");
  // W2: a draft can be a plain comment, an anchored question (kind:"question") with optional choices,
  // or a track-changes suggestion (kind:"suggestion") carrying a replacement for the selected span.
  const [draftKind, setDraftKind] = useState<"note" | "question" | "suggestion">("note");
  const [draftOptions, setDraftOptions] = useState("");
  const [draftReplacement, setDraftReplacement] = useState("");
  const [replyText, setReplyText] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  // What the last paint actually placed, for click hit-testing (range → annotation id).
  const painted = useRef<{ id: string; range: Range }[]>([]);
  // The live popover element + its measured height. The popover grows with its content (replies, reply
  // row) up to max-height:55% of the card, so a fixed height guess under-clamps `top` and the .node box
  // clips the bottom — text the popover's own scroll can't reach because its box overflows the card.
  const popRef = useRef<HTMLDivElement>(null);
  const [popH, setPopH] = useState(0);

  const list = useMemo(() => annos ?? [], [annos]);
  const openAnnos = useMemo(() => list.filter((a) => !a.resolved), [list]);
  const orphans = useMemo(() => openAnnos.filter((a) => a.orphaned), [openAnnos]);
  // W2: questions awaiting a human decision — surfaced as a distinct count on the badge.
  const awaitingQs = useMemo(() => openAnnos.filter((a) => a.state === "awaiting"), [openAnnos]);
  // Track-changes suggestions awaiting an accept/reject — a distinct count on the badge, like awaitingQs.
  const pendingSuggestions = useMemo(() => openAnnos.filter((a) => a.state === "pending"), [openAnnos]);
  const current = openId ? (list.find((a) => a.id === openId) ?? null) : null;

  // PAINT: resolve every visible anchor against the rendered text and publish the ranges. Re-runs on
  // data/toggle changes, and on any interior re-render (lit re-builds the prose DOM on a content
  // change, stranding the old Ranges) via a MutationObserver scoped to the template's interior —
  // never to this layer's own DOM, so popover typing doesn't churn paints. rAF-coalesced.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const el = host.querySelector<HTMLElement>("[data-text]");
      const entries: { id: string; range: Range; resolved: boolean; question: boolean; suggestion: boolean }[] = [];
      if (el) {
        for (const a of list) {
          if (a.orphaned || (a.resolved && !showResolved)) continue;
          const range = anchorRangeIn(el, a.anchor);
          if (range)
            entries.push({
              id: a.id,
              range,
              resolved: a.resolved,
              question: a.kind === "question",
              suggestion: a.kind === "suggestion",
            });
        }
      }
      painted.current = entries;
      const active = entries.filter((e) => e.id === openId).map((e) => e.range);
      // The DRAFTED selection stays marked while its comment is being written: the native selection
      // dies the moment the popover's textarea takes focus, and losing the mark mid-thought (or after
      // an interruption) makes the author forget what they were commenting on.
      if (el && draft) {
        const r = rangeFromTextOffsets(el, draft.start, draft.end);
        if (r) active.push(r);
      }
      // Questions paint in their own bucket (a distinct hue) so an anchored ask reads apart from a plain
      // comment at a glance; the open one still promotes to `active`, resolved to `resolved`.
      const paintable = entries.filter((e) => e.id !== openId);
      setCardHighlights(id, {
        open: paintable.filter((e) => !e.resolved && !e.question && !e.suggestion).map((e) => e.range),
        question: paintable.filter((e) => !e.resolved && e.question).map((e) => e.range),
        suggestion: paintable.filter((e) => !e.resolved && e.suggestion).map((e) => e.range),
        resolved: paintable.filter((e) => e.resolved).map((e) => e.range),
        active,
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    schedule();
    const interior = host.querySelector(".tpl-interior");
    const mo = interior ? new MutationObserver(schedule) : null;
    if (interior && mo) mo.observe(interior, { childList: true, subtree: true, characterData: true });
    return () => {
      mo?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      painted.current = [];
      setCardHighlights(id, null);
    };
  }, [hostRef, id, list, openId, draft, showResolved, source]);

  // CLICK a highlight → open its exchange; click prose that isn't one → close whatever is open.
  // Native listener (the canvas seam is native too); layer chrome handles its own clicks and is
  // excluded, as is a click that just finished a text selection.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || t.closest(".anno-layer")) return;
      if (!t.closest("[data-text]")) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      const caret = caretPointAt(e.clientX, e.clientY);
      // Highlights can NEST (a comment on a phrase inside a comment on the whole sentence), so of all
      // ranges containing the point, open the SMALLEST — first-match made an inner comment unreachable,
      // which read as "my comment disappeared" (it was swallowed by the outer highlight).
      const containing = caret
        ? painted.current.filter((en) => {
            try {
              return en.range.isPointInRange(caret.node, caret.offset);
            } catch {
              return false;
            }
          })
        : [];
      const hit = containing.reduce<{ id: string; range: Range } | null>(
        (best, en) =>
          !best || en.range.toString().length < best.range.toString().length ? en : best,
        null,
      );
      if (hit) {
        setOpenId(hit.id);
        setPopAt(cardLocalPoint(host, e.clientX, e.clientY));
        setFab(null);
        setDraft(null);
      } else {
        setOpenId(null);
      }
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [hostRef]);

  // SELECTION → the comment affordance. On pointerup (a beat later, so the selection is settled),
  // if the selection lives inside this card's [data-text], place the 💬 button at its end; any
  // collapse clears it. Selection is only possible once the card is selected (the [data-text]
  // pointerdown containment in TemplateCard), so this can't fire from a passing drag.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onUp = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".anno-layer")) return;
      setTimeout(() => {
        const el = host.querySelector<HTMLElement>("[data-text]");
        const sel = document.getSelection();
        if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return;
        const start = textOffsetOf(el, range.startContainer, range.startOffset);
        const end = textOffsetOf(el, range.endContainer, range.endOffset);
        if (end <= start) return;
        const rect = range.getBoundingClientRect();
        const p = cardLocalPoint(host, rect.right, rect.bottom);
        setFab({ x: p.x, y: p.y, start, end });
      }, 0);
    };
    const onSelChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setFab(null);
    };
    host.addEventListener("pointerup", onUp);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      host.removeEventListener("pointerup", onUp);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [hostRef]);

  // Clamp a card-local anchor point so the popover stays inside the card box (.node clips overflow).
  // The vertical bound is the popover's MEASURED height (popH, from the layout effect below) so a tall
  // exchange near the card bottom is lifted fully into view rather than clipped; 120 is only the
  // pre-measure fallback for the first frame.
  const clampPop = (p: { x: number; y: number }): { x: number; y: number } => {
    const host = hostRef.current;
    const w = host?.offsetWidth ?? 0;
    const h = host?.offsetHeight ?? 0;
    const ph = popH || 120;
    return {
      x: Math.max(8, Math.min(p.x, Math.max(8, w - ANNO_POP_W - 8))),
      y: Math.max(8, Math.min(p.y, Math.max(8, h - ph - 8))),
    };
  };

  // Measure the popover after each render so clampPop above can bound against its true height. Reading
  // offsetHeight is position-independent, so this converges in one extra render (no reflow loop).
  useLayoutEffect(() => {
    setPopH(popRef.current?.offsetHeight ?? 0);
  }, [current, draft, draftText, replyText, popAt, list, showResolved]);

  // CREATE: mint the selector from the drafted selection. The rendered-text quote re-resolves
  // against the SOURCE so the stored anchor is source-true (see the section comment); if the source
  // isn't loaded or even fuzzy can't place the quote, store the rendered quote — the server will
  // report it orphaned rather than lose the comment.
  const submitDraft = async () => {
    const host = hostRef.current;
    const el = host?.querySelector<HTMLElement>("[data-text]");
    // A suggestion's payload is its replacement, so the note is optional (default it); a comment/question
    // requires its text. The endpoint requires `text`, so a note-less suggestion gets a stand-in label.
    const text = draftKind === "suggestion" ? draftText.trim() || "suggested edit" : draftText.trim();
    if (!el || !draft || !text) return;
    const rendered = el.textContent ?? "";
    const q = {
      exact: rendered.slice(draft.start, draft.end),
      prefix: rendered.slice(Math.max(0, draft.start - 32), draft.start),
      suffix: rendered.slice(draft.end, draft.end + 32),
    };
    const hit = source != null ? resolveAnchor(source, q) : null;
    const anchor = source != null && hit ? makeAnchor(source, hit.start, hit.end) : q;
    const options =
      draftKind === "question"
        ? draftOptions
            .split(/[\n|]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const r = await postAnnotationOp(path, {
      op: "create",
      anchor,
      text,
      author: "human",
      ...(draftKind === "question" ? { kind: "question" } : {}),
      ...(draftKind === "suggestion" ? { kind: "suggestion", replacement: draftReplacement } : {}),
      ...(options.length ? { options } : {}),
    });
    if (r.ok) {
      setDraft(null);
      setDraftText("");
      setDraftKind("note");
      setDraftOptions("");
      setDraftReplacement("");
      document.getSelection()?.removeAllRanges();
    }
  };

  const sendReply = async () => {
    const text = replyText.trim();
    if (!current || !text) return;
    const r = await postAnnotationOp(path, { op: "reply", id: current.id, from: "human", text });
    if (r.ok) setReplyText("");
  };

  // W2: record a decision on the open question — an option `choice` and/or free prose. Flips the
  // question awaiting → answered (the server stamps `answer`); the popover stays up to show it.
  const sendAnswer = async (choice?: string, text?: string) => {
    if (!current) return;
    const body: Record<string, unknown> = { op: "answer", id: current.id, by: "human" };
    if (choice) body.choice = choice;
    if (text) body.text = text;
    if (!body.choice && !body.text) return;
    const r = await postAnnotationOp(path, body);
    if (r.ok) setReplyText("");
  };

  const toggleResolve = async (a: AnnotationInfo) => {
    await postAnnotationOp(path, { op: a.resolved ? "reopen" : "resolve", id: a.id, by: "human" });
    if (!a.resolved) setOpenId(null); // resolving dismisses the exchange; reopen keeps it up
  };

  // Track-changes decision on the open suggestion: accept applies the replacement to the file's bytes
  // (server-side splice) and resolves; reject resolves, bytes untouched. Both dismiss the popover.
  const decideSuggestion = async (op: "accept" | "reject") => {
    if (!current) return;
    const r = await postAnnotationOp(path, { op, id: current.id, by: "human" });
    if (r.ok) setOpenId(null);
  };

  const openFromStrip = (a: AnnotationInfo) => {
    setOpenId(a.id);
    setPopAt({ x: 12, y: 28 });
    setFab(null);
    setDraft(null);
  };

  const pop = clampPop(popAt);
  // The doc's primary watcher (P1/W4) — the first armed role, if any. The chip cycles its wake level
  // all → mentions → paused → (off), and the CLI (`canvas anno watch`) covers multi-role / role choice.
  const watcher = (watchers ?? [])[0] ?? null;
  const cycleWatch = () => {
    if (!watcher) {
      void postAnnotationOp(path, { op: "watch", role: DEFAULT_WATCH_ROLE, level: "all", by: "human" });
      return;
    }
    const i = WATCH_LEVELS.indexOf(watcher.level);
    const next = WATCH_LEVELS[i + 1]; // undefined past `paused` → unwatch (a full cycle back to off)
    if (next) void postAnnotationOp(path, { op: "watch", role: watcher.role, level: next, by: "human" });
    else void postAnnotationOp(path, { op: "unwatch", role: watcher.role, by: "human" });
  };

  return (
    <div className="anno-layer" data-interactive>
      {list.length > 0 && (
        <button
          className={`anno-badge${openAnnos.length === 0 ? " quiet" : ""}`}
          title={`${openAnnos.length} open comment${openAnnos.length === 1 ? "" : "s"} (${list.length} total)${awaitingQs.length ? ` · ${awaitingQs.length} question${awaitingQs.length === 1 ? "" : "s"} awaiting an answer` : ""}${pendingSuggestions.length ? ` · ${pendingSuggestions.length} suggestion${pendingSuggestions.length === 1 ? "" : "s"} to review` : ""} — click to ${showResolved ? "hide" : "show"} resolved`}
          onClick={() => setShowResolved((v) => !v)}
        >
          💬 {openAnnos.length}
          {awaitingQs.length > 0 && <span className="anno-badge-q">❓{awaitingQs.length}</span>}
          {pendingSuggestions.length > 0 && <span className="anno-badge-s">✏️{pendingSuggestions.length}</span>}
        </button>
      )}
      {/* Watch-for-comments chip (P1/W4): arm/re-level/unwatch a watcher on this doc — the "who to wake
          when a comment lands" seat. Click cycles all → mentions → paused → off. */}
      <button
        className={`anno-watch${watcher && watcher.level !== "paused" ? " on" : " quiet"}`}
        title={
          watcher
            ? `watched by ${watcher.role} · ${watcher.level} — click to cycle level / unwatch`
            : "watch this doc for comments — click to arm a watcher"
        }
        onClick={cycleWatch}
      >
        👁{watcher ? ` ${watcher.role}:${watcher.level}` : ""}
      </button>
      {orphans.length > 0 && (
        <div className="anno-strip" title="comments whose quoted text no longer matches this file">
          {orphans.map((a) => (
            <div key={a.id} className="anno-orphan" onClick={() => openFromStrip(a)}>
              <span className="anno-orphan-mark">⚠</span>
              <span className="anno-orphan-quote">“{a.anchor.exact}”</span>
              <span className="anno-orphan-text">{a.text}</span>
            </div>
          ))}
        </div>
      )}
      {fab && !draft && (
        <button
          className="anno-fab"
          style={{ left: Math.max(8, Math.min(fab.x, (hostRef.current?.offsetWidth ?? 200) - 40)), top: fab.y + 4 }}
          title="comment on or ask a question about the selection"
          onClick={() => {
            setDraft(fab);
            setDraftText("");
            setDraftKind("note");
            setDraftOptions("");
            setFab(null);
            setOpenId(null);
          }}
        >
          💬
        </button>
      )}
      {draft && (
        <div ref={popRef} className="anno-pop" style={{ left: clampPop(draft).x, top: clampPop(draft).y }}>
          {/* A draft is a plain comment, an anchored question (§6), or a track-changes suggestion. The
              toggle picks the kind; a question reveals a choices field, a suggestion a replacement field. */}
          <div className="anno-pop-row anno-kind-toggle">
            <button
              className={`anno-btn${draftKind === "note" ? "" : " quiet"}`}
              onClick={() => setDraftKind("note")}
            >
              💬 Comment
            </button>
            <button
              className={`anno-btn${draftKind === "question" ? "" : " quiet"}`}
              title="ask a decision on this span — answered on the doc, not in-session"
              onClick={() => setDraftKind("question")}
            >
              ❓ Ask
            </button>
            <button
              className={`anno-btn${draftKind === "suggestion" ? "" : " quiet"}`}
              title="propose a replacement for this span — accepted or rejected as a unit"
              onClick={() => setDraftKind("suggestion")}
            >
              ✏️ Suggest
            </button>
          </div>
          {draftKind === "suggestion" && (
            <textarea
              className="anno-input anno-replacement"
              placeholder="replace the selected span with…"
              autoFocus
              value={draftReplacement}
              onChange={(e) => setDraftReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
              }}
            />
          )}
          <textarea
            className="anno-input"
            placeholder={
              draftKind === "question"
                ? "ask a question about the selection…"
                : draftKind === "suggestion"
                  ? "why this edit? (optional note)…"
                  : "comment on the selection…"
            }
            autoFocus={draftKind !== "suggestion"}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitDraft();
              }
              if (e.key === "Escape") setDraft(null);
            }}
          />
          {draftKind === "question" && (
            <textarea
              className="anno-input anno-options"
              placeholder="options, one per line (optional)"
              value={draftOptions}
              onChange={(e) => setDraftOptions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
              }}
            />
          )}
          <div className="anno-pop-row">
            <button className="anno-btn" onClick={() => void submitDraft()}>
              {draftKind === "question" ? "Ask" : draftKind === "suggestion" ? "Suggest" : "Comment"}
            </button>
            <button className="anno-btn quiet" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
      {current && (() => {
        const isQuestion = current.kind === "question";
        const isSuggestion = current.kind === "suggestion";
        const qState = current.state; // awaiting | answered | resolved
        const answerable = isQuestion && !current.resolved; // a question still open to a decision
        const decidable = isSuggestion && !current.decision; // a suggestion still open to accept/reject
        return (
        <div ref={popRef} className="anno-pop" style={{ left: pop.x, top: pop.y }}>
          <div className="anno-pop-head">
            {isQuestion && (
              <span className={`anno-qpill ${qState ?? "awaiting"}`} title="anchored question (docs/anchored-async-ask.md)">
                {qState === "answered" ? "answered" : qState === "resolved" ? "resolved" : "awaiting"}
              </span>
            )}
            {isSuggestion && (
              <span className={`anno-spill ${current.decision ?? "pending"}`} title="track-changes suggestion">
                {current.decision ?? "pending"}
              </span>
            )}
            <span className="anno-quote">“{current.anchor.exact}”</span>
            <button className="anno-x" title="close" onClick={() => setOpenId(null)}>✕</button>
          </div>
          {/* A suggestion shows the proposed change as a diff: the anchored span struck through, the
              replacement inserted below it. */}
          {isSuggestion && (
            <div className="anno-diff">
              <div className="anno-diff-old">{current.anchor.exact}</div>
              <div className="anno-diff-new">{current.replacement}</div>
            </div>
          )}
          <div className="anno-msg">
            <span className="anno-from">{current.author}</span>
            <span className="anno-time">{formatEventTime(current.ts)}</span>
            <div className={`anno-text${isQuestion ? " anno-question-text" : ""}`}>
              {isQuestion && "❓ "}
              {isSuggestion && "✏️ "}
              {current.text}
            </div>
          </div>
          {current.replies.map((rep, i) => (
            <div key={i} className="anno-msg reply">
              <span className="anno-from">{rep.from === "human" ? "human" : rep.from.slice(0, 8)}</span>
              <span className="anno-time">{formatEventTime(rep.ts)}</span>
              <div className="anno-text">
                {rep.choice != null && <span className="anno-choice">chose “{rep.choice}”</span>}
                {rep.text}
              </div>
            </div>
          ))}
          {/* W2: answer a question straight from the card — one click per option, or prose in the row
              below. Answering flips awaiting → answered; the asker resolves once satisfied. */}
          {answerable && current.options && current.options.length > 0 && (
            <div className="anno-opts">
              {current.options.map((o) => (
                <button
                  key={o.label}
                  className="anno-opt"
                  title={o.description ?? `answer: ${o.label}`}
                  onClick={() => void sendAnswer(o.label)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {/* Track-changes decision: accept splices the replacement into the file's bytes and resolves;
              reject resolves, bytes untouched. Shown only while the suggestion is still undecided. */}
          {decidable && (
            <div className="anno-opts anno-decide">
              <button
                className="anno-opt anno-accept"
                title="apply the replacement to the file and resolve"
                onClick={() => void decideSuggestion("accept")}
              >
                ✓ Accept
              </button>
              <button
                className="anno-opt anno-reject"
                title="decline — resolve without changing the file"
                onClick={() => void decideSuggestion("reject")}
              >
                ✕ Reject
              </button>
            </div>
          )}
          {current.thread && <div className="anno-escalated">discussion moved to a thread</div>}
          <div className="anno-pop-row">
            <input
              className="anno-input"
              placeholder={answerable ? "answer in prose…" : "reply…"}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") answerable ? void sendAnswer(undefined, replyText.trim()) : void sendReply();
                if (e.key === "Escape") setOpenId(null);
              }}
            />
            {replyText.trim() ? (
              // Typed text swaps Resolve out for the send action: on a question that's an Answer, else a
              // Reply. The send affordance was Enter-only (invisible), and Resolve here would dismiss the
              // popover and lose the unsent draft.
              answerable ? (
                <button className="anno-btn" title="record this as the answer (Enter)" onClick={() => void sendAnswer(undefined, replyText.trim())}>
                  Answer
                </button>
              ) : (
                <button className="anno-btn" title="add your comment to this exchange (Enter)" onClick={() => void sendReply()}>
                  Reply
                </button>
              )
            ) : (
              <button
                className="anno-btn"
                title={current.resolved ? "reopen this comment" : "mark this comment resolved"}
                onClick={() => void toggleResolve(current)}
              >
                {current.resolved ? "Reopen" : "✓ Resolve"}
              </button>
            )}
          </div>
        </div>
        );
      })()}
    </div>
  );
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
      buildCard(nodeSub, template.capabilities, { id, editor: m.editor, m }),
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
      buildCard(nodeSub, template.capabilities, { id, editor: m.editor, m }),
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
      // ctrl+wheel is pinch-zoom — leave it for the canvas even over a scrollable card. Also pass
      // through when the gesture isn't this card's to claim (interior.ts): a pan that slides the card
      // under the cursor stays a pan mid-gesture, and hover the camera delivered (a peek dive landing
      // the cursor on a card) doesn't turn the follow-up nudge-pan into a card scroll.
      if (e.ctrlKey || !wheelClaimableByCard()) return;
      if (scrollableFromTarget(e.target, host)) {
        claimWheelGesture();
        e.stopPropagation();
      }
    };
    // keydown: when focus is in an interior text control (a notebook cell's <textarea>, a future input),
    // contain it so the canvas's keyboard shortcuts never fire mid-type — otherwise Delete/Backspace would
    // delete the card, arrows would scroll it, and v/h would swap tools. Mirrors ChannelView's seam.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [data-interactive]"))
        e.stopPropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // Alt is the canvas-level wire gesture (alt-drag joins a session↔channel; select-tool.ts). It's
      // never an interior interaction, so always let an alt-press reach the canvas — otherwise a press on
      // the card's controls/text (a session card is almost all <summary>/<button>/<input>/[data-text])
      // is contained here and the connect-drag can never start.
      if (e.altKey) return;
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
    // A markdown link in a FILE/DOC card opens its target as a card on the canvas (materialize + focus)
    // instead of letting the <a target=_blank> navigate the browser to `/some.md` — which the SPA reads as
    // a board mount (the "new board with a filename in the URL" bug). Only IN-REPO links are intercepted:
    // resolveDocLink returns null for external/anchor hrefs, so those keep their default new-tab behavior.
    // A relative href resolves against THIS card's own directory; the root comes from its (root,path) id.
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const a = t.closest("a");
      if (!a || !host.contains(a)) return;
      const n = store.get<"node">(id);
      if (n?.type !== "file") return; // only file/doc cards route their links to cards
      const rest = id.startsWith("node:") ? id.slice(5) : ""; // node:<root>:<path>
      const ci = rest.indexOf(":");
      if (ci < 0) return;
      const root = rest.slice(0, ci);
      const selfPath = n.title; // authoritative path (re-keyed with the id on rename)
      const baseDir = selfPath.includes("/") ? selfPath.slice(0, selfPath.lastIndexOf("/")) : "";
      const target = resolveDocLink(root, baseDir, a.getAttribute("href") ?? "");
      if (!target) return; // external / anchor → let the <a> do its default
      e.preventDefault();
      e.stopPropagation();
      void openDocLink(m, id, target.root, target.path);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("keydown", onKeyDown);
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("click", onClick);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("click", onClick);
    };
  }, []);
  // lit owns .tpl-interior's children and React never reconciles past it (display:contents keeps
  // them direct flex items of the box). The annotations layer is a React SIBLING of the interior
  // (host chrome, like the selection ring): file cards on the canonical root only — annotations are
  // keyed by repo-relative path and deliberately don't fork per worktree (the server refuses ?root=).
  return (
    <div
      ref={hostRef}
      data-node-id={id}
      className={`node ${template.type} c-${node?.color ?? "grey"}${template.chrome === "bare" ? " bare" : ""}${selected ? " selected" : ""}`}
      style={box}
    >
      <div className="tpl-interior" ref={ref} />
      {template.type === "file" && node && id.startsWith("node:repo:") && (
        <AnnotationsLayer id={id} path={node.title} hostRef={hostRef} />
      )}
    </div>
  );
}
