import type { Pool } from 'pg';
import { withAdvisoryLock } from './lock.js';
import { MIGRATION_LOCK_KEY } from './write.js';

/**
 * Forward-only, numbered, idempotent. Every entry must be safe to run
 * against a store already at that version. Index 0 is migration 001.
 */
export const MIGRATIONS: readonly string[] = [
  // 001 is the initial pgops schema. A TypeScript module, not .sql files:
  // `packages/checks` builds with plain `tsc`, which would not copy a .sql file
  // into dist/.
  //
  // This file is the only place in the product permitted to contain DDL;
  // apps/web/test/guards.test.ts holds this.
  `
CREATE SCHEMA IF NOT EXISTS pgops;

CREATE TABLE IF NOT EXISTS pgops.schema_version (
  version int NOT NULL,
  -- One row, enforced. A second row would make "what version is this store"
  -- ambiguous, and the runner reads it with a bare SELECT.
  singleton bool NOT NULL DEFAULT true UNIQUE CHECK (singleton)
);

CREATE TABLE IF NOT EXISTS pgops.databases (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Query text is stored ONCE per shape, not once per capture. A 5,000-shape
-- database capturing every 5 minutes would otherwise write roughly
-- 1 kB x 5,000 x 288/day of duplicated text. pgHero normalises the same way.
CREATE TABLE IF NOT EXISTS pgops.queries (
  id          serial PRIMARY KEY,
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  -- bigint: pg_stat_statements' 64-bit hash. Identity only, never arithmetic.
  queryid     bigint NOT NULL,
  -- Redacted before insert (redactSecrets). The store is durable; a secret in
  -- a query literal written here outlives every screenshot.
  query       text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (database_id, queryid)
);

-- CUMULATIVE counters, never deltas. pgops does not reset pg_stat_statements
-- (doing so silently breaks every other consumer on the database), so deltas
-- are computed at read time from consecutive snapshots. See deltas.ts.
CREATE TABLE IF NOT EXISTS pgops.query_stats (
  database_id      int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  query_id         int NOT NULL REFERENCES pgops.queries(id) ON DELETE CASCADE,
  captured_at      timestamptz NOT NULL,
  calls            bigint NOT NULL,
  total_exec_time  double precision NOT NULL,
  rows             bigint NOT NULL,
  shared_blks_hit  bigint NOT NULL,
  shared_blks_read bigint NOT NULL,
  -- From pg_stat_statements_info (PG14+). An advance here marks a
  -- discontinuity: the interval spanning it is dropped, never charted.
  stats_reset      timestamptz,
  PRIMARY KEY (database_id, query_id, captured_at)
);

CREATE INDEX IF NOT EXISTS query_stats_captured_at_idx
  ON pgops.query_stats (database_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS pgops.space_stats (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  relation    text NOT NULL,
  captured_at timestamptz NOT NULL,
  size_bytes  bigint NOT NULL,
  PRIMARY KEY (database_id, relation, captured_at)
);

CREATE INDEX IF NOT EXISTS space_stats_captured_at_idx
  ON pgops.space_stats (database_id, captured_at DESC);
`,

  // 002: an index leading with `query_id`. Neither existing index on
  // `pgops.query_stats` leads with it, and two things need it: the
  // `ON DELETE CASCADE` foreign key to `pgops.queries`, which otherwise scans
  // sequentially per deleted row, and `prune`'s orphan sweep, whose
  // `NOT EXISTS` otherwise anti-joins the whole table.
  //
  // Plain `CREATE INDEX`, not CONCURRENTLY: `migrate` runs each migration in a
  // transaction and CONCURRENTLY cannot run in one. The lock blocks capture on
  // the store once, at boot.
  `
CREATE INDEX IF NOT EXISTS query_stats_query_id_idx
  ON pgops.query_stats (query_id);
`,

  // 003: the hygiene cache, what the last pass of each hygiene check found.
  // Dropped by migration 008.
  //
  // One row per check, not a history: `captured_at` is a column rather than
  // part of the key, and every write is an upsert.
  //
  // `level` has no CHECK constraint: its values come from `Verdict['level']`,
  // and a constraint would need a migration whenever that union changes.
  `
CREATE TABLE IF NOT EXISTS pgops.check_results (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  check_id    text NOT NULL,
  captured_at timestamptz NOT NULL,
  ok          boolean NOT NULL,
  level       text,
  note        text,
  message     text,
  PRIMARY KEY (database_id, check_id)
);
`,

  // 004: the total load of one capture interval, one row per capture.
  //
  // Written at capture rather than summed at read time: a day's load spans
  // every shape and every capture in the window (5,000 shapes × 288 captures
  // is 1.4 million rows to difference), on a page that polls every five
  // seconds.
  //
  // `total_exec_time` and `calls` are the interval's, not cumulative counters.
  // `captureOnce` applies the discontinuity rule (deltas.ts) per shape before
  // the sum. A capture where no shape yields an interval, including a
  // database's first, writes no row.
  `
CREATE TABLE IF NOT EXISTS pgops.query_load (
  database_id     int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  total_exec_time double precision NOT NULL,
  calls           bigint NOT NULL,
  PRIMARY KEY (database_id, captured_at)
);
`,

  // 005: one wide row per database per minute.
  //
  // Wide, not one row per metric: the page reads every metric for a window at
  // once.
  //
  // Every metric column is nullable and none has a default. Null is "pgops
  // could not look"; zero is "pgops looked and there were none".
  //
  // Counters are stored raw and differenced at read. `stats_reset` lets a read
  // tell a reset from a quiet minute. `wal_bytes` is numeric because
  // pg_stat_wal reports it that way.
  `
CREATE TABLE IF NOT EXISTS pgops.health_stats (
  database_id              int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  captured_at              timestamptz NOT NULL,
  connections              int,
  server_connections       int,
  max_connections          int,
  sessions                 bigint,
  sessions_abandoned       bigint,
  sessions_fatal           bigint,
  sessions_killed          bigint,
  blocked                  int,
  longest_wait_secs        double precision,
  idle_in_txn              int,
  idle_in_transaction_time double precision,
  deadlocks                bigint,
  active                   int,
  active_time              double precision,
  longest_query_secs       double precision,
  xact_commit              bigint,
  xact_rollback            bigint,
  blks_hit                 bigint,
  blks_read                bigint,
  temp_bytes               bigint,
  own_statements           int,
  stats_reset              timestamptz,
  replication_lag_secs     double precision,
  wal_bytes                numeric,
  xid_age                  bigint,
  xmin_age                 bigint,
  size_bytes               bigint,
  PRIMARY KEY (database_id, captured_at)
);
`,

  // 006: the clock's storage.
  //
  // `sample_buckets` is the claim: whoever inserts a database's bucket first
  // writes its sessions, and everyone else skips. An empty bucket is still a
  // row, because "pgops looked and nothing was running" is a reading.
  //
  // `load_minutes` holds the mean sessions per class for the database ('d',
  // key ''), each table ('t', key '' for sessions on no table) and each
  // statement ('q'). Each is counted from the samples, none summed from
  // another: a session on three tables is in three 't' rows and one 'd' row.
  //
  // `backend_start` is text, as Postgres printed it, because the terminate
  // guard compares it as text.
  `
CREATE TABLE IF NOT EXISTS pgops.sample_buckets (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  bucket      timestamptz NOT NULL,
  hidden      boolean NOT NULL,
  truncated   boolean NOT NULL,
  PRIMARY KEY (database_id, bucket)
);
CREATE TABLE IF NOT EXISTS pgops.session_samples (
  database_id   int NOT NULL,
  bucket        timestamptz NOT NULL,
  pid           int NOT NULL,
  backend_start text NOT NULL,
  app           text,
  class         text NOT NULL,
  since         timestamptz NOT NULL,
  statement     text,
  relations     text[] NOT NULL,
  blocked_by    int,
  PRIMARY KEY (database_id, bucket, pid),
  FOREIGN KEY (database_id, bucket) REFERENCES pgops.sample_buckets ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pgops.sample_statements (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  key         text NOT NULL,
  query       text NOT NULL,
  relations   text[] NOT NULL,
  PRIMARY KEY (database_id, key)
);
CREATE TABLE IF NOT EXISTS pgops.load_minutes (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  minute      timestamptz NOT NULL,
  kind        text NOT NULL,
  key         text NOT NULL,
  class       text NOT NULL,
  sessions    real NOT NULL,
  PRIMARY KEY (database_id, minute, kind, key, class)
);
CREATE TABLE IF NOT EXISTS pgops.events (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  kind        text NOT NULL,
  relation    text NOT NULL DEFAULT '',
  PRIMARY KEY (database_id, at, kind, relation)
);
`,

  // 007: the catalog as the capture last read it, and its hours.
  //
  // `captures` is one row per captured read: when it was read, whether the
  // read worked, how many rows the catalog held before the cap, and the
  // statistics reset its counters run from. `captured` is that read's rows,
  // replaced whole by each capture: the current catalog, not a history. A row
  // is the check's own, as jsonb, so a field added to a read needs no
  // migration.
  //
  // The history is the two hourly tables. `table_hours` holds what was written
  // and read in the hour, differenced by the capture from the cumulative
  // counters, and the newest gauges. `index_hours` holds scans, and only for an
  // index that was scanned: no row is no scan.
  `
CREATE TABLE IF NOT EXISTS pgops.captures (
  database_id    int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  read           text NOT NULL,
  captured_at    timestamptz NOT NULL,
  ok             boolean NOT NULL,
  message        text,
  total          int NOT NULL,
  stats_reset    timestamptz,
  freeze_max_age double precision,
  PRIMARY KEY (database_id, read)
);
CREATE TABLE IF NOT EXISTS pgops.captured (
  database_id int NOT NULL,
  read        text NOT NULL,
  name        text NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (database_id, read, name),
  FOREIGN KEY (database_id, read) REFERENCES pgops.captures ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pgops.table_hours (
  database_id    int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  hour           timestamptz NOT NULL,
  relation       text NOT NULL,
  inserted       bigint NOT NULL,
  updated        bigint NOT NULL,
  deleted        bigint NOT NULL,
  index_rows     bigint NOT NULL,
  scan_rows      bigint NOT NULL,
  live_rows      bigint NOT NULL,
  dead_rows      bigint NOT NULL,
  vacuum_trigger double precision NOT NULL,
  PRIMARY KEY (database_id, relation, hour)
);
CREATE TABLE IF NOT EXISTS pgops.index_hours (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  hour        timestamptz NOT NULL,
  index_name  text NOT NULL,
  scans       bigint NOT NULL,
  PRIMARY KEY (database_id, index_name, hour)
);
`,

  // 008: the hygiene cache goes.
  //
  // It held a level and a note per check. The catalog is stored whole now
  // (migration 007), and what a row is flagged with is worked out where it is
  // shown. Migration 003 still creates the table on a store built from
  // nothing, because migrations are forward-only and numbered; this drops it.
  `
DROP TABLE IF EXISTS pgops.check_results;
`,

  // 009: a statement is stored as its shape.
  //
  // Until this version a live statement's text was stored as pg_stat_activity
  // printed it, literals and all: an email, an account number, a token in a
  // `SET`, kept for as long as the samples. From now the sampler stores the
  // shape, every literal a placeholder. The texts already stored are deleted
  // rather than kept: a past sample whose text is gone shows its statement
  // without text until a session runs it again, which is the cost of not
  // keeping what was never meant to be stored.
  `
DELETE FROM pgops.sample_statements;
`,

  // 010: replication lag in bytes beside the seconds. Seconds say how stale a
  // standby is; bytes say how much it has still to replay, which is what tells
  // a standby that is catching up from one that has stopped. Numeric, as
  // `pg_wal_lsn_diff` returns it.
  `
ALTER TABLE pgops.health_stats ADD COLUMN IF NOT EXISTS replication_lag_bytes numeric;
`,

  // 011: the health row keeps what is drawn.
  //
  // The samples are the one session read: every 15 seconds, per session, by
  // class. The per-minute session counts, the lock wait and the longest query
  // the health row carried beside them said the same thing worse, and the
  // other pg_stat_database counters had no page. What stays is what Server and
  // the findings draw: the connection counts, deadlocks, commits and
  // rollbacks, the lag, WAL, transaction ID age and size.
  `
ALTER TABLE pgops.health_stats
  DROP COLUMN IF EXISTS blocked,
  DROP COLUMN IF EXISTS longest_wait_secs,
  DROP COLUMN IF EXISTS idle_in_txn,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS longest_query_secs,
  DROP COLUMN IF EXISTS own_statements,
  DROP COLUMN IF EXISTS sessions,
  DROP COLUMN IF EXISTS sessions_abandoned,
  DROP COLUMN IF EXISTS sessions_fatal,
  DROP COLUMN IF EXISTS sessions_killed,
  DROP COLUMN IF EXISTS idle_in_transaction_time,
  DROP COLUMN IF EXISTS active_time,
  DROP COLUMN IF EXISTS blks_hit,
  DROP COLUMN IF EXISTS blks_read,
  DROP COLUMN IF EXISTS temp_bytes;
`,
];

/** The version this build knows how to produce. */
export const CURRENT_VERSION = MIGRATIONS.length;

/**
 * Bring `store` to CURRENT_VERSION and return the version now in force.
 *
 * Held under a session advisory lock so replicas booting together migrate
 * once. Each migration and its version bump are one transaction.
 */
export async function migrate(store: Pool): Promise<number> {
  return withAdvisoryLock(store, MIGRATION_LOCK_KEY, async (client) => {
    // The version table is created by migration 001, so the first run has
    // none. `to_regclass` answers without throwing.
    const { rows: probe } = await client.query<{ present: string | null }>(
      `SELECT to_regclass('pgops.schema_version')::text AS present`,
    );
    let current = 0;
    if (probe[0]!.present !== null) {
      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM pgops.schema_version',
      );
      current = rows[0]?.version ?? 0;
    }

    for (let v = current; v < MIGRATIONS.length; v += 1) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v]!);
        await client.query(
          `INSERT INTO pgops.schema_version (version) VALUES ($1)
             ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`,
          [v + 1],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    // The store may have been migrated by a newer pgops (a rollback, or a
    // rolling deploy). An older build is not refused, because throwing would
    // turn all of its history off. Not every migration is additive, though:
    // 008 drops pgops.check_results, so a build from before it loses its
    // hygiene cache. It is logged instead.
    if (current > MIGRATIONS.length) {
      console.error(
        'pgops: store schema is at version %d but this build knows %d — '
        + 'it was migrated by a newer pgops. Some history may not work; finish the '
        + 'rollback or roll forward.',
        current, MIGRATIONS.length,
      );
    }
    return Math.max(current, MIGRATIONS.length);
  });
}
