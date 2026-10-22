/**
 * The pgHero parity registry: every public pgHero capability (audited against
 * pgHero 4.0.1), mapped to the check, action or tool that
 * answers it, or declined with a reason.
 *
 * pgHero methods folded into another entry rather than given their own:
 *
 *  - basic.rb: `current_user` into #2, `server_version_num` into #1.
 *  - indexes.rb: `index_covers?` into #28.
 *  - maintenance.rb: `analyze` (single table) into #47.
 *  - query_stats.rb: `query_stats_enabled?`, `query_stats_extension_enabled?`
 *    and `query_stats_readable?` into #18; `historical_query_stats_enabled?`,
 *    `queries_table_exists?`, `query_stats_table_exists?` and
 *    `clean_query_stats` into #21.
 *  - settings.rb: `autovacuum_settings` and `vacuum_settings` into #56.
 *  - space.rb: `space_stats_enabled?` and `clean_space_stats` into #42.
 *  - suggested_indexes.rb: `suggested_indexes_enabled?` into #58.
 *  - system.rb: `system_stats_enabled?`, `system_stats_provider` and
 *    `rds_stats` into #59.
 *  - `quote_ident` is plumbing and has no entry. Neither does `tune`, a
 *    dashboard view over #56's settings.
 *
 * Mappings that are not what the names suggest:
 *
 *  - #10 `blocked_queries` is backed by `sessions`: each session carries
 *    `blockedBy`, which is what the chain is built from.
 *  - #4 `connections` is pgHero's per-connection list, so `connectionDetail`
 *    backs it, along with #7 and #65. The `connections` check returns four
 *    aggregate numbers.
 *  - #5 `total_connections` is the `connections` check's `used`, which
 *    counts client backends only; pgHero counts every backend.
 */
import { analyzeTables, killBackend, killLongRunning, resetQueryStats, resetStats } from './actions.js';
import { indexes, tables } from './checks/catalog.js';
import { connectionDetail, connections } from './checks/connections.js';
import { identity } from './checks/identity.js';
import { horizon } from './checks/horizon.js';
import { indexBloat } from './checks/index-bloat.js';
import { queryStats } from './checks/query-stats.js';
import { replicationLag } from './checks/replication.js';
import { sequences } from './checks/sequences.js';
import { sessions } from './checks/sessions.js';
import { settings } from './checks/settings.js';
import { slots } from './checks/slots.js';
import { standbys } from './checks/standbys.js';
import { wraparound } from './checks/wraparound.js';
import { explain } from './tools/explain.js';
import { suggestedIndexes } from './tools/suggested-indexes.js';

export const CHECKS = {
  connectionDetail,
  connections,
  horizon,
  identity,
  indexBloat,
  indexes,
  queryStats,
  replicationLag,
  sequences,
  sessions,
  settings,
  slots,
  standbys,
  tables,
  wraparound,
} as const;

type CheckId = keyof typeof CHECKS;

/**
 * Actions mutate, so they are kept out of CHECKS. Keyed so `action:` in the
 * parity map names a real thing; registry.test.ts holds this.
 */
export const ACTIONS = {
  analyzeTables, kill: killBackend, killLongRunning, resetQueryStats, resetStats,
} as const;

/** Questions the operator asks; see `Tool` in types.ts. */
export const TOOLS = { explain, suggestedIndexes } as const;
type ToolId = keyof typeof TOOLS;

type ActionId = keyof typeof ACTIONS;

/**
 * The variants are meant to be mutually exclusive, but a union of object
 * types does not enforce that: `tsc --strict` accepts an entry carrying both
 * `check` and `declined`. registry.test.ts enforces exactly one, over every
 * entry.
 *
 * `platform` is for a shipped capability that is neither a check nor an
 * action (#60). Its payload is prose naming where the capability lives, and
 * cannot be checked against a registry.
 */
type ParityEntry = {
  name: string;
  source: string;
} & (
  | { check: CheckId }
  | { action: ActionId }
  | { tool: ToolId }
  | { platform: string }
  | { declined: string }
);

export const PGHERO: Record<number, ParityEntry> = {
  // basic — methods/basic.rb
  // One round trip and one check (checks/identity.ts), which also backs #48.
  // #3 reads pg_stat_ssl, not pgHero's sslinfo extension.
  1: { name: 'server_version', source: 'methods/basic.rb',
    check: 'identity' },
  2: { name: 'database_name', source: 'methods/basic.rb',
    check: 'identity' },
  3: { name: 'ssl_in_use', source: 'methods/basic.rb',
    check: 'identity' },

  // connections — methods/connections.rb
  // #4 is a per-connection list, so `connectionDetail` backs it; #5 is the
  // `connections` aggregate's `used` (client backends only).
  4: { name: 'connections', source: 'methods/connections.rb',
    check: 'connectionDetail' },
  5: { name: 'total_connections', source: 'methods/connections.rb',
    check: 'connections' },
  // The census by state is the band's split by class, on every page with a clock.
  6: { name: 'connection_states', source: 'methods/connections.rb',
    platform: 'apps/web/lib/tree.ts: the band and every row strip, sessions not idle split by class' },
  7: { name: 'connection_sources', source: 'methods/connections.rb',
    check: 'connectionDetail' },

  // queries — methods/queries.rb
  // running_queries is `state <> 'idle'` in pgHero: the sessions `sessions`
  // reads, every one not idle, which are the tree's session rows.
  8: { name: 'running_queries', source: 'methods/queries.rb',
    check: 'sessions' },
  // A session's time in its state is its row's span on the tree; what holds vacuum back is Server's list.
  9: { name: 'long_running_queries', source: 'methods/queries.rb',
    platform: 'apps/web/lib/tree.ts: a session row is its time in one state; apps/web/app/db/[name]/server: the transactions open longest' },
  // A chain is the answer line on the table it is on, with Terminate on its root; `sessions` carries `blockedBy`.
  10: { name: 'blocked_queries', source: 'methods/queries.rb',
    platform: 'apps/web/lib/tree.ts: a lock chain is one finding on its table, from the sessions read\'s blockedBy' },

  // kill — methods/kill.rb
  11: { name: 'kill', source: 'methods/kill.rb',
    action: 'kill' },
  12: { name: 'kill_long_running_queries', source: 'methods/kill.rb',
    action: 'killLongRunning' },
  13: {
    name: 'kill_all',
    source: 'methods/kill.rb',
    declined: 'An action with no diagnosis; there is no incident in which '
      + '"terminate every session, unreviewed" is the correct first move. '
      + 'Web design spec §7.1; ops-console spec §3.4d. Permanent — ruled by the controller.',
  },

  // query_stats — methods/query_stats.rb
  14: { name: 'query_stats', source: 'methods/query_stats.rb',
    check: 'queryStats' },
  // Over any window of the store: the stored snapshots differenced by `deltas`.
  15: { name: 'historical_query_stats', source: 'methods/query_stats.rb',
    platform: 'apps/web/app/db/[name]/queries: every statement on the scatter over the window, from readWindowStats' },
  16: { name: 'query_hash_stats', source: 'methods/query_stats.rb',
    platform: 'apps/web/app/db/[name]/queries/[queryid]: one statement over the window, its stat line and load' },
  // pgHero's bound (calls >= 100 and average_time >= 20ms), as SLOW_QUERY_DEFAULTS:
  // the Queries scatter marks the shapes past it.
  17: { name: 'slow_queries', source: 'methods/query_stats.rb',
    check: 'queryStats' },
  // The availability probe is the `requires` block on #14's check: run.ts
  // turns an UNDEFINED_TABLE from it into `reason: 'missing-extension'`
  // carrying a `remedy`.
  18: { name: 'query_stats_available', source: 'methods/query_stats.rb',
    check: 'queryStats' },
  19: {
    name: 'enable_query_stats',
    source: 'methods/query_stats.rb',
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
    action: 'resetQueryStats' },
  21: { name: 'capture_query_stats', source: 'methods/query_stats.rb',
    platform: 'packages/checks/src/capture.ts: captureOnce, every five minutes, query and space statistics in one pass' },

  // indexes — methods/indexes.rb
  // Each a column of a captured read. Per index, the `indexes` read: its hit
  // rate, its scans since the reset (`never used`), `valid`, and
  // `duplicateOf`, the index that covers it. Per table, the `tables` read:
  // `idxScans` against `seqScans`, and the `full scans` flag that is
  // pgHero's missing-index bound.
  22: { name: 'index_hit_rate', source: 'methods/indexes.rb',
    check: 'indexes' },
  23: { name: 'index_caching', source: 'methods/indexes.rb',
    check: 'indexes' },
  24: { name: 'index_usage', source: 'methods/indexes.rb',
    check: 'tables' },
  25: { name: 'missing_indexes', source: 'methods/indexes.rb',
    check: 'tables' },
  26: { name: 'unused_indexes', source: 'methods/indexes.rb',
    check: 'indexes' },
  27: { name: 'invalid_indexes', source: 'methods/indexes.rb',
    check: 'indexes' },
  28: { name: 'duplicate_indexes', source: 'methods/indexes.rb',
    check: 'indexes' },
  29: { name: 'index_bloat', source: 'methods/indexes.rb',
    check: 'indexBloat' },
  30: { name: 'indexes', source: 'methods/indexes.rb',
    check: 'indexes' },
  31: { name: 'reset_stats', source: 'methods/indexes.rb',
    action: 'resetStats' },
  // `statsReset` on the `tables` read, from `pg_stat_database`.
  32: { name: 'last_stats_reset_time', source: 'methods/indexes.rb',
    check: 'tables' },

  // tables — methods/tables.rb
  // Columns of the `tables` read: `hitRate`, and `seqScans` with `idxScans`
  // for a table nothing reads.
  33: { name: 'table_hit_rate', source: 'methods/tables.rb',
    check: 'tables' },
  34: { name: 'table_caching', source: 'methods/tables.rb',
    check: 'tables' },
  35: { name: 'unused_tables', source: 'methods/tables.rb',
    check: 'tables' },
  36: { name: 'table_stats', source: 'methods/tables.rb',
    check: 'tables' },

  // space — methods/space.rb
  // #37 is on every health row, and Server's head states it. #38 and
  // #39 are the `tables` read's `sizeBytes`, `heapBytes` and `indexBytes`.
  37: { name: 'database_size', source: 'methods/space.rb',
    platform: 'packages/checks/src/health.ts: pg_database_size on every health row, as size_bytes; '
      + 'Server\'s head states the newest' },
  38: { name: 'relation_sizes', source: 'methods/space.rb',
    check: 'tables' },
  39: { name: 'table_sizes', source: 'methods/space.rb',
    check: 'tables' },
  40: { name: 'space_growth', source: 'methods/space.rb',
    platform: 'apps/web/app/db/[name]/tables/[relation]: the size panel on the clock, from readRelationSpace' },
  41: { name: 'relation_space_stats', source: 'methods/space.rb',
    platform: 'packages/checks/src/store/read.ts: readRelationSpace, the size panel on the table page' },
  42: { name: 'capture_space_stats', source: 'methods/space.rb',
    platform: 'packages/checks/src/capture.ts: captureOnce, every five minutes, query and space statistics in one pass' },

  // maintenance — methods/maintenance.rb
  // #43 is the `tables` read's rows, dead rows and last vacuum and analyze,
  // the fields of pgHero's `maintenance_info`. #45 is its `xidAge`, flagged
  // `xid age`. #46 is its `vacuuming`: the phase of a running vacuum, with no
  // percentage, which is narrower than pgHero's.
  43: { name: 'maintenance_info', source: 'methods/maintenance.rb',
    check: 'tables' },
  44: { name: 'transaction_id_danger', source: 'methods/maintenance.rb',
    check: 'wraparound' },
  45: { name: 'autovacuum_danger', source: 'methods/maintenance.rb',
    check: 'tables' },
  46: { name: 'vacuum_progress', source: 'methods/maintenance.rb',
    check: 'tables' },
  47: { name: 'analyze_tables', source: 'methods/maintenance.rb',
    action: 'analyzeTables' },

  // replication — methods/replication.rb
  // #48 is `pg_is_in_recovery()`, folded into the identity round trip.
  48: { name: 'replica', source: 'methods/replication.rb',
    check: 'identity' },
  49: { name: 'replication_lag', source: 'methods/replication.rb',
    check: 'replicationLag' },
  50: { name: 'replication_slots', source: 'methods/replication.rb',
    check: 'slots' },
  // Folded into #49's round trip as a count of standbys, where pgHero
  // returns a boolean.
  51: { name: 'replicating', source: 'methods/replication.rb',
    check: 'replicationLag' },

  // sequences — methods/sequences.rb
  // #52, #53 and #54 are one query: the danger ranking needs the column
  // ceiling the listing already finds.
  52: { name: 'sequences', source: 'methods/sequences.rb',
    check: 'sequences' },
  53: { name: 'sequence_danger', source: 'methods/sequences.rb',
    check: 'sequences' },
  54: { name: 'unreadable_sequences', source: 'methods/sequences.rb',
    check: 'sequences' },

  // constraints — methods/constraints.rb
  // The `tables` read's `unvalidated`, flagged `not validated`: a count per
  // table, where pgHero names each constraint.
  55: { name: 'invalid_constraints', source: 'methods/constraints.rb',
    check: 'tables' },

  // settings — methods/settings.rb
  56: { name: 'settings', source: 'methods/settings.rb',
    check: 'settings' },

  // explain — methods/explain.rb
  // A Tool. Planned through `planStatements`, the one path operator SQL
  // takes: a named statement, read-only, rolled back, its connection
  // destroyed. No ANALYZE, which would execute the statement. See
  // tools/explain.ts.
  57: { name: 'explain', source: 'methods/explain.rb',
    tool: 'explain' },

  // suggested_indexes — methods/suggested_indexes.rb
  // #58 and #63 are one tool. It reads the busiest live shapes, not three
  // captured hours as pgHero does. See tools/suggested-indexes.ts.
  58: { name: 'suggested_indexes', source: 'methods/suggested_indexes.rb',
    tool: 'suggestedIndexes' },

  // system — methods/system.rb
  59: {
    name: 'system_stats',
    source: 'methods/system.rb',
    declined: 'CPU, IOPS and free space come from CloudWatch, Azure Monitor or GCP '
      + 'monitoring: per-cloud credentials and a cloud SDK, for one panel that is '
      + 'blank for everyone self-hosting. The parent spec cut `events` for exactly '
      + 'this reason, and this has the same shape (full-parity spec §7). Permanent.',
  },

  // platform — multi-database is configuration (lib/pghero/database.rb), not
  // a query. Here the URL names the database, so a pasted link keeps it.
  60: {
    name: 'multiple_databases',
    source: 'database.rb',
    platform: 'apps/web: PGOPS_DATABASES / PGOPS_CONFIG_FILE (lib/config.ts), '
      + 'one route per name under app/db/[name], all of them listed on the overview',
  },

  61: {
    name: 'disable_query_stats',
    source: 'methods/query_stats.rb',
    declined: 'Removing the pg_stat_statements extension is a schema change '
      + 'against a MONITORED database — see #19 — and it is worse than #19 in '
      + 'one way that stands on its own. It irreversibly destroys every query '
      + 'statistic on the database, and pgops\'s own capture scheduler reads '
      + 'that extension every five minutes. A console whose control deletes '
      + 'the data its own history feature collects is incoherent, not merely '
      + 'sharp-edged. Permanent.',
  },
  62: {
    name: 'autoindex',
    source: 'methods/suggested_indexes.rb',
    declined: 'Its body builds an index concurrently on a MONITORED database — a schema '
      + 'change, forbidden for the same four reasons as #19 and #61: the §3.3 promise, '
      + 'the DDL guard, the web spec\'s tier 3, and §8\'s removal of the CLI that tier '
      + 'needed. pgHero\'s autoindex builds every suggestion with no review; a concurrent '
      + 'build still takes a SHARE UPDATE EXCLUSIVE lock, can fail and leave an INVALID '
      + 'index behind, and adds write cost to the table for as long as the index exists. '
      + 'Every #58 suggestion carries the exact statement instead, for the operator to '
      + 'run through their own migration tooling. Permanent.',
  },
  63: { name: 'suggested_indexes_by_query', source: 'methods/suggested_indexes.rb',
    tool: 'suggestedIndexes' },
  // The same tool as #57: the plan is best_index's input. It reads the
  // planner's plan rather than a pg_query parse tree, so it handles joins.
  // See tools/advice.ts.
  64: { name: 'best_index', source: 'methods/suggested_indexes.rb',
    tool: 'explain' },
  // Dashboard-only in pgHero. Derived in `map` from the connections round
  // trip, as `bySslStatus`; see `sslStatus` for the four-value scheme.
  65: { name: 'connection_security_breakdown', source: 'app/controllers/pg_hero/home_controller.rb',
    check: 'connectionDetail' },
};
