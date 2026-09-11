# pgops P2 — the hygiene class

**Status:** design, approved 2026-09-03; **§0, §4.1 and §4.2 amended 2026-09-09; §4.2 corrected 2026-09-10** (see *Amendment*, below)
**Parent spec:** `docs/superpowers/specs/2026-08-26-pgops-web-design.md` (§10 P2)
**Benchmarked against:** pgHero 4.0.1 (`lib/pghero/version.rb`, CHANGELOG `## 4.0.1 (2026-08-15)`), re-cloned 2026-09-03
**Closes:** the 31 registry entries this spec classified as P2 (§1). The
P2a plan has since shipped the six incident-class members (§1.2);
`parityBacklog('P2')` now returns 25, and closing those is this spec's
remaining scope.

---

## Amendment, 2026-09-09 — routing follows the gates

This spec was approved before `packages/checks/src/gates.ts` existed. §4.1
gave each pgHero area its own top-level tab, taking the database nav from four
to ten. `gates.ts` has since made the four gates the console's organising idea
and states that each gate's `title` mirrors the tab that goes deeper into the
same subject — "not a coincidence and not free wording", written after the
bands and tabs had drifted into two names for everything.

Ten tabs cannot hold that. Worse, the six proposed tabs cut *across* the
gates: `/indexes` would have held nine `work` capabilities and one `keep-up`
one, so a reader could not tell from the nav which question a page answers.

The registry settles it, because every capability already declares a gate. The
25 split **12 `work`, 12 `keep-up`, 1 `server`** — two gates and a status
fact, not six areas. So hygiene does not add six tabs; it completes two bands
that already exist, and fills the one gap the gates model already implied:
`keep-up`'s title is *Replication & cleanup* and it mirrors **no tab today**.

§4.1 is rewritten below, and §0's scope-decision row with it. §4.2 is
corrected separately: the poll move it called P2's "one risky edit" has
since shipped, and the guard that came with it already generalises to
nested hygiene routes — so P2b inherits that work rather than doing it.

§1 (the checks and their files), §2, §3, §5 and §6 are unchanged —
this amendment moves where checks render, not what they compute, and file
granularity in §1.3 still follows the pgHero area rather than the route.

---

## 0. Why this spec exists

The parent spec's §10 describes P2 in one paragraph: seven areas, "Closes ~24
gaps", plus `pgops check --format json`. Three of those claims are wrong.

At the 2026-08-26 re-audit the registry tagged **31** entries `planned:
'P2'`, across **ten** pgHero source files — three areas §10 never names. The
`~24` predates that re-audit against pgHero 4.0.1; the registry was corrected
and the prose was not. Nothing compares them, so nothing complained.

The P2a plan has since shipped six of those 31 — the incident-class set in
§1.2 (#4, #7, #17, #49, #51, #65). `parityBacklog('P2')` now returns **25**;
this spec's remaining scope is exactly that 25, all hygiene (§1.1).

This is the same defect the P1 phase gate caught in P1c, one level up. There,
six capabilities stayed `planned: 'P1'` after P1 closed because no test
compared the registry to the phase. Here, a sentence in a spec claims a scope
the registry contradicts, because no test compares prose to the registry — and
prose is not testable. §8 records the resolution: delete the count from the
prose rather than try to verify it.

**Scope decisions taken 2026-09-03, which this spec is written to:**

| Decision | Consequence |
|---|---|
| No CLI | `pgops check --format json`, exit codes, and the cron surface leave P2 entirely. Not deferred to a sub-phase — cut from this scope. |
| Web only, routed by gate (amended 2026-09-09) | One new tab (`/cleanup`, the `keep-up` gate) plus sub-routes under it and under `/queries`. Run on visit. No `/doctor` roll-up. Nothing added to the overview except the two incident-class replication checks. |
| Mirror pgHero's escalation | A verdict only where pgHero has one. pgHero's numbers are adopted as `Threshold` data with provenance in `because`, not re-derived. |

The parent spec's argument for bundling the CLI was that cron is what makes
hygiene findings *arrive* rather than wait to be looked at. That argument is
sound and is not answered here. Under this scope a hygiene finding surfaces
only when an operator opens the page. That is a known, accepted limitation of
P2, recorded here so it is not rediscovered as a defect.

---

## 1. The 31, classified

§10 calls P2 "the hygiene class". That is true of 25 of the 31. Six are
incident-class capabilities that carry the P2 tag for scheduling, not kind,
and they land on surfaces that already exist.

### 1.1 Hygiene — 25 capabilities, eight new files

| File | pgHero source | Capabilities |
|---|---|---|
| `checks/indexes.ts` | `methods/indexes.rb` | #22 `index_hit_rate`, #23 `index_caching`, #24 `index_usage`, #25 `missing_indexes`, #26 `unused_indexes`, #27 `invalid_indexes`, #28 `duplicate_indexes`, #30 `indexes`, #32 `last_stats_reset_time` |
| `checks/index-bloat.ts` | `methods/indexes.rb` | #29 `index_bloat` |
| `checks/tables.ts` | `methods/tables.rb` | #33 `table_hit_rate`, #34 `table_caching`, #35 `unused_tables`, #36 `table_stats` |
| `checks/space.ts` | `methods/space.rb` | #37 `database_size`, #38 `relation_sizes`, #39 `table_sizes` |
| `checks/sequences.ts` | `methods/sequences.rb` | #52 `sequences`, #53 `sequence_danger`, #54 `unreadable_sequences` |
| `checks/maintenance.ts` | `methods/maintenance.rb` | #43 `maintenance_info`, #45 `autovacuum_danger`, #46 `vacuum_progress` |
| `checks/settings.ts` | `methods/settings.rb` | #56 `settings` |
| `checks/constraints.ts` | `methods/constraints.rb` | #55 `invalid_constraints` |

### 1.2 Incident-class — 6 capabilities, one new file and two extensions

| File | pgHero source | Capabilities | Surface |
|---|---|---|---|
| `checks/replication.ts` (new) | `methods/replication.rb` | #49 `replication_lag`, #51 `replicating` | Triage page + overview |
| `checks/connections.ts` (extend) | `methods/connections.rb`, `home_controller.rb` | #4 `connections` list, #7 `connection_sources`, #65 `connection_security_breakdown` | Sessions page |
| `checks/query-stats.ts` (extend) | `methods/query_stats.rb` | #17 `slow_queries` | Queries page |

`25 + 6 = 31` matched `parityBacklog('P2')` when this classification was
made. The P2a plan has since shipped the six incident-class capabilities
above (#4, #7, #17, #49, #51, #65); `parityBacklog('P2')` now returns
**25** — the hygiene set in §1.1, this spec's actual remaining scope.

### 1.3 File granularity

The unit is the pgHero *area*, not the individual check. `sessions.ts` already
holds two checks in 294 lines; package files run 93–384 lines. Nine checks in
one `indexes.ts` stays inside that range because eight of the nine are short
catalog queries.

`index_bloat` is the exception and gets its own file. Its query is a ~140-line
CTE — on its own, larger than six of the nine existing check files — and it is
the only P2 capability with a cost profile that forces a separate route (§4.1
for where it sits, §5 for the timeout that is the reason).
That is two clear responsibilities in the sense the project's style rule means.

---

## 2. Escalation

Six checks carry a `verdict`. Nineteen do not, and ship as tables the
operator reads. This mirrors pgHero, whose entire hygiene alerting is
`list.empty? ? "success" : "warning"` plus one configurable percentage.

### 2.1 The thresholds

| Check | Level | Value | Unit | pgHero source |
|---|---|---|---|---|
| #22 `index_hit_rate` | warn | 99 | percent | `cache_hit_rate_threshold` (`lib/pghero.rb:47`) |
| #33 `table_hit_rate` | warn | 99 | percent | same |
| #53 `sequence_danger` | warn | 90 | percent | `sequence_danger(threshold: 0.9)` |
| #26 `unused_indexes` | warn | 10 | bytes (MB) | `unused_index_megabytes` (`database.rb:64`) |
| #27 `invalid_indexes` | warn | 1 | count | non-empty ⇒ warning (`index.html.erb:70`) |
| #55 `invalid_constraints` | warn | 1 | count | same |
| ~~#45 `autovacuum_danger`~~ | ~~warn~~ | ~~2_000_000~~ | ~~transactions~~ | **Struck 2026-09-11 — see §2.2.** Unreachable beneath #44's recalibrated critical; #45 ships as a list. |

Every `because` states that the number is pgHero's and is adopted rather than
derived. That sentence is true, which is the whole requirement — the parent
spec's §3.2 discipline exists to stop numbers whose justification is invented,
and "pgHero has used this since 2016 and we are targeting parity with pgHero"
is a real justification. Where a number is later re-derived from Postgres
behaviour, the `because` changes with it.

Nothing here escalates to `critical`. pgHero has no critical tier for hygiene,
and inventing one would be exactly the §3.2 failure mode.

### 2.2 The nineteen with no verdict

#23, #24, #25, #28, #30, #32, #34, #35, #36, #37, #38, #39, #43, #45, #46,
#52, #54, #56, and #29.

**#45 joined this list on 2026-09-11** — it was given a `warn` at 2,000,000
transactions in §2.1 below. That threshold was adopted from pgHero before
`wraparound` (#44) was recalibrated, and it is now unreachable as a first
signal: #44 criticals at 100,000,000 transactions remaining, and
`age(datfrozenxid)` for a database is the minimum `relfrozenxid` across it —
so the two track the same number and #45's warn sits 98,000,000 transactions
*inside* #44's critical. A warning that can only appear beneath a standing
critical is noise. #45's value is the list — which tables hold the xid back —
not a level. §2.1's row for it is struck below.

`runCheck` returns `verdict: null` for a check with no `verdict` function
(`run.ts`: `check.verdict?.(…) ?? null`), and `CheckPanel` renders **no
badge** for null. **Corrected 2026-09-11**: this section previously said
`runCheck` "supplies `{level: 'ok'}`". It did once, and was changed
deliberately — `types.ts`'s own docblock records why: substituting `ok` made
"we do not judge" indistinguishable from "we judged and it is fine", which is
this project's central distinction. A page built on the old sentence would
paint a green badge on every check in this list.

These never move a page's status. They can still fail, and a failed hygiene
check renders as unavailable on its own page — "we could not look" stays
distinct from "we looked and it is fine", as everywhere else in this project.

---

## 3. Divergences from pgHero

Each is deliberate, and each is recorded in the registry entry's comment so
the divergence travels with the capability rather than living only here.

**#37 `database_size` returns bytes, not a formatted string.** pgHero returns
`PgHero.pretty_size(...)` — `"8192 MB"`. A formatted string cannot be
thresholded, compared, or charted, and P4 charts space growth. pgops returns
`number` and formats at the edge.

**#24 `index_usage` and #25 `missing_indexes` return `number | null`, not a
sentinel string.** pgHero emits the text `'Insufficient data'` in the same
column as a numeric percentage, so the column's type is text-or-number. pgops
returns `null` for insufficient data. (In `missing_indexes` that branch is
unreachable in pgHero anyway: its `WHERE` requires `idx_scan > 0`, so the
`CASE idx_scan WHEN 0` arm can never fire.)

**#56 `settings` is one query, not fifteen.** pgHero's `fetch_settings` issues
`SHOW <name>` per setting. pgops reads `pg_settings WHERE name = ANY($1)` in a
single round trip. The version branch is preserved: `io_method` is included
only when `server_version_num >= 180000`, matching `settings.rb`.

**#29 `index_bloat` is reachable but not on the Indexes page.** pgHero 4.0.1
ships it disabled on its own dashboard — `home_controller.rb:114` reads
`@index_bloat = [] # @database.index_bloat`, with the real call commented out —
and keeps it behind a dedicated route. pgops matches that placement. Parity
means parity with what pgHero *does*, and what it does is keep this expensive
estimate off the page you open by reflex.

**#45 `autovacuum_danger` is per-table; #44 `wraparound` stays per-database.**
pgHero's `transaction_id_danger` reads `pg_class`/`relfrozenxid` and names the
tables holding the frozen xid back. pgops's shipped `wraparound` reads
`pg_database`/`age(datfrozenxid)`. The registry maps #44 → `wraparound`, which
is accurate for the alarm (`txnsUntilShutdown`) but not for the granularity.
#45 needs the per-table query regardless, and #43 `maintenance_info` is
per-table on the same page, so P2 closes the granularity gap as a side effect.
`wraparound` itself is not modified — it is the incident-page alarm and works.

**#53 `sequence_danger` measures against the COLUMN's type, not the
sequence's max.** This is pgHero's behaviour and it is the correct one: a
`bigint` sequence feeding an `integer` column fails at 2_147_483_647, long
before the sequence's own maximum. `sequences.rb` maps `smallint` → 32767,
`integer` → 2147483647, everything else → 9223372036854775807. pgops keeps
that mapping. Getting this wrong would produce a check that reports healthy
right up to the moment inserts start failing.

---

## 4. Web surface

### 4.1 Routes

**Amended 2026-09-09.** Routing follows the gates, not the pgHero areas. One
new tab, and sub-routes beneath the two gates that own hygiene:

```
Nav:  Triage   Sessions   Locks   Queries   Cleanup
                                  └ work    └ keep-up

/db/[name]/queries                 (exists, polls)   #14 #15 #17 #18
/db/[name]/queries/indexes         #22 #23 #24 #25 #26 #27 #28 #30 #32  +#55
/db/[name]/queries/indexes/bloat   #29
/db/[name]/queries/tables          #33 #34 #35 #36

/db/[name]/cleanup                 (new tab)         #44 #49 #50 #51
/db/[name]/cleanup/space           #37 #38 #39
/db/[name]/cleanup/maintenance     #43 #45 #46
/db/[name]/cleanup/sequences       #52 #53 #54

status line under the heading      #56 settings
```

**Why the nav grows by one and not by six.** `gates.ts` gives each gate a
`title` that names the tab going deeper into it: *Sessions*, *Locks*,
*Queries*, *Replication & cleanup*. Three of those tabs exist. The fourth
never did — the `keep-up` band on the triage page has always been the one band
with nowhere to go — so the operator with a wraparound or replication finding
had no page to open. `/cleanup` is that page, and hygiene is what fills it out.
Adding it is a correction the gates model already implied; the hygiene class
is merely what makes it worth having.

**Why indexes and tables sit under `/queries` rather than beside it.** Both
answer gate 3's question — *is the work itself taking too long?* A missing
index, an unused index and a cold table cache are not a separate subject from
a slow statement; they are the reasons a statement is slow. Nesting them says
so in the URL. The alternative tested badly against the model: `/indexes` as a
peer of `/queries` invites the reading that indexes are a maintenance chore
rather than the explanation for the page next to them.

**#55 `invalid_constraints` renders on `/queries/indexes`, beside #27
`invalid_indexes`.** It keeps its own check file, because its pgHero source is
a separate one, but it has no page of its own: pgHero shows the two together in
a single alert (`index.html.erb:70`, `@invalid_indexes.empty? &&
@invalid_constraints.empty?`), and they are the same question to an operator —
"did a migration leave something half-built?" A `/constraints` route holding
one check would be a tab that is empty on almost every database.

**Three capabilities render on a page whose gate is not their own, and that is
deliberate.** #55 `invalid_constraints`, #29 `index_bloat` and #36
`table_stats` all carry `gate: 'keep-up'` in the registry while sitting on
`work` pages. Each is deferred cleanup by cause — an unvalidated constraint, a
bloated index, dead tuples awaiting vacuum — but each is *looked for* beside
the thing it degrades: constraints beside invalid indexes, bloat beside the
index list, dead tuples beside the table they are in.

The gate records what causes a finding; the route records where an operator
goes to find it. They are different questions and the registry answers only
the first — `gates.test.ts` asserts the gate, never the route. An implementer
who "fixes" one of these three gates to match its page has broken the
causes-run-down-symptoms-run-up property `gates.ts` exists to state.

**#56 `settings` gets no page.** It is `gate: 'server'`, and `gates.ts` is
explicit that `server` facts belong in the status line under the page heading
where `identity` already puts them, not in a band. A settings *tab* would be
the fifth top-level entry that answers no gate's question.

**#29 `index_bloat` keeps its own route**, one level deeper, for the cost
reason in §5 — it is reached by an explicit click and carries the 30s timeout.
Linked from `/queries/indexes`, never from `Nav`.

That places all 25: nine capabilities on `/queries/indexes` (with #55), one on
`/queries/indexes/bloat`, four on `/queries/tables`, three each on
`/cleanup/space`, `/cleanup/maintenance` and `/cleanup/sequences`, and #56 in
the status line.

**Sub-navigation.** `/queries` and `/cleanup` each gain a second-level strip
listing their sub-routes, rendered by the same component `Nav` uses. The tab
itself stays the landing page and keeps its current content; the strip is
additive, so no existing page changes shape.

### 4.2 Moving the poll — done, and the guard already generalises

**Amended 2026-09-09; corrected 2026-09-10 after reading the shipped code.**

This section described the poll move as P2's "one risky edit". It has since
shipped: `<Refresh>` no longer renders in `app/db/[name]/layout.tsx`, and
`test/guards.test.ts` carries "renders `<Refresh>` in exactly the incident
pages and the overview". **P2b has no work to do here.** What follows records
why the shipped guard already covers §4.1's nesting, because that is not
obvious and a future reader would otherwise re-open the question.

The original risk stands as written: a hygiene page under a polling layout
would re-run `index_bloat` and `table_sizes` every five seconds forever, and
both directions of the mistake are silent — a page that loses `<Refresh>`
renders stale during an incident with no indication, and a page that keeps it
puts a table scan on a timer. Neither errors, so nothing else catches them.

**Why §4.1's nesting needs no new guard.** The concern was that a *tab* is no
longer wholly incident or wholly hygiene: `/queries` polls while
`/queries/indexes` and `/queries/tables` must not, and `/cleanup` is the same
shape in reverse — the tab carries incident checks (#44, #49, #50, #51) and
polls, while everything beneath it does not. A guard phrased as a path prefix
("everything under `/queries` polls") would pass exactly that mistake.

The shipped guard is not phrased that way. It walks every source under `app/`,
collects the files matching `<Refresh`, and asserts **set equality** against
four explicitly-listed incident page paths plus the overview. Three properties
follow, and all three are what P2b needs:

1. A new hygiene page that renders `<Refresh>` fails the guard immediately —
   it is an unexpected member of the set, with no list to remember to update.
2. An incident page that *loses* `<Refresh>` fails too, from the same
   assertion — set equality catches both directions at once.
3. It walks layouts as well as pages, so a nested `layout.tsx` under
   `/queries` or `/cleanup` reintroducing the poll is caught by the same
   assertion. This is the failure mode nesting actually introduces, and it is
   already covered.

**The one thing P2b must not do:** add a hygiene route to `INCIDENT_PAGES`
to make a red guard green. That list is the specification, not a fixture. A
hygiene page belongs in it only if it has been deliberately decided that the
page should poll — which for every capability in §1.1 it has not.

### 4.3 The overview

Unchanged in structure. `replication.ts`'s two checks are `class: 'incident'`,
so `test/guards.test.ts`'s existing rule — the overview must run every
incident check — will **fail** until both are added to `worstVerdict`'s
explicit list. That failure is the guard working, exactly as it did for
`identity` in P1c, and it is expected during implementation rather than a
regression to work around.

No hygiene check reaches the overview. A hygiene roll-up there would force all
25 onto the front door's polled hot path, and there is nowhere to cache the
result until P3 ships history.

---

## 5. Cost and safety

Hygiene queries scan catalogs; `relation_sizes` and `table_sizes` touch every
relation, and `index_bloat` is a multi-CTE estimate over `pg_index`. On a large
database any of them can take seconds.

**`statement_timeout` per hygiene check.** Each hygiene check sets a timeout
for its own query, so a slow scan returns `{ok: false, reason: 'error'}` and
renders as unavailable on its page rather than hanging the render. It is
per-check data rather than a global constant, so an expensive check can afford
more than a cheap one:

| Scope | Timeout | Reasoning |
|---|---|---|
| Every hygiene check except `index_bloat` | 10s | A page that takes longer than this is broken from the operator's point of view; failing is more useful than hanging. |
| `index_bloat` | 30s | Reached by an explicit click on its own route, where a wait is expected. |

Incident checks are unchanged — they poll at 5s and must stay well inside it.

**pgHero's size floors, adopted verbatim.** `unused_indexes` ignores indexes
below 10 MB; `index_bloat` ignores relations below 100 MB. Without these a
young database warns about every small index it has not used yet, and the
warning is noise that trains operators to ignore the page.

**Row caps, with the truncation carried in the row.** `relation_sizes`,
`table_sizes`, `table_stats`, `index_caching`, `table_caching`,
`maintenance_info` and `sequences` are unbounded in pgHero. Each takes a limit
(default 100) through the existing `Opts` mechanism — the same seam
`queryStats` and `sessions` already use, and `runCheck`'s two overloads make
the compiler enforce that a caller supplied one.

A cap interacts dangerously with §2's verdicts: `invalid_constraints` warns on
a non-empty list, and `sequence_danger` must consider every sequence to find
the one that is overflowing. A cap applied naively would let a check report
healthy because the dangerous row fell off the end.

`sessions.ts` already solved this and P2 follows it exactly: `count(*) OVER ()`
carries the true pre-`LIMIT` total on every returned row, because Postgres
evaluates window functions before `ORDER BY`/`LIMIT`. **Every verdict reads
that total, never `rows.length`.** For the ordered lists the cap is also chosen
to keep the worst rows — `unused_indexes` orders by size descending,
`sequence_danger` by headroom ascending — so truncation drops the least
interesting rows rather than the finding.

---

## 6. Testing

The integration suite runs ~244s across 15 files with `fileParallelism: false`.
Twenty-five new integration files would take it past ten minutes, and a suite
nobody waits for is a suite nobody runs.

**Unit tests for all 25.** Pure `map` behaviour, and for the seven that
escalate, the threshold at its value and one unit either side — the §9 boundary
rule the existing checks follow. These are fast and carry most of the value,
because `map` is where nullability and unit confusion actually go wrong.

**Integration tests grouped into eight per-area files**, one per new check
file, covering only SQL that can silently return the wrong thing against a live
server rather than erroring:

- `sequences` — identity-column sequences, added in pgHero 4.0.1. The catalog
  join is the most intricate query in P2 and a fixture with an identity column
  is the only thing that proves it finds them.
- `constraints` — `NOT VALID` constraints, which require a fixture that
  actually has one.
- `maintenance` — `pg_stat_progress_vacuum` is empty unless a vacuum is
  running; the per-table frozen-xid query needs a real `pg_class`.
- `indexes`, `tables` — the hit-rate views return **NULL**, not 0, on a
  database with no I/O yet (`sum(...) / nullif(sum(...), 0)`). A fresh
  container is exactly that database, so this is the one place the fixture
  reproduces the dangerous case for free.
- `space`, `settings`, `index-bloat` — one smoke test each that the query
  parses and returns the expected shape against a real server.

**Two cases are the priority, because both fail silently and both are wrong in
the direction that loses a finding or invents one.**

*NULL hit rate.* `index_hit_rate` returning NULL on an idle database, rendered
as `0` and compared against a 99% threshold, is a false `warn` on every freshly
started database — the same `null`-means-unknown confusion `identity`'s `ssl`
field was written to prevent, now in a check that does escalate.

*Verdicts under truncation.* A test seeds more rows than the cap and asserts
that the verdict is unchanged — that `sequence_danger` still warns when the
overflowing sequence sorts past the limit, and that `invalid_constraints`
reports the true count rather than the capped one. Written against
`rows.length` these pass at any cap and prove nothing; written against a
fixture larger than the cap they fail unless the window-function total is
actually being read. That distinction is the test.

---

## 7. What P2 does not do

- No CLI, no `pgops check --format json`, no exit codes, no cron surface.
- No `/doctor` aggregate page.
- No hygiene signal on the overview.
- No history, caching, or trend data — that is P3 and P4. Every hygiene check
  runs on visit and reports the present.
- No `analyze` or `reset_stats` actions (#47, #31 — P5). P2 is read-only.
- `wraparound` is not modified.

---

## 8. Closing the drift

§10 of the parent spec is rewritten to name all ten areas and to drop the
hand-written count. The count is cited as `parityBacklog('P2')` — the registry
is the authority, and prose that restates a number the registry owns is what
rotted in the first place.

The registry entries for the 31 are updated from `planned: 'P2'` to their
`check:` ids as each ships. When the last one lands, `'P2'` joins
`COMPLETE_PHASES`, and the phase gate added in P1c then asserts that nothing
still claims to be owed by it.

That gate is why this spec does not need a checklist of the 31: the registry
already is one, and it is the copy under test.
