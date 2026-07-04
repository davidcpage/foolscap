// The annotation anchor module (docs/doc-annotations.md §3): W3C TextQuoteSelector resolution, pure
// string-in/range-out. Plain ESM at the app root (the thread-state.js convention) so it runs under
// node --test, the server imports it for read-time orphan detection, and the doc card can import it
// for highlight painting in build-order step 2 — one owned module, and core/interaction never learn
// about annotations.
//
// An anchor is a QUOTE plus context — `{exact, prefix, suffix, offset}` — resolved against the
// markdown SOURCE (never the rendered DOM; the source is the durable coordinate system). Resolution
// tries, in order: the offset fast path (unedited doc: always hits), exact search disambiguated by
// context, then a bounded fuzzy match. `null` means ORPHAN — the caller surfaces it loud (the strip),
// never drops it; the quote itself is the payload.

/** Context captured either side of the quote when minting a selector — Hypothes.is-sized. */
const CONTEXT_LEN = 32;

// Fuzzy bounds. A quote longer than FUZZY_MAX_EXACT that no longer matches exactly is an orphan —
// the DP is O(|exact| · window) per candidate and a paragraph-sized quote whose text drifted is
// better re-anchored by an agent (§4) than guessed at. MAX_DIST_RATIO is the accept threshold:
// a quarter of the quote may have changed before we call it gone.
const FUZZY_MAX_EXACT = 512;
const MAX_DIST_RATIO = 0.25;
const SEED_LEN = 12; // seed-and-extend: an unchanged 12-char run of the quote locates candidates
const MAX_CANDIDATES = 32;

/**
 * Mint a selector for [start, end) of `source` — the creation-time half (the card's selection maps
 * rendered-DOM → source offsets, then calls this). `offset` is a hint for the resolve fast path,
 * never trusted on its own.
 */
export function makeAnchor(source, start, end) {
  return {
    exact: source.slice(start, end),
    prefix: source.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: source.slice(end, end + CONTEXT_LEN),
    offset: start,
  };
}

// How well the text around a hit agrees with the stored context: contiguous matching chars of
// `prefix` walking backwards from the hit + of `suffix` walking forwards from its end. Cheap, and
// exactly the disambiguator needed when `exact` occurs more than once.
function contextScore(source, start, len, prefix, suffix) {
  let score = 0;
  for (let k = 0; k < prefix.length; k++) {
    if (source[start - 1 - k] !== prefix[prefix.length - 1 - k]) break;
    score++;
  }
  const end = start + len;
  for (let k = 0; k < suffix.length; k++) {
    if (source[end + k] !== suffix[k]) break;
    score++;
  }
  return score;
}

/**
 * Resolve an anchor against a source, or null = orphan. `method` reports which pass hit
 * ("offset" | "exact" | "fuzzy") — the card can render a fuzzy hit slightly differently if it ever
 * wants to; the server just cares that it resolved.
 */
export function resolveAnchor(source, anchor) {
  if (typeof source !== "string" || !anchor || typeof anchor.exact !== "string" || anchor.exact.length === 0)
    return null;
  const exact = anchor.exact;
  const prefix = typeof anchor.prefix === "string" ? anchor.prefix : "";
  const suffix = typeof anchor.suffix === "string" ? anchor.suffix : "";
  const offset = typeof anchor.offset === "number" && anchor.offset >= 0 ? anchor.offset : null;

  // 1. Offset fast path — does the quote still sit where it was minted? (Unedited doc: always.)
  if (offset != null && source.startsWith(exact, offset))
    return { start: offset, end: offset + exact.length, method: "offset" };

  // 2. Exact search, context-disambiguated. Ties on context score fall to the hit nearest the
  // stored offset (an edit above the quote shifts it the least).
  let best = null;
  for (let i = source.indexOf(exact); i !== -1; i = source.indexOf(exact, i + 1)) {
    const score = contextScore(source, i, exact.length, prefix, suffix);
    const dist = offset != null ? Math.abs(i - offset) : i;
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { i, score, dist };
  }
  if (best) return { start: best.i, end: best.i + exact.length, method: "exact" };

  // 3. Fuzzy — the quote itself was edited.
  return fuzzyResolve(source, exact, prefix, suffix, offset);
}

// Seed-and-extend fuzzy match: find candidate positions from unchanged fragments (runs of the quote,
// or its intact prefix/suffix context), then score each candidate window with an approximate-substring
// alignment and accept the best if it's within MAX_DIST_RATIO of the quote's length.
function fuzzyResolve(source, exact, prefix, suffix, offset) {
  if (exact.length > FUZZY_MAX_EXACT || source.length === 0) return null;
  const maxDist = Math.max(2, Math.floor(exact.length * MAX_DIST_RATIO));

  // Candidate window STARTS — each seed hit back-projects to where the quote would begin.
  const starts = new Set();
  const addCandidates = (needle, backShift, cap) => {
    if (!needle) return;
    let n = 0;
    for (let i = source.indexOf(needle); i !== -1 && n < cap; i = source.indexOf(needle, i + 1), n++)
      starts.add(Math.max(0, i - backShift));
  };
  if (exact.length >= SEED_LEN) {
    const mid = Math.floor((exact.length - SEED_LEN) / 2);
    addCandidates(exact.slice(0, SEED_LEN), 0, 8);
    if (mid > 0) addCandidates(exact.slice(mid, mid + SEED_LEN), mid, 8);
    addCandidates(exact.slice(-SEED_LEN), exact.length - SEED_LEN, 8);
  } else {
    addCandidates(exact, 0, 8);
  }
  // Context seeds catch the case where the quote changed but its surroundings didn't.
  addCandidates(prefix, -prefix.length, 8); // window starts right AFTER the prefix
  addCandidates(suffix, exact.length, 8); // window ends right BEFORE the suffix
  if (starts.size === 0) return null;

  const pad = Math.max(8, Math.ceil(exact.length * MAX_DIST_RATIO));
  let best = null;
  let seen = 0;
  for (const s of starts) {
    if (++seen > MAX_CANDIDATES) break;
    const from = Math.max(0, s - pad);
    const to = Math.min(source.length, s + exact.length + pad);
    const m = bestSubstringMatch(exact, source, from, to);
    if (!m || m.dist > maxDist) continue;
    const dist = offset != null ? Math.abs(m.start - offset) : m.start;
    if (!best || m.dist < best.dist || (m.dist === best.dist && dist < best.offDist))
      best = { ...m, offDist: dist };
  }
  return best ? { start: best.start, end: best.end, method: "fuzzy" } : null;
}

// Approximate-substring alignment: the substring of text[from,to) with minimum edit distance to
// `pattern` (free start and end in the window — the standard semi-global DP, rolling rows, with a
// parallel array carrying each alignment's start column so the match start needs no traceback).
function bestSubstringMatch(pattern, text, from, to) {
  const n = to - from;
  const m = pattern.length;
  if (n === 0 || m === 0) return null;
  let prev = new Array(n + 1).fill(0);
  let prevStart = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevStart[j] = j;
  let cur = new Array(n + 1);
  let curStart = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const pc = pattern.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (pc === text.charCodeAt(from + j - 1) ? 0 : 1);
      const del = prev[j] + 1; // pattern char unmatched
      const ins = cur[j - 1] + 1; // text char skipped
      if (sub <= del && sub <= ins) {
        cur[j] = sub;
        curStart[j] = prevStart[j - 1];
      } else if (del <= ins) {
        cur[j] = del;
        curStart[j] = prevStart[j];
      } else {
        cur[j] = ins;
        curStart[j] = curStart[j - 1];
      }
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let bestJ = -1;
  let bestD = Infinity;
  // `<=` so an equal-cost LONGER match wins: substituting the quote's changed tail chars beats
  // deleting them, and the returned span then covers the replacement text (what a highlight wants).
  for (let j = 0; j <= n; j++)
    if (prev[j] <= bestD) {
      bestD = prev[j];
      bestJ = j;
    }
  if (bestJ < 0) return null;
  return { start: from + prevStart[bestJ], end: from + bestJ, dist: bestD };
}
