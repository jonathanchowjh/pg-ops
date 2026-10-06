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
   * The page needs this because the ABSENCE of a "blocked by" marker is
   * ambiguous on its own: a table with no markers is either a database with
   * nothing blocked or a database whose lock graph we could not see, and this
   * console's standing rule is that those two never render the same. The
   * reason travels rather than a boolean so the page can print it.
   */
  locksUnavailable: FailureReason | null;
}

/**
 * The verdict a long-running panel should show when every query in it is a
 * lock waiter.
 *
 * The LEVEL stays: these sessions are stuck and the panel must stay loud. The
 * NOTE changes, because the check's own note names the longest-running pid —
 * which, when they are all waiters, is the one pid the panel's own body says
 * never to terminate. Measured on a live chain: the badge read "pid 4512
 * running 100s" directly above "Terminating one frees nothing."
 *
 * The new note counts the waiters and names the ROOT, which is the one pid on
 * this page an operator can act on.
 *
 * `count` is the caller's to supply, and `stuckFrom` passes the WAIT GRAPH's
 * count (`blockingCounts`' `totalWaiters`), not the panel's own row count. A
 * waiter that has not yet crossed the long-running floor, or a truncated
 * long-running page, would otherwise leave a waiter off this panel's list
 * while the Locks page still counts it against the same root — this note
 * already names that root, a pid that may not even appear among the panel's
 * rows, so it is speaking about the graph and must agree with what Locks
 * shows for it. Anything else is this task's own defect one level up: the
 * console giving two answers to one question.
 */
function waitingVerdict(verdict: Verdict, count: number, root: number | undefined): Verdict {
  if (root === undefined) return verdict;
  return { ...verdict, note: `${count} waiting on ${root}` };
}

/**
 * The join two catalogs need and no single check can make: a session
 * blocked on a lock is `active` in pg_stat_activity, so every waiter is
 * also a long-running query. Only a page that holds both results can say
 * which. This is that page's logic, shared, so triage and Sessions agree.
 *
 * When the lock check failed, this degrades to the old behaviour — every
 * long-runner treated as slow — rather than to a claim that nothing is
 * blocked.
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
 * cycle back-edges.
 *
 * A17 folds the triage page on this. `blockedByRoot` answers "which root is
 * this waiter behind", which is the wrong question for a panel that may be
 * about the ROOT itself — Sessions by state judges the idle-in-transaction
 * blocker, Oldest snapshot names whichever session pins the horizon — so
 * membership needs its own walk.
 *
 * A cycle back-edge is included although `countDistinctWaiters` skips it:
 * that pid is genuinely in the chain, and this is a membership test, not a
 * count, so seeing it twice costs nothing.
 *
 * Empty when the check did not run, and empty when it ran and found nothing.
 * The first is the one that matters: a fold keyed on a reading this console
 * could not take would quietly demote four real verdicts on the strength of
 * a graph nobody saw, which is the false-negative the whole console is built
 * against.
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
