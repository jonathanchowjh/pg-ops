import { query } from './connection.js';
import { writeAudit } from './audit.js';

/**
 * Outcome of a kill attempt.
 * - `terminated`     — the session we selected was still on that pid; killed it.
 * - `session-changed`— the pid is live but belongs to a *different* session now
 *                      (the original disconnected and the OS reused the pid). We
 *                      refuse: killing it would terminate an innocent backend.
 * - `gone`           — the pid is no longer present; nothing to do.
 */
export type KillOutcome = 'terminated' | 'session-changed' | 'gone';

export interface KillTarget {
  pid: number;
  /** Session identity captured at selection (pg_stat_activity.backend_start::text). */
  backendStart: string | null;
}

export interface KillContext {
  /** Which view issued the kill — audit-log field. */
  subcommand: string;
  /** Human-readable justification — audit-log field. */
  reason: string;
  /** Extra target metadata for the audit entry (user, app, held_mode, state…). */
  meta?: Record<string, unknown>;
}

/**
 * Terminate a backend (plan §A1 kill action, §G threat model).
 *
 * Uses pg_terminate_backend() — requires pg_signal_backend (or superuser).
 * Parameterized, never string-built. One PID at a time; killing a blocker does
 * NOT cascade to its waiters. Every call is audit-logged.
 *
 * PID-reuse guard (deep-review follow-up H): the target is captured at `x`-press
 * and may sit through a human delay before `y`. Postgres reuses backend PIDs, so
 * we pin the kill to a stable session identity — `backend_start` — captured at
 * selection. The CASE guards the side-effecting call: pg_terminate_backend only
 * fires when the identity still matches, so a reused pid yields NULL (refused)
 * rather than a wrong-session kill that would still return true.
 */
const KILL_SQL = `
SELECT CASE WHEN backend_start = $2::timestamptz
            THEN pg_terminate_backend(pid)
            ELSE NULL END AS terminated
FROM pg_stat_activity
WHERE pid = $1
`;

export async function killBackend(target: KillTarget, ctx: KillContext): Promise<KillOutcome> {
  let outcome: KillOutcome = 'gone';
  let result = 'unknown';
  try {
    const rows = await query<{ terminated: boolean | null }>(KILL_SQL, [target.pid, target.backendStart]);
    const row = rows[0];
    if (!row) {
      // No row: the pid is not present at all.
      outcome = 'gone';
    } else if (row.terminated === true) {
      outcome = 'terminated';
    } else if (row.terminated === null) {
      // pid is live but backend_start differed — a different session now.
      outcome = 'session-changed';
    } else {
      // Matched but pg_terminate_backend returned false: the backend slipped
      // away between scan and signal. Same operator-facing meaning as gone.
      outcome = 'gone';
    }
    result = outcome;
    return outcome;
  } catch (err) {
    result = `error: ${(err as Error).message}`;
    throw err;
  } finally {
    await writeAudit({
      action: 'kill',
      subcommand: ctx.subcommand,
      target: { pid: target.pid, backend_start: target.backendStart, ...ctx.meta },
      reason: ctx.reason,
      result,
    }).catch(() => {
      // Never let an audit-log write failure mask the kill outcome.
    });
  }
}
