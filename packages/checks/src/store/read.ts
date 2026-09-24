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

/**
 * One check's cached outcome, as the console reads it back.
 *
 * `capturedAt` is what the surface renders as an age. It is per row, not per
 * pass: a check that timed out on the last pass still carries the instant of
 * the pass that wrote it, so an area whose members disagree about their age
 * reports the OLDEST — which is the honest one.
 */
export interface StoredTotal {
  capturedAt: Date;
  sizeBytes: number;
  /** How many relations that total was summed across. */
  relations: number;
}

/**
 * The whole database's captured size over a window, one point per capture.
 *
 * SUMMED IN POSTGRES, not in the console. `space_stats` holds one row per
 * relation per capture, so thirty days of a 400-relation database is 3.4
 * million rows — the same arithmetic that made `query_load` a table written
 * at capture time (migration 004). The difference is that this one collapses
 * to one row per capture inside a single indexed aggregate over
 * `space_stats_captured_at_idx`, on a page that does not poll, so it needs
 * no fourth table to stay cheap.
 *
 * `relations` RIDES ALONG because the sum alone can lie. It is the total of
 * what pgops MEASURED, and a capture that could not read every relation
 * sums fewer of them — which would draw as the database shrinking. The count
 * is what lets the surface tell a dropped table (real) from a capture that
 * saw less of the database than its neighbours (not real), and it is why
 * this returns two numbers rather than the one the chart plots.
 */
export async function readDatabaseSpace(
  store: Pool | PoolClient,
  databaseName: string,
  from: Date,
  to: Date,
): Promise<StoredTotal[]> {
  const { rows } = await store.query<{
    captured_at: Date; size_bytes: string; relations: string;
  }>(
    `SELECT s.captured_at,
            sum(s.size_bytes)::text AS size_bytes,
            count(*)::text          AS relations
       FROM pgops.space_stats s
       JOIN pgops.databases d ON d.id = s.database_id
      WHERE d.name = $1 AND s.captured_at >= $2 AND s.captured_at <= $3
      GROUP BY s.captured_at
      ORDER BY s.captured_at ASC`,
    [databaseName, from, to],
  );
  return rows.map((r) => ({
    capturedAt: r.captured_at,
    sizeBytes: Number(r.size_bytes),
    relations: Number(r.relations),
  }));
}

export interface StoredCheckResult {
  checkId: string;
  ok: boolean;
  level: string | null;
  note: string | null;
  message: string | null;
  capturedAt: Date;
}

/**
 * Every cached hygiene result for one database.
 *
 * A database the store has never seen returns `[]` rather than throwing: a
 * console pointed at a newly configured database has an empty cache for its
 * first five minutes, which is an age the surface reports as `unknown`, not
 * an error to render.
 *
 * Accepts a `Pool` or a `PoolClient` for the same reason `readQueryStats`
 * does — the scheduler calls it on a checked-out client inside its own pass,
 * a page calls it on the pool.
 */
export async function readCheckResults(
  store: Pool | PoolClient,
  databaseName: string,
): Promise<StoredCheckResult[]> {
  const { rows } = await store.query<{
    check_id: string; ok: boolean; level: string | null;
    note: string | null; message: string | null; captured_at: Date;
  }>(
    `SELECT r.check_id, r.ok, r.level, r.note, r.message, r.captured_at
       FROM pgops.check_results r
       JOIN pgops.databases d ON d.id = r.database_id
      WHERE d.name = $1
      ORDER BY r.check_id`,
    [databaseName],
  );
  return rows.map((r) => ({
    checkId: r.check_id,
    ok: r.ok,
    level: r.level,
    note: r.note,
    message: r.message,
    capturedAt: r.captured_at,
  }));
}

/**
 * The most recent snapshot strictly before `before`, keyed by `query_id`.
 *
 * Read by `captureOnce` on the client it already holds, to difference the
 * snapshot it has just taken into one `query_load` row. It returns the
 * previous CAPTURE — every shape at one instant — rather than each shape's
 * own last sighting, because an interval is only an interval if both ends
 * were measured at the same moment. A shape absent from this map is one
 * pgops had not seen at that instant, and it contributes nothing.
 *
 * `query_stats_captured_at_idx` is `(database_id, captured_at DESC)`, so both
 * the `max` and the rows it selects are index scans.
 */
export async function readLastSnapshot(
  store: Pool | PoolClient,
  databaseId: number,
  before: Date,
): Promise<Map<number, CounterPoint>> {
  const { rows } = await store.query<SnapshotRow>(
    `SELECT s.query_id, s.captured_at, s.calls::text AS calls,
            s.total_exec_time, s.rows::text AS rows,
            s.shared_blks_hit::text AS shared_blks_hit,
            s.shared_blks_read::text AS shared_blks_read,
            s.stats_reset
       FROM pgops.query_stats s
      WHERE s.database_id = $1
        AND s.captured_at = (SELECT max(p.captured_at)
                               FROM pgops.query_stats p
                              WHERE p.database_id = $1 AND p.captured_at < $2)`,
    [databaseId, before],
  );
  return new Map(rows.map((r) => [r.query_id, {
    capturedAt: r.captured_at,
    calls: Number(r.calls),
    totalExecTime: r.total_exec_time,
    rows: Number(r.rows),
    sharedBlksHit: Number(r.shared_blks_hit),
    sharedBlksRead: Number(r.shared_blks_read),
    statsReset: r.stats_reset,
  }]));
}

interface SnapshotRow {
  query_id: number; captured_at: Date; calls: string;
  total_exec_time: number; rows: string;
  shared_blks_hit: string; shared_blks_read: string; stats_reset: Date | null;
}

/** One capture interval's total work across every shape. */
/**
 * One shape's statement text, by `queryid`.
 *
 * The query detail page identified its subject as a 19-digit integer and
 * nothing else — a page about a statement that never showed the statement.
 * `queryShapeHistory` deliberately returns `Interval[]` ("the caller already
 * knows which shape it asked about"), and that is true of the ID and false of
 * the text, so the text is fetched here instead of widening the series.
 *
 * ONE INDEXED LOOKUP: `pgops.queries` is `UNIQUE (database_id, queryid)`.
 * The text was redacted before it was written (see migration 001), so what
 * comes back is already safe to render.
 *
 * `null` when the store has never seen the shape — which is an ordinary
 * state, not an error: the operator may have followed a link to a statement
 * that has since aged out of the retention window.
 */
export async function readQueryText(
  store: Pool | PoolClient,
  databaseName: string,
  queryid: string,
): Promise<string | null> {
  const { rows } = await store.query<{ query: string }>(
    `SELECT q.query
       FROM pgops.queries q
       JOIN pgops.databases d ON d.id = q.database_id
      WHERE d.name = $1 AND q.queryid = $2`,
    [databaseName, queryid],
  );
  return rows[0]?.query ?? null;
}

export interface StoredLoad { capturedAt: Date; totalExecTime: number; calls: number }

/**
 * The whole database's load over a window, one point per capture, oldest
 * first.
 *
 * No `maxPoints`. Every other series read here is bounded because its row
 * count is shapes × captures; this table holds one row per capture, so a
 * 24-hour window at the five-minute cadence is 288 rows and the bound would
 * be ceremony. A caller asking for a wider window than a chart can draw is a
 * question for the caller.
 *
 * Rows are already differenced intervals — see migration 004. A capture that
 * recorded no measurable interval simply has no row, and the chart draws the
 * gap rather than a zero.
 */
export async function readQueryLoad(
  store: Pool | PoolClient,
  databaseName: string,
  from: Date,
  to: Date,
): Promise<StoredLoad[]> {
  const { rows } = await store.query<{
    captured_at: Date; total_exec_time: number; calls: string;
  }>(
    `SELECT l.captured_at, l.total_exec_time, l.calls::text AS calls
       FROM pgops.query_load l
       JOIN pgops.databases d ON d.id = l.database_id
      WHERE d.name = $1 AND l.captured_at >= $2 AND l.captured_at <= $3
      ORDER BY l.captured_at ASC`,
    [databaseName, from, to],
  );
  return rows.map((r) => ({
    capturedAt: r.captured_at,
    totalExecTime: r.total_exec_time,
    calls: Number(r.calls),
  }));
}
