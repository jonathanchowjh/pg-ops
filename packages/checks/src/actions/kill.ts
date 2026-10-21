import type { ActionMeta, CheckContext } from '../types.js';
import { messageOf, ownSql } from '../run.js';
import { ownSession } from '../checks/shared.js';
import { audited } from './audited.js';

/**
 * Outcome of a kill attempt.
 * - `terminated`     — the session we selected was still on that pid, still
 *                       a client backend, and was killed.
 * - `session-changed`— the pid is live but the guard refused it: either it
 *                       now belongs to a different session (the pid was
 *                       reused), or it is not a client backend.
 * - `gone`           — the pid is no longer present; nothing to do.
 */
type KillOutcome = 'terminated' | 'session-changed' | 'gone';

interface KillTarget {
  pid: number;
  /** Session identity captured at selection (pg_stat_activity.backend_start::text). */
  backendStart: string | null;
}

/**
 * Terminate one backend. The only place in this package that issues
 * pg_terminate_backend, which needs pg_signal_backend or superuser. Killing a
 * blocker does not cascade to its waiters. Every call is audit-logged,
 * success or failure.
 *
 * Four guards. Postgres reuses backend pids and the operator may take a
 * while to confirm, so the kill is pinned to the `backend_start` captured at
 * selection. Only a `'client backend'` is killed: `pg_blocking_pids()` can
 * name an autovacuum worker. Only one of this database:
 * pg_stat_activity is server-wide, and `/db/a` must not end a session of `b`.
 * And never pgops's own: the tree does not list them, but a hand-made POST
 * could end the connection running the kill, or a capture mid-write.
 *
 * All four sit in the same CASE as the terminate, against one row from one
 * snapshot of pg_stat_activity. A validating SELECT followed by a separate
 * terminate would leave a window for the pid to be recycled in between. When
 * a guard fails the THEN branch is never evaluated, so no signal is sent;
 * kill.int.test.ts holds this against a real non-client backend.
 */
const KILL_SQL = ownSql(`SELECT CASE WHEN backend_start = $2::timestamptz
            AND backend_type = 'client backend'
            AND datname = current_database()
            AND pid <> pg_backend_pid() AND NOT ${ownSession('application_name')}
            THEN pg_terminate_backend(pid)
            ELSE NULL END AS terminated
FROM pg_stat_activity
WHERE pid = $1`);

export async function killBackend(ctx: CheckContext, target: KillTarget, meta: ActionMeta): Promise<KillOutcome> {
  return audited('kill', meta, () => ({ pid: target.pid, backend_start: target.backendStart }), async () => {
    const { rows } = await ctx.target.query<{ terminated: boolean | null }>(
      KILL_SQL,
      [target.pid, target.backendStart],
    );
    const row = rows[0];
    if (!row) return 'gone';
    if (row.terminated === true) return 'terminated';
    // The CASE guard refused: wrong identity, wrong backend_type, or both.
    if (row.terminated === null) return 'session-changed';
    // Guard passed but pg_terminate_backend returned false: the backend
    // exited between the scan and the signal.
    return 'gone';
  }, (outcome) => outcome);
}

interface BulkKillResult {
  pid: number;
  outcome: KillOutcome;
  /**
   * Present only when `killBackend` threw, most plausibly because the role
   * lacks `pg_signal_backend`. The outcome is then `gone` because nothing was
   * observed to die; this field distinguishes that from "already finished".
   */
  error?: string;
}

/**
 * `killBackend` applied to each target in turn, so every target keeps its
 * own `backend_start` guard and its own audit record.
 *
 * Sequential on purpose: the database is already unwell, and concurrent
 * calls would interleave the audit trail. One target throwing does not
 * abandon the rest.
 */
export async function killLongRunning(
  ctx: CheckContext,
  targets: readonly KillTarget[],
  meta: ActionMeta,
): Promise<BulkKillResult[]> {
  const results: BulkKillResult[] = [];
  for (const target of targets) {
    try {
      results.push({ pid: target.pid, outcome: await killBackend(ctx, target, meta) });
    } catch (err) {
      results.push({ pid: target.pid, outcome: 'gone', error: messageOf(err) });
    }
  }
  return results;
}
