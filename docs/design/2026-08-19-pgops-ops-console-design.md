# pgops v0.2 — "The Ops Console" (pgHero replacement) — design spec

**Date:** 2026-08-19 (rev. 4, 2026-08-20) · **Status:** approved — pgops is a strict superset of pgHero (§3); 28 capability gaps found and assigned

## 1. Mission

> `pgops` is the Postgres ops console. The daily review **and** the incident, in
> your terminal. You should not need a browser, a hosted dashboard, or a SaaS
> agent to know how your database is doing.

This is a deliberate **thesis change**. v0.1 claimed a narrow lane:

> ~~"pgHero is your daily dashboard. pgBadger is your postmortem tool. pganalyze
> is the enterprise SaaS. pgops is what you run during the incident."~~

That framing ceded the daily-dashboard ground to pgHero. v0.2 takes it. pgHero
moves from *complement* to *the tool being replaced*; pgBadger and pganalyze
keep their lanes (offline log parsing, enterprise SaaS) and are still not
competitors.

**What does not change:** terminal-native, action-shaped, free, no agent, no
hosting, nothing leaves your VPC. Those were always the moat, and taking on
pgHero's scope strengthens rather than dilutes them — pgHero's two standing
weaknesses in our own competitor table are *"need to host it"* and *"not
incident-shaped."* We keep both advantages while removing its feature lead.

**Rev. 4 makes "removing its feature lead" a literal, testable rule** rather
than an aspiration: pgops is a *strict superset* of pgHero (§3.1), audited
capability by capability against pgHero source and enforced by a checked-in
registry (§10). The tagline is `pgHero + the incident + the terminal`, and the
first term of that is now an obligation with a test behind it.

## 2. Current state (as of this spec)

**Built and tested (v0.1, commit `3841e2a`):** the triage cockpit
(`src/commands/home/`), `locks`, `sessions`, `top`, shared core (connection
pool, snapshot writer, theme, audit log, filter, list-navigation hook,
freshness/status bar), universal `--snapshot`, hardened kill (confirm modal +
session-identity re-check + audit log).

**Shipped since (v0.2, commit `f8a7e4f`):** the shared `Table` primitive
(`src/ui/table-layout.ts`, `src/ui/Table.tsx`) with virtualised scroll, migrated
onto `sessions` and `top` — Phase 1(1), less its terminal-geometry work (§9).

**What v0.2 adds:** nine new content areas, a historical-stats collector, a
`pgops` schema, a global navigation layer, and the §4 action ladder. Rev. 4
raised the content count from eight after the §3 audit found `tables`,
`replication`, and `system` unowned.

## 3. Competitive baseline — complete pgHero parity audit

### 3.1 The parity rule

> **pgops is a strict superset of pgHero.** Every question pgHero can answer,
> pgops answers. Nothing pgHero surfaces may be absent from pgops without an
> entry in §3.4 naming the reason and the equivalent we ship instead.

Rev. 3 mapped pgHero's 16 *modules* and concluded "three we beat, eight new."
That was too coarse: a module is not a capability, and mapping at module
granularity hid genuine gaps inside modules we had marked **done**. Rev. 4
replaces it with a capability-level audit against pgHero source
(`lib/pghero/methods/*.rb`, `app/controllers/pg_hero/home_controller.rb`,
`app/views/pg_hero/home/*.erb`).

**60 capabilities.** Legend: **have** = shipped in v0.1 · **spec'd** = named in
this document with an owning view · **GAP** = found by this audit, previously
unspecified.

### 3.2 Capability matrix

**`basic` — 3**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 1 | Server version | status bar | GAP |
| 2 | Database name, current user | status bar (`safeTarget`) | have |
| 3 | SSL in use (`ssl_is_used()`) | `sessions` detail | GAP |

**`connections` — 4**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 4 | Connection list: pid, db, user, app, IP, state, SSL | `sessions` | have |
| 5 | Total connections vs `max_connections` | cockpit CONNECTIONS | have |
| 6 | Connection states census | cockpit SESSIONS | have |
| 7 | **Connection sources** — db × user × app × IP, ranked | `sessions` — `c` toggles grouped view | GAP |

**`queries` — 3**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 8 | Running queries, live, with wait status | `sessions` | have |
| 9 | Long-running queries (`long_running_query_sec`, default 60 s) | cockpit LONG-RUNNING (5 s) + `--long-running-sec` | partial (threshold not configurable) |
| 10 | Blocked queries: locked item, both sides' pid/user/query/lockmode | `locks` — **we beat it**, full wait chain not one hop | have |

**`kill` — 3**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 11 | `kill(pid)` | `x` in `sessions`/`locks` — **we beat it** (§3.4a) | have |
| 12 | `kill_long_running_queries` (bulk) | `X` bulk kill, §4 ladder | GAP |
| 13 | `kill_all` (bulk) | **deliberately declined** — §3.4d | declined |

**`query_stats` — 8**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 14 | Live `pg_stat_statements` top-N | `top` | have |
| 15 | Historical stats, `start_at`/`end_at` slicing | `top` + `pgops.query_stats` | spec'd |
| 16 | **Per-query 24 h trend** (`query_hash_stats`, show_query page) | `top` → `Enter` → query detail | GAP |
| 17 | **`slow_queries`** — threshold-based, not top-N | `doctor` finding + `top` marker | GAP |
| 18 | Extension availability / readability probe | `top` error mapping (`explain()`) | have |
| 19 | `enable_query_stats` — `CREATE EXTENSION` | `pgops init --query-stats` (§4) | GAP |
| 20 | `reset_query_stats` (global or per user/query) | `pgops reset --query-stats` (§4) | GAP |
| 21 | Capture + retention | `pgops capture` (§6.2) | spec'd |

**`indexes` — 11**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 22 | `index_hit_rate` (global) | `indexes` header | spec'd |
| 23 | **`index_caching`** — per-index hit rate | `indexes` column | GAP |
| 24 | **`index_usage`** — index vs seq-scan % per table | `tables` view | GAP |
| 25 | **`missing_indexes`** — usage < 95 % on tables ≥ 10 000 rows | `indexes` + `doctor` | GAP |
| 26 | `unused_indexes` — `idx_scan <= 50`, `NOT indisunique`, ≥ min size | `indexes` | spec'd |
| 27 | `invalid_indexes` — incl. in-progress `CREATE INDEX CONCURRENTLY` | `indexes` | spec'd |
| 28 | `duplicate_indexes` — same table, method, covered columns | `indexes` | spec'd |
| 29 | `index_bloat` — wasted bytes over min size | `indexes` | spec'd |
| 30 | **`indexes`** — full list: definition, columns, unique, valid | `indexes` (default listing) | GAP |
| 31 | **`reset_stats`** (`pg_stat_reset()`) | `pgops reset --stats` (§4) | GAP |
| 32 | **`last_stats_reset_time`** | status bar on `top`/`indexes` | GAP |

**`tables` — 4**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 33 | **`table_hit_rate`** (global heap cache hit) | `tables` header | GAP |
| 34 | **`table_caching`** — per-table hit rate | `tables` column | GAP |
| 35 | **`unused_tables`** — `idx_scan = 0` | `tables` + `doctor` | GAP |
| 36 | `table_stats` — estimated rows + total size | `space` | spec'd |

**`space` — 6**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 37 | `database_size` | `space` header | spec'd |
| 38 | `relation_sizes` — tables, matviews, indexes | `space` | spec'd |
| 39 | `table_sizes` | `space` | spec'd |
| 40 | `space_growth` over N days (default 7) | `space` headline | spec'd |
| 41 | **`relation_space_stats`** — 30-day per-relation history | `space` → `Enter` → relation detail | GAP |
| 42 | Capture + retention (pgHero: 90 days) | `pgops capture --space` (§6.3) | spec'd |

**`maintenance` — 5**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 43 | **`maintenance_info`** — last (auto)vacuum/analyze, dead/live rows per table | `vacuum` (the view's default listing) | GAP |
| 44 | **`transaction_id_danger`** — **per table**, < 10 M transactions left | `vacuum` | GAP |
| 45 | `autovacuum_danger` — per table, < 2 M vs `autovacuum_freeze_max_age` | `vacuum` + cockpit escalation | partial (cockpit is database-wide only) |
| 46 | **`vacuum_progress`** — `pg_stat_progress_vacuum` phase per pid | `vacuum` + cockpit when non-empty | GAP |
| 47 | **`analyze(table)` / `analyze_tables`** — an action | `A` in `vacuum`, §4 ladder | GAP |

**`replication` — 4**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 48 | `replica?` — `pg_is_in_recovery()` | status bar badge | GAP |
| 49 | **`replication_lag`** in seconds | `replication` view + cockpit | GAP |
| 50 | `replication_slots` — name, database, active | `replication` — **we beat it**, we add retained WAL | have |
| 51 | `replicating?` — `pg_stat_replication` | `replication` view | GAP |

**`sequences` — 3**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 52 | Sequences with column-type max (32767 / 2147483647 / 9223372036854775807) | `seq` | spec'd |
| 53 | `sequence_danger` — **pgHero flags at 90 %** | `seq` reports ≥ 90 %, escalates ≥ 95 % (§5.2) | spec'd — threshold corrected |
| 54 | **Unreadable sequences** (privilege-limited) named, not silently dropped | `seq` — `n/a (no privilege)` row | GAP |

**`constraints` — 1**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 55 | `invalid_constraints` — `convalidated = 'f'` | `seq` (absorbs constraints) | spec'd |

**`settings` — 1**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 56 | 24 settings in 3 groups (main / autovacuum / vacuum), version-aware for PG18 | `config` — same groups, same version branch | spec'd |

**`explain` — 1**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 57 | `EXPLAIN` on a pasted query | `explain`, contextual from `top` | spec'd |

**`suggested_indexes` — 1**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 58 | AST parse + `pg_stats` selectivity; ≥ 500 rows, stop < 50 rows or 2 cols, 0.3 ratio | `indexes` (Phase 5) | spec'd |

**`system` — 1**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 59 | CloudWatch / GCP Monitoring: CPU, connections, replica lag, read/write IOPS, free space | `system` view (§7) | **GAP — non-goal reversed, §12.5** |

**Platform — 1**

| # | pgHero capability | pgops surface | Status |
|---|---|---|---|
| 60 | **Multiple databases**, switchable from the UI | `pgops.toml` + `D`-less database switcher (§12.3) | **GAP — decision reversed, §12.3** |

### 3.3 Audit result

| | Count |
|---|---:|
| Already shipped in v0.1 | 10 |
| Already specified in rev. 3 | 19 |
| **GAP — found by this audit** | **28** |
| Partial — capability present, detail missing (#9, #45) | 2 |
| Deliberately declined (§3.4) | 1 |
| **Total pgHero capabilities audited** | **60** |

Twenty-eight capabilities were missing from a spec that claimed pgHero
replacement. Every one now has an owning view in §7 and a phase in §9.

The three most consequential, because each is *incident*-class rather than
hygiene and so belongs on the fast path rather than in `doctor`:

- **#46 `vacuum_progress`.** "Is an autovacuum already running on this table,
  and what phase is it in" is a first-five-minutes question. `pg_stat_progress_vacuum`
  answers it in one cheap query and the cockpit should show it whenever it is
  non-empty.
- **#49 `replication_lag`.** Rev. 3 mapped pgHero's whole `replication` module
  onto `slots` and silently dropped lag — the single most-watched replication
  number in production.
- **#44 per-table wraparound.** The cockpit's database-wide
  `max(age(datfrozenxid))` tells you *that* you have a problem; pgHero's
  per-table view tells you *which table to vacuum*. Only the second is
  actionable, and §5.2's own actionability test therefore requires it.

### 3.4 Deliberate divergences

Four places where pgops does **not** copy pgHero. Three are strict improvements;
one is a declined action. All four are load-bearing and must survive
implementation.

**a. Kill is guarded.** pgHero's `kill(pid)` is a bare
`pg_terminate_backend(:pid)` behind a button. pgops confirms in a modal,
re-checks `backend_start` so a recycled pid cannot be killed by mistake, and
writes an audit line. Same capability, materially safer.

**b. Capture is non-destructive.** pgHero's `capture_query_stats` calls
`pg_stat_statements_reset()` after each snapshot — that is how it gets deltas,
and it means installing pgHero silently breaks every other consumer of
`pg_stat_statements` on that database. pgops stores cumulative counters and
diffs at read time with explicit reset detection (§6.3). **pgops must never
reset a shared statistics view as a side effect of capture.** Resetting stays an
explicit user action (#20, #31).

**c. Our tables live in our own schema.** pgHero creates `pghero_query_stats`
and `pghero_space_stats` in `public`, in the database being monitored. pgops
creates `pgops.*`, only under `pgops init` (§4).

**d. No `kill_all`.** pgHero ships a one-click terminate-every-connection.
There is no incident in which "kill every session, unreviewed" is the correct
first move, and it fails §5.2's actionability test in the opposite direction —
it is an action with no diagnosis. pgops ships `X` (bulk kill of the *current
filtered selection*, itemised in the confirm modal) which covers the real use
case behind `kill_long_running_queries` (#12) without the blast radius. This is
the one pgHero capability pgops does not have, and it is deliberate.
## 4. Safety posture — the action ladder

v0.1 promised *"Read-only by default"* (README §Safety). Rev. 3 narrowed it to
*"the only action taken against your workload remains `x` → kill."* The §3
parity rule breaks that sentence: pgHero ships six actions, and a superset ships
at least five of them.

The promise is therefore restated as a **ladder**, not a single claim. Each rung
names what it can do and what gate stands in front of it. The gate is the
product; the capability is table stakes.

> **pgops never writes to your data.** It never issues `INSERT`, `UPDATE`,
> `DELETE`, `TRUNCATE`, or schema DDL against a table it did not create. Every
> rung below is either a read, a write confined to the `pgops` schema, or an
> operational command that a DBA would otherwise type into `psql` — and each
> one above Tier 0 is reachable only through an explicit, itemised gate.

| Tier | What | Gate | Capabilities |
|---|---|---|---|
| **0** | Read | none — always available | every view, `doctor`, `--snapshot` |
| **1** | Terminate a backend | confirm modal + `backend_start` re-check + audit line | `x` single kill (#11), `X` filtered bulk kill (#12) |
| **2** | Operational command | confirm modal naming the exact statement + audit line | `A` `ANALYZE` (#47), `pgops reset` (#20, #31) |
| **3** | DDL | **`pgops init` only** — never a view, never implicit | `CREATE SCHEMA pgops` + tables, `CREATE EXTENSION pg_stat_statements` (#19) |

**Rules this imposes.**

- **Tier 3 has exactly one entry point.** `pgops init` is the only code path in
  the binary that issues DDL. A view may *report* that
  `pg_stat_statements` is missing and *name* the command; it may never run it.
  This is unchanged from rev. 3 and is the load-bearing rule of the whole
  posture.
- **Tier 2 shows the statement before it runs it.** The confirm modal for `A`
  reads `ANALYZE public.orders;` — the literal text. An operator must never
  approve a category of action, only a specific one.
- **Every Tier ≥ 1 action writes an audit line**, reusing `src/core/audit.ts`.
- **`pgops capture` never resets a shared statistics view** (§3.4b). This is the
  one place where copying pgHero would be actively harmful.
- **Without `pgops init`, every view still works.** History-backed panels render
  `n/a (no capture history — run pgops init)`, reusing the existing per-panel
  isolation path (`PanelResult.ok === false`). A missing collector must never
  blank a screen, and must never render a `✓`.
- **Least-privilege roles are documented per tier.** Views need `SELECT`;
  `capture` additionally needs `INSERT`/`DELETE` on `pgops.*`; Tier 1 needs
  `pg_signal_backend`; Tier 2 `ANALYZE` needs table ownership or
  `pg_maintain` (PG17+); `init` needs `CREATE`. The §3.4c schema separation is
  what makes these grantable rather than aspirational.
- **`--read-only` disables Tiers 1–3 entirely**, for a shared or production
  connection string. pgHero's equivalent (`disable_kill`) is bypassed by its own
  bulk-kill methods; ours is checked in `core/` at the single choke point every
  action passes through, not per call site.
## 5. Information architecture — the tab strip

### 5.1 Decision

Navigation is **flat and global**: every view is reachable in one keystroke from
anywhere, including from inside a drill-down. The landing screen stays the
cockpit.

The strip is pgHero's tab bar, with one correction: **it carries incident glyphs
only.** See §5.2 for why that restraint is the whole point.

```
┌──────────────────────────────────────────────────────────────────────┐
│ pgops  localhost:5432/appdb  updated just now       s snap · q quit  │
└──────────────────────────────────────────────────────────────────────┘
 1 triage  2 sessions⚠  3 locks⚠  4 top  5 space
 6 vacuum  7 replication  8 seq  9 system        D doctor
 ────────
▸ SESSIONS ⚠ oldest idle-in-transaction 138s
    active                       3    2m 17s
    idle in transaction          1    2m 17s

  BLOCKED ⚠ 2 pid(s) waiting
    2 waiting · longest 2m 17s · suspect pid 89

  LONG-RUNNING ⚠
       90   2m 17s UPDATE users SET n = n + 1 WHERE id = 1

 1-9 jump · Tab next · Enter drill in · D doctor · q quit
```

### 5.2 Two urgency classes — the governing rule

**A ⚠ in pgops means "act now." It must never mean "act eventually."**

This is the single most important rule in the spec, and it is what pgHero gets
wrong. Its tabs are undifferentiated, so *"you have four unused indexes"* and
*"a transaction is blocking production writes"* arrive with identical weight.
`src/commands/home/Home.tsx:46` already states our opposing principle: *"ok is
deliberately dim: only a problem should draw the eye during an incident."*

An earlier draft of this spec put a verdict glyph on every tab. That was
wrong: it would have rendered `locks ⚠` and `indexes ⚠` identically, which does
not add information — it **destroys** the meaning of ⚠, the one thing pgops does
better than pgHero. Several tabs also have no honest verdict at all: "12
settings differ from default" is what a *tuned* database looks like, not a
finding.

Each class decides the treatment:

| Class | Means | Surface | Strip indicator |
|---|---|---|---|
| **Now** | Drop what you are doing | the **cockpit** (tab `1`) | ⚠ / critical glyph |
| **Eventually** | Hygiene; schedule it | **`doctor`** (§8) | none — plain name only |

**The class is a property of the finding, not of the area.** An area has a
*default* class, but any area may escalate a specific finding to "now" when it
crosses a named threshold. This follows established practice rather than taste:
Google SRE assigns page-vs-ticket per *alert condition*, not per subsystem — a
low error rate for an hour files a ticket while a 100 % error rate pages, from
the same subsystem. Organising severity by subsystem is the thing SRE practice
explicitly does not do.

The concrete case that forced this: a sequence at 99 % of an `int4` column is
hours from failing every `INSERT`. Integer-overflow incidents are well
documented and have come within a day of halting large production systems. A
rule that filed that under "eventually" would be wrong.

**Escalation discipline.** Without limits this collapses back into
warning-on-everything, so:

1. An escalation must be a **named, documented threshold in code** — never a
   judgement made at render time.
2. It must pass the **actionability test**: there is a specific action available
   *now*. If the honest answer is "plan a migration next sprint," it is not
   "now." (Alert-fatigue practice: an alert nobody can act on should not exist.)
3. The escalation set is **enumerated here**. Adding one is a deliberate spec
   change, enforced by the §10 test.

| Area | Default | Escalates to "now" when |
|---|---|---|
| `seq` | eventually | a sequence reaches **95 %** of its column type's max (critical at 99 %) |
| `space` | eventually | tablespace or disk headroom drops below **10 %** |
| `vacuum` | eventually | wraparound ≥ **75 %** of horizon (existing `verdictWraparound`), **or** a vacuum is in progress on a table you are looking at |
| `replication` | eventually | replica lag exceeds the configured bound, **or** an inactive slot retains WAL past it (existing `verdictSlots`) |
| `system` | eventually | free storage space drops below **10 %** |
| `indexes` | eventually | **never** — bloat and unused indexes are never an emergency |
| `tables` | eventually | **never** — a cold cache or an unused table is a tuning finding, not an incident |
| `config` | eventually | **never** — settings differing from default is not a finding |

Note `seq` **reports** from 90 % (pgHero parity, §3.2 #53) but **escalates** at
95 %. Reporting threshold and escalation threshold are independent, and
conflating them is the mistake this section exists to prevent: a 92 % sequence
belongs in the `seq` view and belongs nowhere near the strip.

That three of eight areas have no escalation at all is the point: the rule
discriminates rather than licensing a glyph everywhere.

### 5.3 Tabs vs. subcommands — two different surfaces

Rev. 3 proposed ten tabs. The §3 audit adds `tables`, `replication`, and
`system` as areas in their own right, which makes twelve — and twelve does not
fit ten digits. Forcing it would mean two-key jumps, which destroys the reason
the tab strip was chosen over a menu.

The resolution is to stop treating "is it a tab" as "does it exist," because
those were never the same question:

> **Every area is a shell subcommand. Only areas that can escalate to "now" get
> a digit on the strip.**

`pgops indexes`, `pgops tables`, and `pgops config` are first-class commands
with full views, reachable from the shell, from `doctor` with `Enter` on a
finding, and from `--snapshot`. What they do not get is a single-keystroke jump
during an incident — because under §5.2 there is no incident in which the right
move is to press it. A digit is scarce incident-time real estate, not the
definition of the feature set.

This is derived from §5.2's own escalation table rather than from taste. The two
areas that table marks **"escalates: never"** are exactly the two that lose their
digit.

**The nine tabs.** Order is **fixed** — never re-sorted by severity. Muscle
memory is the point; a glyph may appear, the tab never moves.

| Key | View | Class | Strip indicator |
|---|---|---|---|
| `1` | `triage` (cockpit) | now | — (it *is* the aggregate) |
| `2` | `sessions` | now | ⚠ live |
| `3` | `locks` | now | ⚠ live |
| `4` | `top` | now | ⚠ live |
| `5` | `space` | eventually | ⚠ on escalation (headroom < 10 %) |
| `6` | `vacuum` | eventually | ⚠ on escalation (wraparound ≥ 75 %, or a vacuum in progress) |
| `7` | `replication` | eventually | ⚠ on escalation (lag > threshold, or inactive slot retaining WAL) |
| `8` | `seq` | eventually | ⚠ on escalation (≥ 95 % of type max) |
| `9` | `system` | eventually | ⚠ on escalation (free storage < 10 %) |

**`0` is deliberately unassigned.** A tenth tab requires a new registered
escalation rule (§5.2), not an empty slot. Leaving the key free is what stops
"there was room" from becoming the argument that re-dilutes the strip.

**Reached another way, not absent:**

| Area | How you reach it | Why not a tab |
|---|---|---|
| `indexes` | `pgops indexes` · `D` → `Enter` on a finding | §5.2: escalates **never** |
| `tables` | `pgops tables` · `D` → `Enter` on a finding | §5.2: escalates **never** |
| `config` | `pgops config` · `D` → `Enter` on a finding | §5.2: escalates **never** |
| `explain` | `Enter` on a row in `top` | contextual, not browsable |
| `doctor` | `D` from anywhere · `pgops doctor` | it is a *report over* the areas, so it does not sit beside them |

**Tabs for views not yet built** open a one-line placeholder naming the phase
that delivers them. A tab must never show a `✓` for something unmeasured.

**This also resolves a rev. 3 contradiction.** §8 said doctor "is the only
surface for hygiene findings" while §5.3 said every hygiene area "shows its full
findings in its own view **and** in `doctor`." Both cannot hold. The rule above
settles it: `doctor` is the only surface that *ranks and surfaces* hygiene
findings unprompted; each area's view is the *detail you drill into* from there.
Doctor tells you what is wrong; the view shows you the whole population it was
drawn from. They are a summary and its backing table, not two front doors.
### 5.4 Verdict polling

The strip polls the three always-"now" areas (`sessions`, `locks`, `top`) plus
the **escalation checks** from §5.2 — now six rather than four, since `vacuum`
gains `pg_stat_progress_vacuum` and `replication` gains lag.
`src/commands/home/index.tsx:27-40` documents why this restraint matters: *"one
tick here is SIX queries… not free on a 500-session box under lock contention,
which is exactly when this screen is open."*

Critically, an escalation check is **not** the area's full analysis: `seq` polls
`pg_sequences` once for the maximum ratio, not every sequence's detail; `space`
reads tablespace headroom, not per-relation sizes; `vacuum` reads
`pg_stat_progress_vacuum` (already aggregated, one row per running vacuum) and
the database-wide `datfrozenxid` age, not `maintenance_info` across every table.
The expensive work stays in the view and in `doctor`.

- One shared poller on a **slow 15 s cadence** runs the nine in-database checks —
  never the full view queries. `indexes`, `tables`, and `config` are never
  polled at all.
- The **active view keeps its own fast poll** (2 s; 5 s for the cockpit),
  untouched. A strip up to 15 s stale is correct: it answers "where should I
  look," not "what is the number."
- **`system` is not on this poller.** Its checks are billed, rate-limited HTTP
  calls to CloudWatch or GCP Monitoring, not SQL. It polls on its own **60 s**
  cadence, caches the last response, and **fails silently to no-glyph** — a
  throttled or unauthenticated metrics API must never render a ⚠, because an
  absent answer is not a bad answer. This is the one check whose failure mode is
  invisibility rather than `n/a`, and it is the exception that needs its own
  test.
- **Hygiene areas are not polled for the strip at all.** Their findings surface
  in `doctor` and in their own views, both of which are user-initiated. This is
  what keeps the expensive scans — index bloat estimation, per-relation sizes,
  per-table `maintenance_info` — off the incident hot path entirely.

Implementation: one `useVerdicts()` hook owned by the shell, sibling to the
existing `usePoll` (`src/ui/usePoll.ts`), reusing its in-flight guard and mount
cancellation. `system` gets a second instance of the same hook at its own
cadence rather than a bespoke path.
### 5.5 Key bindings and collisions

New global keys: `1`–`9` (jump; `0` deliberately unbound, §5.3), `Tab` /
`Shift-Tab` (cycle), `D` (doctor).
None collide with existing per-view keys (`j`/`k`, `/`, `o`, `x`, `s`, `q`).

**Suppression rule — required for correctness:** global navigation keys are
inert while a `ConfirmModal` (`src/ui/ConfirmModal.tsx`) is open or a filter
input has focus. Typing `5` into a filter must filter, never navigate. This is
the single highest-risk regression in the tab strip and needs a dedicated test.

### 5.6 `Esc` semantics — simplified

v0.1: `Esc` returns to the cockpit *only* when you drilled in; inert on direct
invocation (README §Keys). That rule existed because `pgops locks` had no home
to return to.

v0.2: pgops is one app with tabs, so there is always a tab `1`. `Esc` now
**always** returns to `triage` — after first dismissing any open modal or
filter. This removes a documented special case and makes `onBack` unconditional.
Note this is a **behaviour change** for `pgops locks` invoked directly.

## 6. Data architecture

### 6.1 Schema

Created by `pgops init`. A deliberate superset of pgHero's, which stores only
`total_time` and `calls` — carrying `rows` and cache-hit counters is nearly free
at capture time and unlocks trend lines pgHero cannot draw.

```sql
CREATE SCHEMA IF NOT EXISTS pgops;

-- Query text is a DIMENSION, not a fact. Storing it on every capture row would
-- write ~288 copies of every query text per day (5-minute cadence); at 500
-- tracked queries that is 144k duplicated strings daily. It is normalised here
-- and joined at read time.
CREATE TABLE pgops.queries (
  queryid     bigint      PRIMARY KEY,
  database    text        NOT NULL,
  query       text        NOT NULL,
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL
);

CREATE TABLE pgops.query_stats (
  captured_at       timestamptz      NOT NULL,
  database          text             NOT NULL,
  usename           text,
  queryid           bigint           NOT NULL REFERENCES pgops.queries(queryid),
  calls             bigint,
  total_exec_time   double precision,
  rows              bigint,
  shared_blks_hit   bigint,
  shared_blks_read  bigint,
  stddev_exec_time  double precision
);
CREATE INDEX ON pgops.query_stats (database, captured_at);

CREATE TABLE pgops.space_stats (
  captured_at  timestamptz NOT NULL,
  database     text        NOT NULL,
  schemaname   text        NOT NULL,
  relation     text        NOT NULL,
  kind         text        NOT NULL,   -- 'table' | 'index'
  size_bytes   bigint      NOT NULL
);
CREATE INDEX ON pgops.space_stats (database, captured_at);

CREATE TABLE pgops.counters (
  captured_at   timestamptz NOT NULL,
  database      text        NOT NULL,
  stats_reset   timestamptz,
  -- pg_stat_database
  xact_commit bigint, xact_rollback bigint,
  blks_hit bigint, blks_read bigint,
  tup_returned bigint, tup_fetched bigint,
  tup_inserted bigint, tup_updated bigint, tup_deleted bigint,
  temp_bytes bigint, deadlocks bigint,
  -- checkpointer / bgwriter — column names normalised across versions, see below
  checkpoints_timed bigint, checkpoints_req bigint,
  buffers_checkpoint bigint, buffers_clean bigint, buffers_backend bigint
);
CREATE INDEX ON pgops.counters (database, captured_at);
```

Values are stored **cumulative as read**, and diffed at query time. Storing
pre-computed deltas would make a missed capture indistinguishable from a quiet
interval.

**Version branch required — PG17 moved the checkpointer counters.** Postgres 17
split `pg_stat_bgwriter`, relocating the checkpoint columns into a new
`pg_stat_checkpointer` view *and renaming them*: `checkpoints_timed` →
`num_timed`, `checkpoints_req` → `num_requested`, `buffers_checkpoint` →
`buffers_written`. `pg_stat_bgwriter` retains only `buffers_clean`,
`maxwritten_clean`, `buffers_alloc`, `stats_reset` — and `buffers_backend` was
dropped there entirely. The capture query must branch on `server_version_num`
and normalise into the stable column names above, exactly as the v0.1 plan
already does for `pg_wal` vs `pg_xlog`. **Our stored schema keeps the pre-17
names as the canonical form** so history spanning a major-version upgrade stays
continuous.

### 6.2 Collector

`pgops capture` runs once and exits. Scheduling is the operator's, via cron,
systemd timers, or a Kubernetes CronJob — matching pgHero's cadence:

```
*/5 * * * *   pgops capture --queries    # query stats + counters
17 4 * * *    pgops capture --space      # relation sizes, index bloat
```

One-shot over a daemon: nothing to supervise, no restart/PID/log-rotation story,
and the collector stays a pure function that unit-tests without a process. A
`pgops watch` daemon may later wrap the same function; it is not v0.2.

### 6.3 Two correctness requirements

**Stats resets.** `pg_stat_statements_reset()` and `pg_stat_reset()` make the
next delta negative. `pgops.counters.stats_reset` is captured for exactly this
reason; for `query_stats`, a negative delta on `(queryid, calls)` marks the
interval as reset. Reset intervals are **dropped from trends, never rendered as
a spike, and never rendered as zero.** The v0.1 plan already flagged this for
`top`; it becomes load-bearing here.

**Retention.** These tables grow without bound. `pgops capture` enforces
`--retention-days` by deleting older rows in the same transaction as the insert.
Retention is a property of capture, not a separate chore an operator can forget.

Defaults differ per table, matching pgHero's own (§12.1): **14 days** for
`query_stats` and `counters`, which capture every five minutes, and **90 days**
for `space_stats`, which captures once daily. A single default would be wrong in
both directions — 14 days of size history is too short to call a growth trend,
and 90 days of five-minute query captures is ~26 000 rows per tracked query.

## 7. Views

Each follows the established per-subcommand module shape (`query.ts`,
`render.ts`, a `.tsx` view, `index.tsx`) with a pure query layer and
presentation-only components. Capability numbers refer to the §3.2 matrix.

### 7.1 Additions to existing views

**`sessions`** — gains the connection-sources breakdown (#7): `c` toggles
between the per-session list and a grouped `database × user × application × IP`
census ranked by connection count, which is the view you want when the answer to
"why are we at 480 of 500 connections" is *one misconfigured service*. Also
gains SSL state in the detail panel (#3) and `X` — bulk kill of the current
filtered selection, itemised in the confirm modal (#12, §4 Tier 1).

**`top`** — gains `Enter` → **query detail** (#16): the full normalised query
text, its 24-hour call/time trend from `pgops.query_stats`, and `e` to run
`EXPLAIN` against it (#57). Gains a `last_stats_reset_time` stamp in the status
bar (#32), without which every cumulative number on the screen is unanchored,
and a `slow` marker on rows over the configurable threshold (#17).

**cockpit** — gains a LONG-RUNNING threshold flag (`--long-running-sec`, default
5 s; pgHero's is 60 s) (#9), a REPLICATION line carrying lag (#49), and a
VACUUM line that appears **only when `pg_stat_progress_vacuum` is non-empty**
(#46). The last is a deliberate exception to "one line per area": a vacuum in
progress is transient state you need during an incident and never otherwise.

### 7.2 New views

**`indexes`** — pgHero's most-loved surface, and the largest. Default listing is
the full index inventory with definition, columns, uniqueness, validity, size,
scan count, and per-index cache hit rate (#30, #23). Findings layered on top:
unused (#26), duplicate (#28), invalid incl. in-progress `CREATE INDEX
CONCURRENTLY` (#27), bloat (#29), and missing — tables where index usage is
below 95 % with at least 10 000 rows (#25). Global index hit rate in the header
(#22). Suggested indexes are phased separately (§9) as they need a SQL parser.

**`tables`** — new in rev. 4; pgHero's `tables` module had no owner before.
Per-table heap cache hit rate (#34), global table hit rate (#33), index-vs-
sequential scan ratio per table (#24), unused tables where `idx_scan = 0` (#35),
and estimated rows. The pairing matters: `unused_tables` and `missing_indexes`
are the same finding seen from two ends, and reading them side by side is what
tells you whether a table is dead or merely unindexed.

**`space`** — absorbs `space` + `tables` sizing: relation, index, and matview
sizes, database total, and growth over time from `pgops.space_stats` (#37–#40).
Growth is the headline — "12.4 GB · +80 MB/day" — since a single size number is
available from `psql`. `Enter` on a relation opens its 30-day size history
(#41).

**`vacuum`** — promotes today's HEALTH one-liner into a full view and absorbs
pgHero's entire `maintenance` module. Default listing is `maintenance_info`:
last vacuum, last autovacuum, last analyze, last autoanalyze, dead rows, live
rows, per table (#43). Layered on: **per-table** transaction-ID danger (#44,
#45) — which table to vacuum, not merely that you must — and live
`pg_stat_progress_vacuum` phases (#46). `A` runs `ANALYZE` on the selected table
(#47, §4 Tier 2).

**`replication`** — renamed from rev. 3's `slots`, because "slots" named one
third of the module. Replica detection (#48), lag in seconds (#49), whether
anything is streaming (#51), and the slot table (#50) — where we already beat
pgHero by carrying retained WAL bytes per slot, the number that predicts the
disk filling.

**`seq`** — absorbs `sequences` + `constraints`: every sequence against its
column type's maximum (#52), reported at **≥ 90 %** to match pgHero and
escalating to ⚠ at 95 % (#53, §5.2), plus invalid constraints (#55). Sequences
the current role cannot read are listed as `n/a (no privilege)` rather than
omitted (#54) — a silently dropped sequence is the one that overflows.

**`config`** — absorbs `settings`: the same 24 settings pgHero reads, in the
same three groups (main, autovacuum, vacuum), with the same PG18 version branch,
and those differing from default called out (#56). Read-only; **pgops does not
tune.** pgHero's Tune page links out to PGTune; we name the setting, its value,
its default, and leave the judgement to the DBA.

**`system`** — new in rev. 4, reversing a rev. 3 non-goal (§12.5). Cloud-provider
metrics from AWS CloudWatch and GCP Monitoring: CPU utilisation, database
connections, replica lag, read IOPS, write IOPS, free storage space (#59).
Credentials come from the ambient provider chain (instance role, `AWS_PROFILE`,
`GOOGLE_APPLICATION_CREDENTIALS`) — pgops stores none and prompts for none.
Absent credentials render the view as `not configured`, never as an error and
never as a `✓`. This is the only view that talks to a non-Postgres network
endpoint, and §5.4 gives it its own cadence and its own silent-failure rule for
exactly that reason.
## 8. `pgops doctor`

**`doctor` is the product's second front door, and the actual pgHero
replacement for daily use.** Where the cockpit owns the "now" class, doctor owns
"eventually" (§5.2) — it is the only surface that raises a hygiene finding
*unprompted*, and the two never compete because they cover disjoint urgency
classes.

Rev. 3 overstated this as "the only surface for hygiene findings," which
contradicted §5.3's promise that each area's view shows its own findings too.
§5.3 settles it: doctor is the ranked summary, each area's view is the full
population behind it. `Enter` on a doctor finding opens that view — which, for
`indexes`, `tables`, and `config`, is the primary way you reach them at all.

It runs every check across all twelve areas and emits **one ranked report**: the
daily-review artifact and the postmortem paste, snapshot-able like every other
view (`pgops doctor --snapshot`). Reached with `D` from anywhere, or directly
from the shell.

Ranking is by **impact, not by severity glyph** — hygiene findings have no ⚠, so
doctor orders them by what they cost you: wasted bytes, unindexed sequential
scans, growth rate, headroom remaining. A finding names the object and the
remediation, following the v0.1 health-card discipline (*"inactive slot
'debezium' retaining 2.1 GB — see dba-playbook/04"*).

Because it is user-initiated rather than polled, doctor is the correct home for
the expensive scans that §5.4 deliberately keeps off the incident hot path.

It reuses the existing `Verdict` model (`src/commands/home/model.ts`) for the
"now" checks it also summarises, and extends it with an unglyphed `finding`
level for hygiene.

**Doctor is the only navigation into `indexes`, `tables`, and `config`** from
inside the TUI (§5.3) — they hold no digit — so its ranking is not a
convenience for those three areas, it is their entry point. A finding that
doctor fails to rank is a view a user will never open.

## 9. Phasing

Each phase is independently shippable. Capability numbers refer to §3.2.

**Phase 1 — foundation.** Two pieces, and the second is larger than it looks.

1. **The `Table` primitive** in `src/ui/` — column model, cell formatting,
   virtualised scroll. **Shipped** (`f8a7e4f`), proven on `sessions` and `top`.
   Two items remain and are prerequisites for Phase 2, not polish:
   **terminal-width awareness** (today's column sets total 122 and 109 display
   columns and do not fit an 80-column terminal, which is the incident
   terminal), and **terminal-height awareness** (`height` is a hardcoded 15).
   Retrofitting width after nine more views declare columns means re-tuning
   eleven column sets, so it happens first.
2. **The shell:** global nav keys, `useVerdicts()`, the §5.5 suppression rule,
   the §5.6 `Esc` change, and migrating `Home.tsx` and `LockChain.tsx` onto
   `Table` — `Home.tsx` still hand-pads at lines 117-120 and 166-167.

**Scope warning on (2).** Every view currently owns its own chrome and key
handling — `src/commands/sessions/index.tsx:148` and
`src/commands/home/index.tsx:119` each render their own `<StatusBar>`, and
`HubApp` mounts exactly one view at a time with no shared frame. A shell-owned
tab strip means restructuring all four existing views so the shell owns chrome.
The §5.5 suppression rule additionally needs the shell to know whether a child's
filter is active — state that today lives inside `useListNavigation` and does
not flow upward at all. This is a refactor of existing working code, not a
component addition, and it should be planned and reviewed as such.

*Phase 1 is also the honest answer to "Ink feels limiting to build in": the
friction was a missing table primitive, not the terminal.*

**Phase 2 — parity, live.** Seven views — `indexes`, `tables`, `space`,
`vacuum`, `replication`, `seq`, `config` — plus the §7.1 additions to
`sessions`, `top`, and the cockpit, plus the §4 action ladder (`X`, `A`,
`pgops reset`, `--read-only`) behind its single choke point. This closes
**24 of the 28 gaps** and is where nearly all user-visible value lands.

Two items in this phase are disproportionately cheap relative to their effect
and should not slip: **#32 `last_stats_reset_time`** in `top`'s status bar is
one query and it is what makes every cumulative number on that screen
interpretable; **#46 `vacuum_progress`** is one query and it answers a
first-five-minutes question nothing else in the tool can.

**Phase 3 — `doctor`.** With Phases 1–2 done, every area has checks, and doctor
is what makes the hygiene class reachable at all — under §5.2 it is the *only*
surface that surfaces hygiene findings unprompted, so until it ships, everything
`indexes`, `tables`, and `space` find is invisible unless you go looking. It
needs no history to be useful.

**Phase 4 — the collector.** `pgops init`, `pgops capture`, retention, reset
detection. History then lands in `top` (#15, #16), `space` (#40, #41), and
doctor's growth findings.

**This phase carries the gap users feel soonest.** `top` reads
`total_exec_time`, which accumulates since the last stats reset — so today it
answers *"what has cost the most ever,"* not *"what got slower this week,"*
which is the question that sends anyone to a query-stats page. pgHero answers it
with `pghero_query_stats`. Until Phase 4 lands, `top` is the one view where
pgHero is ahead of us rather than level. If any phase is reordered, this is the
candidate — and #32 in Phase 2 is the interim mitigation, not a substitute.

**Phase 5 — environment.** `system` (#59) and multi-database (#60). Grouped
because both are configuration-shaped rather than query-shaped: both need
`pgops.toml`, neither adds a SQL surface, and both fail to *"not configured"*
rather than to an error.

**Phase 6 — `suggested_indexes`** (#58). Needs `libpg-query`/`pgsql-parser`
(pgHero uses PgQuery, bindings to Postgres's own parser) plus selectivity
scoring from `pg_stats`. The v0.1 plan already committed to a SQL parser for
`review` — one dependency, two features. **This is the riskiest item in the
spec** — genuinely hard rather than merely large — and it is last so that
nothing depends on it.

**Parity is claimed at the end of Phase 6, not before.** `explain`, `events`,
`parts`, `review`, and `mcp` remain on the v0.1 roadmap and are unaffected by
this spec except where noted.
## 10. Testing

Follows existing patterns — pure query/render layers unit-tested, views tested
with `ink-testing-library`, integration against Testcontainers Postgres.

**The parity registry.** §3.2's matrix is not prose; it is checked in as
`src/core/parity.ts` — one entry per pgHero capability, carrying its id, its
pgHero source file, its owning pgops view, and its status (`shipped` /
`planned` / `declined`). A test asserts that **every entry is either owned by a
view that exists or carries an explicit `declined` reason**, and that the
declined set has exactly one member (#13, `kill_all`). This is what makes "strict
superset" a property the build enforces rather than a claim in a document — the
failure mode it prevents is the one this audit just found, where a module marked
*done* concealed four missing capabilities.

| Area | Test |
|---|---|
| **Parity registry (§3.2)** | Every capability has an owning view or a declined reason; the declined set is exactly `{kill_all}`; no entry references a view that does not exist |
| **Urgency-class rule (§5.2)** | Every strip glyph traces to a **registered escalation rule**; a finding with no rule can never render one. `indexes`, `tables`, and `config` never glyph under any input. This is what stops a later contributor from silently diluting ⚠ |
| Escalation thresholds | Each rule fires at its documented boundary and not below it — `seq` at 95 %, `space` at 10 % headroom, `vacuum` at 75 %, `replication` at its lag threshold |
| **Sequence reporting vs escalation** | A sequence at 92 % is *listed* in `seq` (pgHero parity, #53) and does *not* glyph on the strip. The two thresholds are independent and both are tested |
| **Action ladder (§4)** | No code path outside `pgops init` issues DDL; every Tier ≥ 1 action writes an audit line; `--read-only` blocks Tiers 1–3 at the choke point, verified by calling the choke point directly rather than by driving the UI |
| **Capture is non-destructive (§3.4b)** | `pgops capture` run twice against a live database leaves `pg_stat_statements` counters monotonically increasing — it never resets them |
| Delta maths | Synthetic counter series, including a mid-series reset → interval dropped, not spiked |
| Version branch | Checkpointer counters normalise identically on PG16 (`pg_stat_bgwriter`) and PG17+ (`pg_stat_checkpointer`); `config` reads the PG18 setting list on PG18 and the earlier list below it |
| Query normalisation | Re-capturing an unchanged query inserts one `pgops.query_stats` row and zero new `pgops.queries` rows; `last_seen` advances |
| Retention | `capture` prunes older rows in the same transaction, at the per-table default (§6.3) |
| Tab strip | Glyphs render only for escalating tabs; unbuilt views open a placeholder, never a `✓`; `0` is unbound |
| **Key suppression** | Digits typed into an open filter filter, never navigate; same with `ConfirmModal` open (§5.5 — highest regression risk) |
| `Esc` | Returns to `triage` from a directly-invoked view; dismisses modal/filter first |
| Verdict poller | Slow cadence independent of the active view's poll; in-flight guard holds |
| **`system` failure mode** | A throttled, unauthenticated, or absent metrics API renders `not configured` and emits **no glyph** — never ⚠, never `✓` (§5.4) |
| **Unreadable sequences** | A sequence the role cannot read appears as `n/a (no privilege)` and is never silently omitted (#54) |
| No-history path | Every view and `doctor` render without `pgops init` having been run |
| **Terminal geometry** | Every view's column set fits 80 columns without wrapping, at every supported terminal width, with no row emitting a blank continuation line |
## 11. Non-goals

Rev. 3 listed five. The §3 parity rule removes two of them, because pgHero does
them and a superset therefore must. What remains is scoped by a single test:
**does pgHero do it?** If not, it is ours to decline.

- **Not a time-series database.** Capture is minutes-to-days resolution for
  trends, not a metrics backend. Prometheus exporters remain the answer for
  alerting pipelines. (pgHero does not do this either.)
- **No alerting or paging.** pgops reports; it does not page. (pgHero does not
  either.)
- **No web UI.** The one browser surface remains `explain --serve`, per the v0.1
  plan. This is the *platform inversion*, not a feature gap: every pgHero page
  has a pgops equivalent, rendered in a terminal. "You need to host a Rails app"
  is the weakness we are exploiting, so shipping one would be self-defeating.
- **No fleet aggregation.** pgops switches between databases (#60) exactly as
  pgHero does; it does not roll several clusters into one aggregate view.
  pgHero does not either, and doing so is a different product.
- **`kill_all`.** The one pgHero capability we decline outright. See §3.4d.

**Formerly non-goals, now in scope:** cloud-provider metrics (§7.2 `system`,
#59) and multiple databases (§12.3, #60).
## 12. Resolved decisions

Recorded with reasoning so implementation does not relitigate them. Decisions
1, 2, and 4 are unchanged from rev. 3. Decision 3 is **reversed** by the §3
parity rule; 5, 6, and 7 are new in rev. 4.

1. **Retention default — 14 days for query stats.** Matches pgHero's own
   `clean_query_stats` default and pganalyze's Production tier, keeps the tables
   small enough to ignore, and covers the week-over-week comparison the v0.1
   plan calls for. Overridable with `--retention-days`. **Space stats retain 90
   days**, also matching pgHero: size history is one row per relation per day,
   so it is cheap, and growth trends need a longer baseline than latency trends
   to mean anything.

2. **Capture role — yes, separate and documented.** `pgops capture` connects as
   a write-capable role with `INSERT`/`DELETE` on `pgops.*` and nothing else;
   views connect read-only. This makes the §4 promise enforceable by grants
   rather than by convention, which is the only way a safety claim survives
   contact with a real deployment. `pgops init` requires `CREATE` and is expected
   to be run once, by a human, with elevated rights.

3. **Multiple databases — REVERSED, now in scope (Phase 5).** Rev. 3 declared
   one database per invocation via `-d`, reasoning that a config file would be
   YAGNI. The parity rule overrides that: pgHero lists several databases in its
   config and lets you switch between them from the UI, so pgops must too.

   Scope is **exactly pgHero's**, no wider: a `pgops.toml` naming several
   databases, and a switcher that changes which one every view is pointed at.
   `-d` continues to work and takes precedence. What stays out is *aggregation*
   across databases — that is the fleet view §11 still declines, and pgHero does
   not do it either. The distinction is the whole reason this reverses cleanly:
   we were right that fleet views are a different product, and wrong to conflate
   switching with aggregating.

4. **Urgency class — a property of the finding, not the area.** Resolved in
   §5.2, which carries the rule, the escalation discipline, and the enumerated
   threshold table. Grounded in SRE practice (severity is assigned per alert
   condition, never per subsystem) and in the actionability test from
   alert-fatigue practice (an alert nobody can act on should not exist). The
   sequence case that motivated the question escalates at 95 % of the column
   type's maximum; `indexes`, `tables`, and `config` escalate never.

5. **Cloud-provider metrics — REVERSED, now in scope (Phase 5).** Rev. 3
   deferred pgHero's `system` module to `events`. The parity rule brings it
   forward as its own view (§7.2). The reservations that motivated deferring it
   are answered by constraints rather than by exclusion: pgops stores no
   credentials and reads the ambient provider chain; the view is off the SQL
   poller and on its own 60 s cadence; and an unavailable metrics API renders
   `not configured` with no glyph, so a billing or IAM problem can never
   masquerade as a database problem.

6. **Parity is enforced by a checked-in registry, not by prose.** §3.2 lives in
   `src/core/parity.ts` and is asserted by the §10 test. This decision exists
   because rev. 3's module-level table *looked* complete and concealed 28 gaps —
   a document cannot audit itself, so the audit moves into the build.

7. **A tab is not the same thing as a feature.** Resolved in §5.3: every area is
   a shell subcommand with a full view; only areas that can escalate to "now"
   get a digit on the strip. This is what lets the surface grow to twelve areas
   without either overflowing ten digits or diluting the strip into a menu, and
   it dissolves the rev. 3 contradiction between §8 and §5.3.
