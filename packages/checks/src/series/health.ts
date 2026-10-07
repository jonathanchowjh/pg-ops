import type { Pool, PoolClient } from 'pg';
import type { Series } from '../types.js';

/** Two rows further apart than this are not joined: a missing minute is a gap. */
export const HEALTH_GAP_SECS = 150;

/**
 * No bucket is narrower than two capture intervals. At one interval, ordinary
 * timer jitter puts two rows in one bucket and none in the next, and the
 * chart shows a gap that never happened.
 */
export const HEALTH_MIN_BUCKET_SECS = 120;

/** Sampled once a minute. A bucket takes the MAXIMUM, so a spike survives zooming out. */
const LEVELS = [
  'connections', 'server_connections', 'max_connections', 'blocked', 'longest_wait_secs', 'idle_in_txn',
  'active', 'longest_query_secs', 'replication_lag_secs', 'xid_age', 'xmin_age', 'size_bytes',
] as const;

/** Cumulative in Postgres. A bucket takes the SUM of its valid intervals and the seconds they cover. */
const COUNTERS = [
  'sessions', 'sessions_abandoned', 'sessions_fatal', 'sessions_killed', 'idle_in_transaction_time',
  'deadlocks', 'active_time', 'xact_commit', 'xact_rollback', 'blks_hit', 'blks_read', 'temp_bytes',
  'wal_bytes',
] as const;

type Level = (typeof LEVELS)[number];
/** `own_statements` is stored as a per-interval count already, so it is summed but never differenced. */
type Summed = (typeof COUNTERS)[number] | 'own_statements';

export type BucketRow = { name: string; bucket: number; rows: number }
  & Record<Level, number | null>
  & Record<Summed, number | null>
  & Record<`${Summed}_secs`, number | null>;

/**
 * One query for any number of databases.
 *
 * An interval is VALID for a counter when the previous row is within
 * HEALTH_GAP_SECS, `stats_reset` did not change, and the counter did not go
 * backwards. Anything else contributes nothing: not a zero, not a negative
 * rate, not an interpolated guess. The lookback of one gap before `from`
 * gives the first row in the window a predecessor.
 */
const HISTORY_SQL = `
WITH raw AS (
  SELECT d.name, h.*,
         lag(h.captured_at) OVER w AS prev_at,
         lag(h.stats_reset) OVER w AS prev_reset,
         ${COUNTERS.map((c) => `lag(h.${c}) OVER w AS prev_${c}`).join(',\n         ')}
    FROM pgops.health_stats h
    JOIN pgops.databases d ON d.id = h.database_id
   WHERE d.name = ANY($1::text[])
     AND h.captured_at >= $2::timestamptz - interval '${HEALTH_GAP_SECS} seconds'
     AND h.captured_at <= $3::timestamptz
  WINDOW w AS (PARTITION BY h.database_id ORDER BY h.captured_at)
), marked AS (
  SELECT *,
         (prev_at IS NOT NULL
          AND captured_at - prev_at <= interval '${HEALTH_GAP_SECS} seconds'
          AND stats_reset IS NOT DISTINCT FROM prev_reset) AS joined,
         EXTRACT(EPOCH FROM captured_at - prev_at)::double precision AS secs
    FROM raw
), diffed AS (
  SELECT *,
         ${COUNTERS.map((c) => `CASE WHEN joined AND ${c} >= prev_${c} THEN ${c} - prev_${c} END AS d_${c}`).join(',\n         ')},
         CASE WHEN joined THEN own_statements END AS d_own_statements
    FROM marked
   WHERE captured_at >= $2::timestamptz
)
SELECT name,
       LEAST(width_bucket(EXTRACT(EPOCH FROM captured_at)::double precision,
                          EXTRACT(EPOCH FROM $2::timestamptz)::double precision,
                          EXTRACT(EPOCH FROM $3::timestamptz)::double precision,
                          $4::int), $4::int) AS bucket,
       count(*)::int AS rows,
       ${LEVELS.map((l) => `max(${l})::double precision AS ${l}`).join(',\n       ')},
       ${[...COUNTERS, 'own_statements'].map((c) =>
    `sum(d_${c})::double precision AS ${c},\n       sum(secs) FILTER (WHERE d_${c} IS NOT NULL) AS ${c}_secs`).join(',\n       ')}
  FROM diffed
 GROUP BY name, bucket
 ORDER BY name, bucket`;

/** Every figure a chart can draw. Rates and averages are derived here, so no page does arithmetic on a counter. */
export const HEALTH_METRICS = [
  // connect
  'connections', 'serverConnections', 'maxConnections', 'sessionsPerSec', 'badSessions',
  // wait
  'blocked', 'longestWaitSecs', 'idleInTxn', 'avgIdleInTxn', 'deadlocks',
  // work
  'active', 'avgActive', 'longestQuerySecs', 'commitsPerSec', 'rollbacksPerSec', 'hitPct',
  'tempBytesPerSec', 'ownPerSec',
  // keep-up
  'replicationLagSecs', 'walBytesPerSec', 'xidAge', 'xminAge', 'sizeBytes',
] as const;

export type HealthMetric = (typeof HEALTH_METRICS)[number];
export type HealthPoint = { at: number } & Record<HealthMetric, number | null>;
export interface HealthHistory {
  name: string;
  /** Rows inside the window. */
  rows: number;
  /**
   * The newest row EVER stored for this database, in epoch ms, or null if
   * there has never been one. An empty window means "pgops has only just
   * started" for a database with no rows at all, and "this database stopped
   * being recorded" for one whose last row is old; only this tells them apart.
   */
  lastAt: number | null;
  points: HealthPoint[];
}

const EMPTY = Object.fromEntries(HEALTH_METRICS.map((m) => [m, null])) as Record<HealthMetric, null>;

function point(at: number, r: BucketRow | undefined): HealthPoint {
  if (r === undefined) return { at, ...EMPTY };
  const rate = (c: Summed): number | null => {
    const sum = r[c];
    const secs = r[`${c}_secs`];
    return sum === null || secs === null || secs <= 0 ? null : sum / secs;
  };
  const perMs = (c: Summed): number | null => {
    const v = rate(c);
    return v === null ? null : v / 1000;
  };
  const bad = [r.sessions_abandoned, r.sessions_fatal, r.sessions_killed].filter((v): v is number => v !== null);
  const read = r.blks_hit === null || r.blks_read === null ? null : r.blks_hit + r.blks_read;
  return {
    at,
    connections: r.connections,
    serverConnections: r.server_connections,
    maxConnections: r.max_connections,
    sessionsPerSec: rate('sessions'),
    badSessions: bad.length === 0 ? null : bad.reduce((a, b) => a + b, 0),
    blocked: r.blocked,
    longestWaitSecs: r.longest_wait_secs,
    idleInTxn: r.idle_in_txn,
    // Milliseconds of session time per second of wall clock is an average count of sessions.
    avgIdleInTxn: perMs('idle_in_transaction_time'),
    deadlocks: r.deadlocks,
    active: r.active,
    avgActive: perMs('active_time'),
    longestQuerySecs: r.longest_query_secs,
    commitsPerSec: rate('xact_commit'),
    rollbacksPerSec: rate('xact_rollback'),
    hitPct: read === null || read === 0 ? null : (100 * r.blks_hit!) / read,
    tempBytesPerSec: rate('temp_bytes'),
    ownPerSec: rate('own_statements'),
    replicationLagSecs: r.replication_lag_secs,
    walBytesPerSec: rate('wal_bytes'),
    xidAge: r.xid_age,
    xminAge: r.xmin_age,
    sizeBytes: r.size_bytes,
  };
}

/** Lay bucket rows onto a dense axis of `n` buckets from `from` to `to` (epoch ms). */
export function toHealthPoints(
  rows: readonly BucketRow[],
  from: number,
  to: number,
  n: number,
): HealthPoint[] {
  const width = (to - from) / n;
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return Array.from({ length: n }, (_, i) => point(from + i * width, byBucket.get(i + 1)));
}

/**
 * Health for any number of databases over one window, bucketed to at most
 * `points` buckets. ONE query however many names are asked for, which is
 * what lets the fleet page draw sixty databases.
 */
export async function readHealthHistory(
  store: Pool | PoolClient,
  opts: { names: readonly string[]; from: Date; to: Date; points: number },
): Promise<HealthHistory[]> {
  const from = opts.from.getTime();
  const to = opts.to.getTime();
  if (opts.names.length === 0 || !(to > from)) return [];
  const n = Math.max(1, Math.min(
    Math.floor(opts.points),
    Math.floor((to - from) / 1000 / HEALTH_MIN_BUCKET_SECS),
  ));
  const { rows } = await store.query<BucketRow>(HISTORY_SQL, [[...opts.names], opts.from, opts.to, n]);
  // A backward scan of the primary key per database: one index probe each.
  const { rows: newest } = await store.query<{ name: string; last_at: Date | null }>(
    `SELECT d.name,
            (SELECT max(h.captured_at) FROM pgops.health_stats h WHERE h.database_id = d.id) AS last_at
       FROM pgops.databases d
      WHERE d.name = ANY($1::text[])`,
    [[...opts.names]],
  );
  const lastAt = new Map(newest.map((r) => [r.name, r.last_at?.getTime() ?? null]));
  return opts.names.map((name) => {
    const mine = rows.filter((r) => r.name === name);
    return {
      name,
      rows: mine.reduce((sum, r) => sum + r.rows, 0),
      lastAt: lastAt.get(name) ?? null,
      points: toHealthPoints(mine, from, to, n),
    };
  });
}

export const healthHistory: Series<
  HealthHistory,
  { databaseNames: readonly string[]; points: number }
> = {
  id: 'healthHistory',
  title: 'Health over time',
  read: (ctx, range, opts) => readHealthHistory(ctx.store!, {
    names: opts.databaseNames, from: range.from, to: range.to, points: opts.points,
  }),
};
