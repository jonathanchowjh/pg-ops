# Changelog

All notable changes to pgops are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-09-17

The hygiene half ships. v1 answered the questions you have in the first five
minutes of an incident; v2 answers the ones you have on a Tuesday afternoon —
indexes, bloat, table and database size, sequence exhaustion, vacuum and
analyze, and the server's own settings.

**Major, because the console changed shape.** `gates.ts` has always modelled a
request as four gates, and the nav had only three tabs: `keep-up` —
*Replication & cleanup* — had no destination. It has one now, and every gate
has a tab.

Parity, read from `registry.ts` rather than counted by hand: **49 of the 65
capabilities ship, 1 is declined on purpose, and 15 remain.** `parityBacklog`
reports P2 as 0 and the phase gate is green; P4, P5 and P6 owe 3, 6 and 6.

### Added

- **Cleanup** (`/db/<name>/cleanup`) — the wraparound horizon, replication role
  and lag, and replication slots. The one hygiene-gate route that polls, at the
  incident cadence, because a closing horizon and a stalled slot both get worse
  while you watch.
- **Space** (`/db/<name>/cleanup/space`) — database size, largest relations,
  largest tables with their indexes and TOAST.
- **Maintenance** (`/db/<name>/cleanup/maintenance`) — running vacuums with
  their progress, last vacuum and analyze per table, and transaction-ID age by
  relation.
- **Sequences** (`/db/<name>/cleanup/sequences`) — every sequence against the
  ceiling of the column it actually feeds, with the ones this role cannot read
  counted rather than dropped.
- **Indexes** (`/db/<name>/queries/indexes`) — index hit rate and caching,
  missing indexes, unused indexes, duplicates, and invalid indexes.
- **Index bloat** (`/db/<name>/queries/indexes/bloat`) — the five-CTE estimate,
  on its own route and run only when asked, because pgHero keeps it off the
  page you open by reflex for the same reason.
- **Tables** (`/db/<name>/queries/tables`) — table hit rate, caching, unused
  tables, and per-table statistics.
- **Settings** — the server's own configuration, in a collapsed disclosure on
  the Cleanup page.
- A second-level nav under the tabs that carry sub-routes, and a `Cleanup` tab
  on the first level.

### Changed

- **The poll boundary is now enforced in both directions.** `/cleanup` and the
  four incident pages refresh every five seconds; every hygiene route runs its
  catalog scans on visit and never polls. A guard fails if a hygiene route
  gains a refresh, and fails if an incident page loses one.
- **`registry.ts` closes P2.** Ten capabilities flip from planned to shipped
  and `'P2'` joins `COMPLETE_PHASES`, which the phase gate now holds.

### Divergences from pgHero, new in this release

Each is documented at the code that implements it; the full catalogue of twelve
is in the README.

- **Sizes are bytes, not `pretty_size` strings.** `"8192 MB"` cannot be
  thresholded, summed or charted. The formatting happens at the page.
- **A reading we could not take is `null`, never a sentinel.** pgHero renders
  an index with no I/O yet as `"Insufficient data"` in a column of percentages,
  and a table nothing has read as `0%` cached — both sort to the top of a page
  ranked by how bad the reading is.
- **Settings are one round trip, not fifteen**, and the value is the
  `SHOW`-equivalent: `shared_buffers` reads `128MB`, not `16384` with a
  separate `8kB` unit. pgHero's version branch is dropped rather than copied —
  it exists because `SHOW` errors on a setting the server does not have, and
  `pg_settings` returns no row instead.
- **`sequence_danger` measures against the COLUMN's type, not the sequence's
  own maximum.** A bigint sequence feeding an `integer` column overflows at
  2,147,483,647; measured against its own `max_value` it reads as 0.00000002%
  used on the day it starts failing.
- **`autovacuum_danger` ships as a list, not an alarm.** `transaction_id_danger`
  already reads the database-wide `datfrozenxid` — the minimum over every
  relation — so it cannot miss what the per-relation list would find, and two
  badges on one fact would disagree the moment either was tuned. The list also
  reads the TOAST relation's frozen xid, which freezes independently of the
  heap.
- **`maintenance_info` is answered by `table_stats`.** Both read
  `pg_stat_user_tables` and return the same eight fields. One question, one
  answer.

## [1.0.0] — 2026-09-11

The first release. pgops is a web console you deploy next to your databases:
one URL, many databases, no agent and nothing to schedule.

**v1 is the incident half of pgHero, and only that half — deliberately.** It
answers the questions you have in the first five minutes of an incident: who is
connected, what is blocked, what is running long, how much connection headroom
is left, which server you are actually pointed at. Then, if you switch the
safety off, it can terminate the backend holding everything up.

The hygiene half — indexes, bloat, table and database size, sequence
exhaustion, maintenance and settings — is **not** in v1 and is not partially
in v1. It is designed (`docs/superpowers/specs/2026-09-03-pgops-p2-hygiene-design.md`)
and scheduled for v2. Shipping half of it would have meant a console that
answers "are your indexes healthy?" with a screen that is silently incomplete,
which is the one failure mode this project is built to avoid.

Parity is a checked claim, not a slogan: `packages/checks/src/registry.ts` maps
all 65 capabilities of pgHero 4.0.1 onto a shipped check, a shipped action, a
platform feature, or a numbered phase, and the test suite fails if a phase
marked complete still owes one. **24 of the 65 ship in v1, 1 is declined on
purpose, and 40 remain.**

### Added

- **Overview** (`/`) — every configured database with its worst verdict across
  every incident check. A check that could not *run* is reported separately
  from a check that ran and was fine.
- **Triage** (`/db/<name>`) — connections and headroom, sessions by state,
  what is blocked, long-running queries, the lock picture, wraparound horizon,
  replication slots, replication lag, and top queries.
- **Sessions** (`/db/<name>/sessions`) — live `pg_stat_activity`, connection
  sources grouped by database/user/app/IP with an SSL breakdown, and the one
  place an action can be taken.
- **Locks** (`/db/<name>/locks`) — the wait graph: who blocks whom, root
  blocker at the top of the chain, cycles marked rather than silently trimmed.
- **Queries** (`/db/<name>/queries`) — `pg_stat_statements` sortable by total,
  mean or calls, plus a slow-queries panel scoped to what was fetched. With a
  store configured, each row carries what it did since the last capture.
- **History** — `PGOPS_STORE_URL` enables a `pgops` schema (five tables, one
  forward-only migration under an advisory lock), captured at boot and every
  five minutes.
- **Guarded `kill`** — off by default, pinned to session identity rather than
  pid, requiring a free-text reason, audited to stdout and to a local log.
- **Multi-database routing** via `PGOPS_DATABASES` / `PGOPS_CONFIG_FILE`, read
  at request time so one image serves any target.
- HTTP basic auth over every route that can read or change a database.
- **The gates** (`packages/checks/src/gates.ts`) — the four gates a request
  clears, in order: connect, wait, work, keep-up. Every check and all 65 pgHero
  capabilities declare one, the compiler requires it, and the triage page's
  bands are *derived* from `GATE_ORDER` rather than written beside it. Causes
  run down the order and symptoms run up it, which is why a session blocked at
  `wait` is no longer offered for termination as though it were slow.
- **Every verdict explains itself.** `Threshold.because` was required,
  non-empty and unit-tested, and reached no pixel of the console; thresholds
  now also carry an optional `remedy`, and `runCheck` resolves the threshold a
  verdict actually crossed so any surface renders both without asking.
- **A bullet graph** on the readings that have a scale — the console computed
  `headroom / max * 100` to decide a verdict and then rendered a string that
  never showed it. Redundant to the text beside it, and `aria-hidden` for that
  reason.
- **pgops folds away its own connections** on Sessions, behind a count and a
  toggle. Pools are named via `application_name`, so the console can tell its
  ~19 idle backends from the application's three real ones.
- **A freshness readout that moves, and a refresh you can ask for.** The
  display ticks every second while the poll runs at five, so a stalled poll
  shows as a number climbing past the interval.
- Active-tab marking in the nav, a styled 404, and a tab icon.

### Divergences from pgHero, all deliberate

- **Capture never resets shared statistics.** pgHero's `capture_query_stats`
  calls `pg_stat_statements_reset()`, which silently zeroes the view for every
  other consumer of that database. pgops stores cumulative counters and
  differences them at read time.
- **`kill_all` is declined, permanently.** There is no incident in which
  "terminate every session, unreviewed" is the correct first move.
- **`replication_lag` is `null` on a primary, not `0`** — `0` reads as
  "perfectly caught up", a claim about replication made about a server that is
  not replicating.
- **`ssl_in_use` reads `pg_stat_ssl`**, a core catalog since 9.5, rather than
  pgHero's `sslinfo` extension. An unreadable SSL status renders `SSL unknown`,
  never `no SSL`.
- **`connection_security_breakdown` adds a fifth value**, `Unknown`, to
  pgHero's four, so a read failure cannot render as a confirmed "No SSL".
- **A gap in history is drawn as a gap.** When a counter goes backwards the
  interval spanning it is dropped rather than clamped — a spike that never
  happened reads as an incident, and this is a tool you open during one.

### Security

- **The kill route is now indistinguishable from a build without the file on
  every HTTP method, not just `POST`.** `route.ts` exports only `POST`, so
  Next's app-route dispatch answered `GET` with a `405` before any handler ran
  — and a `405` where a missing route answers `404` disclosed that the console
  had the kill endpoint compiled in, however firmly `PGOPS_ALLOW_ACTIONS` was
  left unset. The gate now sits in `proxy.ts`, above method dispatch; the route
  keeps its own copy so the property does not rest on a matcher.
- The kill route requires `Content-Type: application/json`, which a
  cross-origin HTML form cannot set — basic-auth credentials ride cross-site
  automatically, and there is no SameSite equivalent for `Authorization`.
- `PGOPS_ALLOW_ACTIONS=true` with no `PGOPS_USERNAME` warns on stderr the first
  time such a request arrives. It does not refuse to serve: some deployments
  legitimately put an authenticating proxy in front.

### Fixed

- **Wraparound was calibrated against the wrong number.** The check compared
  `age(datfrozenxid)` against `autovacuum_freeze_max_age` — a routine
  maintenance trigger, not a danger line — and criticalled at 90% of it, which
  fired at 8.38% of the real horizon. In the other direction a database hours
  from refusing transactions rendered as "1000% of horizon". The alarm is now
  transactions remaining; the ratio stays as information.
- `backendStart` may be omitted from a kill request and is treated as `null`,
  which is what every caller that omitted it already meant. `reason` is
  validated first, so a body missing both names the field that matters.
- The delta column pluralizes a single call correctly.
- `scripts/dev-db.sh` no longer advertises `pgops` CLI subcommands, which do
  not exist.
- **The Queries page can now be sorted.** `?sort=` had always been read, and
  this README had always called the route sortable, but nothing on the page
  could set it — the ordering was reachable only by editing the URL. The
  column headers are links, and the active one carries a caret, not colour.
- **Query times are readable.** `formatDuration` floors to whole seconds, so
  every mean below a second — very nearly all of them — rendered `0s` in the
  column the page ranks by.
- **The whole console rendered in the browser's default serif.** `@theme
  inline` mapped `--font-sans` onto a variable normally supplied by
  `next/font`, which this app does not use, so `@apply font-sans` emitted a
  `font-family` with no value.
- **Severity was a two-colour scale.** Every palette token was `oklch(L 0 0)` —
  lightness only, chroma zero — so `warn` and `ok` differed only by having a
  fill, on the page whose job is "is anything wrong anywhere?".
- **An unreachable database rendered its error nine times** inside a full band
  structure, as though there were something to triage. Identical failures now
  collapse to the single fact; differing ones still render per panel.
- The kill control no longer refuses a blank reason silently, announces its
  outcome via `role="status"`, and opens leftward instead of widening the table
  past the viewport.
- The store's pool names itself `pgops-store`, so it is distinguishable from
  the console's own connections when both point at one database.

### Known limits

- No published image. Build from a clone.
- `pg_stat_statements` is required for the Queries route; every other route
  works without it and says what is missing rather than rendering empty.
- Postgres 14 or newer, tested against 14, 16, 17 and 18 on every push.
