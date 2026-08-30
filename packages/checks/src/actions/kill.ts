import type { CheckContext } from '../types.js';
import { writeAudit } from './audit.js';

/**
 * Outcome of a kill attempt.
 * - `terminated`     — the session we selected was still on that pid, still
 *                       a client backend, and was killed.
 * - `session-changed`— the pid is live but the guard refused it: either it
 *                       now belongs to a *different* session (the original
 *                       disconnected and the OS reused the pid), or it was
 *                       never a session we're willing to kill in the first
 *                       place (Ruling 38 below). Either way, terminating it
 *                       would not be terminating what the operator meant.
 * - `gone`           — the pid is no longer present; nothing to do.
 */
export type KillOutcome = 'terminated' | 'session-changed' | 'gone';

export interface KillTarget {
  pid: number;
  /** Session identity captured at selection (pg_stat_activity.backend_start::text). */
  backendStart: string | null;
}

export interface KillMeta {
  /** Which view/command issued the kill — audit-log field. */
  subcommand: string;
  /** Human-readable justification — audit-log field. */
  reason: string;
  /**
   * Who did it, when the caller knows better than this process does.
   *
   * `writeAudit` derives `user` from `currentActor()` — the OS user, plus
   * `process.env.HOSTNAME || hostname()`. That is right for a CLI on a
   * bastion host and wrong inside a container, where HOSTNAME is the
   * container ID, and wronger still once a Next standalone server pins it to
   * 0.0.0.0 so it binds on all interfaces (verified: next/dist/build/utils.js
   * generates `process.env.HOSTNAME || '0.0.0.0'` into server.js). A web
   * console authenticating an operator knows their name; nothing else in
   * this process does. Omitted, the fallback is unchanged.
   */
  actor?: string;
  /** Extra target metadata for the audit entry (user, app, held_mode, state…). */
  extra?: Record<string, unknown>;
}

/**
 * Terminate a backend. The only code path in this package that issues
 * pg_terminate_backend — see the plan's global constraint that names this
 * file specifically. Uses pg_terminate_backend() — requires pg_signal_backend
 * (or superuser). Parameterized, never string-built. One pid at a time;
 * killing a blocker does NOT cascade to its waiters. Every call is
 * audit-logged, success or failure.
 *
 * PID-reuse guard: the target is captured at selection time and may sit
 * through a human delay before the operator confirms. Postgres reuses
 * backend pids, so the kill is pinned to a stable session identity —
 * `backend_start` — captured at selection.
 *
 * Controller Ruling 38 — the non-client-backend guard: `blocked`'s
 * `suspectPid` comes from `pg_blocking_pids()`, which returns whoever
 * actually holds the conflicting lock, autovacuum workers included, and that
 * check deliberately keeps reporting such blockers (an operator needs to SEE
 * that autovacuum is what's blocking them). The refusal to actually kill one
 * belongs here, not there: `killBackend` refuses any target whose
 * `backend_type` is not `'client backend'`.
 *
 * Both guards — identity and backend type — live in the SAME CASE expression
 * as the terminate itself, evaluated against ONE row read from ONE snapshot
 * of pg_stat_activity. That is load-bearing, not stylistic: a pid read a
 * moment ago (by a check, or by a human deciding) may have exited and been
 * recycled onto a different backend — of a different type — by the time this
 * runs. A pre-flight `SELECT` that validates identity/type, followed by a
 * separate `pg_terminate_backend` call, reopens exactly that TOCTOU window:
 * the SELECT can see a valid client backend and the terminate can still hit
 * whatever pid now means by the time it runs. One statement that both
 * validates and terminates against the same read closes that window; two
 * statements cannot, no matter how small the gap between them. The CASE
 * expression also guarantees Postgres never EVALUATES the THEN branch when
 * either guard fails — this is not "compute pg_terminate_backend and then
 * decide whether to look at it", it is "the signal is never dispatched at
 * all" (proved against a real non-client backend in kill.int.test.ts, not
 * merely asserted against the SQL text).
 *
 * The three-valued return distinguishes terminated / refused / already-gone,
 * which a boolean cannot — an operator told "terminated" when nothing died
 * would go on to trust a session is gone that never was.
 */
const KILL_SQL = `
SELECT CASE WHEN backend_start = $2::timestamptz
            AND backend_type = 'client backend'
            THEN pg_terminate_backend(pid)
            ELSE NULL END AS terminated
FROM pg_stat_activity
WHERE pid = $1`;

export async function killBackend(ctx: CheckContext, target: KillTarget, meta: KillMeta): Promise<KillOutcome> {
  let outcome: KillOutcome = 'gone';
  let result = 'unknown';
  try {
    const { rows } = await ctx.target.query<{ terminated: boolean | null }>(
      KILL_SQL,
      [target.pid, target.backendStart],
    );
    const row = rows[0];
    if (!row) {
      // No row at all: the pid is not present.
      outcome = 'gone';
    } else if (row.terminated === true) {
      outcome = 'terminated';
    } else if (row.terminated === null) {
      // Matched the WHERE but the CASE guard refused: wrong identity, wrong
      // backend_type, or both — see the Ruling 38 discussion above.
      outcome = 'session-changed';
    } else {
      // Guard passed but pg_terminate_backend returned false: the backend
      // slipped away between the scan and the signal, within the same
      // statement. Same operator-facing meaning as gone.
      outcome = 'gone';
    }
    result = outcome;
    return outcome;
  } catch (err) {
    result = `error: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    // `extra` spreads FIRST, `pid`/`backend_start` after: this is the audit
    // trail for the only destructive action in this phase, and its subject
    // (which pid, which identity) must not be something caller-supplied
    // metadata can silently overwrite (e.g. an `extra.pid` colliding with
    // the real one). The two fixed fields always win.
    //
    // The inner try/catch is a second, independent guard on top of
    // writeAudit's own (see that function's doc comment for the fuller
    // reasoning): writeAudit is DESIGNED to never reject, but this call
    // does not TRUST that design blindly, because an exception thrown from
    // an `await` inside a `finally` block replaces the `try` block's return
    // value — so if any future edit to writeAudit ever breaks that
    // contract, this catch is what stands between that regression and
    // telling an operator a successful kill failed. Logged, not swallowed,
    // for the same reason writeAudit's own internal failures are logged
    // rather than silent.
    try {
      await writeAudit({
        action: 'kill',
        subcommand: meta.subcommand,
        // Conditional spread, not `user: meta.actor`: writeAudit defaults with
        // `record.user ?? currentActor()`, and an explicit `user: undefined`
        // key would still take that branch — but a future `??=`-style edit, or
        // any consumer reading the object shape, would see a `user` key that is
        // there and empty. Absent means absent.
        //
        // Truthiness, not `=== undefined`: `'' ?? currentActor()` keeps the
        // empty string (`??` only falls through on null/undefined), so that
        // comparison alone let `actor: ''` through as `user: ''` — present
        // and empty, the exact state the comment above says never to leave.
        // An empty actor is not a real one; both cases fall back the same way.
        ...(meta.actor ? { user: meta.actor } : {}),
        target: { ...meta.extra, pid: target.pid, backend_start: target.backendStart },
        reason: meta.reason,
        result,
      });
    } catch (err) {
      console.error('pgops: writeAudit threw despite its no-reject contract; kill outcome unaffected:', err);
    }
  }
}
