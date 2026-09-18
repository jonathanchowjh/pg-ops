import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { json, openAction } from '@/lib/action-route';

/**
 * #20. Tier 2 (web spec §7.1): the gate, plus the database name typed back.
 *
 * Scoped to this database inside the action — pg_stat_statements is shared
 * across the cluster and the unscoped reset wipes every database's
 * statements. See actions/stats.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name, { confirm: name });
  if (opened instanceof Response) return opened;

  try {
    await ACTIONS.resetQueryStats(opened.ctx, {
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
