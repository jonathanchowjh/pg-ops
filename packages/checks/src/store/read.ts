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
