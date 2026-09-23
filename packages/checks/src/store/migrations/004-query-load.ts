/**
 * Migration 004 — the total load of one capture interval, one row per capture.
 *
 * WHY THIS IS WRITTEN RATHER THAN SUMMED AT READ TIME. Everything else on
 * the Queries page is a per-shape question, and `query_stats` answers those
 * from at most two snapshots (read.ts's `maxSnapshots`). "How busy has this
 * database been for a day" is the one question that spans every shape and
 * every capture in the window: 5,000 shapes × 288 captures is 1.4 million
 * rows to difference and sum, on a page that polls every five seconds against
 * a database this console promises not to burden. The same arithmetic done
 * once, inside the capture that already holds both snapshots, leaves the
 * chart reading 288 rows.
 *
 * `total_exec_time` and `calls` are the INTERVAL's, not a cumulative counter:
 * the differencing and the discontinuity rule (series/query-stats.ts) are
 * applied per shape in `captureOnce` before the sum, so a shape whose
 * interval spanned a `pg_stat_statements_reset()` or an LRU eviction
 * contributes nothing rather than a spike. A capture where NO shape survived
 * that rule writes no row at all, which leaves the total a gap exactly where
 * the per-shape series has one.
 *
 * No row for the first capture of a database, for the same reason: one
 * cumulative snapshot is not an interval, and a zero would read as an idle
 * five minutes rather than as the beginning of the history.
 *
 * No index beyond the primary key. `(database_id, captured_at)` is the only
 * read there is — one window, ascending — and it is one row per capture, so
 * a fortnight of the five-minute cadence is ~4,000 rows per database.
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
