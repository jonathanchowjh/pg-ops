import type { PoolClient } from 'pg';

export interface Retention { queryStatsDays: number; spaceStatsDays: number }

/**
 * pgHero's own defaults. Query stats are dense and short-lived interest;
 * space grows slowly and the interesting window is a quarter.
 */
export const RETENTION: Retention = { queryStatsDays: 14, spaceStatsDays: 90 };

/**
 * Rows per statement, for every batched write here.
 *
 * The wire protocol caps one Bind at 65,535 parameters — 9 per row for
 * query_stats, so 7,281 rows. I3 (final review): unchunked, an operator who
 * raised `pg_stat_statements.max` to 10,000 (documented tuning, and something
 * pgHero itself suggests) got a rejected Bind, a rolled-back transaction, one
 * stderr line nobody reads, and NO snapshot ever stored again — while
 * capture.ts's docblock promises "every top-level shape, unbounded".
 */
const CHUNK_ROWS = 1_000;

export interface QueryStatsSnapshot {
  databaseId: number;
  queryId: number;
  capturedAt: Date;
  calls: number;
  totalExecTime: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  statsReset: Date | null;
}

export interface SpaceSnapshot {
  databaseId: number;
  relation: string;
  capturedAt: Date;
  sizeBytes: number;
}

export async function upsertDatabase(client: PoolClient, name: string): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO pgops.databases (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    [name],
  );
  return rows[0]!.id;
}

/**
 * Upsert every shape in one round trip and return queryid -> id.
 *
 * `queryid` is passed and bound as TEXT, then cast in SQL: it is a 64-bit
 * hash, and JavaScript's number cannot hold every 64-bit value exactly — the
 * same rule query-stats.ts already follows. Identity only; never arithmetic.
 *
 * This used to be one statement PER SHAPE, awaited in a loop, which made the
 * multi-row INSERT below pointless: a 5,000-shape database still issued ~5,000
 * sequential round trips per capture, inside one open store transaction that
 * also holds the pruning DELETEs. `unnest` over two arrays sends the whole set
 * as two bind parameters, and `RETURNING` hands back the ids the snapshot rows
 * need — so the saving the comment below claims is now actually delivered.
 *
 * Inputs are deduplicated by queryid first. `ON CONFLICT DO UPDATE` raises
 * "cannot affect row a second time" if one statement touches the same row
 * twice, and capture already groups by queryid — this makes the guarantee
 * local to the function that depends on it rather than an assumption about
 * its caller.
 */
export async function upsertQueries(
  client: PoolClient,
  databaseId: number,
  shapes: readonly { queryid: string; query: string }[],
): Promise<Map<string, number>> {
  const byQueryid = new Map<string, string>();
  for (const s of shapes) if (!byQueryid.has(s.queryid)) byQueryid.set(s.queryid, s.query);

  const out = new Map<string, number>();
  const entries = [...byQueryid];
  for (let i = 0; i < entries.length; i += CHUNK_ROWS) {
    const chunk = entries.slice(i, i + CHUNK_ROWS);
    const { rows } = await client.query<{ id: number; queryid: string }>(
      `INSERT INTO pgops.queries (database_id, queryid, query)
       SELECT $1, u.queryid::bigint, u.query
         FROM unnest($2::text[], $3::text[]) AS u(queryid, query)
       ON CONFLICT (database_id, queryid)
       DO UPDATE SET last_seen = now(), query = EXCLUDED.query
       RETURNING id, queryid::text AS queryid`,
      [databaseId, chunk.map(([q]) => q), chunk.map(([, t]) => t)],
    );
    for (const r of rows) out.set(r.queryid, r.id);
  }
  return out;
}

/**
 * Multi-row INSERTs rather than one per shape: a 5,000-shape database would
 * otherwise issue 5,000 round trips every five minutes against a database
 * pgops is supposed to be leaving alone.
 *
 * ON CONFLICT DO NOTHING because the primary key is (database_id, query_id,
 * captured_at) and a retried tick must not fail on a snapshot already stored.
 */
export async function insertQueryStats(
  client: PoolClient,
  snapshots: QueryStatsSnapshot[],
): Promise<void> {
  for (let i = 0; i < snapshots.length; i += CHUNK_ROWS) {
    await insertQueryStatsChunk(client, snapshots.slice(i, i + CHUNK_ROWS));
  }
}

async function insertQueryStatsChunk(
  client: PoolClient,
  snapshots: QueryStatsSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return;
  const values: unknown[] = [];
  const tuples = snapshots.map((s, i) => {
    const b = i * 9;
    values.push(s.databaseId, s.queryId, s.capturedAt, s.calls, s.totalExecTime,
      s.rows, s.sharedBlksHit, s.sharedBlksRead, s.statsReset);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
  });
  await client.query(
    `INSERT INTO pgops.query_stats
       (database_id, query_id, captured_at, calls, total_exec_time, rows,
        shared_blks_hit, shared_blks_read, stats_reset)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

export async function insertSpaceStats(
  client: PoolClient,
  snapshots: SpaceSnapshot[],
): Promise<void> {
  for (let i = 0; i < snapshots.length; i += CHUNK_ROWS) {
    await insertSpaceStatsChunk(client, snapshots.slice(i, i + CHUNK_ROWS));
  }
}

async function insertSpaceStatsChunk(
  client: PoolClient,
  snapshots: SpaceSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return;
  const values: unknown[] = [];
  const tuples = snapshots.map((s, i) => {
    const b = i * 4;
    values.push(s.databaseId, s.relation, s.capturedAt, s.sizeBytes);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
  });
  await client.query(
    `INSERT INTO pgops.space_stats (database_id, relation, captured_at, size_bytes)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

/**
 * Pruning is called by `captureOnce` inside the SAME transaction as the
 * inserts, so retention cannot drift from capture — a separate schedule is a
 * second thing to get wrong, and the failure mode (a store that grows without
 * bound) is silent until the disk fills.
 *
 * THREE tables, not two. `pgops.queries` holds one row per distinct shape ever
 * seen and nothing ever deleted from it, so the claim above was true of only
 * two of the three growing tables: a database with churning generated SQL
 * accumulated normalised text forever. Orphans were invisible because every
 * read joins through `query_stats`, which is exactly what made it silent.
 * Deleted last, so the snapshot delete above has already removed the rows that
 * make a shape an orphan.
 */
export async function prune(
  client: PoolClient,
  databaseId: number,
  retention: Retention,
): Promise<void> {
  await client.query(
    `DELETE FROM pgops.query_stats
       WHERE database_id = $1 AND captured_at < now() - ($2 || ' days')::interval`,
    [databaseId, String(retention.queryStatsDays)],
  );
  await client.query(
    `DELETE FROM pgops.space_stats
       WHERE database_id = $1 AND captured_at < now() - ($2 || ' days')::interval`,
    [databaseId, String(retention.spaceStatsDays)],
  );
  await client.query(
    `DELETE FROM pgops.queries q
       WHERE q.database_id = $1
         AND NOT EXISTS (SELECT 1 FROM pgops.query_stats s WHERE s.query_id = q.id)`,
    [databaseId],
  );
}
