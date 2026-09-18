import { redactSecrets } from './redact.js';
import { guardClient, messageOf } from './run.js';
import { releaseCaptureLock, tryCaptureLock } from './store/lock.js';
import {
  RETENTION, insertQueryStats, insertSpaceStats, prune, upsertDatabase, upsertQueries,
  type QueryStatsSnapshot, type Retention, type SpaceSnapshot,
} from './store/write.js';
import type { CheckContext, FailureReason } from './types.js';

export type CaptureOutcome =
  /**
   * `queryStatsError` is present when the space half succeeded and the query
   * half did not. I6 (final review): this used to be swallowed into
   * `shapes: 0` with `ok: true`, which is the "we could not look" / "we
   * looked and it's fine" conflation the README makes this project's
   * signature claim against. A cluster pg_upgraded to 14 without the
   * documented `ALTER EXTENSION pg_stat_statements UPDATE` has no
   * `pg_stat_statements_info` and no `toplevel` — both arrived in EXTENSION
   * version 1.9, which `serverVersion >= 140000` does not imply — and every
   * capture from then on recorded nothing and reported success.
   */
  | { ok: true; shapes: number; relations: number; queryStatsError?: string }
  | { ok: false; reason: FailureReason; message: string }
  | { ok: 'skipped'; reason: 'locked' };

/**
 * Every top-level shape in THIS database, unbounded — NOT the top-N the
 * queries page reads.
 *
 * A capture that stored only the worst 100 shapes would make every trend for
 * a shape that drifted in and out of that window a series of holes, and the
 * holes would look like the query going quiet rather than like pgops not
 * having looked.
 *
 * C1 (final review): the `dbid` filter is load-bearing and was missing.
 * pg_stat_statements is CLUSTER-wide; without it, capture connected to `app`
 * stores `analytics`'s statements under `app`'s name, forever, and retention
 * prunes on the wrong scope. This is the same filter — and the same reason —
 * as checks/query-stats.ts's own I2, and the same Ruling 55 the queries page
 * cites.
 *
 * C2 (final review): pg_stat_statements is keyed by
 * (userid, dbid, queryid, toplevel), so filtering dbid still leaves one row
 * PER ROLE for a shape two roles both run — reproduced on PG 17 and
 * documented on the queries page as I3. Ungrouped, those rows collapse into
 * one primary key and `ON CONFLICT DO NOTHING` silently keeps whichever the
 * scan returned first, which is not stable between captures: the survivor
 * flipping from a 4,000,000-call role to a 120-call one makes the counters go
 * BACKWARDS, and `deltas` then drops the interval as a discontinuity. The
 * busiest statement on the database would read as "not seen". Summing across
 * roles is the aggregate the store actually wants.
 *
 * `max(s.query)` picks the group's text, and `queryid IS NOT NULL` above is
 * what makes that safe — NOT any property of the ordering.
 *
 * A role without `pg_read_all_stats` is handed the literal
 * `<insufficient privilege>` for another role's row, and Postgres NULLs that
 * row's `queryid` at the same time. Measured on postgres:17: a role with no
 * extra grants saw 2 readable rows and 220 hidden ones, every hidden one with
 * a null queryid, and a capture run as that role stored only its own shapes
 * and no placeholder. So the placeholder is already excluded before the
 * grouping — one filter, doing two jobs, and the second is worth knowing
 * about if the first is ever relaxed.
 *
 * It is worth knowing what does NOT hold it, because it looks like it should:
 * ordering. An earlier draft justified `max` by "`<` sorts below every
 * letter", which is true only under `C` collation. Measured on the same
 * container, whose default is en_US.utf8, glibc ignores punctuation at the
 * primary level and `max('<insufficient privilege>', 'CREATE INDEX foo')`
 * returns the PLACEHOLDER — likewise against INSERT, DELETE, ALTER, COPY and
 * GRANT. Since `upsertQuery` does `DO UPDATE SET query = EXCLUDED.query`,
 * relying on that would have overwritten the store's durable text.
 */
const QUERY_STATS_SQL = `
SELECT s.queryid::text                AS queryid,
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
`;

/**
 * Relation sizes for the space series. `pg_total_relation_size` includes
 * indexes and TOAST, which is the number an operator watching disk cares
 * about — the table's heap alone understates growth on any indexed table.
 *
 * `pg_total_relation_size` returns NULL for a relation dropped between this
 * scan and the size call, and `Number(null)` is 0 — so a table dropped
 * mid-capture would be stored as a 0-byte snapshot, which in a space chart
 * reads as it shrinking to nothing rather than as it being gone. Omitting the
 * row is the honest answer: pgops did not measure it.
 *
 * That omission is now done in `captureOnce`, not here, and the function is
 * called exactly ONCE. It used to appear in both the select list and an
 * `AND pg_total_relation_size(c.oid) IS NOT NULL` — two separate evaluations,
 * which cannot guard each other: WHERE is evaluated first, so a relation
 * dropped between the two calls passed the IS NOT NULL and then handed NULL to
 * the select list, and the 0-byte snapshot landed anyway. The filter claimed to
 * close a race it left open, and the integration test covering it says as much
 * ("a race no test can stage deterministically, and deliberately NOT asserted
 * here").
 *
 * Filtering in JavaScript is what makes it testable: a null `size_bytes` is an
 * ordinary row to feed a fake target, so the branch has a real unit test
 * instead of a claim. Wrapping the SQL in a subquery to fence the double call
 * was tried first and measured to work on PG 17 — but it rests on the planner
 * declining to flatten it, which is not a property to hang "never store a
 * measurement pgops did not take" on.
 */
const SPACE_SQL = `
SELECT (n.nspname || '.' || c.relname)            AS relation,
       pg_total_relation_size(c.oid)::text        AS size_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'm', 'p')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgops')
`;

/**
 * One capture pass for one database. No timer, no process assumptions — the
 * scheduler that calls this lives in apps/web, so lifting capture into a CLI
 * later is a wrapper rather than a refactor.
 *
 * NEVER throws, for the same reason runCheck never rejects: this runs on a
 * background timer, and an unhandled rejection there terminates the web
 * process. A console that dies because a store blinked is worse than one that
 * reports history as unavailable.
 */
export async function captureOnce(
  ctx: CheckContext,
  name: string,
  retention: Retention = RETENTION,
): Promise<CaptureOutcome> {
  if (!ctx.store) {
    return {
      ok: false,
      reason: 'missing-store',
      message: 'No store configured; set PGOPS_STORE_URL to record history.',
    };
  }
  const store = ctx.store;
  let client;
  let release;
  try {
    client = await store.connect();
    // Before the first await that could see the connection drop. This client
    // is held across BOTH scans of the monitored database and the whole write
    // transaction — seconds, every five minutes, forever — and a checked-out
    // pg client has no 'error' listener of its own, so a store restart or
    // failover inside that window is a FATAL unhandled event, not a failed
    // capture. See guardClient in run.ts: that is the difference between this
    // function honouring its "never throws" contract and taking the web
    // process down with it.
    release = guardClient(client);
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: messageOf(err) };
  }

  let databaseId: number | null = null;
  let locked = false;
  try {
    databaseId = await upsertDatabase(client, name);
    if (!(await tryCaptureLock(client, databaseId))) {
      // Another replica is capturing this database. Skip, never queue — a
      // queued tick runs a capture nobody needs against a database pgops is
      // meant to be leaving alone.
      return { ok: 'skipped', reason: 'locked' };
    }
    locked = true;

    // pg_stat_statements may not be installed, or may be at an extension
    // version older than 1.9. That is not a capture failure for the whole
    // database — space stats are independent and still useful — so it
    // degrades to zero shapes. But it is REPORTED rather than swallowed: see
    // CaptureOutcome above.
    let queryRows: QueryRow[] = [];
    let queryStatsError: string | undefined;
    try {
      const r = await ctx.target.query<QueryRow>(QUERY_STATS_SQL);
      queryRows = r.rows;
    } catch (err) {
      queryStatsError = messageOf(err);
    }

    const spaceResult = await ctx.target.query<SpaceRow>(SPACE_SQL);

    await client.query('BEGIN');
    try {
      // The timestamp comes from the STORE, not from `new Date()` in this
      // process. Several replicas capture the same databases — that is what
      // the advisory lock above exists for — and with a clock skew larger
      // than the capture interval their snapshots sort out of order, at which
      // point `deltas` sees the counters decrease and drops every interval as
      // a discontinuity. One clock, the store's, removes the class. Inside a
      // transaction `now()` is the transaction's start time, so every row this
      // pass writes carries the same instant.
      const { rows: at } = await client.query<{ now: Date }>('SELECT now() AS now');
      const capturedAt = at[0]!.now;

      // `databaseId` is a `number` by here, but it is a `let` read inside the
      // callbacks below, which is the only reason a non-null assertion ever
      // looked necessary. Commit 3c6fea0 removed the one `!` this codebase had
      // for the same reason; a const binding is the fix, not an assertion.
      const dbId = databaseId;

      // Redact BEFORE the insert. pgops.queries is durable storage: a
      // connection string or password in a query literal written there
      // outlives every screenshot and every page view. Ruling 2.
      const ids = await upsertQueries(client, dbId, queryRows.map((row) => ({
        queryid: row.queryid, query: redactSecrets(row.query ?? ''),
      })));
      const stats: QueryStatsSnapshot[] = [];
      for (const row of queryRows) {
        const queryId = ids.get(row.queryid);
        // Every queryid was just upserted, so a miss is impossible — but it
        // would mean writing a snapshot against a shape row that does not
        // exist, and the foreign key would abort the whole pass. Skipping the
        // row keeps the rest of the capture.
        if (queryId === undefined) continue;
        stats.push({
          databaseId: dbId, queryId, capturedAt,
          calls: Number(row.calls),
          totalExecTime: row.total_exec_time,
          rows: Number(row.rows),
          sharedBlksHit: Number(row.shared_blks_hit),
          sharedBlksRead: Number(row.shared_blks_read),
          statsReset: row.stats_reset,
        });
      }
      await insertQueryStats(client, stats);

      // `size_bytes === null` means the relation was dropped between the
      // pg_class scan and the size call. Skipped, never stored: `Number(null)`
      // is 0, and a 0-byte snapshot reads on a space chart as the table
      // shrinking to nothing rather than as pgops not having measured it. See
      // SPACE_SQL, and why this lives here rather than in its WHERE clause.
      const space: SpaceSnapshot[] = spaceResult.rows
        .filter((r) => r.size_bytes !== null)
        .map((r) => ({
          databaseId: dbId, relation: r.relation,
          capturedAt, sizeBytes: Number(r.size_bytes),
        }));
      await insertSpaceStats(client, space);

      // Same transaction as the inserts: retention cannot drift from capture.
      await prune(client, dbId, retention);
      await client.query('COMMIT');
      return queryStatsError === undefined
        ? { ok: true, shapes: stats.length, relations: space.length }
        : { ok: true, shapes: stats.length, relations: space.length, queryStatsError };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, reason: 'error', message: messageOf(err) };
    }
  } catch (err) {
    return { ok: false, reason: 'error', message: messageOf(err) };
  } finally {
    // `locked`, not `databaseId !== null`: on the skipped path this session
    // never acquired the lock, and unlocking one you do not hold makes
    // Postgres log `WARNING: you don't own a lock of type ExclusiveLock` into
    // the STORE's log on every skipped tick — noise that reads, to whoever
    // finds it, like pgops mismanaging locks.
    if (locked && databaseId !== null) await releaseCaptureLock(client, databaseId);
    // `release()`, not `client.release()`: this is guardClient's release, which
    // removes the 'error' listener before handing the connection back, so a
    // reused connection does not accumulate one per capture.
    release();
  }
}

interface QueryRow {
  queryid: string; query: string | null; calls: string;
  total_exec_time: number; rows: string;
  shared_blks_hit: string; shared_blks_read: string;
  stats_reset: Date | null;
}
/** `size_bytes` is NULL for a relation dropped mid-scan — see SPACE_SQL. */
interface SpaceRow { relation: string; size_bytes: string | null }
