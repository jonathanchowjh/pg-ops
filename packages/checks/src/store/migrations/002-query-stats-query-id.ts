/**
 * Migration 002 — an index leading with `query_id`.
 *
 * Neither existing index on `pgops.query_stats` leads with `query_id`, and
 * two things need it: the `ON DELETE CASCADE` foreign key to `pgops.queries`,
 * which otherwise scans sequentially per deleted row, and `prune`'s orphan
 * sweep, whose `NOT EXISTS` otherwise anti-joins the whole table.
 *
 * Plain `CREATE INDEX`, not CONCURRENTLY: `migrate` runs each migration in a
 * transaction and CONCURRENTLY cannot run in one. The lock blocks capture on
 * the store once, at boot.
 */
export const SQL = `
CREATE INDEX IF NOT EXISTS query_stats_query_id_idx
  ON pgops.query_stats (query_id);
`;
