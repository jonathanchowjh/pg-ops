import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { auditMeta, bad, failed, json, openAction } from '@/lib/action-route';
import { eventFor } from '@/lib/samples';

/**
 * Tier 1: the gate plus an inline confirmation, no typed confirmation —
 * ANALYZE refreshes statistics rather than destroying them.
 *
 * One table, named in the body. The name is compared with the catalog's in a
 * bind parameter and never interpolated.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name);
  if (opened instanceof Response) return opened;

  const { relation } = opened.body;
  if (typeof relation !== 'string' || relation === '') return bad('relation is required.');

  try {
    const results = await ACTIONS.analyzeTables(opened.ctx, auditMeta(opened, name, 'web/table'), { relation, limit: 1 });
    if (results.length === 0) return bad('No such table.', 404);
    // On the table, so its own page marks it.
    if (results.some((r) => r.ok)) await eventFor(name, 'analyze', relation);
    return json({ results }, 200);
  } catch (err) {
    return failed(err);
  }
}
