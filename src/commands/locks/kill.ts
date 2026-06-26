import { query } from '../../core/connection.js';
import { writeAudit } from '../../core/audit.js';
import type { RootBlocker } from './chain.js';

/**
 * Terminate a backend (plan §A1 kill action, §G threat model).
 *
 * Uses pg_terminate_backend() — requires pg_signal_backend (or superuser).
 * Parameterized, never string-built. One PID at a time; killing a blocker does
 * NOT cascade to its waiters. Every call is audit-logged.
 */
export async function killBackend(root: RootBlocker): Promise<boolean> {
  let result = 'unknown';
  let terminated = false;
  try {
    const rows = await query<{ terminated: boolean }>(
      'SELECT pg_terminate_backend($1) AS terminated',
      [root.pid],
    );
    terminated = rows[0]?.terminated ?? false;
    result = terminated ? 'terminated' : 'no-such-backend';
    return terminated;
  } catch (err) {
    result = `error: ${(err as Error).message}`;
    throw err;
  } finally {
    await writeAudit({
      action: 'kill',
      subcommand: 'locks',
      target: {
        pid: root.pid,
        user: root.user,
        app: root.app,
        held_mode: root.heldMode,
      },
      reason: `blocking ${root.totalWaiters} waiter(s) for ${Math.round(root.heldForSecs ?? 0)}s`,
      result,
    }).catch(() => {
      // Never let an audit-log write failure mask the kill outcome.
    });
  }
}
