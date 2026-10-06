import type { ActionMeta, CheckContext } from '../types.js';
import { ownSql } from '../run.js';
import { writeAudit } from './audit.js';

/**
 * #20 and #31 — the two destructive-but-bounded actions, and the ONLY file in
 * this package permitted to name a statistics reset function.
 *
 * guards.test.ts pins that allowlist by exact equality. The guard exists
 * because pgHero's `capture_query_stats` calls a statements reset as PART OF
 * CAPTURE, which silently breaks every other consumer on the database; the
 * parent spec §4.3 calls not doing that the strongest product claim in this
 * design. Nothing here touches capture. These run only when an operator
 * presses a tier-2 control, types the database name back to confirm, and
 * supplies a reason that is written to the audit log.
 *
 * Three arguments, never four. `minmax_only` arrived in PG 15 and the
 * supported floor is 14, where a four-argument call does not resolve at all.
 * The return value is ignored for the same reason: `void` on 14, a
 * timestamptz on 15+. (pgHero's "unknown OID 2278" comment is about that
 * `void` and predates the change.)
 *
 * Scoped to this database's oid, never the zero-argument form. The view is
 * SHARED ACROSS THE CLUSTER, so the bare call wipes every database's
 * statements — including those of consumers with nothing to do with the
 * operator's intent. That scoping is the difference between an action and an
 * incident.
 */
const RESET_QUERY_STATS_SQL = ownSql(`SELECT pg_stat_statements_reset(
         0,
         (SELECT oid FROM pg_database WHERE datname = current_database()),
         0)`);

export async function resetQueryStats(ctx: CheckContext, meta: ActionMeta): Promise<void> {
  let result = 'unknown';
  try {
    await ctx.target.query(RESET_QUERY_STATS_SQL);
    result = 'ok';
  } catch (err) {
    result = `error: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    await audit('reset-query-stats', meta, result);
  }
}

/**
 * Resets table, index and function statistics for this database — everything
 * `tableStats`, `indexUsage`, `unusedIndexes` and `unusedTables` read.
 *
 * #32 `lastStatsReset` reports it afterwards, and §3.5 correctly DROPS any
 * captured interval that spans it rather than charting the post-reset totals
 * as a spike. Both of those are honest behaviour; what they are not is a
 * warning, which has to reach the operator BEFORE the press. That is the
 * surface's job and the reason this is tier 2.
 */
export async function resetStats(ctx: CheckContext, meta: ActionMeta): Promise<void> {
  let result = 'unknown';
  try {
    await ctx.target.query(ownSql(`SELECT pg_stat_reset()`));
    result = 'ok';
  } catch (err) {
    result = `error: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    await audit('reset-stats', meta, result);
  }
}

/**
 * The audit write, shared by both.
 *
 * The inner try/catch is not defensive clutter. `writeAudit` is designed never
 * to reject, and an exception thrown from an `await` inside a `finally` would
 * REPLACE the enclosing block's outcome — turning a successful reset into a
 * reported failure, or masking the error a failed one is rethrowing. kill.ts
 * carries the same guard for the same reason.
 *
 * `extra` spreads first so caller-supplied metadata cannot overwrite a fixed
 * field.
 */
async function audit(action: string, meta: ActionMeta, result: string): Promise<void> {
  try {
    await writeAudit({
      action,
      subcommand: meta.subcommand,
      // Conditional spread, not `user: meta.actor` — see kill.ts: an explicit
      // `user: undefined` key is present-and-empty, which is the one state
      // that must never be recorded. Truthiness, so `actor: ''` falls back too.
      ...(meta.actor ? { user: meta.actor } : {}),
      target: { ...meta.extra },
      reason: meta.reason,
      result,
    });
  } catch (err) {
    console.error('pgops: writeAudit threw despite its no-reject contract; action unaffected:', err);
  }
}
