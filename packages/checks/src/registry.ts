/**
 * The pgHero parity registry.
 *
 * Re-audited 2026-08-26 against pgHero 4.0.1 (2026-08-15) — a fresh
 * `git clone --depth 1 https://github.com/ankane/pghero`, version read from
 * `lib/pghero/version.rb`, corroborated by `CHANGELOG.md`'s `## 4.0.1
 * (2026-08-15)` heading. The 60-capability matrix this file encodes was
 * compiled 2026-08-19 (web design spec, drawing on the earlier ops-console
 * spec's §3.2); pgHero shipped two releases since (3.8.0 in April, 4.0.0 in
 * August, 4.0.1 a week later).
 *
 * The audit method: every public method (everything above `private`) in
 * every file under `lib/pghero/methods/`, enumerated and matched to a
 * `PGHERO` id or an explicit fold, plus `app/controllers/pg_hero/
 * home_controller.rb` and `app/views/pg_hero/home/` for anything surfaced
 * only in the dashboard. The full per-file enumeration is checked into the
 * task report, not just this summary. Findings:
 *
 *  - No capability in the old matrix has been removed from pgHero 4.0.1.
 *  - Three capabilities pgHero has were missing from the old matrix, added
 *    below as #61–#63: `disable_query_stats`, `suggested_indexes_by_query`
 *    (the per-query annotation pgHero shows inline on the queries table —
 *    distinct from the aggregate `suggested_indexes` list, and what
 *    `home_controller.rb` actually calls to compute suggestions), and
 *    `best_index` (a single-statement public API, exercised only by
 *    pgHero's own test suite, not the dashboard — the write-side sibling of
 *    #57 `explain`: paste a query, get back an index instead of a plan).
 *  - One capability exists only in the dashboard, backing no
 *    `lib/pghero/methods/` file at all: `/connections?security=1`
 *    categorises every connection's SSL status (SSL / Internal Process /
 *    Socket / No SSL, with the reason) — computed entirely in
 *    `home_controller.rb#connections`, never in a method. Added as #65.
 *  - Nothing was renamed or moved between files, with one correction: the
 *    old matrix implied a `tuning.rb` source file (per the task brief's file
 *    list); no such file exists — `tune` is a dashboard view over
 *    `methods/settings.rb`'s `settings`/`autovacuum_settings`/
 *    `vacuum_settings`, unregistered as its own capability.
 *  - pgHero 4.0.0 dropped support for Postgres < 14, matching this
 *    project's own floor — corroboration, not a finding requiring action.
 *
 * Folds (Ruling 18 — every fold recorded here, so "decided not separate"
 * reads differently from "missed"; every public method not named below has
 * its own PGHERO entry):
 *
 *  - basic.rb: `current_user` folds into #2 `database_name` (old matrix's
 *    own description is "database name, current user" — one capability,
 *    one status-bar line). `server_version_num` folds into #1
 *    `server_version` — it's the same value, machine-readable form, used
 *    internally as a version gate. `quote_ident` is SQL-identifier-quoting
 *    plumbing (also used by pgHero's own view helper) — infrastructure, not
 *    a capability, same category as this package's own `CheckContext`.
 *  - indexes.rb: `index_covers?` folds into #28 `duplicate_indexes` (its
 *    original caller) — it's also called from `suggested_indexes.rb` to
 *    detect an already-covered suggestion, so it's cross-cutting plumbing
 *    between #28 and #58/#63, not a capability of its own.
 *  - maintenance.rb: `analyze` (single table) folds into #47
 *    `analyze_tables` — the old matrix already names both as one entry
 *    ("`analyze(table)` / `analyze_tables` — an action").
 *  - query_stats.rb: `query_stats_enabled?`, `query_stats_extension_enabled?`,
 *    `query_stats_readable?` fold into #18 `query_stats_available`
 *    (the `_enabled?`/probe convention — one entry covers the whole
 *    extension-availability family). `historical_query_stats_enabled?`,
 *    `queries_table_exists?`, `query_stats_table_exists?`, and
 *    `clean_query_stats` fold into #21 `capture_query_stats` — they are the
 *    readiness probes and the retention half of "capture + retention,"
 *    which the old matrix already treats as one entry.
 *  - settings.rb: `autovacuum_settings` and `vacuum_settings` fold into #56
 *    `settings` — the old matrix already describes this as one capability
 *    ("settings in 3 groups: main / autovacuum / vacuum").
 *  - space.rb: `space_stats_enabled?` (the same probe convention as #18)
 *    and `clean_space_stats` (retention) fold into #42 `capture_space_stats`
 *    — "capture + retention," one entry, same as query_stats.
 *  - suggested_indexes.rb: `suggested_indexes_enabled?` folds into #58
 *    `suggested_indexes` (probe convention). `suggested_indexes_by_query`
 *    and `best_index` do NOT fold — see #63/#64 above.
 *  - system.rb: `system_stats_enabled?`, `system_stats_provider`, and
 *    `rds_stats` fold into #59 `system_stats` — the old matrix already
 *    treats CPU/connections/replication-lag/IOPS/free-space as one combined
 *    capability, and these three are the provider-detection plumbing and
 *    the AWS-specific fetch shared by all of it.
 *  - sequences.rb: the "unreadable sequences" capability (#54) is not a
 *    separate method — it's the `readable` attribute on #52 `sequences`'s
 *    own return shape, computed by a private helper. Kept as its own
 *    PGHERO entry because the old matrix already called it out by name.
 *
 * No method in constraints.rb, connections.rb, explain.rb, kill.rb,
 * queries.rb, replication.rb, or tables.rb folds — every public method in
 * those seven files owns its own PGHERO entry with no ambiguity.
 *
 * Controller ruling on #62 `autoindex`: stays `planned:`, not `declined:`,
 * with a constraint carried forward for whichever task builds it — it MUST
 * be gated behind explicit confirmation. Auto-creating an index from a
 * heuristic's suggestion is DDL with no diagnosis step of its own; the
 * confirmation gate is what keeps it out of `kill_all`'s category.
 *
 * SUPERSEDED in P6 (2026-09-21): #62 is declined. The ruling above was made
 * before three later commitments existed, and a confirmation gate answers
 * none of them. Index creation is a schema change against a MONITORED
 * database, which the full-parity spec §3.3 promises never to run, which the
 * DDL guard forbids mechanically, which the web spec's §7.1 puts at tier 3
 * ("CLI only"), and for which §8 removed the only tier-3 vehicle by cutting
 * the CLI — the same four reasons #19 and #61 were declined in P5. The
 * ruling's intent survives in a better form: every #58 suggestion carries
 * the exact statement, for the operator to run through their own migration
 * tooling (tools/advice.ts, `IndexSuggestion.statement`).
 *
 * Ruling 1 (SDD ledger, conflict C1): Tasks 6–12 built the nine checks this
 * registry now owns. Task 14 wired the imports below and flipped eight
 * PGHERO capabilities to `check:` — see the per-entry comments in the
 * PGHERO table for which check backs which id. (`CHECKS` holds nine
 * functions; `blocked` backs no PGHERO entry at all — see below — so eight
 * capabilities carry `check:`, not nine.)
 *
 * Two of those mappings are not the 1:1 they look like at first glance, and
 * one capability that looks like a match is not a match at all — all three
 * found the same way: checking pgHero's actual SQL, not trusting a
 * capability's name.
 *
 *  - `locks`, not `blocked`, is what backs #10 `blocked_queries`. Verified
 *    against pgHero's actual `lib/pghero/methods/queries.rb` (fetched fresh
 *    for this task, not recalled): its `blocked_queries` SQL is a flat list
 *    of blocked/blocking pairs — pid, user, query, and lock mode on BOTH
 *    sides of the conflict. That is the same shape `locks.ts`'s `LockRow`
 *    and wait graph build from `pg_blocking_pids`, just organized as a tree
 *    instead of a flat table — and `locks.ts`'s own A2 fix note describes
 *    rebuilding exactly this self-join. `blocked.ts`'s single aggregate row
 *    (count / oldest query age / one suspect pid) is a triage-tile summary
 *    this package adds on top; no pgHero method returns that shape, so
 *    `blocked` carries no PGHERO entry of its own — it is additional, not a
 *    port, and that is fine: nothing requires every check to have one.
 *  - #4 `connections` is NOT backed by this package's `connections` check —
 *    a fix-round correction of the same class as #10 above, found the same
 *    way. pgHero's own `connections` (methods/connections.rb) is a
 *    per-connection LIST: `SELECT pid, datname AS database, usename AS
 *    user, application_name AS source, client_addr AS ip, state, ssl FROM
 *    pg_stat_activity LEFT JOIN pg_stat_ssl ...` — one row per backend.
 *    This package's `connections` check returns four aggregate numbers
 *    (`max`/`used`/`reserved`/`headroom`); no amount of reading an
 *    aggregate produces a per-connection list. `connectionDetail`
 *    (connections.ts) is that list — the same SQL shape pgHero's own method
 *    runs, plus `count(*) OVER ()` for the pre-LIMIT total — and now backs
 *    #4, its sibling #7 `connection_sources`, and #65's SSL breakdown,
 *    all from the one round trip pgHero's own controller derives them from.
 *    Remapping #4 to `sessions` was considered and rejected: `sessions` is
 *    the closest shipped analog but still lacks `datname` and `ssl`, and
 *    caps at 500 rows where pgHero's list is unbounded — a near-miss
 *    `check:` in a registry whose whole job is being right about parity is
 *    exactly the failure this correction fixes.
 *  - #5 `total_connections`, unlike #4, IS answered by the `connections`
 *    check's aggregate `used` — but with a scope difference worth stating
 *    rather than leaving implicit: pgHero's `total_connections` is `SELECT
 *    COUNT(*) FROM pg_stat_activity`, every backend, while `connections.ts`
 *    filters `used` to `backend_type = 'client backend'` (excluding
 *    auxiliary processes — checkpointer, background writer, walwriter,
 *    archiver, startup — that don't draw from the max_connections pool).
 *    The mapping stands; the difference is a deliberate design choice, not
 *    an oversight, so it is stated here rather than hidden.
 *
 * #11 `kill` is a ruling of its own — see the comment on `ACTIONS` below.
 */
import type { Placement } from './gates.js';
import { killBackend, killLongRunning } from './actions/kill.js';
import { resetQueryStats, resetStats } from './actions/stats.js';
import { analyzeTables } from './actions/analyze.js';
import { captureOnce } from './capture.js';
import { blocked } from './checks/blocked.js';
import { connectionDetail, connections } from './checks/connections.js';
import { invalidConstraints } from './checks/constraints.js';
import { identity } from './checks/identity.js';
import { indexBloat } from './checks/index-bloat.js';
import {
  duplicateIndexes, indexCaching, indexHitRate, indexList, indexUsage,
  invalidIndexes, lastStatsReset, missingIndexes, unusedIndexes,
} from './checks/indexes.js';
import { locks } from './checks/locks.js';
import { autovacuumDanger, vacuumProgress } from './checks/maintenance.js';
import { longRunning } from './checks/long-running.js';
import { queryStats } from './checks/query-stats.js';
import { replicationLag } from './checks/replication.js';
import { sequences } from './checks/sequences.js';
import { sessionStates, sessions } from './checks/sessions.js';
import { settings } from './checks/settings.js';
import { slots } from './checks/slots.js';
import { databaseSize, relationSizes, tableSizes } from './checks/space.js';
import { tableCaching, tableHitRate, tableStats, unusedTables } from './checks/tables.js';
import { wraparound } from './checks/wraparound.js';
import { historicalQueryStats, queryShapeHistory } from './series/query-stats.js';
import { relationSpace, spaceGrowth } from './series/space.js';
import { explain } from './tools/explain.js';
import { suggestedIndexes } from './tools/suggested-indexes.js';

export const CHECKS = {
  autovacuumDanger,
  blocked,
  connectionDetail,
  connections,
  databaseSize,
  duplicateIndexes,
  identity,
  indexBloat,
  indexCaching,
  indexHitRate,
  indexList,
  indexUsage,
  invalidConstraints,
  invalidIndexes,
  lastStatsReset,
  locks,
  longRunning,
  missingIndexes,
  queryStats,
  relationSizes,
  replicationLag,
  sequences,
  sessions,
  sessionStates,
  settings,
  slots,
  tableCaching,
  tableHitRate,
  tableSizes,
  tableStats,
  unusedIndexes,
  unusedTables,
  vacuumProgress,
  wraparound,
} as const;

export type CheckId = keyof typeof CHECKS;

/**
 * Controller ruling on how a SHIPPED ACTION, as opposed to a check, appears
 * in this registry. #11 `kill` is real — Task 13 built `killBackend` — but
 * it is an action, not a `Check`: it mutates, it takes no `sql`/`map`/
 * `verdict`, and it lives in `actions/`, not `checks/`, by this package's
 * own DDL/DML boundary (the plan's global constraint naming `actions/kill.ts`
 * as the only file allowed to issue `pg_terminate_backend`). `ParityEntry`'s
 * `check: CheckId` cannot express it: `CheckId` is `keyof typeof CHECKS`,
 * and `kill` will never be a key there without smuggling a mutation into a
 * map of read-only checks.
 *
 * Leaving #11 `planned:` was rejected: that overstates `parityBacklog()` by
 * one and misreports a delivered capability as future work — exactly the
 * silent mismatch a controller asked this file never to produce. The fix
 * mirrors `CHECKS`/`CheckId`, applied to actions: a tiny registry, an id
 * type derived from its own keys, and a third `ParityEntry` variant,
 * `{ action: ActionId }`. That makes "never names an action that does not
 * exist" a real, checked property of this file (see registry.test.ts) — the
 * same guarantee `CHECKS` gives `check:` — rather than a free-form string a
 * typo could defeat without any test noticing.
 */
export const ACTIONS = {
  analyzeTables, kill: killBackend, killLongRunning, resetQueryStats, resetStats,
} as const;

/**
 * The over-time half. Keyed the same way CHECKS is, so `series:` in the
 * parity map can name a real thing and the test can prove it exists.
 */
export const SERIES = {
  historicalQueryStats, queryShapeHistory, relationSpace, spaceGrowth,
} as const;
export type SeriesId = keyof typeof SERIES;

/**
 * Questions the operator asks — see `Tool` in types.ts. Keyed like CHECKS and
 * SERIES, so `tool:` in the parity map names a real thing and the test proves
 * it exists.
 */
export const TOOLS = { explain, suggestedIndexes } as const;
export type ToolId = keyof typeof TOOLS;

/**
 * Scheduled work that is neither a check nor an action.
 *
 * `platform: string` would have accepted these, and that is exactly why it
 * must not: it is free text, so it cannot enforce "never names something that
 * does not exist" — the property that makes this registry worth having. Same
 * precedent as `action: ActionId`. Spec 2026-09-03 Ruling 3.
 *
 * Both entries point at the one function: pgHero splits capture into two
 * methods, pgops captures both in one pass because they share a transaction
 * and a lock.
 */
export const JOBS = {
  captureQueryStats: captureOnce,
  captureSpaceStats: captureOnce,
} as const;
export type JobId = keyof typeof JOBS;

export type ActionId = keyof typeof ACTIONS;

export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

/**
 * `check` / `action` / `platform` / `planned` / `declined` are meant as mutually
 * exclusive, but a union of object types does not enforce that at the type
 * level — TypeScript's excess-property check only rejects a property absent
 * from EVERY member, so `tsc --strict` accepts an entry carrying both
 * `check` and `planned`. `registry.test.ts`'s "exactly one of check /
 * action / platform / planned / declined" test is the actual enforcement, at
 * runtime, over every entry, on every run.
 *
 * `platform` is the third shipped variant, added for #60
 * `multiple_databases`. It is the same problem the #11 `kill` comment above
 * works through, one step further out: #11 was shipped but was not a
 * `Check`, so it got `action`; #60 is shipped but is neither a check nor an
 * action — it is the app's routing and configuration model, `PGOPS_DATABASES`
 * and a path segment per name. Leaving it `planned` overstated the backlog
 * and reported a delivered capability as future work, which is the one thing
 * this file exists to prevent. Unlike `check` and `action` its payload
 * cannot be checked against a registry of real things — there is no
 * `PLATFORM` map to key off — so it carries prose naming where the
 * capability lives, and that string is the weakest link in this file.
 */
export type ParityEntry = {
  name: string;
  source: string;
  /**
   * Where this capability sits on the tree (gates.ts) — required on every
   * entry, shipped or not.
   *
   * This is the half of the registry that faces FORWARD. `check`/`planned`
   * answer "is it built and when"; `gate` answers "what is it for", which is
   * the question that has to have an answer BEFORE anything is built, or the
   * capability arrives with nowhere to render and a band gets invented to
   * hold it. All forty remaining capabilities carry one today.
   *
   * For a shipped `check`, this must equal that check's own `gate` — asserted
   * in registry.test.ts rather than derived, so the duplication is the thing
   * that catches a capability being remapped to a check on a different gate.
   *
   * Ruling on ACTIONS, which are remedies rather than questions: an action
   * takes the gate of the OBJECT it acts on, not of every stall it can clear.
   * #11 `kill` terminates a session, so it is `connect` and lives on Sessions,
   * even though breaking a lock chain is its headline use; #12
   * `kill_long_running_queries` selects its targets by query duration, so it
   * is `work`. Without that rule `kill` could be argued into any of three
   * gates.
   */
  gate: Placement;
} & (
  | { check: CheckId }
  | { action: ActionId }
  | { series: SeriesId }
  | { tool: ToolId }
  | { job: JobId }
  | { platform: string }
  | { planned: Phase }
  | { declined: string }
);

export const PGHERO: Record<number, ParityEntry> = {
  // basic — methods/basic.rb
  // All three of basic.rb's status-bar facts are one round trip and one
  // check — see checks/identity.ts, which also backs #48. #3 diverges from
  // pgHero deliberately (pg_stat_ssl, not the sslinfo extension); the
  // reasoning is in that file's docblock.
  1: { name: 'server_version', source: 'methods/basic.rb',
    gate: 'server', check: 'identity' },
  2: { name: 'database_name', source: 'methods/basic.rb',
    gate: 'server', check: 'identity' },
  3: { name: 'ssl_in_use', source: 'methods/basic.rb',
    gate: 'server', check: 'identity' },

  // connections — methods/connections.rb
  // #4 is pgHero's per-connection LIST (pid/datname/user/source/ip/state/
  // ssl) — this package's `connections` check is an aggregate only, so
  // `connectionDetail` backs #4 instead. #5 IS answered by that aggregate's
  // `used`, with a scoping difference (client backends only). See the
  // top-of-file note.
  4: { name: 'connections', source: 'methods/connections.rb',
    gate: 'connect', check: 'connectionDetail' },
  5: { name: 'total_connections', source: 'methods/connections.rb',
    gate: 'connect', check: 'connections' },
  6: { name: 'connection_states', source: 'methods/connections.rb',
    gate: 'connect', check: 'sessionStates' },
  7: { name: 'connection_sources', source: 'methods/connections.rb',
    gate: 'connect', check: 'connectionDetail' },

  // queries — methods/queries.rb
  // running_queries: pgHero's own SQL is `state <> 'idle'`, ordered by
  // query/xact start — the same detail columns (pid, state, query, user,
  // duration) `sessions` already returns for every session; sessions.ts's
  // own `prepareSessions(..., { sort: 'active' })` is this exact view.
  8: { name: 'running_queries', source: 'methods/queries.rb',
    gate: 'connect', check: 'sessions' },
  9: { name: 'long_running_queries', source: 'methods/queries.rb',
    gate: 'work', check: 'longRunning' },
  // blocked_queries: `locks`, not `blocked` — see the top-of-file note for
  // why (verified against pgHero's actual SQL, not the name alone).
  10: { name: 'blocked_queries', source: 'methods/queries.rb',
    gate: 'wait', check: 'locks' },

  // kill — methods/kill.rb
  11: { name: 'kill', source: 'methods/kill.rb',
    gate: 'connect', action: 'kill' },
  12: { name: 'kill_long_running_queries', source: 'methods/kill.rb',
    gate: 'work', action: 'killLongRunning' },
  13: {
    name: 'kill_all',
    source: 'methods/kill.rb',
    gate: 'connect',
    declined: 'An action with no diagnosis; there is no incident in which '
      + '"terminate every session, unreviewed" is the correct first move. '
      + 'Web design spec §7.1; ops-console spec §3.4d. Permanent — ruled by the controller.',
  },

  // query_stats — methods/query_stats.rb
  14: { name: 'query_stats', source: 'methods/query_stats.rb',
    gate: 'work', check: 'queryStats' },
  15: { name: 'historical_query_stats', source: 'methods/query_stats.rb',
    gate: 'work', series: 'historicalQueryStats' },
  16: { name: 'query_hash_stats', source: 'methods/query_stats.rb',
    gate: 'work', series: 'queryShapeHistory' },
  // A FILTER over #14's rows, not a query: pgHero's slow_queries selects
  // from query_stats on calls >= 100 && average_time >= 20ms. Derived by
  // `slowQueries(data)` in query-stats.ts — same precedent as #5, where an
  // aggregate this package already computes answers a pgHero capability
  // without a check of its own.
  17: { name: 'slow_queries', source: 'methods/query_stats.rb',
    gate: 'work', check: 'queryStats' },
  // Shipped since P1a and mislabelled `planned` until the P1 phase gate
  // caught it. pgHero's capability is the probe plus the remedy, and both
  // exist: query-stats.ts declares `requires` (the pg_stat_statements
  // extension and a version floor), and run.ts turns an UNDEFINED_TABLE
  // from that check into `reason: 'missing-extension'` carrying a `remedy`.
  // It shares a check with #14 — the availability probe is the `requires`
  // block ON that check, not a separate query, and `ParityEntry` does not
  // require check ids to be unique across capabilities.
  18: { name: 'query_stats_available', source: 'methods/query_stats.rb',
    gate: 'work', check: 'queryStats' },
  19: {
    name: 'enable_query_stats',
    source: 'methods/query_stats.rb',
    gate: 'work',
    declined: 'Installing the pg_stat_statements extension is a schema change '
      + 'against a MONITORED database, which this project promises never to '
      + 'make. Parity spec §3.3 confines every schema change to the store '
      + 'named by PGOPS_STORE_URL "and nowhere else"; web design spec §7.1 '
      + 'puts such changes at tier 3, "CLI only, never reachable from the '
      + 'web"; and §8 cut the CLI, so tier 3 has no vehicle left. The remedy '
      + 'path already exists and is better: run.ts\'s remedyFor turns the '
      + 'absent extension into the exact statement for an operator to run '
      + 'through their own migration tooling, which is where a schema change '
      + 'belongs. Permanent.',
  },
  20: { name: 'reset_query_stats', source: 'methods/query_stats.rb',
    gate: 'work', action: 'resetQueryStats' },
  21: { name: 'capture_query_stats', source: 'methods/query_stats.rb',
    gate: 'work', job: 'captureQueryStats' },

  // indexes — methods/indexes.rb
  22: { name: 'index_hit_rate', source: 'methods/indexes.rb',
    gate: 'work', check: 'indexHitRate' },
  23: { name: 'index_caching', source: 'methods/indexes.rb',
    gate: 'work', check: 'indexCaching' },
  24: { name: 'index_usage', source: 'methods/indexes.rb',
    gate: 'work', check: 'indexUsage' },
  25: { name: 'missing_indexes', source: 'methods/indexes.rb',
    gate: 'work', check: 'missingIndexes' },
  26: { name: 'unused_indexes', source: 'methods/indexes.rb',
    gate: 'work', check: 'unusedIndexes' },
  27: { name: 'invalid_indexes', source: 'methods/indexes.rb',
    gate: 'work', check: 'invalidIndexes' },
  28: { name: 'duplicate_indexes', source: 'methods/indexes.rb',
    gate: 'work', check: 'duplicateIndexes' },
  29: { name: 'index_bloat', source: 'methods/indexes.rb',
    gate: 'keep-up', check: 'indexBloat' },
  30: { name: 'indexes', source: 'methods/indexes.rb',
    gate: 'work', check: 'indexList' },
  31: { name: 'reset_stats', source: 'methods/indexes.rb',
    gate: 'work', action: 'resetStats' },
  32: { name: 'last_stats_reset_time', source: 'methods/indexes.rb',
    gate: 'work', check: 'lastStatsReset' },

  // tables — methods/tables.rb (a distinct file in current pgHero; the old
  // matrix did not name a source file for this group)
  33: { name: 'table_hit_rate', source: 'methods/tables.rb',
    gate: 'work', check: 'tableHitRate' },
  34: { name: 'table_caching', source: 'methods/tables.rb',
    gate: 'work', check: 'tableCaching' },
  35: { name: 'unused_tables', source: 'methods/tables.rb',
    gate: 'work', check: 'unusedTables' },
  36: { name: 'table_stats', source: 'methods/tables.rb',
    gate: 'keep-up', check: 'tableStats' },

  // space — methods/space.rb
  37: { name: 'database_size', source: 'methods/space.rb',
    gate: 'keep-up', check: 'databaseSize' },
  38: { name: 'relation_sizes', source: 'methods/space.rb',
    gate: 'keep-up', check: 'relationSizes' },
  39: { name: 'table_sizes', source: 'methods/space.rb',
    gate: 'keep-up', check: 'tableSizes' },
  40: { name: 'space_growth', source: 'methods/space.rb',
    gate: 'keep-up', series: 'spaceGrowth' },
  41: { name: 'relation_space_stats', source: 'methods/space.rb',
    gate: 'keep-up', series: 'relationSpace' },
  42: { name: 'capture_space_stats', source: 'methods/space.rb',
    gate: 'keep-up', job: 'captureSpaceStats' },

  // maintenance — methods/maintenance.rb
  // Answered by `tableStats` (#36), not by a check of its own. pgHero's
  // `maintenance_info` reads pg_stat_user_tables and returns (schema, table,
  // last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, dead_rows,
  // live_rows); `tableStats` reads the same view and returns the same eight
  // fields, because #36 diverged from pgHero's `table_stats` precisely by
  // adopting THIS shape — see tables.ts. Two checks would have given the
  // maintenance page two answers to one question. Naming one check twice is
  // already how #49/#51 and #1/#2/#3/#48 work.
  43: { name: 'maintenance_info', source: 'methods/maintenance.rb',
    gate: 'keep-up', check: 'tableStats' },
  44: { name: 'transaction_id_danger', source: 'methods/maintenance.rb',
    gate: 'keep-up', check: 'wraparound' },
  45: { name: 'autovacuum_danger', source: 'methods/maintenance.rb',
    gate: 'keep-up', check: 'autovacuumDanger' },
  46: { name: 'vacuum_progress', source: 'methods/maintenance.rb',
    gate: 'keep-up', check: 'vacuumProgress' },
  47: { name: 'analyze_tables', source: 'methods/maintenance.rb',
    gate: 'keep-up', action: 'analyzeTables' },

  // replication — methods/replication.rb
  // `pg_is_in_recovery()`, folded into the identity round trip. slots.ts
  // already branched on this predicate to stay correct on a standby (see
  // its A6 note) without ever telling the operator they were on one.
  48: { name: 'replica', source: 'methods/replication.rb',
    gate: 'server', check: 'identity' },
  49: { name: 'replication_lag', source: 'methods/replication.rb',
    gate: 'keep-up', check: 'replicationLag' },
  50: { name: 'replication_slots', source: 'methods/replication.rb',
    gate: 'keep-up', check: 'slots' },
  // `SELECT state FROM pg_stat_replication` in pgHero, reduced to `.any?`.
  // Folded into #49's round trip as a count rather than a boolean: "two
  // standbys attached" and "one" are different operational facts, and the
  // boolean throws that away for nothing.
  51: { name: 'replicating', source: 'methods/replication.rb',
    gate: 'keep-up', check: 'replicationLag' },

  // sequences — methods/sequences.rb
  // #52, #53 and #54 are one query. pgHero asks three times — list them,
  // rank them by danger, name the ones it could not read — and the ranking
  // needs the column ceiling that the listing already had to find, so
  // splitting them would mean deriving the same ceiling three times and
  // letting the three copies drift.
  52: { name: 'sequences', source: 'methods/sequences.rb',
    gate: 'keep-up', check: 'sequences' },
  53: { name: 'sequence_danger', source: 'methods/sequences.rb',
    gate: 'keep-up', check: 'sequences' },
  54: { name: 'unreadable_sequences', source: 'methods/sequences.rb',
    gate: 'keep-up', check: 'sequences' },

  // constraints — methods/constraints.rb (a distinct file in current
  // pgHero; the old matrix did not name a source file for this group)
  55: { name: 'invalid_constraints', source: 'methods/constraints.rb',
    gate: 'keep-up', check: 'invalidConstraints' },

  // settings — methods/settings.rb (a distinct file in current pgHero; the
  // old matrix did not name a source file for this group)
  56: { name: 'settings', source: 'methods/settings.rb',
    gate: 'server', check: 'settings' },

  // explain — methods/explain.rb
  // Shipped in P6 as a Tool, the shape spec §7 declined to design. Planned
  // through `planStatements`, the one path operator SQL takes: a named
  // statement, read-only, rolled back, its connection destroyed. No ANALYZE
  // (divergence D2 — it executes the statement); no Visualize (chrome, an
  // external site). See tools/explain.ts.
  57: { name: 'explain', source: 'methods/explain.rb',
    gate: 'work', tool: 'explain' },

  // suggested_indexes — methods/suggested_indexes.rb
  // #58 and #63 are one tool: pgHero computes suggested_indexes FROM
  // suggested_indexes_by_query, and so does this. The busiest live shapes
  // (divergence D3 — not three captured hours), planned and advised through
  // #57's machinery. See tools/suggested-indexes.ts.
  58: { name: 'suggested_indexes', source: 'methods/suggested_indexes.rb',
    gate: 'work', tool: 'suggestedIndexes' },

  // system — methods/system.rb
  59: {
    name: 'system_stats',
    source: 'methods/system.rb',
    gate: 'server',
    declined: 'CPU, IOPS and free space come from CloudWatch, Azure Monitor or GCP '
      + 'monitoring: per-cloud credentials and a cloud SDK, for one panel that is '
      + 'blank for everyone self-hosting. The parent spec cut `events` for exactly '
      + 'this reason, and this has the same shape (full-parity spec §7). Permanent.',
  },

  // platform — multi-database is Rails-engine configuration
  // (lib/pghero/database.rb), not a lib/pghero/methods/ query
  // Shipped in P1a/P1b, and the second entry the phase gate caught. Neither
  // a check nor an action — hence the `platform` variant, whose docblock
  // explains the gap. pgHero's phrasing is "switchable from the UI"; here
  // the URL is the switcher, which is strictly better for an incident tool:
  // a pgops link names its database, so it survives being pasted into an
  // incident channel. A dropdown does not.
  60: {
    name: 'multiple_databases',
    source: 'database.rb',
    gate: 'server',
    platform: 'apps/web: PGOPS_DATABASES / PGOPS_CONFIG_FILE (lib/config.ts), '
      + 'one route per name under app/db/[name], all of them listed on the overview',
  },

  // Found by the 2026-08-26 re-audit, absent from the old 60-capability
  // matrix entirely:
  61: {
    name: 'disable_query_stats',
    source: 'methods/query_stats.rb',
    gate: 'work',
    declined: 'Removing the pg_stat_statements extension is a schema change '
      + 'against a MONITORED database — see #19 — and it is worse than #19 in '
      + 'one way that stands on its own. It irreversibly destroys every query '
      + 'statistic on the database, and pgops\'s own capture scheduler reads '
      + 'that extension every five minutes. A console whose control deletes '
      + 'the data its own history feature collects is incoherent, not merely '
      + 'sharp-edged. Permanent.',
  },
  // Declined in P6, superseding the controller ruling that kept it planned —
  // see the top-of-file note for why a confirmation gate was not enough.
  62: {
    name: 'autoindex',
    source: 'methods/suggested_indexes.rb',
    gate: 'work',
    declined: 'Its body builds an index concurrently on a MONITORED database — a schema '
      + 'change, forbidden for the same four reasons as #19 and #61: the §3.3 promise, '
      + 'the DDL guard, the web spec\'s tier 3, and §8\'s removal of the CLI that tier '
      + 'needed. pgHero\'s autoindex builds every suggestion with no review; a concurrent '
      + 'build still takes a SHARE UPDATE EXCLUSIVE lock, can fail and leave an INVALID '
      + 'index behind, and adds write cost to the table for as long as the index exists. '
      + 'Every #58 suggestion carries the exact statement instead, for the operator to '
      + 'run through their own migration tooling. Permanent.',
  },
  // Found by the systematic (fix-round) re-audit — see the file-by-file
  // enumeration in the task report:
  63: { name: 'suggested_indexes_by_query', source: 'methods/suggested_indexes.rb',
    gate: 'work', tool: 'suggestedIndexes' },
  // The same tool as #57: the plan is best_index's input, so one pass answers
  // both — the JOBS precedent. Reads the planner's plan rather than a
  // pg_query parse tree (divergence D1), which is why it handles joins where
  // pgHero returns "JOIN not supported yet". See tools/advice.ts.
  64: { name: 'best_index', source: 'methods/suggested_indexes.rb',
    gate: 'work', tool: 'explain' },
  // Dashboard-only — no lib/pghero/methods/ file backs this; it is Ruby
  // post-processing over the connections list in home_controller.rb's
  // params[:security] branch. Derived here in `map` from the same round
  // trip, as `bySslStatus`. See `sslStatus` for the four-value scheme and
  // why a boolean would be wrong.
  65: { name: 'connection_security_breakdown', source: 'app/controllers/pg_hero/home_controller.rb',
    gate: 'connect', check: 'connectionDetail' },
};

/**
 * The phases whose work is finished and merged.
 *
 * This is the list `registry.test.ts` gates on: a capability still `planned`
 * for a phase named here fails the suite. Add a phase to this array only
 * when its branch has landed on master — the array is the claim, and the
 * test is what makes the claim cost something.
 *
 * P1 covers both P1a ("the console renders") and P1b ("the console ships");
 * the registry's `Phase` has no sub-phase granularity and does not need any,
 * since a capability is owed by P1 whether P1a or P1b was meant to deliver
 * it.
 */
export const COMPLETE_PHASES: readonly Phase[] = ['P0', 'P1', 'P3', 'P2', 'P4', 'P5', 'P6'];

/**
 * Build order, as data. `planned: 'P3'` means "P3 OWNS this", not "P3 happens
 * third" — so P3 shipping before P2 is a change to this array and nothing
 * else. Renumbering 43 registry entries to make labels sort would be ceremony.
 */
export const PHASE_ORDER: readonly Phase[] = ['P0', 'P1', 'P3', 'P2', 'P4', 'P5', 'P6'];

/**
 * Capabilities owned but not yet built. Parity is complete when this is 0.
 *
 * With `phase`, the backlog for that phase alone — which is what the gate
 * above needs, and what makes "P2 is 31 capabilities" a number this file
 * reports rather than one somebody counts by hand and gets wrong.
 */
export function parityBacklog(phase?: Phase): number {
  return Object.values(PGHERO)
    .filter((e) => 'planned' in e && (phase === undefined || e.planned === phase))
    .length;
}
