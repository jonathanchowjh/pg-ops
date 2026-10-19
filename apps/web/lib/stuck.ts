import { blockedByRoot, blockingCounts } from '@pgops/checks';
import type { CheckResult, FailureReason, LocksData, LongRunningData, Verdict } from '@pgops/checks';

export interface Stuck {
  /** Waiter pid → root blocker pid. Empty when the lock check could not run. */
  blockedBy: Map<number, number>;
  /** Root pid → sessions queued behind it. */
  blocking: Map<number, number>;
  /** Every long-running query is a waiter: nothing here is slow. */
  allStuck: boolean;
  /** The long-running result, with its guidance withheld when `allStuck`. */
  longRunning: CheckResult<LongRunningData>;
  /**
   * Why the lock graph could not be read, or null when it was.
   *
   * Without it, a table with no "blocked by" markers could be a database
   * with nothing blocked or one whose lock graph we could not see. The
   * reason travels rather than a boolean so the page can print it.
   */
  locksUnavailable: FailureReason | null;
}

/**
 * The verdict a long-running panel should show when every query in it is a
 * lock waiter.
 *
 * The level stays: these sessions are stuck. The note changes, because the
 * check's own note names the longest-running pid, which is a waiter the
 * panel's body says not to terminate. The new note counts the waiters and
 * names the root, the one pid an operator can act on.
 *
 * `stuckFrom` passes the wait graph's count (from `blockingCounts`), not the
 * panel's own row count. A waiter below the long-running floor, or a
 * truncated long-running page, would otherwise make this note disagree with
 * what the Locks page shows for the same root.
 */
function waitingVerdict(verdict: Verdict, count: number, root: number | undefined): Verdict {
  if (root === undefined) return verdict;
  return { ...verdict, note: `${count} waiting on ${root}` };
}

/**
 * The join two catalogs need and no single check can make: a session
 * blocked on a lock is `active` in pg_stat_activity, so every waiter is
 * also a long-running query. Shared so triage and Sessions agree.
 *
 * When the lock check failed, every long-runner is treated as slow, rather
 * than claiming nothing is blocked.
 */
export function stuckFrom(
  longRunning: CheckResult<LongRunningData>,
  locks: CheckResult<LocksData>,
): Stuck {
  const blockedBy = locks.ok ? blockedByRoot(locks.data.roots) : new Map<number, number>();
  const blocking = locks.ok ? blockingCounts(locks.data.roots) : new Map<number, number>();
  const queries = longRunning.ok ? longRunning.data.queries : [];
  const allStuck = queries.length > 0 && queries.every((q) => blockedBy.has(q.pid));
  const roots = new Set(queries.map((q) => blockedBy.get(q.pid)));
  const soleRoot = roots.size === 1 ? [...roots][0] : undefined;
  const longRunningOut = allStuck && longRunning.ok
    ? {
        ...longRunning,
        crossed: undefined,
        verdict: longRunning.verdict === null
          ? null
          : waitingVerdict(
              longRunning.verdict,
              (soleRoot === undefined ? undefined : blocking.get(soleRoot)) ?? queries.length,
              soleRoot,
            ),
      }
    : longRunning;
  return {
    blockedBy,
    blocking,
    allStuck,
    longRunning: longRunningOut,
    locksUnavailable: locks.ok ? null : locks.reason,
  };
}

/**
 * Every pid the lock graph accounts for: roots, waiters at any depth, and
 * cycle back-edges. The triage page folds on this. A back-edge is included
 * although `countDistinctWaiters` skips it: this is a membership test, not a
 * count.
 *
 * Empty when the check did not run, as well as when it ran and found
 * nothing, so a fold never demotes a verdict on the strength of a graph
 * nobody saw.
 */
export function chainPids(locks: CheckResult<LocksData>): Set<number> {
  const pids = new Set<number>();
  if (!locks.ok) return pids;
  const walk = (waiters: LocksData['roots'][number]['waiters']): void => {
    for (const w of waiters) {
      pids.add(w.pid);
      walk(w.waiters);
    }
  };
  for (const root of locks.data.roots) {
    pids.add(root.pid);
    walk(root.waiters);
  }
  return pids;
}
