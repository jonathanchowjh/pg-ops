import type { PoolClient, Pool } from 'pg';
import type { CounterPoint } from '../series/query-stats.js';

export interface StoredShape {
  queryid: string;
  query: string;
  points: CounterPoint[];
}

export interface ReadOpts {
  /**
   * Keep only the N most recent capture timestamps in the window.
   *
   * I2 (final review): the queries page needs exactly two — enough for one
   * interval — and spec §5.1 says its store read is "one indexed lookup per
   * render and it must stay that way". Unbounded, a 5,000-shape database at a
   * five-minute cadence returned ~25,000 rows each dragging ~1 kB of query
   * text, every 5 seconds, per open tab. That is the console becoming the
   * reason a database struggles, on the page whose whole point is that it
   * must not be.
   */
  maxSnapshots?: number;
  /**
   * Keep only these shapes. The queries page renders ~100 rows and needs
   * deltas for those; reading every shape in the database to display 100 is
   * work nobody looks at.
   */
  queryids?: string[];
}

/**
 * Stored snapshots for one database in one window, grouped by shape.
 *
 * Ordered by captured_at so `deltas` receives points in order; it sorts again
 * defensively, because a series that silently reversed would produce negative
 * intervals that read as discontinuities and vanish.
 */
export async function readQueryStats(
  store: Pool | PoolClient,
  databaseName: string,
  from: Date,
  to: Date,
  opts: ReadOpts = {},
): Promise<StoredShape[]> {
  // Built as a list of `$n` fragments, never interpolated values — the same
  // rule store/write.ts follows.
  const values: unknown[] = [databaseName, from, to];
  let snapshotFilter = '';
  if (opts.maxSnapshots !== undefined) {
    values.push(opts.maxSnapshots);
    snapshotFilter = `
      AND s.captured_at IN (
        SELECT s2.captured_at
          FROM pgops.query_stats s2
         WHERE s2.database_id = d.id AND s2.captured_at >= $2 AND s2.captured_at <= $3
         GROUP BY s2.captured_at
         ORDER BY s2.captured_at DESC
         LIMIT $${values.length})`;
  }
  let shapeFilter = '';
  if (opts.queryids !== undefined) {
    if (opts.queryids.length === 0) return [];
    values.push(opts.queryids);
    shapeFilter = `\n      AND q.queryid = ANY($${values.length}::bigint[])`;
  }

  const { rows } = await store.query<Row>(
    `SELECT q.queryid::text          AS queryid,
            q.query                  AS query,
            s.captured_at            AS captured_at,
            s.calls::text            AS calls,
            s.total_exec_time        AS total_exec_time,
            s.rows::text             AS rows,
            s.shared_blks_hit::text  AS shared_blks_hit,
            s.shared_blks_read::text AS shared_blks_read,
            s.stats_reset            AS stats_reset
       FROM pgops.query_stats s
       JOIN pgops.queries   q ON q.id = s.query_id
       JOIN pgops.databases d ON d.id = s.database_id
      WHERE d.name = $1 AND s.captured_at >= $2 AND s.captured_at <= $3${snapshotFilter}${shapeFilter}
      ORDER BY q.queryid, s.captured_at`,
    values,
  );

  const byShape = new Map<string, StoredShape>();
  for (const r of rows) {
    let shape = byShape.get(r.queryid);
    if (!shape) {
      shape = { queryid: r.queryid, query: r.query, points: [] };
      byShape.set(r.queryid, shape);
    }
    shape.points.push({
      capturedAt: r.captured_at,
      calls: Number(r.calls),
      totalExecTime: r.total_exec_time,
      rows: Number(r.rows),
      sharedBlksHit: Number(r.shared_blks_hit),
      sharedBlksRead: Number(r.shared_blks_read),
      statsReset: r.stats_reset,
    });
  }
  return [...byShape.values()];
}

interface Row {
  queryid: string; query: string; captured_at: Date; calls: string;
  total_exec_time: number; rows: string;
  shared_blks_hit: string; shared_blks_read: string; stats_reset: Date | null;
}

export interface StoredGrowth {
  relation: string;
  firstBytes: number;
  lastBytes: number;
  firstAt: Date;
  lastAt: Date;
  /** Captures in the window. 1 means there is no interval to measure. */
  points: number;
}

interface GrowthRow {
  relation: string;
  /** bigint -> string, per this package's convention. */
  first_bytes: string;
  last_bytes: string;
  first_at: Date;
  last_at: Date;
  points: string;
}

/**
 * #40, and the divergence from pgHero is deliberate.
 *
 * `space_growth` takes the first captured size in the window and subtracts it
 * from the relation's CURRENT, LIVE size — it re-runs `relation_sizes` against
 * the monitored database to get the second endpoint. That mixes a stored
 * reading with a live one: up to one capture interval of change is silently
 * attributed to the whole window, and the number moves every time the page is
 * re-rendered, so two operators looking at the same "7-day growth" see
 * different figures. Both endpoints here come from the store, and `lastAt`
 * travels with them so the surface can say how fresh the window is.
 *
 * One pass with `min`/`max` over `captured_at`, not two `DISTINCT ON`
 * subqueries: `(database_id, relation, captured_at)` is the primary key, so
 * this is an index scan per relation either way, and one aggregate is one
 * plan to read.
 */
export async function readSpaceGrowth(
  store: Pool | PoolClient,
  databaseName: string,
  from: Date,
  to: Date,
): Promise<StoredGrowth[]> {
  const { rows } = await store.query<GrowthRow>(
    `WITH bounds AS (
       SELECT s.relation,
              min(s.captured_at) AS first_at,
              max(s.captured_at) AS last_at,
              count(*)           AS points
         FROM pgops.space_stats s
         JOIN pgops.databases d ON d.id = s.database_id
        WHERE d.name = $1 AND s.captured_at >= $2 AND s.captured_at <= $3
        GROUP BY s.relation
     )
     SELECT b.relation,
            f.size_bytes::text AS first_bytes,
            l.size_bytes::text AS last_bytes,
            b.first_at,
            b.last_at,
            b.points::text     AS points
       FROM bounds b
       JOIN pgops.databases d ON d.name = $1
       JOIN pgops.space_stats f
         ON f.database_id = d.id AND f.relation = b.relation AND f.captured_at = b.first_at
       JOIN pgops.space_stats l
         ON l.database_id = d.id AND l.relation = b.relation AND l.captured_at = b.last_at
      ORDER BY (l.size_bytes - f.size_bytes) DESC, b.relation`,
    [databaseName, from, to],
  );

  return rows.map((r) => ({
    relation: r.relation,
    firstBytes: Number(r.first_bytes),
    lastBytes: Number(r.last_bytes),
    firstAt: r.first_at,
    lastAt: r.last_at,
    points: Number(r.points),
  }));
}

export interface StoredSize { capturedAt: Date; sizeBytes: number }

interface SizeRow { captured_at: Date; size_bytes: string }

/**
 * #41. One relation's captured sizes, oldest first.
 *
 * `maxPoints` keeps the most RECENT N and then re-orders ascending, which is
 * why the subquery exists: thirty days at the five-minute capture cadence is
 * 8,640 rows for one relation (§5.1), and a chart truncated from the wrong end
 * would show the history and hide the present. `ORDER BY ... DESC LIMIT n`
 * inside, ascending outside.
 */
export async function readRelationSpace(
  store: Pool | PoolClient,
  databaseName: string,
  relation: string,
  from: Date,
  to: Date,
  opts: { maxPoints?: number } = {},
): Promise<StoredSize[]> {
  const values: unknown[] = [databaseName, relation, from, to];
  let bound = '';
  if (opts.maxPoints !== undefined) {
    values.push(opts.maxPoints);
    bound = `ORDER BY s.captured_at DESC LIMIT $${values.length}`;
  }
  const { rows } = await store.query<SizeRow>(
    `SELECT p.captured_at, p.size_bytes::text AS size_bytes
       FROM (
         SELECT s.captured_at, s.size_bytes
           FROM pgops.space_stats s
           JOIN pgops.databases d ON d.id = s.database_id
          WHERE d.name = $1 AND s.relation = $2
            AND s.captured_at >= $3 AND s.captured_at <= $4
          ${bound}
       ) p
      ORDER BY p.captured_at ASC`,
    values,
  );

  return rows.map((r) => ({ capturedAt: r.captured_at, sizeBytes: Number(r.size_bytes) }));
}
