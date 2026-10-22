import type { ActionMeta, CheckContext } from './types.js';
import { guardClient, messageOf, ownSql } from './run.js';
import { ownSession, visibleSchemas } from './checks/shared.js';
import { audited } from './audit.js';

/**
 * Outcome of a kill attempt.
 * - `terminated`     — the session we selected was still on that pid, still
 *                       a client backend, and was killed.
 * - `session-changed`— the pid is live but the guard refused it: either it
 *                       now belongs to a different session (the pid was
 *                       reused), or it is not a client backend.
 * - `gone`           — the pid is no longer present; nothing to do.
 */
type KillOutcome = 'terminated' | 'session-changed' | 'gone';

interface KillTarget {
  pid: number;
  /** Session identity captured at selection (pg_stat_activity.backend_start::text). */
  backendStart: string | null;
}

/**
 * Terminate one backend. The only place in this package that issues
 * pg_terminate_backend, which needs pg_signal_backend or superuser. Killing a
 * blocker does not cascade to its waiters. Every call is audit-logged,
 * success or failure.
 *
 * Four guards. Postgres reuses backend pids and the operator may take a
 * while to confirm, so the kill is pinned to the `backend_start` captured at
 * selection. Only a `'client backend'` is killed: `pg_blocking_pids()` can
 * name an autovacuum worker. Only one of this database:
 * pg_stat_activity is server-wide, and `/db/a` must not end a session of `b`.
 * And never pgops's own: the tree does not list them, but a hand-made POST
 * could end the connection running the kill, or a capture mid-write.
 *
 * All four sit in the same CASE as the terminate, against one row from one
 * snapshot of pg_stat_activity. A validating SELECT followed by a separate
 * terminate would leave a window for the pid to be recycled in between. When
 * a guard fails the THEN branch is never evaluated, so no signal is sent;
 * kill.int.test.ts holds this against a real non-client backend.
 */
const KILL_SQL = ownSql(`SELECT CASE WHEN backend_start = $2::timestamptz
            AND backend_type = 'client backend'
            AND datname = current_database()
            AND pid <> pg_backend_pid() AND NOT ${ownSession('application_name')}
            THEN pg_terminate_backend(pid)
            ELSE NULL END AS terminated
FROM pg_stat_activity
WHERE pid = $1`);

export async function killBackend(ctx: CheckContext, target: KillTarget, meta: ActionMeta): Promise<KillOutcome> {
  return audited('kill', meta, () => ({ pid: target.pid, backend_start: target.backendStart }), async () => {
    const { rows } = await ctx.target.query<{ terminated: boolean | null }>(
      KILL_SQL,
      [target.pid, target.backendStart],
    );
    const row = rows[0];
    if (!row) return 'gone';
    if (row.terminated === true) return 'terminated';
    // The CASE guard refused: wrong identity, wrong backend_type, or both.
    if (row.terminated === null) return 'session-changed';
    // Guard passed but pg_terminate_backend returned false: the backend
    // exited between the scan and the signal.
    return 'gone';
  }, (outcome) => outcome);
}

interface BulkKillResult {
  pid: number;
  outcome: KillOutcome;
  /**
   * Present only when `killBackend` threw, most plausibly because the role
   * lacks `pg_signal_backend`. The outcome is then `gone` because nothing was
   * observed to die; this field distinguishes that from "already finished".
   */
  error?: string;
}

/**
 * `killBackend` applied to each target in turn, so every target keeps its
 * own `backend_start` guard and its own audit record.
 *
 * Sequential on purpose: the database is already unwell, and concurrent
 * calls would interleave the audit trail. One target throwing does not
 * abandon the rest.
 */
export async function killLongRunning(
  ctx: CheckContext,
  targets: readonly KillTarget[],
  meta: ActionMeta,
): Promise<BulkKillResult[]> {
  const results: BulkKillResult[] = [];
  for (const target of targets) {
    try {
      results.push({ pid: target.pid, outcome: await killBackend(ctx, target, meta) });
    } catch (err) {
      results.push({ pid: target.pid, outcome: 'gone', error: messageOf(err) });
    }
  }
  return results;
}

interface AnalyzeResult {
  /** Schema-qualified and already quoted, exactly as issued. */
  relation: string;
  ok: boolean;
  error?: string;
}

/** How many tables one call analyzes when the caller names neither a limit nor a table. */
const ANALYZE_DEFAULT_TABLES = 50;

interface AnalyzeOpts {
  /**
   * Skip tables smaller than this. Compared against the planner's `relpages`
   * estimate of the main heap, so a table never yet analyzed reads as 0 and
   * is skipped by any non-zero filter.
   */
  minSizeBytes?: number;
  /** Hard cap on how many statements one press may issue. */
  limit?: number;
  /** Only this table, by its schema-qualified name as the catalog prints it. A bind parameter: the name issued is still the catalog's, quoted. */
  relation?: string;
  /** Per-table lock wait. Default 5s; lowered only by tests. */
  lockTimeoutMs?: number;
  /** Per-table statement ceiling. Default 120s. */
  statementTimeoutMs?: number;
}

/**
 * The relation list, largest first so a clipped list still covers the tables
 * that matter most.
 *
 * `ANALYZE` cannot take a parameterised identifier, so the name is
 * interpolated. It is safe because no name comes from a caller: every
 * identifier comes out of pg_class already quoted by `quote_ident`.
 *
 * `visibleSchemas` keeps other sessions' `pg_temp_N` schemas out.
 *
 * Sized from `relpages`, not `pg_total_relation_size`. The function opens
 * each relation under an AccessShareLock, so one table held ACCESS EXCLUSIVE
 * by a migration would block this listing query, which has no timeout.
 * `relpages` is a pg_class column and locks nothing, so a locked table costs
 * one failed row. It is the planner's estimate of the main heap only (no
 * indexes or TOAST, 0 if never analyzed): good enough to order by, not a size
 * to report.
 */
const TABLES_SQL = ownSql(`SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS qualified
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND ${visibleSchemas('n.nspname')}
  AND c.relpages::bigint * current_setting('block_size')::bigint >= $1
  AND ($3::text IS NULL OR n.nspname || '.' || c.relname = $3)
ORDER BY c.relpages DESC, n.nspname, c.relname
LIMIT $2`);

/**
 * Milliseconds, coerced to a non-negative integer. `SET LOCAL` takes no
 * parameter, so these values are interpolated, and they arrive in an options
 * object a route can reach.
 */
function ms(value: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * One ANALYZE per table, each in its own transaction with its own timeouts,
 * each failure recorded rather than thrown.
 *
 * `SET LOCAL`, never a bare `SET`: the client is pooled, and a timeout left
 * behind would apply to whatever ran on it next.
 *
 * `guardClient` because a client that errors mid-ANALYZE and is released
 * without it emits an unhandled `error` event.
 */
export async function analyzeTables(
  ctx: CheckContext,
  meta: ActionMeta,
  opts: AnalyzeOpts = {},
): Promise<AnalyzeResult[]> {
  const lockMs = ms(opts.lockTimeoutMs ?? 5_000, 5_000);
  const stmtMs = ms(opts.statementTimeoutMs ?? 120_000, 120_000);
  const results: AnalyzeResult[] = [];

  return audited('analyze', meta, () => ({ relations: results.map((r) => r.relation) }), async () => {
    const { rows } = await ctx.target.query<{ qualified: string }>(
      TABLES_SQL, [opts.minSizeBytes ?? 0, opts.limit ?? ANALYZE_DEFAULT_TABLES, opts.relation ?? null]);

    const client = await ctx.target.connect();
    const release = guardClient(client);
    try {
      for (const { qualified } of rows) {
        try {
          // Marked as pgops's own so these stay out of the Queries ranking.
          await client.query(ownSql('BEGIN'));
          await client.query(ownSql(`SET LOCAL lock_timeout = ${lockMs}`));
          await client.query(ownSql(`SET LOCAL statement_timeout = ${stmtMs}`));
          await client.query(ownSql(`ANALYZE ${qualified}`));
          await client.query(ownSql('COMMIT'));
          results.push({ relation: qualified, ok: true });
        } catch (err) {
          // Until this runs, every statement on this connection fails with
          // "current transaction is aborted".
          await client.query(ownSql('ROLLBACK')).catch(() => {});
          results.push({ relation: qualified, ok: false, error: messageOf(err) });
        }
      }
    } finally {
      release();
    }
    return results;
  }, (done) => {
    const failed = done.filter((r) => !r.ok).length;
    return failed === 0 ? `ok: ${done.length}` : `partial: ${done.length - failed} ok, ${failed} failed`;
  });
}

/**
 * The only file in this package permitted to name a statistics reset
 * function; guards.test.ts holds this. Capture never resets, because a reset
 * breaks every other consumer of the statistics.
 *
 * Three arguments, never four: `minmax_only` arrived in PG 15 and a
 * four-argument call does not resolve on 14. The return value is ignored
 * because it is `void` on 14 and a timestamptz on 15+.
 *
 * Scoped to this database's oid. The view is shared across the cluster, so
 * the zero-argument form wipes every database's statements.
 */
const RESET_QUERY_STATS_SQL = ownSql(`SELECT pg_stat_statements_reset(
         0,
         (SELECT oid FROM pg_database WHERE datname = current_database()),
         0)`);

export async function resetQueryStats(ctx: CheckContext, meta: ActionMeta): Promise<void> {
  await audited('reset-query-stats', meta, () => ({}),
    () => ctx.target.query(RESET_QUERY_STATS_SQL), () => 'ok');
}

/**
 * Resets table, index and function statistics for this database — everything
 * the `tables` and `indexes` reads count. The catalog reports it
 * afterwards, and a captured interval that spans it is dropped rather than
 * charted as a spike.
 */
export async function resetStats(ctx: CheckContext, meta: ActionMeta): Promise<void> {
  await audited('reset-stats', meta, () => ({}),
    () => ctx.target.query(ownSql('SELECT pg_stat_reset()')), () => 'ok');
}
