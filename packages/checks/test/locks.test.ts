import { describe, expect, it } from 'vitest';
import {
  buildChains, countDistinctWaiters, locks, longestWaitSecs,
  type LockRow, type Waiter,
} from '../src/checks/locks.js';

const row = (pid: number, blockedBy: number[], app = `a${pid}`, waitSecs?: string | null): LockRow => ({
  pid, blocked_by: blockedBy, app, usename: 'u', state: 'active',
  query: 'q', backend_start: '2026-01-01T00:00:00Z',
  xact_age_secs: '1', waiting_mode: null, waiting_on: null,
  // Mirrors what the SQL's `HAVING count(*) > 0` produces: a session with no
  // ungranted lock — i.e. one that is not blocked — has no wait to report,
  // so its `wait_secs` comes back NULL rather than 0 (I3). Pass `waitSecs`
  // explicitly to model a specific wait duration.
  wait_secs: waitSecs !== undefined ? waitSecs : (blockedBy.length > 0 ? '1' : null),
});

describe('buildChains', () => {
  it('nests a chain', () => {
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [2])]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.pid).toBe(1);
    expect(roots[0]!.waiters[0]!.pid).toBe(2);
    expect(roots[0]!.waiters[0]!.waiters[0]!.pid).toBe(3);
    expect(roots[0]!.totalWaiters).toBe(2);
  });

  it('shows a diamond once and counts it once', () => {
    // 2 and 3 both blocked by 1; 4 blocked by both 2 and 3.
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [1]), row(4, [2, 3])]);
    expect(roots[0]!.totalWaiters).toBe(3);
  });

  it('surfaces a closed cycle instead of reporting no contention', () => {
    const roots = buildChains([row(1, [2]), row(2, [1])]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.waiters[0]!.waiters[0]!.cycle).toBe(true);
  });

  it('terminates a three-node cycle rather than looping forever (A -> B -> C -> A)', () => {
    // 1 is blocked by 3, 2 is blocked by 1, 3 is blocked by 2: a ring, not a
    // pair. Termination is guaranteed structurally by `path.has(child)`
    // regardless of cycle length, but a 2-node cycle can pass even with an
    // off-by-one in the ancestor tracking, since the immediate parent looks
    // the same as "any ancestor" when there's only one. This shape only
    // terminates at the right place if the whole `path` set is checked at
    // every level, not just the direct parent.
    const roots = buildChains([row(1, [3]), row(2, [1]), row(3, [2])]);
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    expect(root.pid).toBe(1);
    expect(root.totalWaiters).toBe(2);
    const back = root.waiters[0]!.waiters[0]!.waiters[0]!;
    expect(back.cycle).toBe(true);
    expect(back.pid).toBe(1);
  });

  it('orders the worst offender first', () => {
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [1]), row(10, []), row(11, [10])]);
    expect(roots[0]!.pid).toBe(1);
  });

  it('counts a waiter blocked by two independent roots once, though it appears under both', () => {
    // pg_blocking_pids() returns an array: 20 is blocked by both 1 and 10,
    // the shape a DDL statement queued behind several independently-granted
    // readers produces (each reader is its own unblocked root). 20 belongs
    // under both trees -- that's real, killing either root alone won't free
    // it -- so each root's own totalWaiters is correctly 1. But summing
    // those two per-root counts would say two sessions are stuck when there
    // is one; that sum is exactly what the pre-fix verdict computed.
    const roots = buildChains([row(1, []), row(10, []), row(20, [1, 10])]);
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.waiters.some((w) => w.pid === 20))).toBe(true);
    expect(roots.every((r) => r.totalWaiters === 1)).toBe(true);
    expect(countDistinctWaiters(roots)).toBe(1);
  });

  it('does not crash when a referenced blocker has no row of its own', () => {
    // pg_blocking_pids() can return the pid of a parallel worker or other
    // auxiliary process; this check's SQL restricts the row set to
    // backend_type = 'client backend', so an untracked blocker pid is a
    // real possibility from a live server, not a hypothetical. Losing this
    // one pid's blocked status must not crash buildChains and take the
    // whole check down with it.
    expect(() => buildChains([row(5, [999])])).not.toThrow();
    expect(buildChains([row(5, [999])])).toEqual([]);
  });
});

describe('locks.map (truncation)', () => {
  // The SQL fetches LIMIT 501 specifically so `map` can tell "exactly 500
  // rows exist" apart from "more than 500 rows exist and 500 survived an
  // arbitrary-looking cutoff." These pin that row-count logic directly,
  // since a pure buildChains-level test can't reach it -- `truncated` is
  // set in `map`, one level up.
  const chain = (n: number): LockRow[] =>
    // pid 1 unblocked; pid 2 blocked by 1; pid 3 blocked by 2; ... pid n
    // blocked by n-1. Ordered oldest-first, the same order the SQL's
    // `ORDER BY xact_start ASC` would hand map -- so slicing the array is
    // exactly what happens to the real result set.
    Array.from({ length: n }, (_, i) => row(i + 1, i === 0 ? [] : [i]));

  // Follows the chain to its tail, whichever node type it starts from.
  const deepest = (w: { pid: number; waiters: Waiter[] }): { pid: number; waiters: Waiter[] } =>
    (w.waiters[0] ? deepest(w.waiters[0]) : w);

  it('does not flag truncation at exactly 500 rows', () => {
    const data = locks.map(chain(500));
    expect(data.truncated).toBe(false);
    // full chain intact: the 500th pid is reachable.
    expect(deepest(data.roots[0]!).pid).toBe(500);
  });

  it('flags truncation and drops the 501st row when the query returns the overflow row', () => {
    const data = locks.map(chain(501));
    expect(data.truncated).toBe(true);
    // pid 501 (and its edge from 500) must not appear -- only the retained
    // window (pids 1..500) is used to build the graph.
    expect(deepest(data.roots[0]!).pid).toBe(500);
    expect(data.roots[0]!.totalWaiters).toBe(499);
  });
});

/**
 * I3 + I5. `locks.verdict` had no test of any kind — not a unit test, not an
 * integration test — which is how it came to escalate on
 * `max(roots[*].xactAgeSecs)`, the root BLOCKER's transaction age, while its
 * own critical threshold justified the escalation with a sentence about how
 * long the WAITERS had waited. Spec §9 requires every threshold be asserted
 * at its boundary and one unit either side; these do that, and the I3
 * regression below pins the subject of the comparison as well as its shape.
 *
 * Data is built through `locks.map`, not hand-assembled, so these tests
 * exercise the same row -> graph path the live check takes.
 */
describe('locks.verdict', () => {
  const t = locks.thresholds!;
  const warnAt = t.find((x) => x.level === 'warn')!.value;
  const critAt = t.find((x) => x.level === 'critical')!.value;

  /** One root blocker (pid 1) and `n` waiters, each waiting `waitSecs`. */
  const graph = (n: number, waitSecs: number, rootXactAge = '1') => locks.map([
    { ...row(1, []), xact_age_secs: rootXactAge },
    ...Array.from({ length: n }, (_, i) => row(i + 2, [1], `w${i}`, String(waitSecs))),
  ]);

  it('reports ok on a database with no contention at all', () => {
    expect(locks.verdict!(locks.map([]), t).level).toBe('ok');
  });

  it('flips to warn exactly at the warn threshold, in blocked-session count', () => {
    // warnAt is 1 session, so "one unit below" is a graph with no waiters —
    // which is what a lone unblocked session is.
    expect(warnAt).toBe(1);
    expect(locks.verdict!(graph(warnAt - 1, 0), t).level).toBe('ok');
    expect(locks.verdict!(graph(warnAt, 0), t).level).toBe('warn');
    expect(locks.verdict!(graph(warnAt + 1, 0), t).level).toBe('warn');
  });

  it('flips to critical exactly at the critical threshold, in seconds WAITED', () => {
    expect(locks.verdict!(graph(1, critAt - 1), t).level).toBe('warn');
    expect(locks.verdict!(graph(1, critAt), t).level).toBe('critical');
    expect(locks.verdict!(graph(1, critAt + 1), t).level).toBe('critical');
  });

  /**
   * The I3 defect itself. A nightly ETL job holds one transaction open for
   * forty minutes doing ordinary work, then blocks one short SELECT for
   * 200ms. The old verdict took `max(roots[*].xactAgeSecs)` — 2400 — and
   * reported `critical`, two severity levels above what `blocked` reported
   * for the same event on the same page. With the subject corrected to the
   * waiter's own `waitSecs`, this is a warn.
   */
  it('does not escalate on the blocker’s transaction age (I3)', () => {
    const d = graph(1, 0.2, String(40 * 60));
    expect(d.roots[0]!.xactAgeSecs).toBe(2400);
    expect(d.roots[0]!.waitSecs).toBeNull();
    expect(locks.verdict!(d, t).level).toBe('warn');
  });

  it('escalates on a genuinely long wait even when the blocker’s transaction is young', () => {
    const d = graph(1, critAt, '0.5');
    expect(locks.verdict!(d, t).level).toBe('critical');
  });

  // Same Convention 3 proof the other checks carry: the lookups must not use
  // a non-null assertion, and "no critical threshold configured" must fail
  // toward visible, not toward silence.
  it('does not throw, and stays visible, when a threshold level is absent', () => {
    const warnOnly = t.filter((x) => x.level === 'warn');
    expect(locks.verdict!(graph(1, 99999), warnOnly).level).toBe('warn');
    expect(locks.verdict!(graph(1, 99999), []).level).toBe('warn');
  });
});

describe('longestWaitSecs', () => {
  it('reaches a waiter nested several levels down, not just the first', () => {
    const roots = buildChains([
      row(1, []), row(2, [1], 'a2', '3'), row(3, [2], 'a3', '42'), row(4, [3], 'a4', '7'),
    ]);
    expect(longestWaitSecs(roots)).toBe(42);
  });

  it('is 0 when nothing in the graph is waiting', () => {
    expect(longestWaitSecs(buildChains([row(1, []), row(2, [1], 'a2', null)]))).toBe(0);
  });

  /**
   * In a deadlock every session is blocked, so `buildChains` seeds one of
   * them as a root even though it is itself waiting (see its own comment).
   * That seeded root's wait is real and must count — the max walk therefore
   * includes roots and cycle back-edges, unlike `countDistinctWaiters`,
   * which must skip them to avoid double-counting a session.
   */
  it('counts the wait of a cycle’s seeded root', () => {
    const roots = buildChains([row(1, [2], 'a1', '30'), row(2, [1], 'a2', '10')]);
    expect(longestWaitSecs(roots)).toBe(30);
  });
});

describe('locks.requires', () => {
  /**
   * The verdict reads `pg_locks.waitstart`, which Postgres added in 14. The
   * package floor is 14 so every supported server has it — but a check that
   * merely assumes its floor fails on PG13 with a raw `42703 column
   * "waitstart" does not exist`, where the version machinery would say so in
   * words. query-stats.ts already declares exactly this; locks now depends on
   * a 14-only column too, so it declares it too.
   */
  it('declares the PG14 floor its waitstart column needs', () => {
    expect(locks.requires).toContainEqual({ kind: 'version', min: 140000 });
  });
});
