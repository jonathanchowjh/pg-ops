import type { PoolClient } from 'pg';
import { indexes, tables, type TableRead } from './checks/catalog.js';
import { sequences } from './checks/sequences.js';
import { statementShape } from './redact.js';
import { messageOf, ownSql, runCheck } from './run.js';
import { deltas, type CounterPoint } from './deltas.js';
import { withCaptureLock } from './store/lock.js';
import { readLastSnapshot } from './store/read.js';
import {
  RETENTION, insertQueryLoad, insertQueryStats, insertSpaceStats, prune, upsertQueries, writeCaptured,
  type CapturedRead, type CapturedWrite, type QueryStatsSnapshot, type Retention, type SpaceSnapshot,
} from './store/write.js';
import type { CheckContext, FailureReason } from './types.js';

/** What the capture's store transaction may take, whatever the pool allows. */
const CAPTURE_STORE_MS = 120_000;

type CaptureOutcome =
  /**
   * `queryStatsError` is present when the space half succeeded and the query
   * half did not. A cluster pg_upgraded to 14 without `ALTER EXTENSION
   * pg_stat_statements UPDATE` has no `pg_stat_statements_info` and no
   * `toplevel`: both arrived in extension version 1.9, which a server
   * version of 14 does not imply.
   */
  | { ok: true; shapes: number; relations: number; queryStatsError?: string }
  | { ok: false; reason: FailureReason; message: string }
  | { ok: 'skipped'; reason: 'locked' };

/**
 * Every top-level shape in this database, unbounded. Storing only the top N
 * would leave holes in the trend of any shape that drifts in and out of it.
 *
 * The `dbid` filter is required: pg_stat_statements is cluster-wide, and
 * without it another database's statements are stored under this one's name.
 *
 * Grouped by queryid because the view is keyed by
 * (userid, dbid, queryid, toplevel), so a shape two roles run has one row per
 * role. Ungrouped, those collide on the store's primary key and which one
 * survives changes between captures, so the counters appear to go backwards.
 *
 * `max(s.query)` is safe only because of `queryid IS NOT NULL`. A role
 * without `pg_read_all_stats` gets `<insufficient privilege>` as another
 * role's text, and Postgres nulls that row's queryid too, so the placeholder
 * is filtered out before grouping. Ordering does not protect it: under
 * en_US.utf8 the placeholder sorts above ordinary statement text.
 */
const QUERY_STATS_SQL = ownSql(`SELECT s.queryid::text                AS queryid,
       max(s.query)                   AS query,
       sum(s.calls)::text             AS calls,
       sum(s.total_exec_time)         AS total_exec_time,
       sum(s.rows)::text              AS rows,
       sum(s.shared_blks_hit)::text   AS shared_blks_hit,
       sum(s.shared_blks_read)::text  AS shared_blks_read,
       i.stats_reset                  AS stats_reset
  FROM pg_stat_statements s
  CROSS JOIN pg_stat_statements_info i
 WHERE s.toplevel
   AND s.queryid IS NOT NULL
   AND s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
 GROUP BY s.queryid, i.stats_reset
`);

/** The most rows of one captured read the store keeps: the largest tables and indexes, the fullest sequences. */
const CAPTURE_ROWS = 5_000;

/**
 * The three catalog scans, one after another so pgops is one connection wide
 * here, each under its own timeout. `runCheck` never rejects: a scan that
 * failed is written as failed, and the rows before it stand.
 *
 * The tables are returned as well: their sizes are the space series, so the
 * pass measures each relation once.
 */
async function readCatalog(ctx: CheckContext): Promise<{ writes: CapturedWrite[]; tables: TableRead[] }> {
  const failed = (read: CapturedRead, message: string): CapturedWrite =>
    ({ read, ok: false, message, rows: [], total: 0, statsReset: null, freezeMaxAge: null });
  const t = await runCheck(ctx, tables, { limit: CAPTURE_ROWS });
  const i = await runCheck(ctx, indexes, { limit: CAPTURE_ROWS });
  const s = await runCheck(ctx, sequences, { limit: CAPTURE_ROWS });
  const writes: CapturedWrite[] = [
    !t.ok ? failed('tables', t.message) : {
      read: 'tables', ok: true, message: null, rows: t.data.tables, total: t.data.total,
      statsReset: t.data.statsReset, freezeMaxAge: t.data.freezeMaxAge,
    },
    !i.ok ? failed('indexes', i.message) : {
      read: 'indexes', ok: true, message: null, rows: i.data.indexes, total: i.data.total,
      statsReset: i.data.statsReset, freezeMaxAge: null,
    },
    !s.ok ? failed('sequences', s.message) : {
      read: 'sequences', ok: true, message: null, rows: s.data.sequences, total: s.data.total,
      statsReset: null, freezeMaxAge: null,
    },
  ];
  return { writes, tables: t.ok ? t.data.tables : [] };
}

/**
 * One capture pass for one database. The scheduler that calls this lives in
 * apps/web.
 *
 * Never throws: it runs on a background timer, where an unhandled rejection
 * terminates the web process.
 */
export async function captureOnce(
  ctx: CheckContext,
  name: string,
  retention: Retention = RETENTION,
): Promise<CaptureOutcome> {
  const capture = async (client: PoolClient, databaseId: number): Promise<CaptureOutcome> => {
    // pg_stat_statements may be missing or older than 1.9. Space stats are
    // independent, so this degrades to zero shapes and reports the error.
    let queryRows: QueryRow[] = [];
    let queryStatsError: string | undefined;
    try {
      const r = await ctx.target.query<QueryRow>(QUERY_STATS_SQL);
      queryRows = r.rows;
    } catch (err) {
      queryStatsError = messageOf(err);
    }

    // Read before BEGIN: the store's transaction never waits on the monitored database.
    const catalog = await readCatalog(ctx);

    await client.query('BEGIN');
    try {
      // A capture writes thousands of rows and prunes a day's worth: longer
      // than the pool allows a page's read.
      await client.query(`SET LOCAL statement_timeout = ${CAPTURE_STORE_MS}`);
      // The store's clock, not this process's: several replicas capture the
      // same databases, and under clock skew their snapshots would sort out
      // of order and `deltas` would drop the intervals. Inside a transaction
      // `now()` is its start time, so every row of this pass shares it.
      const capturedAt = await storeNow(client);

      // Redact before the insert: pgops.queries is durable storage.
      const ids = await upsertQueries(client, databaseId, queryRows.map((row) => ({
        queryid: row.queryid, query: statementShape(row.query ?? ''),
      })));
      const stats: QueryStatsSnapshot[] = [];
      for (const row of queryRows) {
        const queryId = ids.get(row.queryid);
        // Should not happen, since every queryid was just upserted. Skipping
        // keeps a foreign-key failure from aborting the whole pass.
        if (queryId === undefined) continue;
        stats.push({
          databaseId, queryId, capturedAt,
          calls: Number(row.calls),
          totalExecTime: row.total_exec_time,
          rows: Number(row.rows),
          sharedBlksHit: Number(row.shared_blks_hit),
          sharedBlksRead: Number(row.shared_blks_read),
          statsReset: row.stats_reset,
        });
      }
      await insertQueryStats(client, stats);

      // The whole database's work in this interval, differenced here rather
      // than at read time (see migration 004).
      const load = queryLoadRow(stats, await readLastSnapshot(client, databaseId, capturedAt));
      if (load !== null) await insertQueryLoad(client, databaseId, capturedAt, load);

      // A tables read that failed writes no sizes: a missing snapshot is a
      // gap, where a zero would chart as the table shrinking to nothing.
      const space: SpaceSnapshot[] = catalog.tables.map((t) => ({
        databaseId, relation: t.name, capturedAt, sizeBytes: t.sizeBytes,
      }));
      await insertSpaceStats(client, space);

      // The catalog, with its hours and its events, in the pass's one transaction.
      for (const read of catalog.writes) await writeCaptured(client, databaseId, capturedAt, read, retention.rollupDays);

      // Same transaction as the inserts: retention cannot drift from capture.
      await prune(client, databaseId, retention);
      await client.query('COMMIT');
      return queryStatsError === undefined
        ? { ok: true, shapes: stats.length, relations: space.length }
        : { ok: true, shapes: stats.length, relations: space.length, queryStatsError };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  };
  return withCaptureLock(ctx, name, { recording: 'history' }, capture);
}

/** The store's own `now()`. Inside a transaction, that transaction's start. */
async function storeNow(client: PoolClient): Promise<Date> {
  const { rows } = await client.query<{ now: Date }>('SELECT now() AS now');
  return rows[0]!.now;
}

interface QueryRow {
  queryid: string; query: string | null; calls: string;
  total_exec_time: number; rows: string;
  shared_blks_hit: string; shared_blks_read: string;
  stats_reset: Date | null;
}

/**
 * Sum one interval's work across every shape, or report that there was no
 * interval to measure.
 *
 * Uses `deltas` per shape so the discontinuity rule lives in one place. A
 * shape whose interval spans a reset or an eviction contributes nothing,
 * not a zero.
 *
 * `null` when no shape contributed (first capture, pg_stat_statements
 * unavailable, cluster-wide reset). No row is written and the chart draws a
 * gap; a zero row would read as an idle interval.
 */
export function queryLoadRow(
  snapshots: readonly QueryStatsSnapshot[],
  previous: ReadonlyMap<number, CounterPoint>,
): { totalExecTime: number; calls: number } | null {
  let totalExecTime = 0;
  let calls = 0;
  let measured = 0;
  for (const s of snapshots) {
    const prev = previous.get(s.queryId);
    // Not seen at the previous capture: its counter is a total of unknown
    // age, not an interval.
    if (prev === undefined) continue;
    const [interval] = deltas([prev, s]);
    if (interval === undefined) continue;
    totalExecTime += interval.totalExecTime;
    calls += interval.calls;
    measured += 1;
  }
  return measured === 0 ? null : { totalExecTime, calls };
}
