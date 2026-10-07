/**
 * One wide row per database per minute.
 *
 * WIDE, not one row per metric: the page reads every metric for a window at
 * once, and a narrow table would be 27 times the rows for the same read.
 *
 * EVERY metric column is nullable and none has a default. Null is "pgops
 * could not look" (a role that cannot read replication state, a statement
 * that timed out); zero is "pgops looked and there were none". A default of
 * zero would turn the first into the second.
 *
 * Counters are stored RAW, exactly as Postgres reported them, and differenced
 * at read. `stats_reset` rides along so a read can tell a reset from a quiet
 * minute. `wal_bytes` is numeric because pg_stat_wal reports it that way.
 *
 * The primary key is the only index. Every read is "these databases, this
 * time range", and retention deletes by the same two columns.
 */
export const SQL = `
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
`;
