import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { auditMeta, bad, failed, json, openAction } from '@/lib/action-route';
import { eventFor } from '@/lib/samples';

/**
 * Tier 2: one press terminates several sessions, so the database name is
 * typed back.
 *
 * Each target is validated as the single-kill route validates its one.
 * `backendStart` is passed through exactly as received — re-deriving it
 * server-side would compare the server's current idea of the session against
 * itself and always agree.
 */
const MAX_TARGETS = 100;

interface Target { pid: number; backendStart: string | null }

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name, { confirm: name });
  if (opened instanceof Response) return opened;

  const { targets } = opened.body;
  if (!Array.isArray(targets)) return bad('targets must be an array.');
  // An empty list means the page and the server disagree about what was on
  // screen. The action itself returns [] for this.
  if (targets.length === 0) return bad('targets must not be empty.');
  // Bounds the loop of pg_terminate_backend calls.
  if (targets.length > MAX_TARGETS) {
    return bad(`targets must hold at most ${MAX_TARGETS} sessions.`);
  }

  const parsed: Target[] = [];
  for (const t of targets) {
    const { pid, backendStart } = (t ?? {}) as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return bad('every target needs a pid that is a positive integer.');
    }
    if (backendStart !== undefined && backendStart !== null && typeof backendStart !== 'string') {
      return bad('backendStart must be the session identity string, or null.');
    }
    parsed.push({ pid, backendStart: (backendStart as string | null) ?? null });
  }

  try {
    const results = await ACTIONS.killLongRunning(opened.ctx, parsed, auditMeta(opened, name, 'web/sessions'));
    // One mark for the press, not one per session.
    if (results.some((r) => r.outcome === 'terminated')) await eventFor(name, 'terminate');
    // Per-session outcomes, not a boolean: some may have been refused.
    return json({ results }, 200);
  } catch (err) {
    return failed(err);
  }
}
