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
 *    `home_controller.rb#connections`, never in a method. Added as #64.
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
 *    aggregate produces a per-connection list, so #4 is `planned: 'P2'`,
 *    the same phase as its sibling #7 `connection_sources`. Remapping #4 to
 *    `sessions` was considered and rejected: `sessions` is the closest
 *    shipped analog but still lacks `datname` and `ssl`, and caps at 500
 *    rows where pgHero's list is unbounded — a near-miss `check:` in a
 *    registry whose whole job is being right about parity is exactly the
 *    failure this correction fixes.
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
import { killBackend } from './actions/kill.js';
import { blocked } from './checks/blocked.js';
import { connections } from './checks/connections.js';
import { locks } from './checks/locks.js';
import { longRunning } from './checks/long-running.js';
import { queryStats } from './checks/query-stats.js';
import { sessionStates, sessions } from './checks/sessions.js';
import { slots } from './checks/slots.js';
import { wraparound } from './checks/wraparound.js';

export const CHECKS = {
  blocked,
  connections,
  locks,
  longRunning,
  queryStats,
  sessions,
  sessionStates,
  slots,
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
export const ACTIONS = { kill: killBackend } as const;

export type ActionId = keyof typeof ACTIONS;

export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

/**
 * `check` / `action` / `planned` / `declined` are meant as mutually
 * exclusive, but a union of object types does not enforce that at the type
 * level — TypeScript's excess-property check only rejects a property absent
 * from EVERY member, so `tsc --strict` accepts an entry carrying both
 * `check` and `planned`. `registry.test.ts`'s "exactly one of shipped /
 * planned / declined" test is the actual enforcement, at runtime, over
 * every entry, on every run.
 */
export type ParityEntry = { name: string; source: string } & (
  | { check: CheckId }
  | { action: ActionId }
  | { planned: Phase }
  | { declined: string }
);

export const PGHERO: Record<number, ParityEntry> = {
  // basic — methods/basic.rb
  1: { name: 'server_version', source: 'methods/basic.rb', planned: 'P1' },
  2: { name: 'database_name', source: 'methods/basic.rb', planned: 'P1' },
  3: { name: 'ssl_in_use', source: 'methods/basic.rb', planned: 'P1' },

  // connections — methods/connections.rb
  // #4 is pgHero's per-connection LIST (pid/datname/user/source/ip/state/
  // ssl) — this package's `connections` check is an aggregate only, so
  // nothing here backs it. #5 IS answered by that aggregate's `used`, with
  // a scoping difference (client backends only). See the top-of-file note.
  4: { name: 'connections', source: 'methods/connections.rb', planned: 'P2' },
  5: { name: 'total_connections', source: 'methods/connections.rb', check: 'connections' },
  6: { name: 'connection_states', source: 'methods/connections.rb', check: 'sessionStates' },
  7: { name: 'connection_sources', source: 'methods/connections.rb', planned: 'P2' },

  // queries — methods/queries.rb
  // running_queries: pgHero's own SQL is `state <> 'idle'`, ordered by
  // query/xact start — the same detail columns (pid, state, query, user,
  // duration) `sessions` already returns for every session; sessions.ts's
  // own `prepareSessions(..., { sort: 'active' })` is this exact view.
  8: { name: 'running_queries', source: 'methods/queries.rb', check: 'sessions' },
  9: { name: 'long_running_queries', source: 'methods/queries.rb', check: 'longRunning' },
  // blocked_queries: `locks`, not `blocked` — see the top-of-file note for
  // why (verified against pgHero's actual SQL, not the name alone).
  10: { name: 'blocked_queries', source: 'methods/queries.rb', check: 'locks' },

  // kill — methods/kill.rb
  11: { name: 'kill', source: 'methods/kill.rb', action: 'kill' },
  12: { name: 'kill_long_running_queries', source: 'methods/kill.rb', planned: 'P5' },
  13: {
    name: 'kill_all',
    source: 'methods/kill.rb',
    declined: 'An action with no diagnosis; there is no incident in which '
      + '"terminate every session, unreviewed" is the correct first move. '
      + 'Web design spec §7.1; ops-console spec §3.4d. Permanent — ruled by the controller.',
  },

  // query_stats — methods/query_stats.rb
  14: { name: 'query_stats', source: 'methods/query_stats.rb', check: 'queryStats' },
  15: { name: 'historical_query_stats', source: 'methods/query_stats.rb', planned: 'P3' },
  16: { name: 'query_hash_stats', source: 'methods/query_stats.rb', planned: 'P4' },
  17: { name: 'slow_queries', source: 'methods/query_stats.rb', planned: 'P2' },
  18: { name: 'query_stats_available', source: 'methods/query_stats.rb', planned: 'P1' },
  19: { name: 'enable_query_stats', source: 'methods/query_stats.rb', planned: 'P5' },
  20: { name: 'reset_query_stats', source: 'methods/query_stats.rb', planned: 'P5' },
  21: { name: 'capture_query_stats', source: 'methods/query_stats.rb', planned: 'P3' },

  // indexes — methods/indexes.rb
  22: { name: 'index_hit_rate', source: 'methods/indexes.rb', planned: 'P2' },
  23: { name: 'index_caching', source: 'methods/indexes.rb', planned: 'P2' },
  24: { name: 'index_usage', source: 'methods/indexes.rb', planned: 'P2' },
  25: { name: 'missing_indexes', source: 'methods/indexes.rb', planned: 'P2' },
  26: { name: 'unused_indexes', source: 'methods/indexes.rb', planned: 'P2' },
  27: { name: 'invalid_indexes', source: 'methods/indexes.rb', planned: 'P2' },
  28: { name: 'duplicate_indexes', source: 'methods/indexes.rb', planned: 'P2' },
  29: { name: 'index_bloat', source: 'methods/indexes.rb', planned: 'P2' },
  30: { name: 'indexes', source: 'methods/indexes.rb', planned: 'P2' },
  31: { name: 'reset_stats', source: 'methods/indexes.rb', planned: 'P5' },
  32: { name: 'last_stats_reset_time', source: 'methods/indexes.rb', planned: 'P2' },

  // tables — methods/tables.rb (a distinct file in current pgHero; the old
  // matrix did not name a source file for this group)
  33: { name: 'table_hit_rate', source: 'methods/tables.rb', planned: 'P2' },
  34: { name: 'table_caching', source: 'methods/tables.rb', planned: 'P2' },
  35: { name: 'unused_tables', source: 'methods/tables.rb', planned: 'P2' },
  36: { name: 'table_stats', source: 'methods/tables.rb', planned: 'P2' },

  // space — methods/space.rb
  37: { name: 'database_size', source: 'methods/space.rb', planned: 'P2' },
  38: { name: 'relation_sizes', source: 'methods/space.rb', planned: 'P2' },
  39: { name: 'table_sizes', source: 'methods/space.rb', planned: 'P2' },
  40: { name: 'space_growth', source: 'methods/space.rb', planned: 'P4' },
  41: { name: 'relation_space_stats', source: 'methods/space.rb', planned: 'P4' },
  42: { name: 'capture_space_stats', source: 'methods/space.rb', planned: 'P3' },

  // maintenance — methods/maintenance.rb
  43: { name: 'maintenance_info', source: 'methods/maintenance.rb', planned: 'P2' },
  44: { name: 'transaction_id_danger', source: 'methods/maintenance.rb', check: 'wraparound' },
  45: { name: 'autovacuum_danger', source: 'methods/maintenance.rb', planned: 'P2' },
  46: { name: 'vacuum_progress', source: 'methods/maintenance.rb', planned: 'P2' },
  47: { name: 'analyze_tables', source: 'methods/maintenance.rb', planned: 'P5' },

  // replication — methods/replication.rb
  48: { name: 'replica', source: 'methods/replication.rb', planned: 'P1' },
  49: { name: 'replication_lag', source: 'methods/replication.rb', planned: 'P2' },
  50: { name: 'replication_slots', source: 'methods/replication.rb', check: 'slots' },
  51: { name: 'replicating', source: 'methods/replication.rb', planned: 'P2' },

  // sequences — methods/sequences.rb
  52: { name: 'sequences', source: 'methods/sequences.rb', planned: 'P2' },
  53: { name: 'sequence_danger', source: 'methods/sequences.rb', planned: 'P2' },
  54: { name: 'unreadable_sequences', source: 'methods/sequences.rb', planned: 'P2' },

  // constraints — methods/constraints.rb (a distinct file in current
  // pgHero; the old matrix did not name a source file for this group)
  55: { name: 'invalid_constraints', source: 'methods/constraints.rb', planned: 'P2' },

  // settings — methods/settings.rb (a distinct file in current pgHero; the
  // old matrix did not name a source file for this group)
  56: { name: 'settings', source: 'methods/settings.rb', planned: 'P2' },

  // explain — methods/explain.rb
  57: { name: 'explain', source: 'methods/explain.rb', planned: 'P6' },

  // suggested_indexes — methods/suggested_indexes.rb
  58: { name: 'suggested_indexes', source: 'methods/suggested_indexes.rb', planned: 'P6' },

  // system — methods/system.rb
  59: { name: 'system_stats', source: 'methods/system.rb', planned: 'P6' },

  // platform — multi-database is Rails-engine configuration
  // (lib/pghero/database.rb), not a lib/pghero/methods/ query
  60: { name: 'multiple_databases', source: 'database.rb', planned: 'P1' },

  // Found by the 2026-08-26 re-audit, absent from the old 60-capability
  // matrix entirely:
  61: { name: 'disable_query_stats', source: 'methods/query_stats.rb', planned: 'P5' },
  // #62 stays planned: (controller ruling); action must be gated behind
  // explicit confirmation when built — see the top-of-file note.
  62: { name: 'autoindex', source: 'methods/suggested_indexes.rb', planned: 'P6' },
  // Found by the systematic (fix-round) re-audit — see the file-by-file
  // enumeration in the task report:
  63: { name: 'suggested_indexes_by_query', source: 'methods/suggested_indexes.rb', planned: 'P6' },
  64: { name: 'best_index', source: 'methods/suggested_indexes.rb', planned: 'P6' },
  // Dashboard-only — no lib/pghero/methods/ file backs this; see
  // home_controller.rb#connections, the params[:security] branch.
  65: { name: 'connection_security_breakdown', source: 'app/controllers/pg_hero/home_controller.rb', planned: 'P2' },
};

/** Capabilities owned but not yet built. Parity is complete when this is 0. */
export function parityBacklog(): number {
  return Object.values(PGHERO).filter((e) => 'planned' in e).length;
}
