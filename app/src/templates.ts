import { nothing, render as litRender } from "../vendor/lit-html.js";
import type { Editor, Id, InteractionManager, Subscribable } from "./lib";
import { nowSignal } from "./clock";
import { feedSignal, onFeedsReconnect } from "./feeds";
import { fileContentSignal, writeFileContent, dirListingSignal, sessionListSignal, refreshSessionList, hideSession, channelListSignal, refreshChannelList, rolesListSignal, refreshRolesList, rootsSignal, goneSignal, type DirListing, type RootInfo } from "./content";
import { openSession, openChannel, openRole, requestThreadJump, spawnLiveSession, materializeAt, cascadeFrom, renameFileNodes, type RootId } from "./loader";
// The role.md codec — the ONE source for `role.md text <-> {name,colour,charter}`, shared with the server
// ledger (role-ledger.js). The host parses/serialises here so the role CARD stays a pure view (it can only
// import /vendor/, never this) — exactly how the host hands cards parsed sessionList/dirListing data.
import { parseRoleFile, renderRoleFile } from "../role-format.js";
import { cellOutputsSignal, runCell, syncCells, type CellSpec } from "./notebook-runtime";
import { weatherSignal, type WeatherData } from "./weather";
import { activeBoardId } from "./board";

// A board-scoped feed (e.g. `githead:<boardId>`): the repo a feed reflects is this tab's board. The
// boardId isn't known at module-load (resolveBoard runs first), so resolve it LAZILY at first subscribe —
// always after boot, since a card can only subscribe once it's rendered. Cached so the handle is stable.
function boardFeedSignal(prefix: string): Subscribable<unknown> {
  let inner: Subscribable<unknown> | null = null;
  const resolve = (): Subscribable<unknown> => (inner ??= feedSignal(prefix + ":" + activeBoardId()));
  return { get: () => resolve().get(), subscribe: (cb) => resolve().subscribe(cb) };
}

// The card-type registry + template host (card-types-as-data.md §3, experiment §7). Types are
// folders under card-types/ — type.yaml (capability grant) + render.js (the interior, loaded with
// a browser-native import()). Three rules enforced here, because this is the only place templates
// touch the app:
//
//   1. CAPABILITY-PASSING, NEVER AMBIENT. A template gets a `card` object holding exactly the
//      signals its type.yaml names (from CAPABILITY_SIGNALS below) plus the node's content fields.
//      No store, no editor, no InteractionManager. The import graph proves it: render.js may
//      import only /vendor/lit-html.js (the headless test greps for this).
//   2. THE HOST OWNS SPACE. mountTemplate renders into the interior of a box the renderer
//      positions; x/y/w/h/z, camera, and selection never reach the template. A drag re-renders
//      the host's box style and the template not at all.
//   3. FINE-GRAINED REFRESH ON THE SUBSCRIBABLE SEAM. Reading a capability inside render() is
//      what subscribes the card to it — a tiny read-tracker over Subscribable<T>, no signia
//      import (the substrate stays hidden, same rule as everywhere else in the spike). TiddlyWiki's
//      coarse-refresh failure, fixed at the seam itself.

export interface CardFields {
  title: string;
  text: string;
  color: string;
  name?: string; // optional display handle (NodeRecord.name) — a card renders this in preference to its
  // title where present (e.g. a role-spawned session's "<RoleName>.<short-sid>"); absent → fall back to title.
}

// What a template receives — the whole v1 contract surface. `signals` holds only the capabilities
// the type declared; reading a property tracks it.
export interface CardApi {
  fields: CardFields;
  signals: Record<string, unknown>;
  // The card's ROOT (worktree-activity slice B): parsed from its node id (`node:<root>:<path>`), so a
  // file/directory template knows which worktree it belongs to without a new field. "repo" (the
  // canonical checkout) for non-file cards and any id that doesn't carry a root — harmless there.
  root: RootId;
}

export interface CardTemplateModule {
  contract?: number;
  render(card: CardApi): unknown;
  dispose?(): void;
}

export interface CardTemplate {
  type: string;
  contract: number;
  capabilities: string[];
  // "bare" → the host skips the resting frame (file-trees-on-canvas.md §7): no border/background/shadow,
  // the card paints onto transparent ground. The AABB box is UNCHANGED — spatial index, hit-testing, and
  // edge anchoring still see a rectangle — and the host still draws a selection ring so it stays
  // discoverable. One declarative field + one branch in the host; non-rectangular geometry stays out.
  chrome?: string;
  // Optional resize aspect-ratio (w/h): a card type that reads as a shape, not a rectangle, pins its
  // proportions so a corner drag scales it uniformly (the round clock → `aspect: 1`, always square).
  // The host hands this to the interaction layer's resize as a per-node lock; absent = free resize.
  aspect?: number;
  // `aspect: auto` instead of a number: the ratio isn't fixed by the TYPE but by each card's CONTENT —
  // an image card locks to whatever proportions it currently has (set to the image's own aspect at drop).
  // The host resolves this to the node's live w/h ratio; can't live in the static `aspect` number.
  aspectAuto?: boolean;
  module: CardTemplateModule;
}

// The off-log signals a type.yaml may request — the spike-derived capability list from the design
// note. Adding a capability means adding a line here, not widening what templates can reach for.
// A role edit card's title is its role.md path `.canvas/roles/<roleId>/role.md`; the roleId is the segment
// after `roles/`. parseRoleFile takes the id as given (it knows it from the path), so we recover it here for
// the `roleDoc`/`roleSave` capabilities. Falls back to "" for a malformed path (then name defaults to "").
function roleIdFromDocPath(path: string): string {
  const m = /(?:^|\/)\.canvas\/roles\/([^/]+)\/role\.md$/.exec(path);
  return m ? m[1]! : "";
}

const CAPABILITY_SIGNALS: Record<string, Subscribable<unknown>> = {
  now: nowSignal,
  githead: boardFeedSignal("githead"), // this board's repo HEAD (githead:<boardId>)
  hn: feedSignal("hn"),
  usage: feedSignal("usage"), // account-level plan windows, polled server-side (vite-fs-plugin.ts)
  sessionList: sessionListSignal, // the historical-transcript list (GET /api/sessions), the sessions card's body
  channelList: channelListSignal, // the persisted-channel list (GET /api/channels), the channels card's body
  rolesList: rolesListSignal, // this board's roles (GET /api/roles), the roles card's body (agent-roles.md)
  roots: rootsSignal, // the board's roots (canonical + git worktrees), each with a colour — worktree-activity slice B/C
};

// The per-card WRITE capabilities a type.yaml may request: capability name → the command's payload
// key. The command name equals the capability name (setText/setTitle/setColor in core/src/commands),
// so a grant is one bound action committing that one command for this one node. Add a write power
// here, not by widening what templates can reach.
const WRITE_CAPS: Record<string, string> = {
  setText: "text",
  setTitle: "title",
  setColor: "color",
};

// The card's own host context — the one node identity and the editor handle buildCard needs to mint
// per-card WRITE capabilities (setText/setTitle). Kept off the CardApi the template sees: a template
// gets the bound, named action, never the editor or the id, so the capability stays scoped (you can
// only edit YOUR OWN node, and only via the two commands you were granted).
export interface CardHost {
  id: Id<"node">;
  editor: Editor;
  // The full manager, for the few capabilities that perform an authored canvas ACT placed relative to
  // this card — the browsers' double-click open (sessionOpen/fsOpen), which commits a new node offset
  // from THIS card's box (cascadeFrom needs the viewport + layout). Still never handed to the template:
  // the capability is the bound, scoped action; `m` stays host-side, like `editor`.
  m: InteractionManager;
}

// ── read-tracking over Subscribable<T> ──────────────────────────────────────────────────────────

let trackingReads: Set<Subscribable<unknown>> | null = null;

function tracked<T>(s: Subscribable<T>): T {
  trackingReads?.add(s as Subscribable<unknown>);
  return s.get();
}

// The live mount handle: re-render the interior in place by swapping its template/card, or tear it
// down. setTemplate is the HOT-RELOAD seam — a template edit on disk re-renders through lit's diff
// against the existing DOM (a focused input keeps its focus and caret), never a remount.
export interface TemplateMount {
  setTemplate(template: CardTemplate, card: CardApi): void;
  dispose(): void;
}

// Render into `container`, re-rendering whenever a Subscribable that the LAST render actually read
// changes — dependencies re-collected each pass, so conditional reads track correctly. Returns a
// mount handle. This is the doc's "signia reactor" delivered on the Subscribable seam itself.
export function mountTemplate(
  container: HTMLElement,
  template: CardTemplate,
  card: CardApi,
): TemplateMount {
  const subs = new Map<Subscribable<unknown>, () => void>();
  let disposed = false;
  // The current template/card are mutable so a hot-reload can swap them and re-render in place,
  // rather than disposing and remounting (which would destroy a focused input — the focus-loss bug).
  let curTemplate = template;
  let curCard = card;

  const pass = () => {
    if (disposed) return;
    // Stick-to-bottom for a live region (the session card's streamed output). A template marks its
    // live scroll region with [data-autoscroll]; if the user is already at the bottom BEFORE this
    // render, re-pin them after — otherwise streamed output lands below the fold and "disappears"
    // until they remember to scroll. Measured before litRender mutates the (reused) DOM; if they've
    // scrolled up to read history, leave their position alone. Ephemeral view state, so it's host
    // chrome like scroll itself — outside the template contract.
    const live = container.querySelector<HTMLElement>("[data-autoscroll]");
    const pinned = live ? live.scrollHeight - live.scrollTop - live.clientHeight < 24 : false;
    const reads = new Set<Subscribable<unknown>>();
    trackingReads = reads;
    try {
      litRender(curTemplate.module.render(curCard), container);
    } finally {
      trackingReads = null;
    }
    if (pinned) {
      const after = container.querySelector<HTMLElement>("[data-autoscroll]");
      if (after) after.scrollTop = after.scrollHeight;
    }
    for (const s of reads) if (!subs.has(s)) subs.set(s, s.subscribe(schedule));
    for (const [s, off] of subs) if (!reads.has(s)) (off(), subs.delete(s));
  };

  // Coalesce a burst of signal changes into one render per frame — the same beat the renderer runs at.
  let queued = false;
  const schedule = () => {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      pass();
    });
  };

  pass();
  return {
    setTemplate(t, c) {
      if (disposed) return;
      curTemplate.module.dispose?.(); // the OLD module's author-cleanup hook — NOT a DOM teardown
      curTemplate = t;
      curCard = c;
      pass(); // lit diffs the new render against the live DOM → focus + scroll position preserved
    },
    dispose() {
      disposed = true;
      for (const off of subs.values()) off();
      subs.clear();
      curTemplate.module.dispose?.();
      litRender(nothing, container);
    },
  };
}

// Parse the rootId out of a node id (`node:<root>:<path>`). The root is colon-free (a slug), so the first
// two colons bound it; ids without a (root, path) shape (node:clock, node:session:<id>) don't match and
// fall back to the canonical "repo" — which those cards never read, so the fallback is harmless.
function rootOfId(id: string): RootId {
  const m = /^node:([^:]+):/.exec(id);
  return (m ? m[1] : "repo") as RootId;
}

// Build the capability object for one card: content fields off the node's channel-1 handle, plus
// the declared off-log signals. All reads route through tracked(), so render-time access = subscription.
// The directory card's expand-set (open-folder `treeState`), kept by node id so it survives the card's
// unmount→remount when the HUD is toggled closed and reopened (a per-mount closure reset it each time). Value
// only — never persisted to the log or reload (session-local view state, file-trees-on-canvas.md §9).
const TREE_STATE = new Map<string, unknown>();

export function buildCard(
  nodeSub: Subscribable<{ title: string; text: string; color: string; name?: string } | undefined>,
  capabilities: string[],
  host?: CardHost,
): CardApi {
  const signals: Record<string, unknown> = {};
  // The card's root (worktree-activity slice B) — which checkout/worktree its (root, path) reference is in.
  const root: RootId = host ? rootOfId(host.id) : "repo";
  for (const name of capabilities) {
    // `setText`/`setTitle`/`setColor` are the WRITE capabilities — the "validated commit surface" the
    // design note defers, kept deliberately narrow: a per-card ACTION (not a signal, like
    // sessionInput) bound to ONE node and ONE command, with actor "user" so the edit lands on the
    // intent log undoable and provenance-tagged. The template gets the bound fn, never the editor —
    // it can edit its own text/title/color and commit nothing else. The sticky-note card uses these.
    // WRITE_CAPS maps the capability name to the command's payload key (the command name IS `name`).
    if (WRITE_CAPS[name] && host) {
      const { id, editor } = host;
      const key = WRITE_CAPS[name]!;
      signals[name] = (value: string): void => {
        editor.commit({ type: name, actor: "user", payload: { id, [key]: value } });
      };
      continue;
    }
    // `session` is the one PER-CARD capability: each session card reads a DIFFERENT feed, keyed by
    // its own session id (carried in the title), so it can't live in the global CAPABILITY_SIGNALS
    // map. Resolved once here (the id is immutable after creation). It's the live transcript tail —
    // derived/channel-1, the clock's pattern with a session in it (agent-sessions §3,
    // session-timelines.md §5); reading it re-renders the card without ever touching the log.
    if (name === "session") {
      const feed = feedSignal("session:" + (nodeSub.get()?.title ?? ""));
      Object.defineProperty(signals, "session", { enumerable: true, get: () => tracked(feed) });
      continue;
    }
    // `fileContent` is a PER-CARD off-log capability shaped exactly like `session`: each file card
    // reads a DIFFERENT content signal, keyed by its own path (carried in the title), so it can't
    // live in the global CAPABILITY_SIGNALS map. The content is projected from disk (content.ts) —
    // derived/channel-1, fetched + kept live by the repo watch, NEVER the log — so the durable log
    // holds only the card's arrangement and this (root, path) reference (root is the one allow-listed
    // `repo`, as everywhere). Reading it re-renders the card on a disk change without any setText.
    if (name === "fileContent") {
      const content = fileContentSignal(root, nodeSub.get()?.title ?? "");
      Object.defineProperty(signals, "fileContent", { enumerable: true, get: () => tracked(content) });
      continue;
    }
    // `writeFile` is the notebook card's serialize-back ACTION (docs/notebook-card.md §13): a per-card
    // bound fn that POSTs new content for THIS card's (root, path) to disk (content.ts → POST /api/file).
    // Source lives in the FILE, not record.text (§4), so an edit is a file write, NOT a setText on the
    // log — the watcher then refreshes `fileContent` on every card viewing this path. Keyed by the card's
    // own (root, path) like `fileContent`, so a card can only write its own backing file. Not read-tracked
    // (writing is an act, not a dependency), mirroring sessionInput.
    if (name === "writeFile") {
      const path = nodeSub.get()?.title ?? "";
      signals.writeFile = (content: string): Promise<boolean> => writeFileContent(root, path, content);
      continue;
    }
    // `roleDoc` is the role edit card's PARSED view of its role.md (agent-roles.md 2b). Shaped like
    // `fileContent` — keyed by this card's path (the title = `.canvas/roles/<roleId>/role.md`) — but the host
    // PARSES the file text with the shared role-format codec before handing it over, so the card receives a
    // structured {roleId, name, colour, charter} (never raw text + a parser — the card can't import the codec).
    // Reading it tracks the underlying file signal, so an external role.md edit (or our own save) re-renders.
    // `undefined` until the first fetch lands (a fresh card / pre-signal), so the template shows a loading state.
    if (name === "roleDoc") {
      const path = nodeSub.get()?.title ?? "";
      const roleId = roleIdFromDocPath(path);
      // role.md lives under the REPO root (.canvas/roles/<id>/role.md), but this card's id is `node:role:<id>`,
      // so the scope `root` (derived from the id prefix via rootOfId) would be the bogus root `role` → /api/file
      // 400s → roleDoc never loads (card stuck on "loading…"). Pin to "repo", where the file actually is.
      const content = fileContentSignal("repo", path);
      Object.defineProperty(signals, "roleDoc", {
        enumerable: true,
        get: () => {
          const text = tracked(content);
          return text == null ? undefined : parseRoleFile(text, roleId);
        },
      });
      continue;
    }
    // `roleSave` is the role edit card's serialize-back ACTION (agent-roles.md 2b): the host serialises the
    // edited {name, colour, charter} with the SAME role-format codec the ledger uses (renderRoleFile) and
    // writes role.md back through the file path (writeFileContent → POST /api/file), exactly like the notebook
    // card's `writeFile`. The watcher then refreshes `roleDoc` on this card (and pings the roles list). Keyed
    // by the card's own path, so a card can only write its own role.md. Not read-tracked — saving is an act.
    if (name === "roleSave") {
      const path = nodeSub.get()?.title ?? "";
      // Same as roleDoc: write to the REPO root, not the `role` root the id prefix would otherwise yield.
      signals.roleSave = (doc: { name: string; colour?: string | null; charter?: string }): Promise<boolean> =>
        writeFileContent("repo", path, renderRoleFile({ name: doc.name, colour: doc.colour ?? undefined, charter: doc.charter }));
      continue;
    }
    // `cellOutputs` is the notebook card's OFF-LOG cell-output projection (notebook-runtime.ts), keyed by
    // this card's node id — the `fileContent` shape applied to derived run results (cellId → {status,
    // value, error}). Reading it during render subscribes the card, so a finished run re-renders just this
    // card; never persisted (recomputed/cached, §4). A no-op key when there's no host (the headless mock).
    if (name === "cellOutputs") {
      const sig = cellOutputsSignal(host?.id ?? nodeSub.get()?.title ?? "");
      Object.defineProperty(signals, "cellOutputs", { enumerable: true, get: () => tracked(sig) });
      continue;
    }
    // `runCell` is the notebook card's manual-run ACTION (docs/notebook-card.md §6): force ONE module cell
    // to run now (the Run button / a manual cell's trigger), overriding its policy. The runtime
    // (notebook-runtime.ts — the only place a Worker is made) already holds the cell's source + wiring from
    // `syncCells`, so this just names the cell. Keyed by the same node id as cellOutputs so a run lands on
    // the card that asked. Not read-tracked — running is an act.
    if (name === "runCell") {
      const cardKey = host?.id ?? nodeSub.get()?.title ?? "";
      signals.runCell = (cellId: string): void => runCell(cardKey, cellId);
      continue;
    }
    // `syncCells` is the notebook card's graph-feed ACTION (docs/notebook-card.md §5): the template parses
    // its `.html` source and hands the cell list (id/source/in/out/policy) to the reactive scheduler, which
    // diffs it and (re)builds the dependency DAG. Called from render but DIFF-GUARDED in the runtime (a
    // no-op when the spec set is unchanged), so it rides the same render beat as fileContent without
    // re-running cells on an unrelated re-render. Keyed by this card's node id. Not read-tracked.
    if (name === "syncCells") {
      const cardKey = host?.id ?? nodeSub.get()?.title ?? "";
      signals.syncCells = (cells: CellSpec[], opts?: { mainRealmAllowed?: boolean }): void => syncCells(cardKey, cells, opts);
      continue;
    }
    // `gone` (slice D): true once this card's (root, path) backing is deleted on disk (the watch's unlink
    // or a 404). The file/dir card reads it to render a TOMBSTONE instead of content / a stuck "loading…".
    // Per-card (keyed by this card's root + path). Worktree-removal isn't tracked here — the card derives
    // that reactively from `roots` (its root dropping out of the list).
    if (name === "gone") {
      const sig = goneSignal(root, nodeSub.get()?.title ?? "");
      Object.defineProperty(signals, "gone", { enumerable: true, get: () => tracked(sig) });
      continue;
    }
    // `dirListing` is the directory card's PER-CARD off-log capability — a CALLABLE keyed by PATH, not a
    // single own-path signal. The directory card is an in-card TREE: it reads its own root's children AND
    // each expanded sub-folder's children, so it calls dirListing(path) per visible level. Each call is
    // read-tracked, so an expanded folder subscribes its own listing and a collapsed one drops the
    // subscription on the next render (read reconciliation). Children come from disk (content.ts
    // dirListingSignal, /api/ls, lazy per path) — derived/channel-1, never the log; the durable log holds
    // only the card's arrangement + its (root, path). DRAGGING a row onto the canvas is the one act that
    // promotes it (loader.materializeAt). `repo` is the one allow-listed root, as everywhere.
    if (name === "dirListing") {
      // (rootId, path) → that root's listing. The combined "File tree" card spans MANY roots, so the
      // capability takes the root explicitly rather than closing over this card's own `root`.
      signals.dirListing = (rootId: string, path: string): DirListing | undefined =>
        tracked(dirListingSignal(rootId, path));
      continue;
    }
    // `weather` is the weather card's PER-CARD off-log capability — a CALLABLE keyed by a free-text
    // location query (the card's title), exactly the shape `dirListing` uses. It's a callable rather
    // than a single own-query signal because the query is EDITABLE: the card reads its own title and
    // calls weather(title) each render, so retyping the location subscribes the new query's signal and
    // drops the old one (read reconciliation), where a mount-time-resolved signal (like fileContent)
    // would freeze the location at creation. The value comes from /api/weather → Open-Meteo, fetched
    // server-side (weather.ts) — derived/channel-1, never the log; the durable log holds only the card's
    // arrangement and its title. Each call is read-tracked, so a refresh re-renders just this card.
    if (name === "weather") {
      signals.weather = (query: string): WeatherData | undefined => tracked(weatherSignal(query));
      continue;
    }
    // `treeState` is per-card EPHEMERAL view state (the directory card's expand-set): a tiny read-tracked,
    // settable Subscribable so a LOCAL toggle re-renders the card exactly as a signal change would. It is
    // never committed, never logged, gone on reload — browsing a tree is "derived by default"
    // (file-trees-on-canvas.md §9), so which folders are open is view state, not authored state. The one
    // bit of mutable view-state the contract grants a template; reading get() during render subscribes the
    // card, set() notifies it.
    //
    // The VALUE lives in a module-level map keyed by node id (TREE_STATE), NOT a per-mount closure: the
    // File Tree HUD card is unmounted when the HUD closes and remounted on reopen, so a per-mount closure
    // would reset every folder to collapsed each time (the reported bug). Backing it by node id lets the
    // expand-set survive close→reopen while staying session-local (the map is gone on page reload, matching
    // the "never persisted" contract). Watchers stay per-mount — the old render's subscribers are gone with
    // its DOM — so only `value` is shared across mounts, not the notify set.
    if (name === "treeState") {
      const key = host ? host.id : "";
      const watchers = new Set<() => void>();
      const sub: Subscribable<unknown> = {
        get: () => TREE_STATE.get(key),
        subscribe(fn) {
          watchers.add(fn);
          return () => watchers.delete(fn);
        },
      };
      signals.treeState = {
        get: (): unknown => tracked(sub),
        set: (next: unknown): void => {
          TREE_STATE.set(key, next);
          for (const fn of watchers) fn();
        },
      };
      continue;
    }
    // `sessionInput` is the duplex's INPUT half (agent-sessions §3) — a per-card ACTION, not a
    // signal: a bound fn the template calls to send a prompt into its live session. It is
    // SESSION-INTERNAL (session-timelines §4): a plain POST to the registry, never editor.commit and
    // never a canvas-log entry. Not read-tracked — sending input is an act, not a dependency. This is
    // the "template that both reads a feed and commits" the contract had to be able to express.
    if (name === "sessionInput") {
      const id = nodeSub.get()?.title ?? "";
      signals.sessionInput = (text: string): Promise<boolean> =>
        fetch(`/api/session/${encodeURIComponent(id)}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }).then((r) => r.ok, () => false);
      continue;
    }
    // `sessionResume` is the unify-on-resume handoff (slice 3): a per-card ACTION (like sessionInput,
    // not a signal) that recommences this card's historical session as a live process IN PLACE. The
    // server seeds the live feed from the .jsonl and `--resume`s; because the feed is keyed by this
    // same id, the card flips itself from static transcript to live duplex. Session-internal: a POST,
    // never editor.commit, never a canvas-log entry (session-timelines §4).
    if (name === "sessionResume") {
      const id = nodeSub.get()?.title ?? "";
      signals.sessionResume = (): Promise<boolean> =>
        fetch(`/api/session/${encodeURIComponent(id)}/resume?board=${activeBoardId()}`, {
          method: "POST",
        }).then(
          (r) => r.ok,
          () => false,
        );
      continue;
    }
    // `sessionDone` is the Phase-2 explicit teardown: a per-card ACTION (like sessionResume) that POSTs
    // /done to end this card's live session — terminate the process AND record `endReason:"done"` on the
    // durable marker, so the card settles into the calm "✓ done" band. Session-internal: a POST, never
    // editor.commit, never a canvas-log entry. The id is the live UUID, globally unique, so no ?board=.
    if (name === "sessionDone") {
      const id = nodeSub.get()?.title ?? "";
      signals.sessionDone = (): Promise<boolean> =>
        fetch(`/api/session/${encodeURIComponent(id)}/done`, { method: "POST" }).then(
          (r) => r.ok,
          () => false,
        );
      continue;
    }
    // `sessionPermission` is the answer half of the permission-prompt relay (permission-prompt-tool):
    // a per-card ACTION that POSTs the human's allow/deny for one held permission prompt — the entries
    // the session feed carries as `permissions`. Session-internal like input/resume/done: a plain POST,
    // never editor.commit, never a canvas-log entry (a permission decision is a session act). The
    // decision id is a global UUID, so no ?board=.
    if (name === "sessionPermission") {
      signals.sessionPermission = (permId: string, behavior: "allow" | "deny"): Promise<boolean> =>
        fetch(`/api/permission/${encodeURIComponent(permId)}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ behavior }),
        }).then(
          (r) => r.ok,
          () => false,
        );
      continue;
    }
    // `sessionRefresh` is the sessions browser card's one ACTION (Phase C): re-pull the off-log session
    // list (content.ts) and notify its subscribers. Not a signal — a bound fn the refresh button calls;
    // there's no disk-watch push for the sessions dir, so this is how a long-open card picks up newly-
    // written transcripts. Board-global like `sessionList` itself (no per-card id), never the canvas log.
    if (name === "sessionRefresh") {
      signals.sessionRefresh = (): void => refreshSessionList();
      continue;
    }
    // `sessionDelete` is the sessions browser card's hide ACTION (select a row, Shift+Delete): drop one
    // historical transcript from THIS list. Board-global and off-log like `sessionRefresh` — it adds the
    // id to a localStorage hidden-set (content.ts), never the canvas log, and never touches the .jsonl on
    // disk (Claude Code's own data). A bound fn taking the row's id, not a signal.
    if (name === "sessionDelete") {
      signals.sessionDelete = (id: string): void => hideSession(id);
      continue;
    }
    // `sessionOpen` is the sessions browser's DOUBLE-CLICK open — the keyboard-free twin of the drag-out
    // (App.tsx's drop → openSession). Same authored addNode, but placed by cascadeFrom (offset down-right
    // from THIS browser card) since a double-click carries no drop point. Per-card: it needs the host id
    // to anchor the cascade. A no-op without a host (the headless mock has none).
    if (name === "sessionOpen") {
      if (host) {
        const { m, id } = host;
        signals.sessionOpen = (sid: string): void => void openSession(m, sid, cascadeFrom(m, id, 520, 400));
      }
      continue;
    }
    // `channelRefresh` is the channels browser card's re-pull ACTION (the sessions card's `sessionRefresh`
    // twin): re-fetch the off-log channel list (content.ts) and notify. Board-global, never the canvas log.
    if (name === "channelRefresh") {
      signals.channelRefresh = (): void => refreshChannelList();
      continue;
    }
    // `channelOpen` is the channels browser's DOUBLE-CLICK open — the keyboard-free twin of the drag-out
    // (App.tsx's drop → openChannel). Same authored addNode (or fly-to if the card already exists), placed by
    // cascadeFrom off THIS browser card since a double-click carries no drop point. Per-card: needs the host id
    // to anchor the cascade. A no-op without a host (the headless mock has none).
    if (name === "channelOpen") {
      if (host) {
        const { m, id } = host;
        signals.channelOpen = (chanId: string, title: string, text: string): void =>
          openChannel(m, chanId, title, text, cascadeFrom(m, id, 300, 240));
      }
      continue;
    }
    // `channelJump` is `channelOpen` + a scroll-to-message (user waiting-state, P3): the threads-list card's
    // preview popover picks a specific unseen mention, so this opens/focuses the thread card AND asks it to
    // scroll to that seq (requestThreadJump — a module handoff the ThreadView consumes on mount / via event).
    if (name === "channelJump") {
      if (host) {
        const { m, id } = host;
        signals.channelJump = (chanId: string, title: string, text: string, seq: number): void => {
          openChannel(m, chanId, title, text, cascadeFrom(m, id, 300, 240));
          requestThreadJump(chanId, seq);
        };
      }
      continue;
    }
    // `rolesRefresh` is the roles browser card's re-pull ACTION (the channels card's `channelRefresh` twin):
    // re-fetch the off-log roles list (content.ts) and notify. Board-global, never the canvas log.
    if (name === "rolesRefresh") {
      signals.rolesRefresh = (): void => refreshRolesList();
      continue;
    }
    // `roleLaunch` is the roles browser's explicit LAUNCH action (agent-roles.md): spawn a live session UNDER
    // a role and drop its card (loader.spawnLiveSession, which stamps the RoleName.<sid> name), placed by
    // cascadeFrom off THIS browser card. A BUTTON, not a double-click — spawning a real process eats a session
    // slot, too costly for a misclick. Per-card: needs the host id to anchor the cascade; no-op without a host.
    if (name === "roleLaunch") {
      if (host) {
        const { m, id } = host;
        signals.roleLaunch = (roleId: string): void =>
          void spawnLiveSession(m, cascadeFrom(m, id, 800, 520), roleId);
      }
      continue;
    }
    // `roleOpen` is the roles browser's EDIT open (agent-roles.md 2b) — drag-out / double-click a role row to
    // open its charter card (loader.openRole, or fly-to if already on the board), placed by cascadeFrom off
    // THIS browser card. The drag-out's keyboard-free twin, like channelOpen. Per-card: needs the host id to
    // anchor the cascade; no-op without a host (the headless mock).
    if (name === "roleOpen") {
      if (host) {
        const { m, id } = host;
        signals.roleOpen = (roleId: string): void => openRole(m, roleId, cascadeFrom(m, id, 460, 480));
      }
      continue;
    }
    // `fsOpen` is the directory browser's DOUBLE-CLICK open — the drag-out's twin (App.tsx's drop →
    // materializeAt), placed by cascadeFrom off this browser card. Only the FILE rows use it; a folder
    // row's click already drills in (treeState), so it keeps click=expand / drag=pin and doesn't open.
    if (name === "fsOpen") {
      if (host) {
        const { m, id } = host;
        signals.fsOpen = (rootId: string, path: string, kind: "file" | "dir"): void => {
          const at = cascadeFrom(m, id, kind === "dir" ? 240 : 250, kind === "dir" ? 300 : 180);
          void materializeAt(m, rootId, path, kind, at.x, at.y);
        };
      }
      continue;
    }
    // `fsRename` is the directory card's in-app RENAME/MOVE ACTION (select a row, Enter): a per-card bound
    // fn that POSTs (root, from, to) to /api/file/rename — a real disk move, never editor.commit on the
    // file content. On success it RE-KEYS any pinned card from the old (root, path) to the new one
    // (loader.renameFileNodes) so a standalone card for that file survives in place rather than tombstoning
    // — the referential-integrity edge an external Finder rename can't reach. `rename ≡ move`, so a `to`
    // under a different parent moves it (the server mkdir's the parent). Not read-tracked — renaming is an
    // act. A no-op without a host (the headless mock has no editor to re-key through).
    if (name === "fsRename") {
      const editor = host?.editor;
      signals.fsRename = (rootId: string, from: string, to: string): Promise<boolean> =>
        fetch(`/api/file/rename?board=${activeBoardId()}&root=${encodeURIComponent(rootId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to }),
        }).then(
          (r) => {
            if (!r.ok) return false;
            if (editor) renameFileNodes(editor, rootId, from, to);
            return true;
          },
          () => false,
        );
      continue;
    }
    // `fsDelete` is the directory card's DELETE ACTION (select a row, Shift+Delete): a per-card bound fn
    // that POSTs (root, path) to /api/file/delete — a real disk delete. No browser-side bookkeeping: a
    // pinned card for the path is left to the watch's unlink → `gone` TOMBSTONE (the loader's "don't
    // silently vanish a card" rule), which the user dismisses deliberately. Not read-tracked.
    if (name === "fsDelete") {
      signals.fsDelete = (rootId: string, path: string): Promise<boolean> =>
        fetch(
          `/api/file/delete?board=${activeBoardId()}&root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
          { method: "POST" },
        ).then((r) => r.ok, () => false);
      continue;
    }
    // `editState` is per-card EPHEMERAL view state shaped exactly like `treeState` (same factory): which
    // row (if any) is mid-rename, plus any transient error. Read-tracked + settable so opening/committing
    // the inline rename input re-renders the card; never logged, gone on reload — an in-flight edit is view
    // state, not authored state. Kept SEPARATE from `treeState` (the expand-set) so a rename doesn't perturb
    // which folders are open.
    if (name === "editState") {
      let value: unknown = undefined;
      const watchers = new Set<() => void>();
      const sub: Subscribable<unknown> = {
        get: () => value,
        subscribe(fn) {
          watchers.add(fn);
          return () => watchers.delete(fn);
        },
      };
      signals.editState = {
        get: (): unknown => tracked(sub),
        set: (next: unknown): void => {
          value = next;
          for (const fn of watchers) fn();
        },
      };
      continue;
    }
    const s = CAPABILITY_SIGNALS[name];
    if (s) Object.defineProperty(signals, name, { enumerable: true, get: () => tracked(s) });
  }
  return {
    get fields(): CardFields {
      const n = tracked(nodeSub);
      return { title: n?.title ?? "", text: n?.text ?? "", color: n?.color ?? "grey", ...(n?.name ? { name: n.name } : {}) };
    },
    signals,
    root,
  };
}

// ── the registry ────────────────────────────────────────────────────────────────────────────────

// Minimal flat-yaml reader for type.yaml — `key: value` lines and one inline list. The day a type
// needs nesting is the day this becomes a real parser; refusing that now keeps type.yaml honest.
function parseTypeYaml(src: string): {
  contract: number;
  capabilities: string[];
  chrome?: string;
  aspect?: number;
  aspectAuto?: boolean;
} {
  let contract = 1;
  let capabilities: string[] = [];
  let chrome: string | undefined;
  let aspect: number | undefined;
  let aspectAuto: boolean | undefined;
  for (const line of src.split("\n")) {
    const m = /^(\w+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    if (m[1] === "contract") contract = Number(m[2]) || 1;
    if (m[1] === "chrome") chrome = m[2] || undefined;
    // `aspect: auto` → content-driven lock (aspectAuto); any number → a fixed type ratio.
    if (m[1] === "aspect") {
      if (m[2] === "auto") aspectAuto = true;
      else aspect = Number(m[2]) || undefined;
    }
    if (m[1] === "capabilities")
      capabilities = m[2]!
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return { contract, capabilities, chrome, aspect, aspectAuto };
}

// Snapshot-on-write: get() must return a NEW reference when the registry changes (channel-1
// consumers compare snapshots by identity — useSyncExternalStore bails out on Object.is).
let templates: ReadonlyMap<string, CardTemplate> = new Map();
const registrySubs = new Set<() => void>();
let started = false;

function setType(type: string, tpl: CardTemplate | null): void {
  const next = new Map(templates);
  tpl ? next.set(type, tpl) : next.delete(type);
  templates = next;
  for (const fn of registrySubs) fn();
}

// import() with a cache-busting query: the browser module cache can't be evicted, so each reload
// is a fresh module and the old one leaks — design-note cost #2, accepted for live editability.
// Rapid saves overlap loads, and import() resolution order isn't request order — a superseded
// load must never clobber a newer one, so each completion checks it's still the latest for its type.
const loadGen = new Map<string, number>();

// Resolves false when the import failed (so loadAll can RETRY the type — a restart race nulls every
// type at once and a one-shot null was permanent); a load superseded by a newer one is not a failure.
async function loadType(type: string, yaml: string): Promise<boolean> {
  const gen = (loadGen.get(type) ?? 0) + 1;
  loadGen.set(type, gen);
  const { contract, capabilities, chrome, aspect, aspectAuto } = parseTypeYaml(yaml);
  try {
    const mod = (
      await import(/* @vite-ignore */ `/card-types/${type}/render.js?t=${Date.now()}-${gen}`)
    ).default as CardTemplateModule;
    if (typeof mod?.render !== "function") throw new Error("template has no render()");
    if (loadGen.get(type) !== gen) return true;
    setType(type, { type, contract, capabilities, chrome, aspect, aspectAuto, module: mod });
    return true;
  } catch (err) {
    if (loadGen.get(type) !== gen) return true;
    // A broken template must never take the canvas down — drop the type, card falls back to the
    // host's placeholder (design-note cost #4: never hard-fail a card) while the retry loop runs.
    console.warn(`card-types/${type}: load failed`, err);
    setType(type, null);
    return false;
  }
}

// The registry's boot fetch RACES a dev-server restart: Vite's client reloads the page the moment the
// socket answers, which can be a beat before the API middleware is serving — and this load runs exactly
// once per page. A one-shot failure here left EVERY template card on the "no template for type …"
// placeholder until a manual reload, with only an unhandled-rejection warning to show for it (nothing
// re-triggers the load except a template edit on disk). So: retry with a short linear backoff — bounded,
// so a genuinely dead server doesn't poll forever, and loud when it gives up — where a failed per-type
// IMPORT counts as a failure too (only the types that failed re-import, so healthy types' template
// objects keep their identity and their cards don't churn). startRegistry also re-runs the load when
// the server socket RECONNECTS, so a tab that lived through a dead-server window heals itself.
const LOAD_ALL_RETRIES = 5;

// A fetch stuck in the browser's request QUEUE neither resolves nor rejects, so no retry/error path can
// even fire — the 2026-07-02 connection-pool starvation was invisible precisely because nothing anywhere
// reported anything. One honest tripwire: if the registry is still empty 10s after a load cycle began,
// say so, loudly and specifically. Disarmed when a cycle finishes (success or give-up), re-armed by the
// next cycle.
let loadWatchdog: ReturnType<typeof setTimeout> | null = null;
function armLoadWatchdog(): void {
  loadWatchdog ??= setTimeout(() => {
    if (templates.size === 0)
      console.error(
        "card-types: registry load still pending after 10s — requests may be queueing (connection-pool " +
          "starvation — too many tabs on this origin?) or the dev server is unreachable; template cards " +
          "show the placeholder until it resolves",
      );
  }, 10_000);
}
function disarmLoadWatchdog(): void {
  if (loadWatchdog) clearTimeout(loadWatchdog);
  loadWatchdog = null;
}

// `only` scopes a retry cycle to the types whose imports failed; absent ⇒ the whole registry.
async function loadAll(attempt = 0, only?: ReadonlySet<string>): Promise<void> {
  armLoadWatchdog();
  let failedTypes: Set<string> | undefined;
  try {
    const res = await fetch("/api/card-types");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { types } = (await res.json()) as { types: { type: string; yaml: string }[] };
    const wanted = only ? types.filter((t) => only.has(t.type)) : types;
    const results = await Promise.all(wanted.map(async (t) => ({ type: t.type, ok: await loadType(t.type, t.yaml) })));
    const failed = results.filter((r) => !r.ok).map((r) => r.type);
    if (!failed.length) return disarmLoadWatchdog();
    failedTypes = new Set(failed);
    throw new Error(`template import failed: ${failed.join(", ")}`);
  } catch (err) {
    if (attempt >= LOAD_ALL_RETRIES) {
      disarmLoadWatchdog();
      console.error("card-types: registry load failed after retries — cards will show the placeholder", err);
      return;
    }
    // A list-fetch failure keeps the incoming scope (`only`); a partial import failure narrows to it.
    setTimeout(() => void loadAll(attempt + 1, failedTypes ?? only), 1000 * (attempt + 1));
  }
}

// A template edit on disk arrives on the feed bus ("cardtypes", from the server's folder watch) and
// re-imports the type — edit render.js in your editor, the card live-updates. When the repo dataset
// is loaded the SAME disk event also rides the file-watch into render.js's own file card, refreshing
// its off-log content signal (content.ts) — the card body updates live, off the log, exactly as any
// file card does. The template re-import and the body refresh are two reads of one disk change.
function startRegistry(): void {
  if (started) return;
  started = true;
  void loadAll();
  // A server socket RECONNECT means the server was unreachable for a while — exactly the window where a
  // bounded retry loop can have given up. Re-pull the whole registry (fresh attempt budget), the same
  // re-arm App.tsx does for session feeds; a superseded in-flight load can't clobber it (loadGen).
  onFeedsReconnect(() => void loadAll());
  let lastTs = 0;
  feedSignal<{ path: string; ts: number }>("cardtypes").subscribe(() => {
    const ev = feedSignal<{ path: string; ts: number }>("cardtypes").get();
    if (!ev || ev.ts === lastTs) return;
    lastTs = ev.ts;
    // Reload ONLY the type whose folder changed (path is "<type>/<file>"). Re-importing every type on
    // each save churned every card and leaked a module per type per save (the cache-busted import,
    // cost #2); scoping it keeps unchanged types' template objects IDENTICAL, so their cards don't
    // re-render at all. Fall back to a full load if the path doesn't name a type.
    const type = ev.path?.split(/[\\/]/)[0];
    void (type ? reloadType(type) : loadAll());
  });
}

// Re-import a single type after a disk edit. Lists the registry (cheap — just the yamls) to read the
// current grant and to tell an EDIT (type still present → re-import its render.js) from a DELETE
// (folder gone → drop it; cards fall back to the host placeholder). Only this one render.js is
// re-imported, so only this type's wrapper object changes identity.
async function reloadType(type: string): Promise<void> {
  const res = await fetch("/api/card-types");
  const { types } = (await res.json()) as { types: { type: string; yaml: string }[] };
  const t = types.find((x) => x.type === type);
  if (t) await loadType(t.type, t.yaml);
  else setType(type, null);
}

// Channel-1 handle for the registry itself — NodeView subscribes like it would to any signal, so
// types appearing/reloading re-render exactly the cards of that type. Lazily starts the registry.
export const templatesSignal: Subscribable<ReadonlyMap<string, CardTemplate>> = {
  get: () => templates,
  subscribe(onChange) {
    startRegistry();
    registrySubs.add(onChange);
    return () => registrySubs.delete(onChange);
  },
};
