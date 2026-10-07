import type { ActionMeta, CheckContext } from '../types.js';
import { guardClient, ownSql } from '../run.js';
import { visibleSchemas } from '../checks/indexes.js';
import { writeAudit } from './audit.js';

export interface AnalyzeResult {
  /** Schema-qualified and already quoted, exactly as issued. */
  relation: string;
  ok: boolean;
  error?: string;
}

export interface AnalyzeOpts {
  /**
   * Skip tables smaller than this. pgHero's `min_size`.
   *
   * Compared against the planner's `relpages` estimate of the main heap, not
   * an exact size — see TABLES_SQL for why the exact measure cannot be used
   * here. A table never yet analyzed reads as 0 and is skipped by any non-zero
   * filter.
   */
  minSizeBytes?: number;
  /** Hard cap on how many statements one press may issue. */
  limit?: number;
  /** Per-table lock wait. pgHero uses 5s; lowered only by tests. */
  lockTimeoutMs?: number;
  /** Per-table statement ceiling. pgHero uses 120s. */
  statementTimeoutMs?: number;
}

/**
 * The relation list, with the catalog doing the quoting.
 *
 * `ANALYZE` cannot take a parameterised identifier, so the name is
 * interpolated — and the defence is not an escaping function but the ABSENCE
 * of a caller-supplied name. Every identifier here comes out of pg_class
 * already quoted by `quote_ident`, verified against a schema named `we;ird`
 * holding a table named `tab"le`.
 *
 * `visibleSchemas`, not pgHero's two-name filter. `analyze_tables` rejects
 * only information_schema and pg_catalog, which leaves every `pg_temp_N`
 * schema in scope — another session's temp tables. That hole was found once
 * already in this repo (verified on 17.11) and the helper exists because of
 * it; there is no reason to re-dig it here.
 *
 * Ordered largest first: if the cap clips the list, the tables whose
 * statistics matter most are the ones that got analyzed.
 *
 * SIZED FROM `relpages`, NOT `pg_total_relation_size`, and this is the
 * important line in the file.
 *
 * `pg_total_relation_size` OPENS each relation, which takes an AccessShareLock
 * — and that conflicts with ACCESS EXCLUSIVE. So a single table locked by a
 * concurrent migration makes the LISTING query block, before any ANALYZE has
 * been attempted, on a plain pool query carrying no timeout at all. Measured:
 * the action hung for the full 120s statement_timeout rather than failing one
 * row after its 5s lock wait. pgHero has the same hang, because
 * `analyze_tables` sizes its list through `table_stats`.
 *
 * `relpages` is a pg_class COLUMN. Reading it opens nothing and locks nothing,
 * so one locked table now costs exactly one failed row — which is the whole
 * point of per-table transactions. Putting a timeout on the listing instead
 * would have been worse: it would fail the entire batch because one table was
 * busy.
 *
 * The cost is that the size is the planner's estimate of the MAIN HEAP, last
 * set by vacuum or analyze, excluding indexes and TOAST — so it is 0 for a
 * table that has never been analyzed. That is acceptable for both jobs it
 * does here: ordering is a heuristic for which tables matter most, and ANALYZE
 * samples the heap anyway. It is NOT a size to report to anyone; nothing here
 * does.
 */
const TABLES_SQL = ownSql(`SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS qualified
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND ${visibleSchemas('n.nspname')}
  AND c.relpages::bigint * current_setting('block_size')::bigint >= $1
ORDER BY c.relpages DESC, n.nspname, c.relname
LIMIT $2`);

/**
 * Milliseconds, coerced.
 *
 * The one interpolation in this file that is not catalog-sourced: `SET LOCAL`
 * takes no parameter, and these values arrive in an options object a route can
 * reach. A non-finite or negative value would either break the statement or
 * silently disable the timeout, so it is floored to an integer here rather
 * than trusted.
 */
function ms(value: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * #47. One ANALYZE per table, each in its own transaction with its own
 * timeouts, each failure recorded rather than thrown.
 *
 * `SET LOCAL`, never a bare `SET`: this client comes from the pool every check
 * on the page shares, and a statement_timeout left behind would apply to
 * whatever ran on it next. `SET LOCAL` is scoped to the transaction and
 * unwinds with it.
 *
 * One client for the batch, with a ROLLBACK in the catch. After a failed
 * statement the connection is inside a failed transaction and EVERY
 * subsequent statement on it errors until it is unwound — so the rollback is
 * what lets the loop continue at all, not tidiness. Checking out a fresh
 * client per table instead would drain a pool sized for a web console.
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
  let result = 'unknown';

  try {
    const { rows } = await ctx.target.query<{ qualified: string }>(
      TABLES_SQL, [opts.minSizeBytes ?? 0, opts.limit ?? 50]);

    const client = await ctx.target.connect();
    const release = guardClient(client);
    try {
      for (const { qualified } of rows) {
        try {
          // All marked as pgops's own, the ANALYZE included: an operator who
          // clicks this and then opens Queries should not find the click.
          await client.query(ownSql('BEGIN'));
          await client.query(ownSql(`SET LOCAL lock_timeout = ${lockMs}`));
          await client.query(ownSql(`SET LOCAL statement_timeout = ${stmtMs}`));
          await client.query(ownSql(`ANALYZE ${qualified}`));
          await client.query(ownSql('COMMIT'));
          results.push({ relation: qualified, ok: true });
        } catch (err) {
          // Unwind before the next iteration: until this runs, every statement
          // on this connection fails with "current transaction is aborted".
          await client.query(ownSql('ROLLBACK')).catch(() => {});
          results.push({
            relation: qualified,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      release();
    }

    const failed = results.filter((r) => !r.ok).length;
    result = failed === 0
      ? `ok: ${results.length}`
      : `partial: ${results.length - failed} ok, ${failed} failed`;
    return results;
  } catch (err) {
    result = `error: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    try {
      await writeAudit({
        action: 'analyze',
        subcommand: meta.subcommand,
        ...(meta.actor ? { user: meta.actor } : {}),
        target: { ...meta.extra, relations: results.map((r) => r.relation) },
        reason: meta.reason,
        result,
      });
    } catch (err) {
      console.error('pgops: writeAudit threw despite its no-reject contract; analyze unaffected:', err);
    }
  }
}
