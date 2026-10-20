/**
 * Migration 010 — replication lag in bytes beside the seconds.
 *
 * Seconds say how stale a standby is; bytes say how much it has still to
 * replay, which is what tells a standby that is catching up from one that
 * has stopped. Numeric, as `pg_wal_lsn_diff` returns it.
 */
export const SQL = `
ALTER TABLE pgops.health_stats ADD COLUMN IF NOT EXISTS replication_lag_bytes numeric;
`;
