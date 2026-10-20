/**
 * Migration 011 — the health row keeps what is drawn.
 *
 * The samples are the one session read: every 15 seconds, per session, by
 * class. The per-minute session counts, the lock wait and the longest query
 * the health row carried beside them said the same thing worse, and the
 * other pg_stat_database counters had no page. What stays is what Server
 * and the findings draw: the connection counts, deadlocks, commits and
 * rollbacks, the lag, WAL, transaction ID age and size.
 */
export const SQL = `
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
`;
