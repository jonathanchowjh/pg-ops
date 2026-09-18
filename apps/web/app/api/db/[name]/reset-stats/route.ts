import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { json, openAction } from '@/lib/action-route';

/**
 * #31. Tier 2 (web spec §7.1): the gate, plus the database name typed back.
 *
 * pg_stat_reset() clears table, index and function statistics for this
 * database — everything tableStats, indexUsage, unusedIndexes and
 * unusedTables read. #32 lastStatsReset reports it afterwards and §3.5
 * correctly drops any captured interval spanning it, so nothing downstream
 * lies; what the operator needs is the warning BEFORE the press, which is the
 * typed confirmation and the page's wording.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name, { confirm: name });
  if (opened instanceof Response) return opened;

  try {
    await ACTIONS.resetStats(opened.ctx, {
      subcommand: 'web/queries',
      reason: opened.reason,
      actor: opened.actor,
      extra: { database: name },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
  return json({ ok: true }, 200);
}
