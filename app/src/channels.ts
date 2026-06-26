// Channels — the reified agent-coordination layer (agent-to-agent-messaging.md §9, evolved). A CHANNEL is
// a node (a card) whose `text` is an optional DESCRIPTION (Slack-topic style, blank by default — the first
// message carries the framing); a session JOINS by a `member:open` edge (session → channel). A post to the
// channel fans out to every other member (server-side, off-log). 1:1 chat is just
// a 2-member channel. The whole lifecycle rides the SAME addEdge/removeEdge/addNode commands a gesture
// uses — each a validated, attributed, logged, undoable channel-3 act — so this file is only the app-side
// semantics the engine is deliberately blind to (it sees "a typed edge from one node to another").
//
//   member:pending — invited/requested, not yet accepted (dashed). Costs the other side nothing.
//   member:open    — joined; the session receives the channel's fan-out (solid).
//   (removed)       — left / declined / kicked. The membership edge is the off-switch.

import type { Editor, Id } from "./lib";
import { activeBoardId } from "./board";

export const MEMBER_OPEN = "member:open";
export const MEMBER_PENDING = "member:pending";

const shortId = () => crypto.randomUUID().slice(0, 8); // short, human-readable, board-local — clash is ~nil

export function isSessionNode(editor: Editor, nodeId: string): boolean {
  return editor.store.get<"node">(nodeId as Id<"node">)?.type === "session";
}
export function isChannelNode(editor: Editor, nodeId: string): boolean {
  return editor.store.get<"node">(nodeId as Id<"node">)?.type === "channel";
}

// The agent attention-edges this UI owns (member:* / watch:*), as opposed to the system wires (type
// "input") that connect computed cards. Only these get the interactive styling + click-to-act.
export function isAttentionEdge(type: string): boolean {
  return type.startsWith("member:") || type.startsWith("watch:");
}
export function edgeClass(type: string): string {
  return "edge-" + type.replace(/:/g, "-");
}

// Create a fresh channel card at `at`. The `text` is the (optional) description — editable inline like any
// card, blank by default. Returns the new channel node id.
export function createChannel(editor: Editor, at: { x: number; y: number }, title = "channel", description = ""): string {
  const id = `node:chan:${shortId()}` as Id<"node">;
  editor.commit({
    type: "addNode",
    actor: "user",
    payload: { id, type: "channel", title, text: description, color: "purple", x: at.x, y: at.y, w: 300, h: 240 },
  });
  return id;
}

// The membership edge between a session card and a channel (any member:* phase), so a re-join upgrades in
// place rather than stacking duplicates.
function memberEdge(editor: Editor, sessionNode: string, chanId: string): { id: string; type: string } | undefined {
  for (const r of editor.store.getSnapshot().records) {
    if (r.typeName === "edge" && r.from === sessionNode && r.to === chanId && r.type.startsWith("member:")) return r;
  }
  return undefined;
}

// Join a session to a channel (member:open). Idempotent; upgrades a pending invite in place. The human
// drawing the wire is the consent for their own agent (§8 auto-accept). Returns the edge id, or null if
// the ends aren't a session + a channel.
export function joinChannel(editor: Editor, sessionNode: string, chanId: string): string | null {
  if (!isSessionNode(editor, sessionNode) || !isChannelNode(editor, chanId)) return null;
  const existing = memberEdge(editor, sessionNode, chanId);
  const id = (existing?.id ?? `edge:${shortId()}`) as Id<"edge">;
  editor.commit({
    type: "addEdge",
    actor: "user",
    payload: { id, from: sessionNode as Id<"node">, to: chanId as Id<"node">, type: MEMBER_OPEN },
  });
  return id;
}

// Propose membership for a session (member:pending) — the "request to join" the agent then accepts/rejects.
export function inviteToChannel(editor: Editor, sessionNode: string, chanId: string): string | null {
  if (!isSessionNode(editor, sessionNode) || !isChannelNode(editor, chanId)) return null;
  const existing = memberEdge(editor, sessionNode, chanId);
  if (existing) return existing.id; // already invited or joined
  const id = `edge:${shortId()}` as Id<"edge">;
  editor.commit({
    type: "addEdge",
    actor: "user",
    payload: { id, from: sessionNode as Id<"node">, to: chanId as Id<"node">, type: MEMBER_PENDING },
  });
  return id;
}

// Resolve a connect-drag (either direction) to a join: one end must be a session, the other a channel.
export function connectToChannel(editor: Editor, from: string, to: string): void {
  if (isSessionNode(editor, from) && isChannelNode(editor, to)) joinChannel(editor, from, to);
  else if (isChannelNode(editor, from) && isSessionNode(editor, to)) joinChannel(editor, to, from);
  // any other pairing (session↔session, channel↔channel) is a no-op for now
}

// Accept a pending invite: re-put the SAME edge as member:open (addEdge is an upsert by id).
export function acceptMembership(editor: Editor, edgeId: string): void {
  const e = editor.store.get<"edge">(edgeId as Id<"edge">);
  if (!e) return;
  editor.commit({ type: "addEdge", actor: "user", payload: { id: e.id, from: e.from, to: e.to, type: MEMBER_OPEN } });
}

// Leave / decline / kick — remove the membership edge. Future fan-out skips this session.
export function removeMembership(editor: Editor, edgeId: string): void {
  editor.commit({ type: "removeEdge", actor: "user", payload: { id: edgeId as Id<"edge"> } });
}

// Post a message to a channel through the server fan-out endpoint. `from` is the sender's session id, or a
// non-session marker like "human" when the board owner posts from the channel card. Returns a thin ok/error
// so the post box can surface a 403 (not a member) / 404 honestly.
export async function postToChannel(chanId: string, from: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/channel/${encodeURIComponent(chanId)}/message?board=${activeBoardId()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) return { ok: true };
    // The membership/channel checks read the last browser-pushed snapshot, which lags a fresh edit by the
    // ~500ms push debounce. So a post right after creating/joining can momentarily 409 (no snapshot yet) or
    // 403 (the join edge hasn't round-tripped) — transient, worth a retry hint rather than the raw status.
    if (res.status === 409) return { ok: false, error: "board still syncing — try again in a moment" };
    if (res.status === 403) return { ok: false, error: body.error ?? "not a member (or membership still syncing)" };
    return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Set how much of the backlog a member sees: "full" replays the whole history to them on their next read
// (and nudges them), "future" jumps them to the latest. Applies now if they're a live member, else it's
// remembered for when they join. The board owner's per-member control on the channel card.
export async function setChannelHistory(
  chanId: string,
  target: string,
  mode: "full" | "future",
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/channel/${encodeURIComponent(chanId)}/history?board=${activeBoardId()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, mode }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
