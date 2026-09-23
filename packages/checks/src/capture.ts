import { redactSecrets } from './redact.js';
import { guardClient, messageOf } from './run.js';
import { HYGIENE_CHECK_IDS } from './checks/areas.js';
import { CHECKS } from './registry.js';
import { runCheck } from './run.js';
import { deltas, type CounterPoint } from './series/query-stats.js';
import { releaseCaptureLock, tryCaptureLock } from './store/lock.js';
import { readLastSnapshot } from './store/read.js';
import {
  RETENTION, insertQueryLoad, insertQueryStats, insertSpaceStats, prune, recordCheckResults,
  upsertDatabase, upsertQueries,
  type QueryStatsSnapshot, type Retention, type SpaceSnapshot, type StoredCheckWrite,
} from './store/write.js';
import type { Check, CheckContext, CheckResult, FailureReason } from './types.js';

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

      // The whole database's work in THIS interval, differenced here rather
      // than at read time — see migration 004 for the arithmetic that would
      // otherwise land on a page polling every five seconds. The previous
      // snapshot is read on the client this transaction already holds.
      const load = queryLoadRow(stats, await readLastSnapshot(client, dbId, capturedAt));
      if (load !== null) await insertQueryLoad(client, dbId, capturedAt, load);

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


/**
 * Sum one interval's work across every shape, or report that there was no
 * interval to measure.
 *
 * `deltas` is called per shape rather than reimplemented, which is the whole
 * point: the discontinuity rule (series/query-stats.ts) is one rule with one
 * set of tests, and a second copy of it here would drift. A shape whose
 * interval spans a `pg_stat_statements_reset()` or an LRU eviction yields no
 * interval and contributes NOTHING — not a clamped zero, which would read on
 * the chart as a quiet five minutes rather than as a gap.
 *
 * `null` when no shape contributed: the first capture of a database, a
 * database whose pg_stat_statements is unavailable, and a cluster-wide reset
 * all reach it. No row is written, so the chart draws a gap there. A zero row
 * would be the "we could not look" / "we looked and it was idle" conflation
 * this project holds a line against everywhere else.
 *
 * Exported for its own unit test — it is the one piece of capture that is
 * pure arithmetic, and the reset case is awkward to stage against a live
 * database.
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
    // Absent means pgops had not seen this shape at the previous capture.
    // Its counter is cumulative since ITS first sighting, so there is no
    // interval here, only a total of unknown age.
    if (prev === undefined) continue;
    const [interval] = deltas([prev, counterPoint(s)]);
    if (interval === undefined) continue;
    totalExecTime += interval.totalExecTime;
    calls += interval.calls;
    measured += 1;
  }
  return measured === 0 ? null : { totalExecTime, calls };
}

/** A snapshot as the series code sees it. Same fields, different shape. */
function counterPoint(s: QueryStatsSnapshot): CounterPoint {
  return {
    capturedAt: s.capturedAt,
    calls: s.calls,
    totalExecTime: s.totalExecTime,
    rows: s.rows,
    sharedBlksHit: s.sharedBlksHit,
    sharedBlksRead: s.sharedBlksRead,
    statsReset: s.statsReset,
  };
}

/**
 * One check's result, flattened for the cache.
 *
 * Exported for its own unit test: the failure branch is the one that matters
 * and it is awkward to provoke against a live database. A check that could
 * not run is STORED, carrying its message and no level — "we could not look"
 * is a reading the triage line has to show. Were it skipped, the previous
 * pass's verdict would sit in the cache going stale while reading as current.
 *
 * A check that ran and reached no verdict stores `level: null`, not `ok`:
 * 15 of the 21 hygiene checks report a reading and never judge, and this
 * project holds "we do not judge" distinct from "we judged and it is fine"
 * everywhere else (spec 2026-09-03 §1.1).
 */
export function checkResultRow(checkId: string, result: CheckResult<unknown>): StoredCheckWrite {
  if (!result.ok) {
    return { checkId, ok: false, level: null, note: null, message: result.message };
  }
  return {
    checkId,
    ok: true,
    level: result.verdict?.level ?? null,
    note: result.verdict?.note ?? null,
    message: null,
  };
}

export type HygieneOutcome =
  | { ok: true; checks: number; failed: number }
  | { ok: false; reason: FailureReason; message: string }
  | { ok: 'skipped'; reason: 'locked' };

/**
 * Run every `class: 'hygiene'` check against one database and cache what it
 * found, so the triage page can report a finding nobody opened a page for.
 *
 * SEPARATE FROM `captureOnce`, AND AFTER IT. That function holds one store
 * client across two scans of the monitored database, every insert and the
 * prune, in a single transaction, so that retention cannot drift from
 * capture. These are 21 catalog scans, each allowed ten seconds by its own
 * `timeoutMs`; run inside that transaction they would hold the store's write
 * path open for minutes at a time. The scans here need no transaction at all
 * — they are independent reads — and only the write at the end does.
 *
 * SEQUENTIAL, for the same reason the scheduler iterates databases in series:
 * a diagnostic tool must never be the reason a database runs out of
 * connections. Twenty-one scans at up to ten seconds each is bounded well
 * inside the five-minute interval, and the tick that follows is skipped
 * rather than queued if it is not.
 *
 * NEVER throws, same contract as `captureOnce` and for the same reason: it
 * runs on a background timer, where an unhandled rejection takes the web
 * process down.
 */
export async function captureHygiene(
  ctx: CheckContext,
  name: string,
): Promise<HygieneOutcome> {
  if (!ctx.store) {
    return {
      ok: false,
      reason: 'missing-store',
      message: 'No store configured; set PGOPS_STORE_URL to record hygiene findings.',
    };
  }
  const store = ctx.store;
  let client;
  let release;
  try {
    client = await store.connect();
    // See captureOnce: a checked-out client with no 'error' listener turns a
    // store failover into a fatal unhandled event rather than a failed pass.
    release = guardClient(client);
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: messageOf(err) };
  }

  let databaseId: number | null = null;
  let locked = false;
  try {
    databaseId = await upsertDatabase(client, name);
    if (!(await tryCaptureLock(client, databaseId))) {
      // Another replica is already scanning this database. Skip, never queue.
      return { ok: 'skipped', reason: 'locked' };
    }
    locked = true;

    const rows: StoredCheckWrite[] = [];
    for (const id of HYGIENE_CHECK_IDS) {
      // The cast is the price of iterating a heterogeneous registry: every
      // hygiene check takes either no options or an options object whose
      // every field is optional, so `{}` is the canonical input — and it is
      // the same input every hygiene PAGE passes, which is what makes the
      // cached result the page's own result rather than a second opinion.
      const check = CHECKS[id as keyof typeof CHECKS] as unknown as Check<unknown, unknown, unknown>;
      // runCheck never rejects: a timeout, a missing privilege and a dropped
      // relation all come back as `ok: false` and are cached as such.
      rows.push(checkResultRow(id, await runCheck(ctx, check, {})));
    }

    await writeCheckPass(client, databaseId, rows);
    return { ok: true, checks: rows.length, failed: rows.filter((r) => !r.ok).length };
  } catch (err) {
    return { ok: false, reason: 'error', message: messageOf(err) };
  } finally {
    if (locked && databaseId !== null) await releaseCaptureLock(client, databaseId);
    release();
  }
}


/**
 * Stamp one pass with the STORE's clock and write it.
 *
 * The timestamp comes from the store rather than from `new Date()` here, for
 * the reason `captureOnce` gives at length: several replicas may write the
 * same database, and under clock skew a process-side timestamp makes "how
 * old is this reading" wrong on the page that renders it — which, for these
 * rows, is the whole content of the line.
 */
async function writeCheckPass(
  client: import('pg').PoolClient,
  databaseId: number,
  rows: readonly StoredCheckWrite[],
): Promise<void> {
  const { rows: at } = await client.query<{ now: Date }>('SELECT now() AS now');
  await recordCheckResults(client, databaseId, at[0]!.now, rows);
}

/**
 * Cache the results a PAGE just computed.
 *
 * The hygiene pages run their checks on visit, as they always have. This
 * writes what they found into the same cache the capture tick fills, so the
 * triage line and the page agree the moment anyone has looked — rather than
 * the line reporting a five-minute-old finding the page has just disproved.
 *
 * No advisory lock, deliberately. The lock in `captureHygiene` exists to stop
 * two replicas SCANNING the same database at once; the scan here has already
 * happened, and what is left is one upsert whose conflict resolution is
 * last-write-wins by design.
 *
 * Never throws: a page must render its checks even when the store is
 * unreachable. The caller gets `false` and shows nothing about it — a failed
 * cache write is not a finding about the database, and the triage line
 * already reports its own staleness.
 */
export async function cacheCheckPass(
  store: import('pg').Pool,
  name: string,
  rows: readonly StoredCheckWrite[],
): Promise<boolean> {
  if (rows.length === 0) return true;
  let client;
  let release;
  try {
    client = await store.connect();
    release = guardClient(client);
  } catch {
    return false;
  }
  try {
    const databaseId = await upsertDatabase(client, name);
    await writeCheckPass(client, databaseId, rows);
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}
