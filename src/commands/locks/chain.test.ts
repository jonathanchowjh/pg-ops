import { describe, expect, it } from 'vitest';
import { buildChains, waiterAppBreakdown, formatDuration, indexForPid } from './chain.js';
import type { LockEdge } from './query.js';

/** Build a lock edge with sensible defaults; override what the test cares about. */
function edge(blocked_pid: number, blocking_pid: number, over: Partial<LockEdge> = {}): LockEdge {
  return {
    blocked_pid,
    blocking_pid,
    blocked_user: 'app',
    blocking_user: 'batch',
    blocked_app: 'web',
    blocking_app: 'worker',
    locktype: 'relation',
    waiting_mode: 'AccessExclusiveLock',
    held_mode: 'AccessShareLock',
    table_name: 'users',
    blocking_query: 'UPDATE users ...',
    blocked_query: 'ALTER TABLE users ...',
    blocked_state: 'active',
    blocking_state: 'idle in transaction',
    blocked_for_secs: 10,
    blocking_for_secs: 60,
    blocked_backend_start: '2026-06-26 10:05:00.000000+00',
    blocking_backend_start: '2026-06-26 10:00:00.000000+00',
    ...over,
  };
}

describe('buildChains', () => {
  it('returns one root with one waiter for a simple A-blocks-B chain', () => {
    const roots = buildChains([edge(2, 1)]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.pid).toBe(1);
    expect(roots[0]?.totalWaiters).toBe(1);
    expect(roots[0]?.waiters.map((w) => w.pid)).toEqual([2]);
  });

  it('threads backend_start onto the root and its waiters as the session identity', () => {
    const roots = buildChains([
      edge(2, 1, { blocking_backend_start: '2026-06-26 09:00:00.111111+00', blocked_backend_start: '2026-06-26 09:01:00.222222+00' }),
    ]);
    expect(roots[0]?.backendStart).toBe('2026-06-26 09:00:00.111111+00');
    expect(roots[0]?.waiters[0]?.backendStart).toBe('2026-06-26 09:01:00.222222+00');
  });

  it('groups multiple waiters under one root blocker', () => {
    const roots = buildChains([edge(2, 1), edge(3, 1), edge(4, 1)]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.totalWaiters).toBe(3);
    expect(roots[0]?.waiters.map((w) => w.pid).sort()).toEqual([2, 3, 4]);
  });

  it('nests a transitive chain A -> B -> C and counts waiters transitively', () => {
    // 1 blocks 2, 2 blocks 3. Root is 1; 3 is not blocked-by anyone outside the chain.
    const roots = buildChains([edge(2, 1), edge(3, 2)]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.pid).toBe(1);
    expect(roots[0]?.totalWaiters).toBe(2);
    const b = roots[0]?.waiters[0];
    expect(b?.pid).toBe(2);
    expect(b?.waiters[0]?.pid).toBe(3);
  });

  it('detects a cycle (deadlock in flight) without infinite recursion', () => {
    // 1 blocks 2 and 2 blocks 1 -> both are blocked, so neither is a root.
    // Force a root by adding an outer blocker 0 -> 1, then 1 <-> 2 cycle.
    const roots = buildChains([edge(1, 0), edge(2, 1), edge(1, 2)]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.pid).toBe(0);
    // pids 1 and 2 are the only real waiters; the cycle back-edge (1 again) must
    // not be double-counted into totalWaiters.
    expect(roots[0]?.totalWaiters).toBe(2);
    // Somewhere in the tree a cycle node is flagged.
    const flagged: number[] = [];
    const walk = (ws: { pid: number; cycle: boolean; waiters: typeof ws }[]) => {
      for (const w of ws) {
        if (w.cycle) flagged.push(w.pid);
        walk(w.waiters);
      }
    };
    walk(roots[0]!.waiters as never);
    expect(flagged).toContain(1);
  });

  it('sorts roots by total waiters, worst first', () => {
    const roots = buildChains([
      edge(2, 1), // root 1: 1 waiter
      edge(4, 3),
      edge(5, 3), // root 3: 2 waiters
    ]);
    expect(roots.map((r) => r.pid)).toEqual([3, 1]);
  });

  it('dedups multiple locktype edges for the same blocked/blocking pair', () => {
    const roots = buildChains([
      edge(2, 1, { locktype: 'relation' }),
      edge(2, 1, { locktype: 'tuple' }),
    ]);
    expect(roots[0]?.totalWaiters).toBe(1);
    expect(roots[0]?.waiters).toHaveLength(1);
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(863)).toBe('14m 23s');
    expect(formatDuration(7200)).toBe('2h 0m');
    expect(formatDuration(null)).toBe('—');
  });
  it('renders negative durations (clock skew) as unknown, not garbled', () => {
    expect(formatDuration(-65)).toBe('—');
    expect(formatDuration(-3601)).toBe('—');
  });
});

describe('state propagation', () => {
  it('carries the blocking session state onto the root', () => {
    const roots = buildChains([edge(2, 1, { blocking_state: 'idle in transaction' })]);
    expect(roots[0]?.state).toBe('idle in transaction');
  });
});

describe('indexForPid', () => {
  const roots = buildChains([edge(2, 1), edge(4, 3), edge(6, 5)]); // roots sorted by waiters; all 1 waiter → insertion-ish
  it('finds the row holding the pid', () => {
    const pid = roots[1]!.pid;
    expect(indexForPid(roots, pid)).toBe(1);
  });
  it('returns -1 when the pid is gone or undefined (caller picks the fallback)', () => {
    expect(indexForPid(roots, 99999)).toBe(-1);
    expect(indexForPid(roots, undefined)).toBe(-1);
  });
});

describe('waiterAppBreakdown', () => {
  it('groups waiters by app, count descending', () => {
    const roots = buildChains([
      edge(2, 1, { blocked_app: 'web-api' }),
      edge(3, 1, { blocked_app: 'web-api' }),
      edge(4, 1, { blocked_app: 'cron' }),
    ]);
    expect(waiterAppBreakdown(roots[0]!.waiters)).toEqual([
      { app: 'web-api', count: 2 },
      { app: 'cron', count: 1 },
    ]);
  });
  it('counts nested waiters and labels missing apps as "?"', () => {
    const roots = buildChains([edge(2, 1, { blocked_app: null }), edge(3, 2, { blocked_app: null })]);
    expect(waiterAppBreakdown(roots[0]!.waiters)).toEqual([{ app: '?', count: 2 }]);
  });
});
