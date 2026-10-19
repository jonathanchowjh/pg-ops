import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { auditMeta, failed, json, openAction } from '@/lib/action-route';
import { eventFor } from '@/lib/samples';

/**
 * Tier 2: the gate, plus the database name typed back.
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
    await ACTIONS.resetQueryStats(opened.ctx, auditMeta(opened, name, 'web/queries'));
  } catch (err) {
    return failed(err);
  }
  await eventFor(name, 'reset');
  return json({ ok: true }, 200);
}
