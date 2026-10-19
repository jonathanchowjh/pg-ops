import type { ActionMeta, CheckContext } from '../types.js';
import { ownSql } from '../run.js';
import { audited } from './audited.js';

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
 * the `tables` and `indexes` reads count. `databaseActivity` reports it
 * afterwards, and a captured interval that spans it is dropped rather than
 * charted as a spike.
 */
export async function resetStats(ctx: CheckContext, meta: ActionMeta): Promise<void> {
  await audited('reset-stats', meta, () => ({}),
    () => ctx.target.query(ownSql('SELECT pg_stat_reset()')), () => 'ok');
}
