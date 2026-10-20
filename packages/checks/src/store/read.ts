import type { PoolClient, Pool } from 'pg';
import type { CounterPoint } from '../series/query-stats.js';
import type { SessionClass } from '../checks/sessions.js';
import { BUCKET_MS, type EventKind, type LoadCell, type Sample, type StatementInfo, type StoredEvent } from '../samples.js';
import { BUCKET, type CapturedRead } from './write.js';

export interface StoredShape {
  queryid: string;
  query: string;
  points: CounterPoint[];
}

/** The counter columns of `pgops.query_stats`, bigints as text. */
interface CounterRow {
  captured_at: Date; calls: string; total_exec_time: number; rows: string;
  shared_blks_hit: string; shared_blks_read: string; stats_reset: Date | null;
}
function counterPoint(r: CounterRow): CounterPoint {
  return {
    capturedAt: r.captured_at,
    calls: Number(r.calls),
    totalExecTime: r.total_exec_time,
    rows: Number(r.rows),
    sharedBlksHit: Number(r.shared_blks_hit),
    sharedBlksRead: Number(r.shared_blks_read),
    statsReset: r.stats_reset,
  };
}

export interface StoredSize { capturedAt: Date; sizeBytes: number }

interface SizeRow { captured_at: Date; size_bytes: string }

/**
 * One relation's captured sizes, oldest first.
 *
 * `maxPoints` keeps the most recent N: the subquery takes them descending
 * and the outer query re-orders ascending.
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
 * The most recent snapshot strictly before `before`, keyed by `query_id`.
 *
 * Used by `captureOnce` to difference a new snapshot into one `query_load`
 * row. Returns the previous capture (every shape at one instant), not each
 * shape's own last sighting, so both ends of every interval were measured at
 * the same moment.
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
  return new Map(rows.map((r) => [r.query_id, counterPoint(r)]));
}

interface SnapshotRow extends CounterRow { query_id: number }

/** A window of samples, ascending. An empty bucket is a sample with no sessions. */
export async function readSamples(store: Pool, name: string, from: Date, to: Date): Promise<Sample[]> {
  const { rows } = await store.query<{
    at: string; hidden: boolean; truncated: boolean; pid: number | null; backend_start: string; app: string | null;
    class: SessionClass; since: string; statement: string | null; relations: string[]; blocked_by: number | null;
  }>(
    `SELECT (extract(epoch FROM b.bucket) * 1000)::text AS at, b.hidden, b.truncated,
            s.pid, s.backend_start, s.app, s.class,
            (extract(epoch FROM s.since) * 1000)::text AS since,
            s.statement, s.relations, s.blocked_by
       FROM pgops.sample_buckets b
       JOIN pgops.databases d ON d.id = b.database_id
       LEFT JOIN pgops.session_samples s ON s.database_id = b.database_id AND s.bucket = b.bucket
      WHERE d.name = $1 AND b.bucket >= $2 AND b.bucket < $3
      ORDER BY b.bucket, s.pid`,
    [name, from, to],
  );
  const out: Sample[] = [];
  for (const r of rows) {
    const at = Math.round(Number(r.at));
    let last = out.at(-1);
    if (last === undefined || last.at !== at) {
      last = { at, sessions: [], hidden: r.hidden, truncated: r.truncated };
      out.push(last);
    }
    if (r.pid === null) continue;
    last.sessions.push({
      pid: r.pid, backendStart: r.backend_start, app: r.app, cls: r.class,
      since: Math.round(Number(r.since)), statement: r.statement, relations: r.relations, blockedBy: r.blocked_by,
    });
  }
  return out;
}

/**
 * The minute rollups, averaged into `columns` equal columns over the
 * window. A minute with no row counts as zero. The caller snaps the window
 * so a column is a whole number of minutes; see `gridFor` in the web layer.
 */
export async function readLoad(
  store: Pool, name: string, from: Date, to: Date, columns: number, kinds: readonly string[],
): Promise<LoadCell[]> {
  const widthSecs = (to.getTime() - from.getTime()) / 1000 / columns;
  const { rows } = await store.query<{ col: number; kind: 'd' | 't' | 'q'; key: string; cls: SessionClass; sessions: number }>(
    `SELECT LEAST($5::int - 1, floor(extract(epoch FROM m.minute - $2::timestamptz) / $4::double precision)::int) AS col,
            m.kind, m.key, m.class AS cls,
            (sum(m.sessions) * 60 / $4::double precision)::real AS sessions
       FROM pgops.load_minutes m
       JOIN pgops.databases d ON d.id = m.database_id
      WHERE d.name = $1 AND m.minute >= $2 AND m.minute < $3 AND m.kind = ANY($6)
      GROUP BY 1, m.kind, m.key, m.class`,
    [name, from, to, widthSecs, columns, kinds],
  );
  return rows;
}

/**
 * How much of each column some sample covered, 0 to 1: the buckets written
 * in it against the buckets it spans. A bucket with nobody running is
 * written, so a quiet column reads as seen and only a column nobody sampled
 * reads as unseen. The rollup alone cannot tell the two apart.
 */
export async function readCoverage(store: Pool, name: string, from: Date, to: Date, columns: number): Promise<number[]> {
  const widthSecs = (to.getTime() - from.getTime()) / 1000 / columns;
  const { rows } = await store.query<{ col: number; n: number }>(
    `SELECT LEAST($5::int - 1, floor(extract(epoch FROM b.bucket - $2::timestamptz) / $4::double precision)::int) AS col,
            count(*)::int AS n
       FROM pgops.sample_buckets b
       JOIN pgops.databases d ON d.id = b.database_id
      WHERE d.name = $1 AND b.bucket >= $2 AND b.bucket < $3
      GROUP BY 1`,
    [name, from, to, widthSecs, columns],
  );
  const out = Array.from({ length: columns }, () => 0);
  for (const r of rows) if (r.col >= 0 && r.col < columns) out[r.col] = Math.min(1, (r.n * BUCKET_MS) / 1000 / widthSecs);
  return out;
}

/**
 * One minute of the health row, as the clock reads it: levels as numbers,
 * counters as numbers to be differenced between consecutive points, and
 * `statsReset` so a counter that fell with a reset is not read as a fall.
 * Null is "pgops could not look". `at` and `statsReset` are epoch ms.
 */
export interface HealthMinute {
  at: number;
  connections: number | null;
  serverConnections: number | null;
  maxConnections: number | null;
  lagSecs: number | null;
  lagBytes: number | null;
  walBytes: number | null;
  xidAge: number | null;
  xminAge: number | null;
  deadlocks: number | null;
  commits: number | null;
  rollbacks: number | null;
  statsReset: number | null;
}

/**
 * The health rows of one window, oldest first, with the one row before
 * `from` so the first interval has a predecessor and a stretch that began
 * before the window is known to have begun before it.
 */
export async function readHealth(store: Pool | PoolClient, name: string, from: Date, to: Date): Promise<HealthMinute[]> {
  const { rows } = await store.query<HealthMinute>(
    `SELECT (extract(epoch FROM h.captured_at) * 1000)::float8 AS at,
            h.connections, h.server_connections AS "serverConnections", h.max_connections AS "maxConnections",
            h.replication_lag_secs AS "lagSecs", h.replication_lag_bytes::float8 AS "lagBytes",
            h.wal_bytes::float8 AS "walBytes", h.xid_age::float8 AS "xidAge", h.xmin_age::float8 AS "xminAge",
            h.deadlocks::float8, h.xact_commit::float8 AS commits, h.xact_rollback::float8 AS rollbacks,
            (extract(epoch FROM h.stats_reset) * 1000)::float8 AS "statsReset"
       FROM pgops.health_stats h JOIN pgops.databases d ON d.id = h.database_id
      WHERE d.name = $1
        AND h.captured_at >= coalesce((SELECT max(p.captured_at) FROM pgops.health_stats p
                                        WHERE p.database_id = d.id AND p.captured_at < $2), $2)
        AND h.captured_at < $3
      ORDER BY h.captured_at`,
    [name, from, to],
  );
  return rows;
}

/**
 * A window's events. With no `relation` it is the database's page: every
 * event but a table's own vacuums and analyzes, which a busy database has
 * several of a minute and which would bury a chain. With one, that table's
 * events and the database's own.
 */
export async function readEvents(store: Pool, name: string, from: Date, to: Date, relation?: string): Promise<StoredEvent[]> {
  const { rows } = await store.query<{ at: string; kind: EventKind; relation: string }>(
    `SELECT (extract(epoch FROM e.at) * 1000)::text AS at, e.kind, e.relation
       FROM pgops.events e JOIN pgops.databases d ON d.id = e.database_id
      WHERE d.name = $1 AND e.at >= $2 AND e.at < $3
        AND CASE WHEN $4::text IS NULL THEN NOT (e.kind IN ('vacuum', 'analyze') AND e.relation <> '')
                 ELSE e.relation IN ('', $4) END
      ORDER BY e.at, e.kind, e.relation`,
    [name, from, to, relation ?? null],
  );
  return rows.map((r) => ({ at: Math.round(Number(r.at)), kind: r.kind, relation: r.relation }));
}

export async function readStatements(
  store: Pool, name: string, keys: readonly string[],
): Promise<Map<string, StatementInfo>> {
  if (keys.length === 0) return new Map();
  const { rows } = await store.query<{ key: string; query: string; relations: string[] }>(
    `SELECT s.key, s.query, s.relations
       FROM pgops.sample_statements s JOIN pgops.databases d ON d.id = s.database_id
      WHERE d.name = $1 AND s.key = ANY($2)`,
    [name, keys],
  );
  return new Map(rows.map((r) => [r.key, { text: r.query, relations: r.relations }]));
}

export interface WindowStats {
  /** Shapes whose call count moved between the window's first and last capture: two points each, costliest first. */
  shapes: StoredShape[];
  /** Every shape's execution time between those two captures. Null when the window holds fewer than two. */
  allMs: number | null;
}

interface EndsRow {
  queryid: string; query: string;
  first_at: Date; f_calls: string; f_time: number; f_rows: string; f_hit: string; f_read: string; f_reset: Date | null;
  last_at: Date; l_calls: string; l_time: number; l_rows: string; l_hit: string; l_read: string; l_reset: Date | null;
}

/** The window's first and last capture. `$1` the database, `$2` and `$3` the window. */
const EDGE = `
  WITH d AS (SELECT id FROM pgops.databases WHERE name = $1),
       edge AS (
         SELECT min(s.captured_at) AS first_at, max(s.captured_at) AS last_at
           FROM pgops.query_stats s, d
          WHERE s.database_id = d.id AND s.captured_at >= $2 AND s.captured_at <= $3
       )`;

/**
 * Each shape's own first and last capture in a window, for the shapes that
 * ran between them. Its own, not the window's: a statement first run, or
 * last run, partway through the window still has an exact interval between
 * the captures that saw it, and a window's first capture would hide a new
 * deploy's statement for as long as the window. Two points a shape and
 * never every snapshot: a polled page reads this.
 *
 * `l.calls <> f.calls` is a filter, not arithmetic: whether the pair is an
 * interval at all is still `deltas`'s to say. A shape in one capture only is
 * absent, because a counter of unknown age is not an interval.
 *
 * `notLike` is how the web layer leaves pgops's own statements out; they
 * end with OWN_SQL_MARKER.
 */
export async function readWindowStats(
  store: Pool | PoolClient,
  databaseName: string,
  from: Date,
  to: Date,
  opts: { limit: number; notLike?: string; queryids?: readonly string[] },
): Promise<WindowStats> {
  const { rows } = await store.query<EndsRow>(
    `WITH d AS (SELECT id FROM pgops.databases WHERE name = $1),
          ends AS (
            SELECT s.query_id, min(s.captured_at) AS first_at, max(s.captured_at) AS last_at
              FROM pgops.query_stats s, d
             WHERE s.database_id = d.id AND s.captured_at >= $2 AND s.captured_at <= $3
             GROUP BY s.query_id
            HAVING min(s.captured_at) < max(s.captured_at)
          )
     SELECT q.queryid::text AS queryid, q.query,
            e.first_at, f.calls::text AS f_calls, f.total_exec_time AS f_time, f.rows::text AS f_rows,
            f.shared_blks_hit::text AS f_hit, f.shared_blks_read::text AS f_read, f.stats_reset AS f_reset,
            e.last_at, l.calls::text AS l_calls, l.total_exec_time AS l_time, l.rows::text AS l_rows,
            l.shared_blks_hit::text AS l_hit, l.shared_blks_read::text AS l_read, l.stats_reset AS l_reset
       FROM ends e
       CROSS JOIN d
       JOIN pgops.query_stats l ON l.database_id = d.id AND l.query_id = e.query_id AND l.captured_at = e.last_at
       JOIN pgops.query_stats f ON f.database_id = d.id AND f.query_id = e.query_id AND f.captured_at = e.first_at
       JOIN pgops.queries q     ON q.id = e.query_id
      WHERE l.calls <> f.calls
        AND ($4::text IS NULL OR q.query NOT LIKE $4)
        AND ($5::text[] IS NULL OR q.queryid::text = ANY($5::text[]))
      ORDER BY l.total_exec_time - f.total_exec_time DESC, q.queryid
      LIMIT $6`,
    [databaseName, from, to, opts.notLike ?? null, opts.queryids ?? null, opts.limit],
  );
  const { rows: sum } = await store.query<{ all_ms: number | null }>(
    `${EDGE}
     SELECT sum(l.total_exec_time)::float8 AS all_ms
       FROM pgops.query_load l, d, edge e
      WHERE l.database_id = d.id AND l.captured_at > e.first_at AND l.captured_at <= e.last_at`,
    [databaseName, from, to],
  );
  return {
    shapes: rows.map((r) => ({
      queryid: r.queryid,
      query: r.query,
      points: [
        counterPoint({
          captured_at: r.first_at, calls: r.f_calls, total_exec_time: r.f_time, rows: r.f_rows,
          shared_blks_hit: r.f_hit, shared_blks_read: r.f_read, stats_reset: r.f_reset,
        }),
        counterPoint({
          captured_at: r.last_at, calls: r.l_calls, total_exec_time: r.l_time, rows: r.l_rows,
          shared_blks_hit: r.l_hit, shared_blks_read: r.l_read, stats_reset: r.l_reset,
        }),
      ],
    })),
    allMs: sum[0]?.all_ms ?? null,
  };
}

export interface Captured<T> {
  rows: T[];
  /** When the rows were read. */
  at: number;
  /** False: the last read failed, and `rows` are the read before it. */
  ok: boolean;
  message: string | null;
  /** Rows the catalog held before the cap. */
  total: number;
  statsReset: number | null;
  freezeMaxAge: number | null;
}

/** One captured read as the store holds it, or null for a read never captured. */
export async function readCaptured<T>(
  store: Pool | PoolClient, name: string, read: CapturedRead,
): Promise<Captured<T> | null> {
  const { rows: head } = await store.query<{
    at: number; ok: boolean; message: string | null; total: number; stats_reset: number | null; freeze_max_age: number | null;
  }>(
    `SELECT (extract(epoch FROM k.captured_at) * 1000)::float8 AS at, k.ok, k.message, k.total,
            (extract(epoch FROM k.stats_reset) * 1000)::float8 AS stats_reset, k.freeze_max_age
       FROM pgops.captures k JOIN pgops.databases d ON d.id = k.database_id
      WHERE d.name = $1 AND k.read = $2`,
    [name, read],
  );
  const h = head[0];
  if (h === undefined) return null;
  const { rows } = await store.query<{ data: T }>(
    `SELECT c.data FROM pgops.captured c JOIN pgops.databases d ON d.id = c.database_id
      WHERE d.name = $1 AND c.read = $2`,
    [name, read],
  );
  return {
    rows: rows.map((r) => r.data),
    at: Math.round(h.at), ok: h.ok, message: h.message, total: h.total,
    statsReset: h.stats_reset === null ? null : Math.round(h.stats_reset),
    freezeMaxAge: h.freeze_max_age,
  };
}

export interface TableHour {
  /** The hour's start. */
  at: number;
  inserted: number;
  updated: number;
  deleted: number;
  /** Rows fetched by index scans, and rows read by sequential ones. */
  indexRows: number;
  scanRows: number;
  liveRows: number;
  deadRows: number;
  vacuumTrigger: number;
}

/** One table's hours across a window, oldest first. The hour the window starts in is included. */
export async function readTableHours(
  store: Pool | PoolClient, name: string, relation: string, from: Date, to: Date,
): Promise<TableHour[]> {
  const { rows } = await store.query<{
    at: number; inserted: number; updated: number; deleted: number; index_rows: number; scan_rows: number;
    live_rows: number; dead_rows: number; vacuum_trigger: number;
  }>(
    `SELECT (extract(epoch FROM h.hour) * 1000)::float8 AS at,
            h.inserted::float8 AS inserted, h.updated::float8 AS updated, h.deleted::float8 AS deleted,
            h.index_rows::float8 AS index_rows, h.scan_rows::float8 AS scan_rows,
            h.live_rows::float8 AS live_rows, h.dead_rows::float8 AS dead_rows, h.vacuum_trigger
       FROM pgops.table_hours h JOIN pgops.databases d ON d.id = h.database_id
      WHERE d.name = $1 AND h.relation = $2 AND h.hour >= date_trunc('hour', $3::timestamptz) AND h.hour < $4
      ORDER BY h.hour`,
    [name, relation, from, to],
  );
  return rows.map((r) => ({
    at: Math.round(r.at), inserted: r.inserted, updated: r.updated, deleted: r.deleted,
    indexRows: r.index_rows, scanRows: r.scan_rows, liveRows: r.live_rows, deadRows: r.dead_rows, vacuumTrigger: r.vacuum_trigger,
  }));
}

/**
 * Rows written to each table over a window: the Tables scatter's x. A table
 * with no hour in it is absent. An hour counts for the part of it inside the
 * window, against the part of it that has passed: a fifteen-minute window
 * does not count its whole hour, and the hour still running is not read as
 * if it had ended.
 */
export async function readWritten(store: Pool | PoolClient, name: string, from: Date, to: Date): Promise<Map<string, number>> {
  const { rows } = await store.query<{ relation: string; written: number }>(
    `SELECT h.relation, sum((h.inserted + h.updated + h.deleted) * GREATEST(0, extract(epoch FROM LEAST(h.hour + interval '1 hour', $3::timestamptz) - GREATEST(h.hour, $2::timestamptz)))
              / GREATEST(1, extract(epoch FROM LEAST(h.hour + interval '1 hour', now()) - h.hour)))::float8 AS written
       FROM pgops.table_hours h JOIN pgops.databases d ON d.id = h.database_id
      WHERE d.name = $1 AND h.hour >= date_trunc('hour', $2::timestamptz) AND h.hour < $3
      GROUP BY h.relation`,
    [name, from, to],
  );
  return new Map(rows.map((r) => [r.relation, r.written]));
}

/**
 * Scans of each index over a window: the Indexes scatter's x. An index not
 * scanned in it is absent. Like `readWritten`, an hour counts for the part of
 * it inside the window, against the part of it that has passed.
 */
export async function readIndexScans(store: Pool | PoolClient, name: string, from: Date, to: Date): Promise<Map<string, number>> {
  const { rows } = await store.query<{ index_name: string; scans: number }>(
    `SELECT h.index_name, sum(h.scans * GREATEST(0, extract(epoch FROM LEAST(h.hour + interval '1 hour', $3::timestamptz) - GREATEST(h.hour, $2::timestamptz)))
              / GREATEST(1, extract(epoch FROM LEAST(h.hour + interval '1 hour', now()) - h.hour)))::float8 AS scans
       FROM pgops.index_hours h JOIN pgops.databases d ON d.id = h.database_id
      WHERE d.name = $1 AND h.hour >= date_trunc('hour', $2::timestamptz) AND h.hour < $3
      GROUP BY h.index_name`,
    [name, from, to],
  );
  return new Map(rows.map((r) => [r.index_name, r.scans]));
}

/**
 * One node's mean sessions not idle for each hour of a window: a table's
 * rhythm. An hour with no load is absent. The hour the window ends in is a
 * mean over its minutes so far, or it would read low against a whole one.
 */
export async function readHourly(
  store: Pool | PoolClient, name: string, kind: 'd' | 't' | 'q', key: string, from: Date, to: Date,
): Promise<{ at: number; sessions: number }[]> {
  const { rows } = await store.query<{ at: number; sessions: number }>(
    `SELECT (extract(epoch FROM h.hour) * 1000)::float8 AS at,
            h.total / least(60, greatest(1, ceil(extract(epoch FROM $5::timestamptz - h.hour) / 60))) AS sessions
       FROM (SELECT date_trunc('hour', m.minute) AS hour, sum(m.sessions)::float8 AS total
               FROM pgops.load_minutes m JOIN pgops.databases d ON d.id = m.database_id
              WHERE d.name = $1 AND m.kind = $2 AND m.key = $3 AND m.minute >= $4 AND m.minute < $5
              GROUP BY 1) h
      ORDER BY h.hour`,
    [name, kind, key, from, to],
  );
  return rows.map((r) => ({ at: Math.round(r.at), sessions: r.sessions }));
}

/** Whether this database's bucket at `at` (the store's now when omitted) is written. The sampler's skip. */
export async function bucketFilled(store: Pool, name: string, at?: Date): Promise<boolean> {
  const { rowCount } = await store.query(
    `SELECT 1 FROM pgops.sample_buckets b JOIN pgops.databases d ON d.id = b.database_id
      WHERE d.name = $2 AND b.bucket = ${BUCKET}`,
    [at ?? null, name],
  );
  return (rowCount ?? 0) > 0;
}
