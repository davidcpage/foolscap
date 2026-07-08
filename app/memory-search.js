#!/usr/bin/env node
// memory-search.js — ranked lexical search + a hygiene doctor over the file-memory store
// (.canvas/memory/*.md). Backs `scripts/canvas memory search|doctor`. Lexical only — semantic/embedding
// search is deliberately out of scope (revisit only if recall degrades at scale). The store is the durable,
// pull-only tier: MEMORY.md is a bounded MAP-index (always loaded), every fact is its own file found by this
// search, so the corpus can grow unbounded without the index enumerating it.
//
// Ranking mirrors a web search: a filename/slug hit outranks a description: hit, which outranks a body hit.
// Output is web-search-shaped — per hit the slug + its description: + the matching lines, most-relevant first
// — so the agent skims the results and opens the promising files.

import fs from 'node:fs';
import path from 'node:path';

// The index itself is not a fact — exclude it from both search and the atomicity/hygiene checks.
const INDEX_FILE = 'MEMORY.md';

const SLUG_WEIGHT = 100; // a term in the slug/filename — strongest signal of relevance
const DESC_WEIGHT = 12;  // a term in the description: frontmatter — the human-written one-line summary
const BODY_WEIGHT = 1;   // each body occurrence of a term (capped, so a long file can't dominate)
const BODY_CAP = 4;      // max counted body occurrences per term
const ALL_TERMS_BONUS = 8; // every query term appears somewhere in the file

// Split a query into lowercased terms; drop empties.
function terms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Parse leading `--- ... ---` YAML-ish frontmatter. We only need name/description/type, so a light
// line scanner beats pulling in a YAML dep. Returns {name, description, type, frontmatterEnd}.
function parseFrontmatter(text) {
  const out = { name: '', description: '', type: '', frontmatterEnd: 0 };
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return out;
  let i = 1;
  let inMetadata = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') { i++; break; }
    const topKey = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    const nested = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (topKey) {
      inMetadata = topKey[1] === 'metadata';
      if (topKey[1] === 'name') out.name = unquote(topKey[2]);
      else if (topKey[1] === 'description') out.description = unquote(topKey[2]);
    } else if (nested && inMetadata && nested[1] === 'type') {
      out.type = unquote(nested[2]);
    }
  }
  out.frontmatterEnd = i;
  return out;
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, idx = 0;
  const h = haystack.toLowerCase();
  while ((idx = h.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
}

function loadFacts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { error: `memory dir not found: ${dir}` };
  }
  const facts = [];
  for (const file of names) {
    if (!file.endsWith('.md') || file === INDEX_FILE) continue;
    const full = path.join(dir, file);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    const slug = fm.name || file.replace(/\.md$/, '');
    const body = text.split('\n').slice(fm.frontmatterEnd).join('\n');
    facts.push({ file, full, slug, description: fm.description, type: fm.type, text, body });
  }
  return { facts };
}

function score(fact, qterms) {
  const slugHay = `${fact.slug} ${fact.file}`.toLowerCase();
  const descHay = fact.description.toLowerCase();
  const bodyHay = fact.body.toLowerCase();
  let s = 0;
  let termsHit = 0;
  for (const t of qterms) {
    let hit = false;
    if (slugHay.includes(t)) { s += SLUG_WEIGHT; hit = true; }
    if (descHay.includes(t)) { s += DESC_WEIGHT; hit = true; }
    const bodyOcc = Math.min(countOccurrences(bodyHay, t), BODY_CAP);
    if (bodyOcc > 0) { s += bodyOcc * BODY_WEIGHT; hit = true; }
    if (hit) termsHit++;
  }
  if (qterms.length > 1 && termsHit === qterms.length) s += ALL_TERMS_BONUS;
  return s;
}

// Body lines that contain any query term — the "matching lines" of a web-search snippet.
function matchingLines(fact, qterms, max = 4) {
  const lines = fact.body.split('\n');
  const hits = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    if (qterms.some((t) => low.includes(t))) {
      hits.push(line.length > 200 ? line.slice(0, 197) + '…' : line);
      if (hits.length >= max) break;
    }
  }
  return hits;
}

function runSearch(dir, query, opts) {
  const qterms = terms(query);
  if (qterms.length === 0) {
    process.stderr.write('memory search: empty query\n');
    process.exit(2);
  }
  const { facts, error } = loadFacts(dir);
  if (error) { process.stderr.write(error + '\n'); process.exit(1); }
  const scored = facts
    .map((f) => ({ f, s: score(f, qterms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.f.slug.localeCompare(b.f.slug));
  const limit = opts.limit || 10;
  const top = scored.slice(0, limit);

  if (opts.json) {
    const out = top.map((x) => ({
      slug: x.f.slug,
      score: x.s,
      type: x.f.type,
      description: x.f.description,
      file: `.canvas/memory/${x.f.file}`,
      matches: matchingLines(x.f, qterms),
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (top.length === 0) {
    process.stdout.write(`no memory matches for "${query}"\n`);
    process.stdout.write(`(searched ${facts.length} fact files in ${dir})\n`);
    return;
  }
  const out = [];
  out.push(`${top.length} match${top.length === 1 ? '' : 'es'} for "${query}" (of ${facts.length} facts, most-relevant first):\n`);
  for (const { f, s } of top) {
    const typeTag = f.type ? ` (${f.type})` : '';
    out.push(`● ${f.slug}${typeTag}  [score ${s}]`);
    if (f.description) out.push(`    ${f.description}`);
    for (const line of matchingLines(f, qterms)) out.push(`      · ${line}`);
    out.push(`    → .canvas/memory/${f.file}`);
    out.push('');
  }
  process.stdout.write(out.join('\n') + '\n');
}

// Hygiene doctor: flag facts missing a description: (unfindable-by-summary) or that look non-atomic
// (multiple facts crammed in one file — the store's rule is one fact per file). Heuristic, advisory.
function runDoctor(dir) {
  const { facts, error } = loadFacts(dir);
  if (error) { process.stderr.write(error + '\n'); process.exit(1); }
  const problems = [];
  for (const f of facts) {
    const issues = [];
    if (!f.description) issues.push('missing description: frontmatter');
    // Non-atomic heuristics: a big file, or many H2/H3 headings, suggests several facts in one file.
    const bytes = Buffer.byteLength(f.text, 'utf8');
    const headings = (f.body.match(/^#{1,3}\s/gm) || []).length;
    if (bytes > 8000) issues.push(`large (${(bytes / 1024).toFixed(1)}KB — may hold multiple facts)`);
    if (headings >= 4) issues.push(`${headings} section headings (may be non-atomic)`);
    if (issues.length) problems.push({ slug: f.slug, file: f.file, issues });
  }
  if (problems.length === 0) {
    process.stdout.write(`memory doctor: ${facts.length} fact files, all healthy (description present, atomic).\n`);
    return;
  }
  const out = [`memory doctor: ${problems.length} of ${facts.length} fact files flagged:\n`];
  for (const p of problems) {
    out.push(`⚠ ${p.slug}  (.canvas/memory/${p.file})`);
    for (const i of p.issues) out.push(`    - ${i}`);
  }
  out.push('');
  out.push('These are advisory: a missing description: makes a fact unfindable by summary; a non-atomic');
  out.push('file should be split so each fact is independently pullable. Nothing was changed.');
  process.stdout.write(out.join('\n') + '\n');
}

// ── arg parsing ──────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const mode = argv[0];
  const rest = argv.slice(1);
  let dir = null;
  const positional = [];
  const opts = { json: false, limit: 10, doctor: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dir') dir = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--doctor') opts.doctor = true;
    else if (a === '--limit') opts.limit = parseInt(rest[++i], 10) || 10;
    else positional.push(a);
  }
  if (!dir) { process.stderr.write('memory-search: --dir <memoryDir> required\n'); process.exit(2); }

  if (mode === 'doctor') return runDoctor(dir);
  if (mode === 'search') {
    if (opts.doctor) return runDoctor(dir); // `memory search --doctor` is an alias for the hygiene check
    return runSearch(dir, positional.join(' '), opts);
  }
  process.stderr.write(`memory-search: unknown mode "${mode}" (search|doctor)\n`);
  process.exit(2);
}

main(process.argv.slice(2));
