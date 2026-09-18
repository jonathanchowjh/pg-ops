/**
 * Migration 002 — the index the foreign key and the orphan sweep both need.
 *
 * `pgops.query_stats` shipped with two indexes, and neither LEADS with
 * `query_id`: the primary key is (database_id, query_id, captured_at) and
 * `query_stats_captured_at_idx` is (database_id, captured_at DESC). Two things
 * need `query_id` on its own and so had nothing to use:
 *
 *  - `query_stats.query_id REFERENCES pgops.queries(id) ON DELETE CASCADE`.
 *    Postgres has to find the referencing rows for every `pgops.queries` row
 *    deleted, and with no index that is one SEQUENTIAL SCAN PER DELETED ROW.
 *  - `prune`'s third statement, the orphan sweep over `pgops.queries`, whose
 *    `NOT EXISTS` becomes a hash anti-join over the whole of `query_stats`.
 *
 * Measured on postgres:17 with 3,000 shapes, 290,000 snapshots and 100
 * orphans to remove: the anti-join read 3,296 buffers and the FK trigger
 * alone took 1,297ms for those 100 rows. `capture.ts` documents the shape of
 * a real store as 5,000 shapes at a five-minute cadence — with the 14-day
 * retention that is roughly 20M rows, about seventy times this fixture — and
 * `prune` runs inside the SAME transaction as the capture's inserts, by
 * design, every five minutes, holding the store's write path open for it.
 *
 * A separate migration rather than an extra line in 001, because 001 only
 * ever runs on a store below version 1: adding it there would fix new stores
 * and leave every existing one exactly as slow. Forward-only means forward.
 *
 * Plain `CREATE INDEX`, not CONCURRENTLY: `migrate` runs each migration in a
 * transaction and CONCURRENTLY cannot run in one. The ACCESS EXCLUSIVE lock
 * this takes blocks capture on that store for the duration, once, at boot —
 * and this is pgops's own schema, never a monitored database.
 */
export const SQL = `
CREATE INDEX IF NOT EXISTS query_stats_query_id_idx
  ON pgops.query_stats (query_id);
`;
