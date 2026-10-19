import type { ActionMeta, CheckContext } from '../types.js';
import { guardClient, messageOf, ownSql } from '../run.js';
import { visibleSchemas } from '../checks/shared.js';
import { audited } from './audited.js';

export interface AnalyzeResult {
  /** Schema-qualified and already quoted, exactly as issued. */
  relation: string;
  ok: boolean;
  error?: string;
}

/** How many tables one call analyzes when the caller names neither a limit nor a table. */
export const ANALYZE_DEFAULT_TABLES = 50;

export interface AnalyzeOpts {
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
