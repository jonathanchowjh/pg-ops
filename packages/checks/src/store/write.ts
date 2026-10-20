import type { Pool, PoolClient } from 'pg';
import { guardClient } from '../run.js';
import { chainEvents, type EventKind, type Sample, type StatementInfo } from '../samples.js';
import type { CounterPoint } from '../series/query-stats.js';

/**
 * A fixed key for the migration lock. Arbitrary, but it must never change:
 * two pgops versions racing to migrate the same store have to contend on the
 * same key or the lock does nothing.
 */
export const MIGRATION_LOCK_KEY = 4021975;

/**
 * Namespace for per-database capture locks, used with the two-int form
 * `pg_try_advisory_lock(ns, database_id)` so a capture lock can never collide
 * with the single-int migration lock above.
 */
export const CAPTURE_LOCK_NS = 4021976;

/**
 * Namespace for the per-database sample lock, taken for one transaction:
 * two writers of one database's adjacent buckets each recompute the minute
 * from what the other has committed, never from a snapshot that misses it.
 */
const SAMPLE_LOCK_NS = 4021978;

/**
 * Namespace for the per-database health lock. Separate from the capture
 * lock: the five-minute capture can hold its lock for a long time, and a
 * health tick that shared it would skip every minute the capture ran.
 */
export const HEALTH_LOCK_NS = 4021977;


export interface Retention {
  queryStatsDays: number; spaceStatsDays: number; healthStatsDays: number;
  /** Raw session samples: the window a past cursor can name a pid in. */
  sampleDays: number;
  /** Minute rollups and events: the window the clock can draw at all. */
  rollupDays: number;
}

/**
 * pgHero's defaults for query and space stats. Query stats are dense and short-lived interest;
 * space grows slowly and the interesting window is a quarter.
 */
export const RETENTION: Retention = {
  queryStatsDays: 14, spaceStatsDays: 90, healthStatsDays: 90, sampleDays: 2, rollupDays: 14,
};

/**
 * Rows per statement, for every batched write here.
 *
 * The wire protocol caps one Bind at 65,535 parameters: 9 per row for
 * query_stats, so 7,281 rows. Unchunked, a database with more shapes than
 * that would have every capture rejected.
 */
const CHUNK_ROWS = 1_000;

/** One shape's counters at one capture, as stored. */
export interface QueryStatsSnapshot extends CounterPoint {
  databaseId: number;
  queryId: number;
}

export interface SpaceSnapshot {
  databaseId: number;
  relation: string;
  capturedAt: Date;
  sizeBytes: number;
}

/**
 * One multi-row INSERT per CHUNK_ROWS rows. `table` and `columns` are
 * interpolated, so they are only ever literals from this file; every value
 * is bound.
 */
async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const chunk = rows.slice(i, i + CHUNK_ROWS);
    const tuples = chunk.map((_, r) =>
      `(${columns.map((_c, c) => `$${r * columns.length + c + 1}`).join(', ')})`);
    // Spread row by row, not `flat()`, which would also open an array value.
    const values: unknown[] = [];
    for (const row of chunk) values.push(...row);
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    );
  }
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
 * `queryid` is bound as text and cast in SQL: it is a 64-bit hash, which a
 * JavaScript number cannot hold exactly.
 *
 * Inputs are deduplicated by queryid first, because `ON CONFLICT DO UPDATE`
 * raises "cannot affect row a second time" if one statement touches the
 * same row twice.
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

/** ON CONFLICT DO NOTHING, so a retried tick does not fail on a snapshot already stored. */
export async function insertQueryStats(
  client: PoolClient,
  snapshots: QueryStatsSnapshot[],
): Promise<void> {
  await insertRows(client, 'pgops.query_stats',
    ['database_id', 'query_id', 'captured_at', 'calls', 'total_exec_time', 'rows',
      'shared_blks_hit', 'shared_blks_read', 'stats_reset'],
    snapshots.map((s) => [s.databaseId, s.queryId, s.capturedAt, s.calls, s.totalExecTime,
      s.rows, s.sharedBlksHit, s.sharedBlksRead, s.statsReset]));
}

export async function insertSpaceStats(
  client: PoolClient,
  snapshots: SpaceSnapshot[],
): Promise<void> {
  await insertRows(client, 'pgops.space_stats',
    ['database_id', 'relation', 'captured_at', 'size_bytes'],
    snapshots.map((s) => [s.databaseId, s.relation, s.capturedAt, s.sizeBytes]));
}

/**
 * The whole database's work in one capture interval.
 *
 * `totalExecTime` and `calls` are already differenced and summed by
 * `queryLoadRow` in capture.ts.
 */
export async function insertQueryLoad(
  client: PoolClient,
  databaseId: number,
  capturedAt: Date,
  load: { totalExecTime: number; calls: number },
): Promise<void> {
  await client.query(
    `INSERT INTO pgops.query_load (database_id, captured_at, total_exec_time, calls)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [databaseId, capturedAt, load.totalExecTime, load.calls],
  );
}

/**
 * Called by `captureOnce` inside the same transaction as the inserts, so
 * retention cannot drift from capture.
 *
 * `pgops.queries` is pruned last: a shape is an orphan once the snapshot
 * delete has removed its last `query_stats` row.
 *
 * `query_load` follows `query_stats`'s retention, so a load chart never
 * outlives the per-shape rows behind it.
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
    `DELETE FROM pgops.query_load
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
  );  // The clock's tables. Session rows go with their bucket, by cascade. A
  // statement's text is an orphan once no rollup names it.
  await client.query(
    `DELETE FROM pgops.sample_buckets
       WHERE database_id = $1 AND bucket < now() - ($2 || ' days')::interval`,
    [databaseId, String(retention.sampleDays)],
  );
  await client.query(
    `DELETE FROM pgops.load_minutes
       WHERE database_id = $1 AND minute < now() - ($2 || ' days')::interval`,
    [databaseId, String(retention.rollupDays)],
  );
  await client.query(
    `DELETE FROM pgops.events
       WHERE database_id = $1 AND at < now() - ($2 || ' days')::interval`,
    [databaseId, String(retention.rollupDays)],
  );
  for (const hourly of ['pgops.table_hours', 'pgops.index_hours']) {
    await client.query(
      `DELETE FROM ${hourly} WHERE database_id = $1 AND hour < now() - ($2 || ' days')::interval`,
      [databaseId, String(retention.rollupDays)],
    );
  }
  await client.query(
    `DELETE FROM pgops.sample_statements s
       WHERE s.database_id = $1
         AND NOT EXISTS (SELECT 1 FROM pgops.load_minutes m
                          WHERE m.database_id = s.database_id AND m.kind = 'q' AND m.key = s.key)`,
    [databaseId],
  );
}

/**
 * The metric columns of pgops.health_stats, in table order. The insert is
 * built from this list, so a column added by a migration after 011 is
 * added here and nowhere else.
 */
export const HEALTH_COLUMNS = [
  'connections', 'server_connections', 'max_connections',
  'deadlocks', 'xact_commit', 'xact_rollback', 'stats_reset',
  'replication_lag_secs', 'replication_lag_bytes', 'wal_bytes', 'xid_age', 'xmin_age', 'size_bytes',
] as const;

type HealthColumn = (typeof HEALTH_COLUMNS)[number];

/**
 * 64-bit and numeric counters travel as strings, the way the sampling
 * statements cast them: a JavaScript number cannot hold a bigint exactly.
 */
export type HealthRow = Record<HealthColumn, string | number | Date | null>;

/**
 * Insert one health row stamped with the store's clock, and prune.
 *
 * The caller wraps this in a transaction. Pruning every minute keeps each
 * delete to about one row.
 */
export async function insertHealth(
  client: PoolClient,
  databaseId: number,
  row: HealthRow,
  days: number,
): Promise<void> {
  const params = HEALTH_COLUMNS.map((_, i) => `$${i + 2}`).join(', ');
  await client.query(
    `INSERT INTO pgops.health_stats (database_id, captured_at, ${HEALTH_COLUMNS.join(', ')})
     VALUES ($1, now(), ${params})
     ON CONFLICT DO NOTHING`,
    [databaseId, ...HEALTH_COLUMNS.map((c) => row[c])],
  );
  await client.query(
    `DELETE FROM pgops.health_stats
       WHERE database_id = $1 AND captured_at < now() - ($2 || ' days')::interval`,
    [databaseId, String(days)],
  );
}

/**
 * Whether this database already has a row from the last 45 seconds.
 *
 * The advisory lock stops two replicas sampling at the same instant. This
 * stops two replicas whose ticks are thirty seconds apart from writing two
 * rows a minute between them.
 */
export async function healthIsFresh(client: PoolClient, databaseId: number): Promise<boolean> {
  const { rows } = await client.query<{ fresh: boolean }>(
    `SELECT coalesce(max(captured_at) > now() - interval '45 seconds', false) AS fresh
       FROM pgops.health_stats WHERE database_id = $1`,
    [databaseId],
  );
  return rows[0]!.fresh;
}

export type CapturedRead = 'tables' | 'indexes' | 'sequences';

/** One captured read as the capture hands it over. `rows` are the check's own, each with a `name`. */
export interface CapturedWrite {
  read: CapturedRead;
  ok: boolean;
  message: string | null;
  rows: readonly { name: string }[];
  total: number;
  statsReset: number | null;
  freezeMaxAge: number | null;
}

/**
 * What each table did since the capture before, added to its hour, with the
 * newest gauges. `$1` the database, `$2` this capture's moment, `$3` the
 * rows, `$4` their statistics reset.
 *
 * A difference counts only against a capture that is recent and counted
 * from the same reset. Fifteen minutes is two missed captures: past that
 * the difference is hours of work and belongs to no one hour. A counter
 * that went backwards with no reset to explain it adds nothing either.
 * `COALESCE(o.x, n.x)` makes every such case a difference of zero.
 */
const TABLE_HOURS_SQL = `
INSERT INTO pgops.table_hours AS h
  (database_id, hour, relation, inserted, updated, deleted, index_rows, scan_rows, live_rows, dead_rows, vacuum_trigger)
SELECT $1, date_trunc('hour', $2::timestamptz), n.name,
       GREATEST(n.inserted - COALESCE(o.inserted, n.inserted), 0),
       GREATEST(n.updated  - COALESCE(o.updated,  n.updated),  0),
       GREATEST(n.deleted  - COALESCE(o.deleted,  n.deleted),  0),
       GREATEST(COALESCE(n."idxRows", 0) - COALESCE(o.idx_rows, n."idxRows", 0), 0),
       GREATEST(n."seqRows" - COALESCE(o.seq_rows, n."seqRows"), 0),
       n."liveRows", n."deadRows", n."vacuumTrigger"
  FROM jsonb_to_recordset($3::jsonb) AS n(
         name text, inserted bigint, updated bigint, deleted bigint, "idxRows" bigint, "seqRows" bigint,
         "liveRows" bigint, "deadRows" bigint, "vacuumTrigger" double precision)
  LEFT JOIN LATERAL (
    SELECT (c.data->>'inserted')::bigint AS inserted, (c.data->>'updated')::bigint AS updated,
           (c.data->>'deleted')::bigint  AS deleted,  (c.data->>'idxRows')::bigint AS idx_rows,
           (c.data->>'seqRows')::bigint  AS seq_rows
      FROM pgops.captured c
      JOIN pgops.captures k ON k.database_id = c.database_id AND k.read = c.read
     WHERE c.database_id = $1 AND c.read = 'tables' AND c.name = n.name
       AND k.stats_reset IS NOT DISTINCT FROM $4::timestamptz
       AND k.captured_at > $2::timestamptz - interval '15 minutes'
  ) o ON true
ON CONFLICT (database_id, relation, hour) DO UPDATE SET
  inserted   = h.inserted   + EXCLUDED.inserted,
  updated    = h.updated    + EXCLUDED.updated,
  deleted    = h.deleted    + EXCLUDED.deleted,
  index_rows = h.index_rows + EXCLUDED.index_rows,
  scan_rows  = h.scan_rows  + EXCLUDED.scan_rows,
  live_rows = EXCLUDED.live_rows, dead_rows = EXCLUDED.dead_rows, vacuum_trigger = EXCLUDED.vacuum_trigger`;

/**
 * A vacuum or an analyze the catalog reports and the capture before did
 * not, stamped with the catalog's own moment, so a five-minute cadence
 * costs the mark no precision. `$1` the database, `$2` the rows, `$3` the
 * retention in days: the first capture of a table would otherwise mark a
 * vacuum from last year.
 */
const TABLE_EVENTS_SQL = `
INSERT INTO pgops.events (database_id, at, kind, relation)
SELECT $1, to_timestamp(v.at / 1000.0), v.kind, n.name
  FROM jsonb_to_recordset($2::jsonb) AS n(name text, "lastVacuum" double precision, "lastAnalyze" double precision)
  LEFT JOIN pgops.captured c ON c.database_id = $1 AND c.read = 'tables' AND c.name = n.name
  CROSS JOIN LATERAL (VALUES
    ('vacuum',  n."lastVacuum",  (c.data->>'lastVacuum')::double precision),
    ('analyze', n."lastAnalyze", (c.data->>'lastAnalyze')::double precision)
  ) AS v(kind, at, was)
 WHERE v.at IS NOT NULL
   AND v.at > COALESCE(v.was, 0)
   AND to_timestamp(v.at / 1000.0) > now() - ($3 || ' days')::interval
ON CONFLICT DO NOTHING`;

/**
 * The statistics reset, when its moment has moved since the capture before.
 * The reset route writes one too, at the store's now; a mark within a minute
 * of this one is that one.
 */
const RESET_EVENT_SQL = `
INSERT INTO pgops.events (database_id, at, kind, relation)
SELECT $1, $2::timestamptz, 'reset', ''
 WHERE $2::timestamptz IS NOT NULL
   AND $2::timestamptz IS DISTINCT FROM
       (SELECT k.stats_reset FROM pgops.captures k WHERE k.database_id = $1 AND k.read = 'tables')
   AND NOT EXISTS (SELECT 1 FROM pgops.events e
                    WHERE e.database_id = $1 AND e.kind = 'reset'
                      AND e.at BETWEEN $2::timestamptz - interval '1 minute' AND $2::timestamptz + interval '1 minute')
ON CONFLICT DO NOTHING`;

/** Scans since the capture before, for the indexes that had any. The same two guards as the tables'. */
const INDEX_HOURS_SQL = `
INSERT INTO pgops.index_hours AS h (database_id, hour, index_name, scans)
SELECT $1, date_trunc('hour', $2::timestamptz), n.name, n.scans - (c.data->>'scans')::bigint
  FROM jsonb_to_recordset($3::jsonb) AS n(name text, scans bigint)
  JOIN pgops.captured c ON c.database_id = $1 AND c.read = 'indexes' AND c.name = n.name
  JOIN pgops.captures k ON k.database_id = c.database_id AND k.read = c.read
 WHERE k.stats_reset IS NOT DISTINCT FROM $4::timestamptz
   AND k.captured_at > $2::timestamptz - interval '15 minutes'
   AND n.scans > (c.data->>'scans')::bigint
ON CONFLICT (database_id, index_name, hour) DO UPDATE SET scans = h.scans + EXCLUDED.scans`;

/**
 * Store one captured read: its hours and events first, because each reads
 * the capture before this one, then the rows, replaced whole. The caller
 * holds the transaction.
 *
 * A read that failed changes nothing but the header's `ok` and `message`.
 * The rows before it stand with their own `captured_at`: a scan that timed
 * out is not an empty catalog.
 */
export async function writeCaptured(
  client: PoolClient,
  databaseId: number,
  capturedAt: Date,
  w: CapturedWrite,
  rollupDays: number,
): Promise<void> {
  if (!w.ok) {
    await client.query(
      `INSERT INTO pgops.captures (database_id, read, captured_at, ok, message, total)
       VALUES ($1, $2, $3, false, $4, 0)
       ON CONFLICT (database_id, read) DO UPDATE SET ok = false, message = EXCLUDED.message`,
      [databaseId, w.read, capturedAt, w.message],
    );
    return;
  }
  const rows = JSON.stringify(w.rows);
  const reset = w.statsReset === null ? null : new Date(w.statsReset);
  if (w.read === 'tables') {
    await client.query(TABLE_HOURS_SQL, [databaseId, capturedAt, rows, reset]);
    await client.query(TABLE_EVENTS_SQL, [databaseId, rows, String(rollupDays)]);
    await client.query(RESET_EVENT_SQL, [databaseId, reset]);
  }
  if (w.read === 'indexes') await client.query(INDEX_HOURS_SQL, [databaseId, capturedAt, rows, reset]);

  await client.query(
    `INSERT INTO pgops.captures (database_id, read, captured_at, ok, message, total, stats_reset, freeze_max_age)
     VALUES ($1, $2, $3, true, NULL, $4, $5, $6)
     ON CONFLICT (database_id, read) DO UPDATE SET
       captured_at = EXCLUDED.captured_at, ok = true, message = NULL, total = EXCLUDED.total,
       stats_reset = EXCLUDED.stats_reset, freeze_max_age = EXCLUDED.freeze_max_age`,
    [databaseId, w.read, capturedAt, w.total, reset, w.freezeMaxAge],
  );
  await client.query('DELETE FROM pgops.captured WHERE database_id = $1 AND read = $2', [databaseId, w.read]);
  // One statement and one parameter, however many rows: the bind limit that CHUNK_ROWS is for does not apply.
  await client.query(
    `INSERT INTO pgops.captured (database_id, read, name, data)
     SELECT $1, $2, e->>'name', e FROM jsonb_array_elements($3::jsonb) AS e
     ON CONFLICT DO NOTHING`,
    [databaseId, w.read, rows],
  );
}

/** The bucket a moment falls in. `$1` is the moment; null means the store's now. */
export const BUCKET = `to_timestamp(floor(extract(epoch FROM COALESCE($1::timestamptz, now())) / 15) * 15)`;

/**
 * Write one sample into its bucket, or find the bucket already written.
 *
 * The bucket is the store's clock, not this process's: two replicas and
 * three browser tabs all poll the same database, and the bucket row's
 * primary key is what makes exactly one of them the sample.
 *
 * One transaction, and it never waits on the monitored database: the
 * sample was read before this was called.
 */
export async function recordSample(
  store: Pool,
  name: string,
  sample: Sample,
  texts: ReadonlyMap<string, StatementInfo>,
  at?: Date,
): Promise<'written' | 'filled'> {
  const client = await store.connect();
  const release = guardClient(client);
  try {
    const databaseId = await upsertDatabase(client, name);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SAMPLE_LOCK_NS, databaseId]);
    const claim = await client.query<{ bucket: Date; at: Date }>(
      `INSERT INTO pgops.sample_buckets (database_id, bucket, hidden, truncated)
       VALUES ($2, ${BUCKET}, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING bucket, COALESCE($1::timestamptz, now()) AS at`,
      [at ?? null, databaseId, sample.hidden, sample.truncated],
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'filled';
    }
    const { bucket, at: storeAt } = claim.rows[0]!;

    // `since` is written as an age back from the store's moment, so a
    // process whose clock is off does not shift every span.
    await client.query(
      `INSERT INTO pgops.session_samples
         (database_id, bucket, pid, backend_start, app, class, since, statement, relations, blocked_by)
       SELECT $1, $2, s.pid, s.backend_start, s.app, s.class,
              $3::timestamptz - s.age_ms * interval '1 millisecond', s.statement,
              ARRAY(SELECT jsonb_array_elements_text(s.relations)), s.blocked_by
         FROM jsonb_to_recordset($4::jsonb)
           AS s(pid int, backend_start text, app text, class text, age_ms double precision,
                statement text, relations jsonb, blocked_by int)
       ON CONFLICT DO NOTHING`,
      [databaseId, bucket, storeAt, JSON.stringify(sample.sessions.map((s) => ({
        pid: s.pid, backend_start: s.backendStart, app: s.app, class: s.cls,
        age_ms: sample.at - s.since, statement: s.statement, relations: s.relations, blocked_by: s.blockedBy,
      })))],
    );

    await client.query(
      `INSERT INTO pgops.sample_statements (database_id, key, query, relations)
       SELECT $1, t.key, t.query, ARRAY(SELECT jsonb_array_elements_text(t.relations))
         FROM jsonb_to_recordset($2::jsonb) AS t(key text, query text, relations jsonb)
       ON CONFLICT (database_id, key) DO UPDATE
          SET relations = ARRAY(SELECT DISTINCT r
                                  FROM unnest(pgops.sample_statements.relations || EXCLUDED.relations) AS r
                                 ORDER BY r
                               )
        WHERE NOT pgops.sample_statements.relations @> EXCLUDED.relations`,
      [databaseId, JSON.stringify([...texts].map(([key, v]) => ({ key, query: v.text, relations: v.relations })))],
    );

    // Every class seen in this minute is recomputed, so each row's mean is
    // over the buckets the minute has so far.
    await client.query(
      `WITH m AS (SELECT date_trunc('minute', $2::timestamptz) AS minute),
       n AS (SELECT count(*)::real AS buckets FROM pgops.sample_buckets b, m
              WHERE b.database_id = $1 AND b.bucket >= m.minute AND b.bucket < m.minute + interval '1 minute'),
       s AS (SELECT x.* FROM pgops.session_samples x, m
              WHERE x.database_id = $1 AND x.bucket >= m.minute AND x.bucket < m.minute + interval '1 minute'),
       r AS (
         SELECT 'd' AS kind, '' AS key, class, count(*) AS c FROM s GROUP BY class
         UNION ALL
         SELECT 't', t.relation, s.class, count(*)
           FROM s CROSS JOIN LATERAL unnest(CASE WHEN cardinality(s.relations) = 0 THEN ARRAY['']
                                                 ELSE s.relations END) AS t(relation)
          GROUP BY t.relation, s.class
         UNION ALL
         SELECT 'q', statement, class, count(*) FROM s WHERE statement IS NOT NULL GROUP BY statement, class
       )
       INSERT INTO pgops.load_minutes (database_id, minute, kind, key, class, sessions)
       SELECT $1, m.minute, r.kind, r.key, r.class, r.c / n.buckets FROM r, m, n
       ON CONFLICT (database_id, minute, kind, key, class) DO UPDATE SET sessions = EXCLUDED.sessions`,
      [databaseId, bucket],
    );

    // The sample before this one, however long ago: `chainEvents` says what a gap means.
    const { rows: prior } = await client.query<{ relations: string[]; bucket: Date }>(
      `SELECT ARRAY(SELECT DISTINCT COALESCE(s.relations[1], '')
                      FROM pgops.session_samples s
                     WHERE s.database_id = $1 AND s.bucket = b.bucket AND s.class = 'lock') AS relations,
              b.bucket
         FROM pgops.sample_buckets b
        WHERE b.database_id = $1 AND b.bucket < $2
        ORDER BY b.bucket DESC
        LIMIT 1`,
      [databaseId, bucket],
    );
    const before = prior[0];
    const marks = chainEvents(
      before === undefined ? null : { bucket: before.bucket.getTime(), tables: before.relations },
      sample,
      bucket.getTime(),
    );
    for (const e of marks) {
      await client.query(
        `INSERT INTO pgops.events (database_id, at, kind, relation) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [databaseId, new Date(e.at), e.kind, e.relation],
      );
    }
    await client.query('COMMIT');
    return 'written';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

/**
 * Record an event at the store's now. `unreachable` and `reachable` are
 * transitions: written only when the last of the pair was the other one, so
 * an outage is one mark and not one per tick.
 */
export async function recordEvent(store: Pool, name: string, kind: EventKind, relation = ''): Promise<void> {
  const client = await store.connect();
  const release = guardClient(client);
  try {
    const databaseId = await upsertDatabase(client, name);
    const transition = kind === 'unreachable' || kind === 'reachable';
    await client.query(
      `INSERT INTO pgops.events (database_id, at, kind, relation)
       SELECT $1, now(), $2, $3
        WHERE NOT $4::boolean
           OR COALESCE((SELECT e.kind FROM pgops.events e
                         WHERE e.database_id = $1 AND e.kind IN ('unreachable', 'reachable')
                         ORDER BY e.at DESC LIMIT 1), 'reachable') <> $2
       ON CONFLICT DO NOTHING`,
      [databaseId, kind, relation, transition],
    );
  } finally {
    release();
  }
}
