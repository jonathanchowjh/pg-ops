# pgops — the full-parity design

**Date:** 2026-09-03 · **Status:** design, approved
**Supersedes the roadmap in:** `2026-08-26-pgops-web-design.md` §10 (phase
*order* and the CLI); its §1–§9 survive and are amended here, not replaced.
**Amends:** `2026-09-03-pgops-p2-hygiene-design.md` — its 25 checks are
unchanged; the phase that ships them moves, and they gain a run model.
**Benchmark:** pgHero 4.0.1, unchanged. `parityBacklog()` is the authority on
scope; this document never restates a count the registry owns.

---

## 0. Why this spec exists

Two specs describe *what* pgops builds. Neither describes *what pgops is* once
all 65 capabilities are shipped, and the gap has started to cost.

Evidence, all of it in the tree today:

- `class: 'hygiene'` has **zero instances**. Every shipped check is `incident`.
  The taxonomy that governs the next 25 capabilities has never been exercised.
- `CheckContext.store?: Pool` has been a declared seam since P0 with nothing
  behind it — no `src/store/`, no `src/series/`, no `PGOPS_STORE_URL`.
- `runCheck` invents `{level: 'ok'}` for a check that has no opinion
  (`run.ts:99`). Harmless today; a false green dot the moment a surface reads
  verdicts per area.
- The P2 spec closes with a limitation it could not answer: with the CLI cut,
  a hygiene finding surfaces only when an operator opens the page.

**The decision this document records:** full pgHero parity is the goal,
including the history half. "Lite" means dropping peripheral detail inside a
capability, never dropping a capability. Two exceptions are declined with
reasons (§7).

---

## 1. The organizing idea

The parent spec's §1 says:

> *pgops is a function from a database to a set of findings. Everything else is
> transport.*

At full parity that is false, and the falsehood is load-bearing. **Eighteen of
the 25 P2 capabilities produce no finding.** `settings`, `table_stats`,
`indexes`, `relation_sizes` are *readings*: tables an operator looks at, with
no judgement attached. A model that calls them findings has to invent a verdict
for them, and it does.

The amendment:

> **pgops answers questions about a database. How a question is answered —
> live, on a schedule, or on request — is a property of the question, and it
> determines where it renders, whether it polls, whether it caches, and
> whether it may colour anything.**

Two orthogonal axes. Every surface decision in this document falls out of a
cell.

|                              | **escalates** (`verdict`)              | **reports** (`verdict: null`)     |
|------------------------------|----------------------------------------|-----------------------------------|
| **`incident`** — live, 5 s poll | triage panel · overview verdict         | triage panel only                 |
| **`hygiene`** — scheduled, cached | area page · **tab badge**              | area page only                    |
| **`on-demand`** — on click       | its own route                          | its own route                     |

A third kind of question — **series**, "how has this moved" — has its own
interface and no verdict at all. The parent spec §4.1 already established that
findings and series are siblings rather than variants; that stands.

### 1.1 The one-line consequence: `verdict: Verdict | null`

```ts
// run.ts today — a check with no opinion reports that everything is fine:
const verdict = check.verdict?.(data, check.thresholds ?? []) ?? { level: 'ok' };
```

This is the project's own discipline — *"we could not look" must never render
as "we looked and it's fine"* — violated one level down. Here it is **"we do
not judge" rendering as "we judged and it's fine."**

`CheckResult` becomes:

```ts
| { ok: true;  data: D; verdict: Verdict | null; measuredAt: number }
| { ok: false; reason: FailureReason; message: string; remedy?: string }
```

`runCheck` stops inventing. The overview's `RANK` treats `null` as
non-participating, exactly as it treats `ok:false` today. This change must land
**before** any hygiene check ships, because §4's badges read verdicts per area
and `null` would otherwise paint green.

---

## 2. `class` is the run model, and only that

Today `class: 'incident' | 'hygiene'` decides three things at once: where a
check surfaces, whether it polls, and how expensive it may be. It is already
bending — the P2 spec has to carve `index_bloat` out of the hygiene page by
hand, in prose.

Collapsed to one job:

| `class` | Run model | Cache | Timeout | Members |
|---|---|---|---|---|
| `incident` | live on every render; page polls at 5 s | none | must stay well inside 5 s | the 12 shipped checks |
| `hygiene` | the scheduler runs it; pages read the cache | `pgops.check_results` | 10 s | 24 of the P2 set |
| `on-demand` | only when the operator clicks | none | 30 s | `index_bloat` |

Surface follows from the class; it is no longer decided per check. `timeoutMs`
becomes a field on `Check` rather than a table in a spec, and `index_bloat`
becomes a class member rather than a carved-out exception.

**A hygiene page renders the cached result with its age, plus a "run now"
button.** This is strictly better than run-on-visit: the page is instant, and
it can show a finding computed ten minutes ago rather than making an operator
wait through a catalog scan during the one minute they cared.

### 2.1 Graceful degradation, not a special case

`hygiene` requires a store (§3). With no store configured, hygiene checks
degrade **one step along the same axis** to `on-demand`: run on visit, no
cache, no badge, badges read `unknown`. Nothing branches on a deployment mode;
one run model becomes unavailable and its members fall back to the next.

---

## 3. The store, and the DDL boundary

### 3.1 Why pgops needs a store when pgHero barely does

pgHero gets query-stat deltas by calling `pg_stat_statements_reset()` after
each snapshot — which silently breaks every other consumer of that extension on
the database. pgops refuses (parent spec §4.3, and it is the strongest product
claim in the corpus). Refusing means snapshotting cumulative counters and
diffing at read time, and that requires somewhere to put snapshots.

The store is not a feature. It is the price of that refusal, and it is
therefore not optional at full parity.

### 3.2 Layout

```
packages/checks/
  src/store/            pgops schema: DDL, forward-only migrations, read/write
  src/store/migrations/ the ONLY directory in the product permitted to hold DDL
  src/series/           Series<Point> — the over-time half
  src/capture.ts        captureOnce(ctx) — no timer, no process assumptions

apps/web/
  instrumentation.ts    Next register(): migrate, then setInterval → captureOnce
```

**The timer lives in `apps/web`; the work lives in `packages/checks`.**
`captureOnce` takes a context and returns. It knows nothing about intervals or
processes, so lifting capture into a CLI later is a wrapper, not a refactor.

`register()` must guard on `process.env.NEXT_RUNTIME === 'nodejs'` — Next fires
the hook for the edge runtime too, where `pg` cannot run. It also fires on
every dev-server restart, so migrations being forward-only and version-gated is
a **requirement**, not a happy accident.

**Every tick takes a Postgres advisory lock keyed on the database id.** N
replicas write once. This is what makes in-process capture safe and is why
`packages/cli` is not needed for parity (§8).

**Cadence and scope.** One timer, iterating every configured database in turn,
never in parallel — a diagnostic tool must not be the reason connections run
out, which is the same reasoning that caps `poolFor` at ten. Two intervals,
because the two jobs have different costs and different consumers:

| Job | Interval | Why |
|---|---|---|
| capture (`query_stats`, `space_stats`) | 5 min | pgHero's own capture cadence; `space_stats` is cheap at this rate and `query_stats` deltas need enough points to chart |
| hygiene (`check_results`) | 15 min | Hygiene findings move on the timescale of migrations and growth, not seconds. A tighter interval buys nothing and puts catalog scans on a schedule. |

A tick that lands while the previous one is still running is **skipped, not
queued** — the `usePoll` rule (parent spec §6.3), applied to the scheduler for
the same reason: the tool must never add load to the database it is
diagnosing.

### 3.3 The DDL boundary — and a promise this design nearly broke

The README states:

> *pgops does not install extensions, manage roles, or run DDL.*

Migrations at boot make that false, and the parent spec §0's fallback — *"the
store falls back to the monitored database when there is only one"* — makes it
dangerous: on the documented simplest deployment (`docker run -e
DATABASE_URL=…`) pgops would issue `CREATE SCHEMA` against a production
database an operator pointed it at expecting a read-only tool.

**The fallback is cut.** History requires an explicit `PGOPS_STORE_URL`.

| `PGOPS_STORE_URL` | Consequence |
|---|---|
| set | pgops migrates and owns the `pgops` schema **in that database only**. Scheduler runs. Hygiene is scheduled and cached; badges are live. Series available. |
| unset | No DDL anywhere, ever. No scheduler. Hygiene degrades to `on-demand` (§2.1); badges read `unknown`. Series capabilities report `missing-store`. |

`missing-store` is a **new member of `FailureReason`**, alongside `privilege`,
`missing-extension`, `unsupported-version`, `unreachable` and `error`. It earns
its place for the same reason the others do: `reason` is machine-readable so
the surface can render the exact remedy, and the remedy here is a specific
environment variable, not a `GRANT` or a `CREATE EXTENSION`. Reporting an
unconfigured store as `error` would tell an operator their database was
unwell — the misattribution class `run.ts`'s I1 and `check.ts`'s M8/F4
docblocks were both written to prevent.

The README sentence becomes precise rather than false:

> *pgops runs no DDL against a monitored database. Given `PGOPS_STORE_URL` it
> creates and migrates its own `pgops` schema in that store, and nowhere else.*

The cost is that the single-database deployment has no history until the
operator opts in with one environment variable. That is the correct trade: the
promise is worth more than the default.

### 3.4 Schema

```sql
CREATE SCHEMA pgops;

pgops.schema_version  (version int)
pgops.databases       (id, name, created_at)
pgops.queries         (id, database_id, queryid, query, first_seen, last_seen)
pgops.query_stats     (database_id, query_id, captured_at, calls,
                       total_exec_time, rows, shared_blks_hit,
                       shared_blks_read, stats_reset)     -- cumulative, never deltas
pgops.space_stats     (database_id, relation, captured_at, size_bytes)
pgops.check_results   (database_id, check_id, computed_at, ok,
                       verdict_level, data jsonb)          -- PRIMARY KEY (database_id, check_id)
```

**`check_results` is a cache, not a log.** One row per `(database_id,
check_id)`, upserted. Given a `captured_at` and append-only semantics it would
*be* a history of verdicts, and then two mechanisms would answer "how has this
moved" — `Series` and a table that grew into one. One question, one mechanism.

Query text is normalised into `pgops.queries` so a 5,000-shape database does
not store ~1 kB × 5,000 × 288/day of duplicated text. Retention is pruned in
the same transaction as the insert, so it cannot drift from capture: 14 days
for `query_stats`, 90 for `space_stats` (pgHero's numbers).

### 3.5 Delta maths

Counters are cumulative since the last reset. An interval is a
**discontinuity** and is **dropped** — not clamped to zero, not rendered as a
spike — when either `stats_reset` (`pg_stat_statements_info`, PG14+) advanced,
or any counter decreased. Both an explicit reset and an LRU eviction
(`pg_stat_statements.max` defaults to 5,000) produce the same signature and are
handled identically.

A gap in a chart is honest. A spike is a lie that reads as an incident.

---

## 4. The surface at full parity

```
Triage · Sessions · Locks · Queries │ Indexes · Tables · Space · Sequences · Maintenance · Settings │ Trends
└──────── incident: polled ─────────┘ └──────── hygiene: scheduled + cached ────────────┘  └─ series ─┘

  /db/[name]/indexes/bloat      on-demand · linked from Indexes · never in the strip
  /db/[name]/queries/explain    P6 · see §7
```

Eleven tabs, one group separator, two unbadged sub-routes. `class` is what
groups the strip — the field finally does visible work.

**Trends is the one tab that can disappear.** It renders series, series require
the store, and a tab leading to a page that only ever explains why it is empty
is worse than no tab. With `PGOPS_STORE_URL` unset the strip has ten tabs and
the overview says once, in the status line, that history is unconfigured and
which variable turns it on.

### 4.1 The badge rule

A hygiene tab shows the **worst verdict among its area's checks**, read from
`check_results`. Readings (`verdict: null`) colour nothing. Incident tabs never
badge: they poll, and the triage page already shows their state.

| Tab | Can badge? | Escalating members |
|---|---|---|
| Indexes | yes | #22 index_hit_rate, #26 unused_indexes, #27 invalid_indexes, #55 invalid_constraints |
| Tables | yes | #33 table_hit_rate |
| Sequences | yes | #53 sequence_danger |
| Maintenance | yes | #45 autovacuum_danger |
| **Space** | **never** | none — #37/#38/#39 are all readings |
| **Settings** | **never** | none — #56 is a reading |

That accounts for all seven thresholds the P2 spec §2.1 defines. **Two tabs
that can never light up is the correct outcome, not an inconsistency to fix.**
Adding a threshold to `database_size` so the strip looks uniform is exactly the
parent spec §3.2 failure mode — a number whose justification is invented.

**Three badge states, not two.** `ok` / `warn` / `critical`, plus **unknown**
when `check_results` holds no recent row: fresh boot, capture failing, capture
never configured (§2.1). A cached badge with no cache behind it reads unknown,
never green. Same rule as everywhere else in this project, applied to the strip.

### 4.2 The overview is unchanged

One worst verdict per database across incident checks, unavailable counted
separately. It answers *"is anything wrong **anywhere**"*; the strip answers
*"where **in this database**"*. Two questions, two surfaces, no overlap — and
no `/doctor`, which would be a third answer to the second question (§8).

---

## 5. Phase order

`planned: 'P3'` in the registry means **"P3 owns this"**, not "P3 happens
third". Phase labels are ownership, not sequence, and `registry.test.ts:58`
iterates `COMPLETE_PHASES` independently of any ordering — so building P3
before P2 costs zero registry churn. Renumbering 43 entries to make labels sort
would be ceremony.

Build order becomes data: `export const PHASE_ORDER` beside `COMPLETE_PHASES`,
and CI prints *next phase* alongside the backlog count.

| Order | Phase | Ships | Backlog |
|---|---|---|---|
| in flight | **P2a** | the six incident-class capabilities; land it | 43 |
| 1 | **P3 · the store** | schema, migrations at boot, `PGOPS_STORE_URL`, advisory lock, scheduler, `query_stats` + `space_stats` capture, delta maths, retention. Plus §1.1 `verdict: null` and §2's `class` collapse — both small, both must precede hygiene. Closes #15, #21, #42 | → 40 |
| 2 | **P2 · the hygiene class** | `check_results`, 25 checks, six routes, grouped nav, badges. Closes 25 | → 15 |
| 3 | **P4 · trends** | charts over P3's data. Closes #16, #40, #41 | → 12 |
| 4 | **P5 · remaining actions** | `analyze`, `reset`, enable/disable query stats, bulk kill. Closes 6 | → 6 |
| 5 | **P6 · the long tail** | `explain`, the `suggested_indexes` family, and the #59 decline. Closes 5, declines 1 | → **0** |

### 5.1 P3 ships no page, and that is its risk

P3 closes three capabilities, adds an entire data plane, and produces no new
route. Phases with nothing to show are the ones that drift.

Mitigation: **#15 `historical_query_stats` surfaces on the existing Queries
page** as a "since last capture" delta column. No chart, no new route, one
column — and it exercises §3.5's delta maths against real captured data before
P4 depends on it.

This makes an *incident* page read the store, which is new. It is one indexed
lookup per render and it must stay that way; and with no store configured the
column is absent rather than empty, because a blank delta column reads as "this
query has not moved" when it means "we never looked."

### 5.2 The registry needs a sixth variant

`ParityEntry` has five states — `check` / `action` / `platform` / `planned` /
`declined`. #15, #16, #40 and #41 are **series**: `Series<Point>` has `read`,
not `sql`/`map`/`verdict`, so `check: CheckId` cannot name one. P3 would either
fail to mark #15 shipped or lie with a `check:`.

Precedent settles it — this problem was solved twice already, when `kill` got
`{ action: ActionId }` and multi-database got `{ platform: string }`. P3 adds
`{ series: SeriesId }`, and `registry.test.ts`'s partition test gains a sixth
name.

---

## 6. What "lite" means

**Lite is a documented divergence recorded at the code. It is never a skipped
capability.** A capability is shipped when an operator can get the answer
pgHero gives — not when pgops gets it the same way or with the same chrome.

The mechanism already exists and already works: #37 `database_size` returns
bytes rather than `"8192 MB"` because a formatted string cannot be thresholded
or charted; #56 `settings` is one `pg_settings` query rather than fifteen
`SHOW`s. Each lives in the registry entry's comment, so the divergence travels
with the capability.

Three tests for droppable detail:

1. **Chrome around an answer pgops already gives** → drop it.
2. **Depends on something pgops refuses on principle** → diverge, and say so.
3. **Requires a dependency out of proportion to the answer** → §7.

---

## 7. The two dependency decisions, and the second decline

All of the hard "lite" calls are in P6, whose six entries are really three
things.

**#57 `explain` — shipped, but not as a `Check`.** `Check.sql` is parameterized
by *options*; `explain` is parameterized by **operator-supplied SQL text**. It
is not a question about a database, it is a question about a statement, which
is why it does not fit either axis in §1. #64 `best_index` has the same shape.
Their type is **deliberately not designed here** — it is a P6 decision, five
phases out, and designing it now would be inventing structure for code nobody
has written.

**#58 / #62 / #63 / #64 — the `suggested_indexes` family — shipped with a
parser.** pgHero uses `pg_query` (a libpg_query binding) to parse statements;
pgops adds the equivalent to the image. Four capabilities, and index
suggestions are the highest-value thing pgHero does. The dependency is
justified by what it buys.

**#59 `system_stats` — declined.** CPU, IOPS and free space from CloudWatch or
GCP monitoring: per-cloud credentials and a cloud SDK, for one panel, blank for
everyone self-hosting. The parent spec §11 already cut `events` for exactly
this reason and #59 is the same shape. It becomes the second entry in
`declined`, after `kill_all`.

**Final trajectory: 43 planned → 0 planned, 2 declined.** `parityBacklog()`
reaching zero is the claim, and CI reports it.

---

## 8. Cut

| Cut | Reason |
|---|---|
| **`packages/cli`** | The README promises *"no agent to install and nothing to schedule."* A cron'd `pgops capture` breaks that for zero capability gain; the advisory lock makes in-process capture safe. **Deferred, not declined** — `captureOnce(ctx)` is a plain function, so a CLI is a wrapper if a user ever asks. |
| **`pgops init`** | Migrations run at boot under the same lock, gated on `PGOPS_STORE_URL` (§3.3). DDL stays unreachable from any request handler; the tier-3 rule survives, moving from "CLI only" to "boot only". |
| **`/doctor`** | Permanently. The badged strip is the roll-up. Two surfaces answering *"where in this database"* is the collision this project has already made once. |
| **`check --format json`, exit codes** | Not a pgHero capability, so not parity. See §9. |
| **The store's fallback to a monitored database** | §3.3. |
| **#59 `system_stats`** | §7. |

The parent spec §11's cuts — `mcp`, `events`, `parts`, the nine-tab digit
bindings, `--snapshot` — all stand.

---

## 9. What this design does not do

**Nothing here delivers a finding to a human who is not looking.** The
scheduler makes a hygiene finding *computed* without anyone opening a page; it
does not make it *arrive*. There is no notification surface — no webhook, no
email, no exit code. An operator must open the console to see a badge.

This is the P2 spec's limitation, narrowed but not closed, and it is recorded
here for the same reason: so it is not rediscovered as a defect. Alerting is
out of scope until a user asks for it, at which point `check_results` is
already the table a notifier would read.

Also out of scope: visual design of the pages; whether `packages/cli` is ever
published; anything requiring pgops to hold credentials for a service other
than Postgres.

---

## 10. Testing

The integration suite runs ~244 s across 15 files with `fileParallelism:
false`, times a four-version CI matrix. Twenty-five hygiene checks plus a store
phase break that budget.

### 10.1 Splitting the integration project

`fileParallelism: false` exists for a correct reason (`vitest.config.ts`):
incident checks read **cluster-wide** catalogs — `pg_stat_activity`, `pg_locks`
— so sibling files' short-lived fixtures race. The harness already gives every
file its own database from one shared container.

That reason does not apply to a check reading only database-scoped catalogs.
Two projects, one `globalSetup` container:

| Project | Parallel | Contains |
|---|---|---|
| `integration` | no | anything reading cluster-wide state — `sessions`, `locks`, `blocked`, `longRunning`, `kill`, **and `vacuum_progress`**, which reads `pg_stat_progress_vacuum` despite living in a hygiene area |
| `integration-hygiene` | **yes** | checks whose every catalog is database-scoped |

**Membership is verified per check when its SQL is written, never assumed.**
`#32 last_stats_reset_time` reads `pg_stat_database`, and the harness creates
and drops a database per file — so it may belong in the serial project. The
rule is the deliverable; the list is derived from it.

### 10.2 Guards

Pure, fast, and each one closes a failure that would otherwise be silent.

1. Every `class: 'incident'` check appears in the overview's list — *exists today*.
2. **No `hygiene` or `on-demand` check is reachable from a polled page.**
   Replaces the P2 spec's `<Refresh>` source-regex with an assertion on
   `class` — the field, not the JSX.
3. **Capture never resets shared statistics.** Run capture twice; assert
   `pg_stat_statements` counters increase monotonically. The parent spec §9
   calls this the strongest product claim in the document, and **it has never
   been written.** It lands in P3 or the claim is unbacked.
4. **DDL appears only under `src/store/migrations/`.** A source guard,
   replacing the old "CLI only" boundary now that migrations run at boot.
5. Every `hygiene` and `on-demand` check declares a `timeoutMs`.
6. Every hygiene check reading a cluster-wide catalog is in the serial project
   (§10.1).

### 10.3 The rest

**Unit tests carry the weight**, as the P2 spec argued: pure `map` tests for all
25, and boundary tests at the value and one unit either side for the seven that
escalate.

**Delta maths** gets a pure test: a synthetic counter series containing a
mid-series reset and an LRU eviction, asserting the interval is dropped —
never clamped, never spiked.

**Verdicts under truncation** (P2 spec §6) is unchanged and still the priority
case: a fixture larger than the row cap, asserting the verdict reads the
`count(*) OVER ()` total rather than `rows.length`.

---

## 11. Summary of amendments to existing specs

| Document | Amendment |
|---|---|
| `2026-08-26-pgops-web-design.md` §10 | Phase *order* becomes P3 → P2 → P4 → P5 → P6. The CLI leaves the roadmap (§8). |
| same, §0 | The store's fallback to a monitored database is cut (§3.3). |
| same, §3.3 | `CheckResult.verdict` becomes `Verdict \| null` (§1.1); `FailureReason` gains `missing-store` (§3.3). |
| same, §4.3 | Capture runs in-process on an advisory lock, not on external cron (§3.2). |
| same, §4.6 | `pgops init` is replaced by migrations at boot (§3.3). |
| same, §6.2 | Route list replaced by §4; `/doctor` cut. |
| `2026-09-03-pgops-p2-hygiene-design.md` §4.2 | The `<Refresh>` move is superseded: the poll boundary is enforced on `class`, not on JSX (§10.2). |
| same, §4.3 | Hygiene does reach a surface beyond its own page — the tab badge — because the store now exists to cache it (§4.1). |
| same, §5 | Per-check `statement_timeout` becomes `timeoutMs` on `Check` (§2). |
| `registry.ts` | `ParityEntry` gains `{ series: SeriesId }` (§5.2); `PHASE_ORDER` is added (§5); #59 moves to `declined` (§7). |
| `README.md` | The DDL sentence is made precise (§3.3). |
