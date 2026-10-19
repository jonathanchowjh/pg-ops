import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { auditMeta, bad, failed, json, openAction } from '@/lib/action-route';
import { eventFor } from '@/lib/samples';

/**
 * Tier 1: the gate plus an inline confirmation, no typed confirmation. The
 * PID-reuse guard in killBackend is what makes a single kill safe.
 *
 * `killBackend` is reached only through `ACTIONS`; guards.test.ts holds which
 * files may name it. The gate, CSRF check, reason, context and actor are in
 * `lib/action-route.ts`, where the order of the checks is explained.
 *
 * `await connection()` is here for uniformity with every other rendering
 * path, not because a POST-only handler is known to need it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name);
  if (opened instanceof Response) return opened;

  const { pid, backendStart } = opened.body;

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return bad('pid must be a positive integer.');
  }
  // Absent means null: no identity captured, kill on pid alone.
  if (backendStart !== undefined && backendStart !== null && typeof backendStart !== 'string') {
    return bad('backendStart must be the session identity string, or null.');
  }

  // backendStart is passed through exactly as received, never looked up or
  // normalised server-side. killBackend's PID-reuse guard works only because
  // the identity was captured at selection time; re-deriving it here would
  // compare the server's current idea of the session against itself.
  try {
    const outcome = await ACTIONS.kill(
      opened.ctx,
      { pid, backendStart: (backendStart as string | null) ?? null },
      auditMeta(opened, name, 'web/tree'),
    );
    // A mark on the clock, so the chart shows what ended the chain.
    if (outcome === 'terminated') await eventFor(name, 'terminate');
    // All three outcomes are 200; the client distinguishes them.
    return json({ outcome }, 200);
  } catch (err) {
    return failed(err);
  }
}
