import { describe, expect, it } from 'vitest';
import {
  blockedByRoot, blockingCounts, buildChains, countDistinctWaiters, locks, longestWaitSecs,
  type LockRow, type Waiter,
} from '../src/checks/locks.js';

const row = (pid: number, blockedBy: number[], app = `a${pid}`, waitSecs?: string | null): LockRow => ({
  pid, blocked_by: blockedBy, app, usename: 'u', state: 'active',
  query: 'q', backend_start: '2026-01-01T00:00:00Z',
  xact_age_secs: '1', waiting_mode: null, waiting_on: null,
  // Mirrors the SQL: a session that is not blocked has `wait_secs` NULL, not 0.
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
    // A two-node cycle passes even if only the direct parent is checked; a
    // ring of three terminates at the right place only if the whole `path`
    // set is checked at every level.
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
    // 20 is blocked by both 1 and 10, as a DDL statement queued behind
    // several readers is. It belongs under both trees, since killing either
    // root alone won't free it, but summing the per-root counts would say
    // two sessions are stuck when there is one.
    const roots = buildChains([row(1, []), row(10, []), row(20, [1, 10])]);
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.waiters.some((w) => w.pid === 20))).toBe(true);
    expect(roots.every((r) => r.totalWaiters === 1)).toBe(true);
    expect(countDistinctWaiters(roots)).toBe(1);
  });

  /**
   * In a deadlock `buildChains` seeds one waiting session as a root. That
   * root is itself stuck, so a count that skips every root reports a
   * two-session deadlock as one blocked session. `waitSecs` tells the two
   * apart: null for an unblocked root, a number for one that is waiting.
   */
  it('counts a seeded cycle root, which is itself a stuck session', () => {
    expect(countDistinctWaiters(buildChains([row(1, [2]), row(2, [1])]))).toBe(2);
  });

  it('does not count an unblocked root as one of the sessions stuck behind it', () => {
    expect(countDistinctWaiters(buildChains([row(1, []), row(2, [1])]))).toBe(1);
  });

  /**
   * Gating cycle seeding on `roots.length === 0` lets one ordinary chain
   * anywhere in the graph hide every deadlock: pids 3 and 4 below would be
   * roots of nothing and waiters under nobody.
   */
  it('seeds a cycle even when an unrelated ordinary root exists', () => {
    // 1 blocks 2. Separately and independently, 3 and 4 block each other.
    const roots = buildChains([row(1, []), row(2, [1]), row(3, [4]), row(4, [3])]);
    expect(roots.map((r) => r.pid).sort((a, b) => a - b)).toEqual([1, 3]);
    const ring = roots.find((r) => r.pid === 3)!;
    expect(ring.waiters[0]!.pid).toBe(4);
    expect(ring.waiters[0]!.waiters[0]!.cycle).toBe(true);
    expect(ring.waiters[0]!.waiters[0]!.pid).toBe(3);
  });

  it('does not re-seed an ordinary root as a cycle entry point', () => {
    // The seeding pass runs unconditionally, so it must treat ordinary roots
    // and everything under them as covered, or pid 1 is appended twice.
    const roots = buildChains([row(1, []), row(2, [1])]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.pid).toBe(1);
  });

  it('does not crash when a referenced blocker has no row of its own', () => {
    // pg_blocking_pids() can return a parallel worker or other auxiliary
    // process, and the SQL keeps only client backends, so a live server can
    // produce a blocker pid with no row.
    expect(() => buildChains([row(5, [999])])).not.toThrow();
    expect(buildChains([row(5, [999])])).toEqual([]);
  });
});

describe('locks.map (truncation)', () => {
  // The SQL fetches LIMIT 501 so `map` can tell exactly 500 rows from more
  // than 500. `truncated` is set in `map`, so buildChains tests cannot reach it.
  const chain = (n: number): LockRow[] =>
    // pid 1 unblocked; pid k blocked by k-1. Oldest first, the order the
    // SQL's `ORDER BY xact_start ASC` hands map.
    Array.from({ length: n }, (_, i) => row(i + 1, i === 0 ? [] : [i]));

  // Follows the chain to its tail, whichever node type it starts from.
  const deepest = (w: { pid: number; waiters: Waiter[] }): { pid: number; waiters: Waiter[] } =>
    (w.waiters[0] ? deepest(w.waiters[0]) : w);

  it('does not flag truncation at exactly 500 rows', () => {
    const data = locks.map(chain(500));
    expect(data.truncated).toBe(false);
    expect(deepest(data.roots[0]!).pid).toBe(500);
  });

  it('flags truncation and drops the 501st row when the query returns the overflow row', () => {
    const data = locks.map(chain(501));
    expect(data.truncated).toBe(true);
    // Only the retained window (pids 1..500) builds the graph.
    expect(deepest(data.roots[0]!).pid).toBe(500);
    expect(data.roots[0]!.totalWaiters).toBe(499);
  });
});

/**
 * Each threshold is asserted at its boundary and one unit either side. Data
 * is built through `locks.map`, so these take the same row -> graph path the
 * live check takes.
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
    // warnAt is 1 session, so "one unit below" is a graph with no waiters.
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
   * A transaction open for forty minutes blocks one short SELECT for 200ms.
   * The verdict reads the waiter's own `waitSecs`, so this is a warn.
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

  // The lookups must not use a non-null assertion, and a missing critical
  // threshold must fail toward visible.
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
   * A deadlock's seeded root is itself waiting, so the max walk includes
   * roots and cycle back-edges, unlike `countDistinctWaiters`, which must
   * skip them to avoid double-counting a session.
   */
  it('counts the wait of a cycle’s seeded root', () => {
    const roots = buildChains([row(1, [2], 'a1', '30'), row(2, [1], 'a2', '10')]);
    expect(longestWaitSecs(roots)).toBe(30);
  });
});

describe('locks.requires', () => {
  /**
   * `pg_locks.waitstart` was added in Postgres 14. Without the declared
   * floor, PG13 fails with a raw `42703 column "waitstart" does not exist`
   * instead of the version machinery's message.
   */
  it('declares the PG14 floor its waitstart column needs', () => {
    expect(locks.requires).toContainEqual({ kind: 'version', min: 140000 });
  });
});

describe('blockedByRoot / blockingCounts', () => {
  // 9401 holds; 9403 waits on 9401; 9402 waits on 9403.
  const rows = [
    row(9401, []), row(9403, [9401]), row(9402, [9403]),
  ];
  const roots = buildChains(rows);

  it('maps every waiter, at any depth, to the root of its chain', () => {
    const m = blockedByRoot(roots);
    expect(m.get(9403)).toBe(9401);
    expect(m.get(9402)).toBe(9401);
    expect(m.has(9401)).toBe(false);
  });

  it('counts waiters per root', () => {
    expect(blockingCounts(roots).get(9401)).toBe(2);
  });

  it('does not recurse into a cycle edge', () => {
    const cyc = buildChains([row(1, [2]), row(2, [1])]);
    expect(() => blockedByRoot(cyc)).not.toThrow();
  });
});
