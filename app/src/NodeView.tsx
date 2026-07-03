import { memo, useEffect, useMemo, useRef, useState } from "react";
import { layoutId, type Id, type InteractionManager, type LayoutRecord, type NodeRecord } from "./lib";
import { useSignal } from "./reactive";
import { nowSignal } from "./clock";
import { feedSignal, shortSha, timeAgo, type GitHead, type HnStory } from "./feeds";
import { activeBoardId } from "./board";
import { formatEventTime, logSignal } from "./provenance";
import { summarizeDiff } from "./lib";
import { buildCard, mountTemplate, templatesSignal, type CardTemplate } from "./templates";
import { claimWheelGesture, scrollableFromTarget, wheelClaimableByCard } from "./interior";
import { MEMBER_OPEN, postToThread, setThreadHistory } from "./threads";
import { openCanvasLink, resolveCanvasLink } from "./loader";
import { matchTagSpans } from "../channel-tags.js";
import { intentGlyph } from "../work-intent.js";

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
    card = <GitHeadView box={box} selected={selected} />; // feed cards: logged box, off-log body (feeds.ts)
  } else if (node.type === "hn") {
    card = <HnView box={box} selected={selected} />;
  } else if (node.type === "computed") {
    card = <ComputedView m={m} id={id} box={box} selected={selected} />;
  } else if (node.type === "provenance") {
    card = <ProvenanceView m={m} box={box} selected={selected} />;
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
      <div className={`node feed c-${node.color}${selected ? " selected" : ""}`} style={box}>
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
function GitHeadView({ box, selected }: { box: React.CSSProperties; selected: boolean }) {
  const head = useSignal(feedSignal<GitHead>("githead:" + activeBoardId()));
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
// A member's readable display handle: a role-spawned session carries a `.name` ("PM.97acc4bc"); show it as
// "PM.97…" (role + the first 2 of its sid hex) so a member reads as who they are, not a raw hash. No name
// (a plain non-role session) → the original 8-char sid prefix. The full sid stays on the pill's title attr.
function displayHandle(name: string | null | undefined, sid: string): string {
  if (!name || !name.trim()) return sid.slice(0, 8);
  const dot = name.indexOf(".");
  return dot < 0 ? name : `${name.slice(0, dot + 3)}…`;
}
const senderLabel = (from: string, name?: string | null) =>
  from === "human" || from === "system" ? from : displayHandle(name, from);

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
  const feed = useSignal(feedSignal<{ messages: ThreadMsg[]; truncated?: boolean }>("thread:" + id));
  const msgs = feed?.messages ?? [];

  const [description, setDescription] = useState(node.text);
  // Charter render/edit toggle: read mode shows the rendered markdown (MarkdownInline), a click flips to the
  // textarea, blur (or a record change underneath) commits + returns to read mode (Channel UI improvements).
  const [editingDesc, setEditingDesc] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);
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
  const postInputRef = useRef<HTMLInputElement>(null);
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
  // highlight against these entries — by sid OR role name, exactly the set the server (channel-tags.js) wakes.
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
    if (r.ok) { setPost(""); setStatus("posted"); }
    else setStatus(r.error ?? "failed");
  };

  return (
    <div ref={ref} className={`node channel c-${node.color}${selected ? " selected" : ""}`} style={box}>
      <div className="file-head">
        <input
          className="chan-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
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
        <div
          className="chan-description chan-description-view"
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
      )}
      <div className="chan-log" ref={logRef} onScroll={onLogScroll}>
        {feed?.truncated && (
          <span className="chan-empty">…earlier messages dropped (showing the most recent {msgs.length})</span>
        )}
        {msgs.length === 0 ? (
          <span className="chan-empty">no messages yet</span>
        ) : (
          msgs.map((mm) =>
            mm.kind === "intent" ? (
              // A work-intent typed act (threads-as-cards §6): a small card-only status line — who declared
              // what stance toward this work — not a conversation turn. The glyph/tint carry the intent.
              <div key={mm.seq} className={`chan-intent i-${(mm.intent ?? "").replace(":", "-")}`}>
                <span className="chan-intent-glyph">{intentGlyph(mm.intent)}</span>
                <span className="chan-msg-from" title={mm.from}>{senderLabel(mm.from, nameForSid(mm.from))}</span>
                <span className="chan-intent-text">{mm.text}</span>
                <span className="chan-msg-time">{formatEventTime(mm.ts)}</span>
              </div>
            ) : (
              <div key={mm.seq} className={`chan-msg${mm.from === "system" ? " sys" : ""}`}>
                <span className="chan-msg-from" title={mm.from}>{senderLabel(mm.from, nameForSid(mm.from))}</span>
                <span className="chan-msg-time">{formatEventTime(mm.ts)}</span>
                <div className="chan-msg-text">{renderTaggedText(mm.text, openEntries)}</div>
              </div>
            ),
          )
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
        <input
          ref={postInputRef}
          className="chan-post-input"
          placeholder="post… @tag a member to notify, @all for everyone"
          value={post}
          onChange={(e) => setPost(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
        />
        <button onClick={() => void send()}>Send</button>
      </div>
      {status && <span className="chan-status">{status}</span>}
    </div>
  );
}

// The shortest unambiguous id-prefix to tag a member by (min 2 chars), e.g. `a9` when no other member
// shares it — what the member pill drops into the post box so a human never types a full hash. Falls back
// to the first 8-char segment if even that collides. Mirrors the server's prefix resolution (channel-tags.js).
function shortTag(sid: string, all: string[]): string {
  for (let len = 2; len < 8; len++) {
    const p = sid.slice(0, len).toLowerCase();
    if (all.every((o) => o === sid || !o.toLowerCase().startsWith(p))) return sid.slice(0, len);
  }
  return sid.slice(0, 8);
}

type TagEntry = { sid: string; name?: string | null };

// What to drop into the post box when a member pill is clicked. Prefer the READABLE role handle (`@PM`) when
// the member has a name and that role prefix is unambiguous among current members; disambiguate to the full
// `Role.sid` handle on a role-name collision (two PMs); fall back to the shortest unambiguous sid prefix when
// the member is unnamed. Every form resolves server-side (channel-tags.js matches sid OR name prefix).
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

// Render channel message text with @-tags highlighted. A token is highlighted only if it would actually
// resolve — a keyword (@all/@human/…) or a prefix of a current member's sid OR role name — by delegating to
// the SERVER's own matcher (channel-tags.js `matchTagSpans`), so the highlight set never drifts from who a
// tag actually wakes. Highlight-in-place: the shown text equals the logged text. Returns React nodes.
function renderTaggedText(text: string, entries: TagEntry[]): React.ReactNode {
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

// A tight, focused inline markdown renderer for the channel charter (Channel UI improvements). Deliberately
// NOT the lit-html vendor parser (app/vendor/markdown.js): that emits raw target=_blank links and is the
// wrong renderer for React. We handle exactly what a charter needs — [text](href), **bold**, `code`, and
// line breaks — and route link clicks through resolveCanvasLink/openCanvasLink so a link to a card ON the
// canvas FOCUSES that card instead of navigating away (http(s) hrefs stay ordinary external links). Links
// are the point; bold/code are a small courtesy. data-interactive keeps a click off the canvas-drag seam.
const MD_INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
function renderInline(line: string, m: InteractionManager): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let mm: RegExpExecArray | null;
  MD_INLINE.lastIndex = 0;
  while ((mm = MD_INLINE.exec(line))) {
    if (mm.index > last) out.push(line.slice(last, mm.index));
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
      out.push(<strong key={key++}>{mm[3]}</strong>);
    } else if (mm[4] !== undefined) {
      out.push(<code key={key++}>{mm[4]}</code>);
    }
    last = mm.index + mm[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
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
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("keydown", onKeyDown);
    host.addEventListener("pointerdown", onPointerDown);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("keydown", onKeyDown);
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
