import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { auditMeta, failed, json, openAction } from '@/lib/action-route';
import { eventFor } from '@/lib/samples';

/**
 * Tier 2: the gate, plus the database name typed back.
 *
 * pg_stat_reset() clears table, index and function statistics for this
 * database — everything the `tables` and `indexes` reads count.
 * The next health minute carries the new reset time, which the Server
 * head shows; the catalog has it from the next capture. Any captured
 * interval spanning it is dropped.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name, { confirm: name });
  if (opened instanceof Response) return opened;

  try {
    await ACTIONS.resetStats(opened.ctx, auditMeta(opened, name, 'web/server'));
  } catch (err) {
    return failed(err);
  }
  await eventFor(name, 'reset');
  return json({ ok: true }, 200);
}
