# Token efficiency of thread-based multi-agent collaboration — review 2026-07-11

*Prepared 2026-07-11 from measurement of the real transcript corpus (271 spawned sessions, 67
threads, 511 transcripts; 6 representative worker transcripts and all 87 Coordinator-substrate
transcripts analyzed in depth via their `message.usage` records). Companion to
`agent-to-agent-messaging.md`, `threads-as-cards.md`, `wakeable-substrate-plan.md`, and
`harness-constitution.md`. The question under review: is the canvas's coordination machinery —
thread messaging via tool calls, session-id plumbing, scheduled wakeups, harness/role/system-prompt
stacking, and the Coordinator+builders topology — a material token-efficiency problem, or is
externalizing work onto threads and durable records a viable route to **context-efficient
multi-agent collaboration on hard, long-running problems**?*

*The headline: **the coordination protocol costs 1–3% of fresh token spend and the
externalization discipline demonstrably works** — a Coordinator and its worker read almost fully
disjoint content, sharing only the thread log. The one large inefficiency is not on the suspect
list: **replaying long-lived accumulated context on every turn**, concentrated in parked
Coordinators and heartbeat sweeps. Over half of cost-weighted Coordinator spend is context replay,
and half of that bought nothing. The fixes are structural and cheap, and they all push in the same
direction the research aim already points: shorter-lived sessions, more state in durable records,
less state in any one context window.*

---

## 1. The research framing

The exploratory aim this review serves: can external communication via threads and other durable
records enable efficient multi-agent collaboration on hard long-running problems in a highly
**context-efficient** manner — where individual agents especially, but also the system as a whole,
process limited token context at any time and in aggregate?

That aim decomposes into three measurable properties:

1. **Bounded individual context** — no agent's window needs to hold the whole problem; each
   session pulls only its slice from durable records.
2. **Bounded aggregate spend** — the sum over all sessions isn't inflated by duplication
   (everyone re-reading the same context) or by protocol overhead (the cost of coordinating).
3. **No loss of capability** — the decomposition doesn't prevent solving problems that a single
   long context could solve.

This review measures (1) and (2) directly from the corpus. (3) is a product question the numbers
can't settle, but §7 notes what the data implies.

## 2. Method

- **Workers**: 6 representative worker transcripts (48KB–1.4MB JSONL) from the per-worktree
  projects dirs, spanning small single-task sessions to 280-turn builds.
- **Coordinators**: all 87 Coordinator-substrate spawns identified in the main projects dir
  (44 summoned, 18 reconstituted seats, 16 driving-thread joins, 8 legacy standing-job spawns,
  1 manual).
- Per transcript: first-turn prompt bytes and first-turn cache-creation (= real cost of the whole
  initial context including the Claude Code base prompt); per-turn `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`; tool calls classified
  **coordination** (Bash → `scripts/canvas` or `/api/*`) vs **work** (everything else).
- Static surfaces read directly: the spawn assembly (`server-sessions.ts` `ensureLiveSession` /
  `workerBrief`), the wake nudge (`server-delivery.ts` `flushNudge`), the heartbeat spec
  (`coordinator-heartbeat.js`), the inbox densification (`routes/inbox.ts`), the thread ledger
  format (`.canvas/threads/*.jsonl`).

Cost weighting used throughout, in input-token equivalents: cache-read ×0.1, cache-write ×1.25,
output ×~5. All observed sessions served **Opus 4.8** (the known Fable→Opus fallback,
`canvas-workers-fable-fallback-opus`), so all of this lands on the weekly quota.

## 3. The suspected micro-inefficiencies, adjudicated

Each of the originally-suspected costs, measured:

| Suspect | Measured | Verdict |
|---|---|---|
| Thread messaging via JSON tool calls | A full thread post: 3.0–3.8KB heredoc Bash command (~900 tok) + ~130B result. Intent/seen/inbox calls: 90–430B command + 10–160B result. Per session: **~1–3% of fresh-input spend** (cache-writes + uncached input). | Real but negligible. One-line hygiene fix available (§6.5). |
| Long session-ids in to/from fields | Already densified on the read path: `/api/inbox` renders `from` as `RoleName.<short-sid>` (`routes/inbox.ts` `inboxHandle`), not the 36-char UUID. UUIDs survive only in the on-disk ledger (invisible to agents) and inside curl command strings. | Solved where it matters. |
| Verbose scheduled wakeups | Wake nudges are content-free and tiny: ~135–190B (`[canvas] new thread messages: "…" (1 new) — GET /api/inbox…`). The heartbeat instruction is ~700B. Workers see 0–2 mid-session wake injections per transcript, <400B total. | Not a verbosity problem. The heartbeat *is* a cost problem, but via frequency × context size (§4), not message length. |
| Harness + role (+ thread history) stacked on the system prompt | First-turn context ≈ 31–35k tok, but the canvas's own append (ask-convention + `harness.md` ~8KB + role charter + worker brief) is only **~3–4k tok** of it; the rest is the CC base prompt + CLAUDE.md, identical for every session. The whole prefix is cache-stable: only 25/87 Coordinator spawns paid a cold write (~12–18k tok); 62 hit warm cache at ~0. **Thread history is not in the spawn prompt** — the assignment arrives as a logged thread message and the worker pulls history via inbox. | Cheap, and by design. Fresh-spawn-per-wake costs only ~4–4.5k genuinely fresh tokens; 7 respawns onto one thread totaled ~30k fresh — less than one mid-size session's cache-writes. The never-`--resume` discipline is *validated*, not indicted. |

## 4. The actual cost center: context replay in long-lived sessions

The number that dwarfs everything else: the 87 Coordinator sessions read **1.00B cache tokens
while producing 9.3M output tokens** (108:1). Cost-weighted, that's roughly:

| Component | Tokens | Input-equivalents | Share |
|---|---|---|---|
| cache-read | 1.00B | ~100M | **~57%** |
| output | 9.3M | ~47M | ~27% |
| cache-write | 22.8M | ~28M | ~16% |

What drives it:

- **Parked Coordinators accrete.** The reap-only-on-done policy (the correct fix for the
  endless-Coordinator runaway, `heartbeat-respawn-on-done-seat`) leaves Coordinator sessions
  parked and long-lived: 300+ turn sessions with 200–240k-token contexts are common. Every
  subsequent turn replays the whole window.
- **The heartbeat multiplies it.** 201 heartbeat nudges across the corpus, median **412k
  cache-read per sweep** (the parked context replays, plus the sweep's own state reads). Total
  ~100M cache-read — a third of all Coordinator cache-read — plus 454k output + 929k writes.
- **Half the sweeps are no-ops.** 101 of 201 nudges resolved in ≤3 turns having found nothing:
  ~36.5M cache-read + 185k writes + 80k output spent concluding "nothing to do."
- **Workers show the same shape, milder.** Big worker sessions replay a 180–240k context per turn
  (20–42M cache-read per session, ~40–80× their cache-writes). Coordination-only turns late in a
  session — a ~200-token intent post or seen-mark — each cost a **full context replay**; they
  account for 5–13% of worker cache-read.
- **Reading state dominates acting.** Coordinator tool-result volume is ~89% state reads
  (inbox/canvas/sessions sweeps, ~850k tok ingested) vs ~11% acts. Sweeping is what a Coordinator
  *is*, but it prices every unnecessary sweep.

The load-bearing pricing fact: this is tolerable **only because** cache-read is ~0.1× and the
sweeps stay inside the prompt-cache TTL. Measured from the usage records' cache buckets, spawned
sessions write exclusively to the **1-hour TTL** cache (`ephemeral_1h`, priced ~2× base input on
write), and the TTL refreshes on each use — so the 4-minute heartbeat keeps a parked context
permanently warm. That is precisely what makes gating safe (§6.2).

## 5. The macro-level concern, measured small

Suspected: Coordinator + N builders each independently ingesting the shared problem context.
Measured:

- **Coordinator + worker on one thread (75557dbd + d1f3e44c, thread mrcmofwf-10): file reads
  fully disjoint.** The Coordinator read *state* (CLI/API sweeps); the worker read *code*. The
  only shared payload was the thread history itself: ~5.6k + 0.9k tok. This is the
  externalization thesis working exactly as intended — the thread log is the shared memory, and
  each party pulls only its slice.
- **Worst duplication episode found (6 serial fresh Coordinators onto one driving thread,
  bcc616f8):** the identical 3.9KB brief paid 6×; 5/6 cold spawns re-wrote the same ~17–20k prefix
  (~89k repeated cache-writes); two hot files (`vite-fs-plugin.ts`, `wakeable-substrate-plan.md`)
  were each read by 5 of the 6 sessions — **~44k tok of file content paid beyond the first copy**.

So the worst observed duplication episode cost ~130k input-equivalents — against ~100M of
heartbeat context replay corpus-wide. Duplication is real but **three orders of magnitude**
smaller than the replay problem. Two honest caveats: (a) serial re-spawns onto a *hard shared
problem* would re-read more than these did — the disjointness partly reflects a clean
state/code split of labor; (b) nothing currently helps the *sixth* Coordinator skip what the
first five learned except what they posted to the thread — which is precisely the discipline to
lean on (pins + a distilled thread brief are the cheap "what we know so far" for a fresh seat).

## 6. Proposals, ranked by leverage

### 6.1 Gate the heartbeat server-side (biggest win, small change)

The server already knows everything a no-op sweep would discover: unread counts per seat, live
session statuses, intent staleness, pending asks. Compute "is there anything to sweep?" in
`loopTick` **before** `flushNudge` and skip the nudge when the answer is no — waking the model
only on a state *change* since the last sweep (a cheap hash of {unread cursors, session statuses,
intent markers, open asks} suffices). Would have avoided the 101 no-op sweeps ≈ **36.5M
cache-read + 185k writes** for zero lost function; stall detection survives because a stall *is*
a state (staleness crossing a threshold), which the predicate can express in code, timer-cheap.

### 6.2 Gating forfeits cache warmth — checked, and still a strict win at the measured 1h TTL

The obvious objection to 6.1: a sweep is also a cache keep-alive. Skip it, and the next real wake
may land on a cold cache and pay full re-creation of the parked context instead of 0.1× reads. Is
gating still worth it?

**Measured TTL first**: every cache write in the transcript usage records lands in the
`ephemeral_1h` bucket — spawned sessions use the **1-hour** cache TTL (write ~2× base input),
refreshed on each use. So a skipped 4-minute sweep leaves ~56 minutes of slack; the cache goes
cold only after a **full hour of total silence**.

The arithmetic at observed sizes (C ≈ 200k parked context; a no-op sweep ≈ 41k input-equiv;
a cold 1h-TTL rewrite ≈ 2×C = 400k eq vs ~20k warm → one-time penalty ≈ 380k eq):

- **Quiet stretch < 1h**: gating skips n sweeps (n × 41k saved), and the next wake is still warm
  — zero penalty. Pure win.
- **Quiet stretch ≥ 1h**: the wake is cold (−380k once), but ≥15 sweeps were skipped
  (≥615k saved). Still net-positive, and it only improves as the stretch lengthens (overnight:
  ~4.9M eq saved per 8 quiet hours vs one 380k cold wake).

So under the 1h TTL gating dominates at every quiet-stretch length. (Under a hypothetical 5-min
TTL the break-even would be ~6 skipped sweeps ≈ 25 min of quiet — gating could lose ~190k eq on
short gaps and would want hysteresis; worth re-checking if the account ever drops to 5-min
caching, e.g. under usage overage.) Two supporting notes: the cold-wake penalty scales with
parked-context size, so 6.3's context cap makes gating TTL-independent entirely; and the same
numbers say **don't slow the cadence as an alternative to gating** — a >1h cadence turns *every*
sweep into a 2× rewrite, ~20× the warm price. Document the TTL dependency next to
`COORDINATOR_HEARTBEAT_INTERVAL_MS` so a future cadence tweak doesn't silently hit it.

### 6.3 Cap seat-occupant context; respawn past the crossover

The arithmetic: nudging a parked seat costs ~0.1 × context per sweep; a warm respawn costs
~0 cache-write for the shared ~31k prefix plus a few k of fresh onboarding (cold: ~15k writes
≈ 19k input-equiv). So once a parked context exceeds roughly **190k tokens, one nudge costs more
than a whole fresh spawn** — and observed Coordinators park at 200–240k, past the crossover,
paying it repeatedly. The seat model already makes occupants disposable (durable state = thread
log + pins + memory; `never-resume-sessions`): add a policy that a seat occupant past N turns or
K context tokens winds down (`done` + posts a hand-off note) and the next real event
reconstitutes a fresh occupant. This is the existing dormant-seat machinery pointed at
efficiency rather than only at crash recovery — and it *strengthens* the research discipline:
anything a 240k-context Coordinator "knows" that isn't in the thread log is state the system was
supposed to externalize anyway.

### 6.4 Batch coordination acts at turn boundaries (harness norm)

Each late-session coordination act spent as its own turn = one full context replay. A one-line
harness-leaf norm — *"bundle your report post + intent declaration + `/done` into a single turn;
never spend a bare turn on one bookkeeping call"* — roughly halves coordination turns, worth
~5–10% of worker cache-read. (The same principle the codebase already applies to commits,
`bundled-commits-ok`.)

### 6.5 Micro-hygiene (do cheaply or not at all)

- Nudge the harness examples toward `scripts/canvas msg <thread> --stdin` (plain text) over the
  observed 3–3.8KB curl heredocs — smaller commands, and it dodges the JSON-body-leak footgun
  (`canvas-msg-stdin-plain-text`). Worth one line in `thread-comms.md`; not worth more.
- Everything else on the micro list is already lean: short handles shipped, nudges content-free,
  spawn prompt minimal, thread history pull-not-push. **Resist adding machinery here** — at 1–3%
  of spend, complexity added to shave it costs more than it saves. Strip-back candidates are
  about *surface complexity*, not tokens.

### 6.6 Instrument it (so this review doesn't go stale)

The transcripts already carry full usage records. A tiny `scripts/canvas usage` roll-up (per
session: writes / reads / output / turns; per thread: spawns × onboarding, sweep count × median
replay) would make regressions visible — e.g. the 6.1 gate's effect, or a future harness edit
that breaks prefix cache stability (any *churning* content injected before the stable prefix —
timestamps, live status — would silently turn every spawn cold. Today's assembly is safely
static; keep it that way and keep churn in the *user* message, never the system prompt).

## 7. What this says about the research question

- **Bounded individual context: achieved for workers, violated by Coordinators.** Workers spawn
  at ~35k, pull their slice, and end; the pathology is the long-lived parked seat whose window
  monotonically grows. 6.3 closes the gap, and notably the *efficient* answer and the
  *architecturally pure* answer coincide: if the durable record is really the source of truth,
  no session ever needs a 240k window.
- **Bounded aggregate spend: the protocol is not the problem.** Coordination overhead ~1–3%;
  duplication second-order; onboarding amortized by prefix caching. Aggregate spend is dominated
  by turn-count × context-size — i.e., by *session lifetime policy*, which is exactly the knob
  threads-as-durable-state makes safe to turn.
- **The discipline compounds.** Every proposal above (gate wakes on state, respawn past a context
  cap, batch acts, distill into pins/briefs) works *because* the durable records exist. A
  monolithic single-context agent has none of these levers: its only choices are "keep paying for
  the whole window" or "lose the state." The canvas's levers are the design's payoff, and this
  corpus is the first quantified evidence they're worth pulling.
- **Open question the corpus can't answer yet:** whether a *hard shared* problem (heavy common
  context, deep interdependence between builders) stays this disjoint, or whether duplication
  grows toward the pessimistic case. The bcc616f8 episode (~44k duplicated reads across 6
  sessions) hints the cost is real but modest even then; a deliberate experiment — one hard
  problem, 3+ builders, measure shared-read overlap and whether pins/briefs substitute for
  re-reading — is the natural next probe.

## 8. Summary table

| Cost | Size (corpus) | Fix | Effort |
|---|---|---|---|
| No-op heartbeat sweeps | ~36.5M cache-read + 185k writes | 6.1 server-side gate | Small |
| Heartbeat replay (non-no-op) | ~64M cache-read | 6.3 context cap on seat occupants | Small–medium |
| Long-session replay generally | 20–50M cache-read per big session | 6.3 + 6.4 | Small |
| Coordination-only turns in workers | 5–13% of worker cache-read | 6.4 batching norm | One harness line |
| Spawn onboarding | ~4–4.5k fresh/spawn (amortized) | none needed — keep prefix cache-stable (6.6) | — |
| Message/id/nudge verbosity | ~1–3% of fresh spend | 6.5 one-line hygiene | Trivial |
| Cross-session duplication | ~130k input-equiv worst episode | pins/brief distillation norm; probe in §7 | Existing machinery |
