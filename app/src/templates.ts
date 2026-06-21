import { nothing, render as litRender } from "../vendor/lit-html.js";
import type { Editor, Id, Subscribable } from "./lib";
import { nowSignal } from "./clock";
import { feedSignal } from "./feeds";
import { fileContentSignal, dirListingSignal, sessionListSignal, refreshSessionList, type DirListing } from "./content";
import { weatherSignal, type WeatherData } from "./weather";

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
}

// What a template receives — the whole v1 contract surface. `signals` holds only the capabilities
// the type declared; reading a property tracks it.
export interface CardApi {
  fields: CardFields;
  signals: Record<string, unknown>;
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
  module: CardTemplateModule;
}

// The off-log signals a type.yaml may request — the spike-derived capability list from the design
// note. Adding a capability means adding a line here, not widening what templates can reach for.
const CAPABILITY_SIGNALS: Record<string, Subscribable<unknown>> = {
  now: nowSignal,
  githead: feedSignal("githead"),
  hn: feedSignal("hn"),
  usage: feedSignal("usage"), // account-level plan windows, polled server-side (vite-fs-plugin.ts)
  sessionList: sessionListSignal, // the historical-transcript list (GET /api/sessions), the sessions card's body
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

// Build the capability object for one card: content fields off the node's channel-1 handle, plus
// the declared off-log signals. All reads route through tracked(), so render-time access = subscription.
export function buildCard(
  nodeSub: Subscribable<{ title: string; text: string; color: string } | undefined>,
  capabilities: string[],
  host?: CardHost,
): CardApi {
  const signals: Record<string, unknown> = {};
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
      const content = fileContentSignal("repo", nodeSub.get()?.title ?? "");
      Object.defineProperty(signals, "fileContent", { enumerable: true, get: () => tracked(content) });
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
      signals.dirListing = (path: string): DirListing | undefined => tracked(dirListingSignal("repo", path));
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
    // (file-trees-on-canvas.md §9), so which folders are open is view state, not authored state. Created
    // fresh per card (buildCard runs once per mount), so the closure persists across re-renders. The one
    // bit of mutable view-state the contract grants a template; reading get() during render subscribes the
    // card, set() notifies it.
    if (name === "treeState") {
      let value: unknown = undefined;
      const watchers = new Set<() => void>();
      const sub: Subscribable<unknown> = {
        get: () => value,
        subscribe(fn) {
          watchers.add(fn);
          return () => watchers.delete(fn);
        },
      };
      signals.treeState = {
        get: (): unknown => tracked(sub),
        set: (next: unknown): void => {
          value = next;
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
        fetch(`/api/session/${encodeURIComponent(id)}/resume`, { method: "POST" }).then(
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
    const s = CAPABILITY_SIGNALS[name];
    if (s) Object.defineProperty(signals, name, { enumerable: true, get: () => tracked(s) });
  }
  return {
    get fields(): CardFields {
      const n = tracked(nodeSub);
      return { title: n?.title ?? "", text: n?.text ?? "", color: n?.color ?? "grey" };
    },
    signals,
  };
}

// ── the registry ────────────────────────────────────────────────────────────────────────────────

// Minimal flat-yaml reader for type.yaml — `key: value` lines and one inline list. The day a type
// needs nesting is the day this becomes a real parser; refusing that now keeps type.yaml honest.
function parseTypeYaml(src: string): { contract: number; capabilities: string[]; chrome?: string; aspect?: number } {
  let contract = 1;
  let capabilities: string[] = [];
  let chrome: string | undefined;
  let aspect: number | undefined;
  for (const line of src.split("\n")) {
    const m = /^(\w+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    if (m[1] === "contract") contract = Number(m[2]) || 1;
    if (m[1] === "chrome") chrome = m[2] || undefined;
    if (m[1] === "aspect") aspect = Number(m[2]) || undefined;
    if (m[1] === "capabilities")
      capabilities = m[2]!
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return { contract, capabilities, chrome, aspect };
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

async function loadType(type: string, yaml: string): Promise<void> {
  const gen = (loadGen.get(type) ?? 0) + 1;
  loadGen.set(type, gen);
  const { contract, capabilities, chrome, aspect } = parseTypeYaml(yaml);
  try {
    const mod = (
      await import(/* @vite-ignore */ `/card-types/${type}/render.js?t=${Date.now()}-${gen}`)
    ).default as CardTemplateModule;
    if (typeof mod?.render !== "function") throw new Error("template has no render()");
    if (loadGen.get(type) !== gen) return;
    setType(type, { type, contract, capabilities, chrome, aspect, module: mod });
  } catch (err) {
    if (loadGen.get(type) !== gen) return;
    // A broken template must never take the canvas down — drop the type, card falls back to the
    // host's placeholder (design-note cost #4: never hard-fail a card).
    console.warn(`card-types/${type}: load failed`, err);
    setType(type, null);
  }
}

async function loadAll(): Promise<void> {
  const res = await fetch("/api/card-types");
  const { types } = (await res.json()) as { types: { type: string; yaml: string }[] };
  await Promise.all(types.map((t) => loadType(t.type, t.yaml)));
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
