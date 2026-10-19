/**
 * Migration 004 — the total load of one capture interval, one row per capture.
 *
 * Written at capture rather than summed at read time: a day's load spans
 * every shape and every capture in the window (5,000 shapes × 288 captures
 * is 1.4 million rows to difference), on a page that polls every five
 * seconds.
 *
 * `total_exec_time` and `calls` are the interval's, not cumulative counters.
 * `captureOnce` applies the discontinuity rule (series/query-stats.ts) per
 * shape before the sum. A capture where no shape yields an interval,
 * including a database's first, writes no row.
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS pgops.query_load (
  database_id     int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  total_exec_time double precision NOT NULL,
  calls           bigint NOT NULL,
  PRIMARY KEY (database_id, captured_at)
);
`;
