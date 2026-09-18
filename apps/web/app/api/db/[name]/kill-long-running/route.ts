import { connection } from 'next/server';
import { ACTIONS } from '@pgops/checks';
import { json, openAction } from '@/lib/action-route';

/**
 * #12. Tier 2 (web spec §7.1).
 *
 * The ladder names `reset` stats at tier 2 and `kill` at tier 1; this sits at
 * 2 on blast radius. One press terminates several sessions at once, and the
 * typed confirmation is what makes "several" a decision rather than a
 * consequence of a mis-click.
 *
 * Every target is validated the way the single-kill route validates its one,
 * because `ACTIONS.killLongRunning` is `killBackend` applied N times and each
 * call carries its own guard. `backendStart` is passed through EXACTLY as
 * received — re-deriving it server-side would compare the server's current
 * idea of the session against itself and always agree.
 */
const MAX_TARGETS = 100;

interface Target { pid: number; backendStart: string | null }

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;

  const opened = await openAction(req, name, { confirm: name });
  if (opened instanceof Response) return opened;

  const { targets } = opened.body;
  if (!Array.isArray(targets)) return json({ error: 'targets must be an array.' }, 400);
  // An operator who pressed a button expects something to have happened; an
  // empty list means the page and the server disagree about what was on
  // screen. The action itself stays total and returns [] for this.
  if (targets.length === 0) return json({ error: 'targets must not be empty.' }, 400);
  // An unbounded array is an unbounded loop of pg_terminate_backend issued
  // from a request handler.
  if (targets.length > MAX_TARGETS) {
    return json({ error: `targets must hold at most ${MAX_TARGETS} sessions.` }, 400);
  }

  const parsed: Target[] = [];
  for (const t of targets) {
    const { pid, backendStart } = (t ?? {}) as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return json({ error: 'every target needs a pid that is a positive integer.' }, 400);
    }
    if (backendStart !== undefined && backendStart !== null && typeof backendStart !== 'string') {
      return json({ error: 'backendStart must be the session identity string, or null.' }, 400);
    }
    parsed.push({ pid, backendStart: (backendStart as string | null) ?? null });
  }

  try {
    const results = await ACTIONS.killLongRunning(opened.ctx, parsed, {
      subcommand: 'web/sessions',
      reason: opened.reason,
      actor: opened.actor,
      extra: { database: name },
    });
    // Per-session outcomes, never a boolean: an operator told "done" when
    // three of five were refused would believe sessions are gone that are not.
    return json({ results }, 200);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
