import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { json, openAction } from '@/lib/action-route';

/**
 * #47. Tier 1 (web spec §7.1): the gate plus an inline confirmation, no typed
 * confirmation — ANALYZE refreshes statistics rather than destroying them.
 *
 * The cap is clamped HERE rather than trusted from the body. An unbounded
 * limit is one ANALYZE per relation in the catalog, issued from a request
 * handler; a caller that asks for more than MAX gets MAX, and the page states
 * which tables were covered.
 */
const MAX_TABLES = 200;
const DEFAULT_TABLES = 50;

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name);
  if (opened instanceof Response) return opened;

  const asked = opened.body.limit;
  if (asked !== undefined && (typeof asked !== 'number' || !Number.isInteger(asked) || asked <= 0)) {
    return json({ error: 'limit must be a positive integer.' }, 400);
  }
  const limit = Math.min(asked ?? DEFAULT_TABLES, MAX_TABLES);

  try {
    const results = await ACTIONS.analyzeTables(
      opened.ctx,
      {
        subcommand: 'web/cleanup',
        reason: opened.reason,
        actor: opened.actor,
        extra: { database: name },
      },
      { limit },
    );
    return json({ results }, 200);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
