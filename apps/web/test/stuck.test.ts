import { describe, expect, it } from 'vitest';
import type { Waiter } from '@pgops/checks';
import { chainPids, stuckFrom } from '@/lib/stuck';

const lr = (pids: number[], crossed = true) => ({
  ok: true as const,
  data: { queries: pids.map((pid) => ({ pid, runningSecs: 100, query: 'x', backendStart: null })), truncated: false },
  verdict: { level: 'warn' as const, note: 'pid running' },
  crossed: crossed ? { level: 'warn' as const, value: 60, unit: 'seconds' as const, because: 'b', remedy: 'kill it' } : undefined,
  measuredAt: 0,
});
// Annotated `Waiter`, so a nested `waiters` array is not inferred as `never[]`.
const waiter = (pid: number): Waiter => ({
  pid, user: null, app: null, query: null, state: 'active', backendStart: null,
  waitingMode: null, waitingOn: null, xactAgeSecs: null, waitSecs: 5, waiters: [], cycle: false,
});
const locks = (rootPid: number, waiters: number[]) => ({
  ok: true as const,
  data: { roots: [{ pid: rootPid, user: null, app: null, query: null, state: 'idle in transaction', backendStart: null,
    waitingMode: null, waitingOn: null, xactAgeSecs: 30, waitSecs: null,
    waiters: waiters.map(waiter), totalWaiters: waiters.length }], truncated: false },
  verdict: { level: 'warn' as const, note: '2 sessions blocked' },
  measuredAt: 0,
});

describe('stuckFrom', () => {
  it('withholds the slow-query guidance when every long-runner is a waiter', () => {
    const s = stuckFrom(lr([103, 104]), locks(102, [103, 104]));
    expect(s.allStuck).toBe(true);
    expect(s.longRunning.ok && s.longRunning.crossed).toBeUndefined();
    expect(s.blockedBy.get(103)).toBe(102);
    expect(s.blocking.get(102)).toBe(2);
  });

  it('keeps the guidance when one long-runner is genuinely slow', () => {
    const s = stuckFrom(lr([103, 999]), locks(102, [103]));
    expect(s.allStuck).toBe(false);
    expect(s.longRunning.ok && s.longRunning.crossed).toBeDefined();
  });

  it('degrades to "every long-runner is slow" when the lock check failed', () => {
    const s = stuckFrom(lr([103]), { ok: false, reason: 'privilege', message: 'denied' });
    expect(s.allStuck).toBe(false);
    expect(s.blockedBy.size).toBe(0);
    expect(s.longRunning.ok && s.longRunning.crossed).toBeDefined();
  });

  it('is not stuck when there are no long-runners at all', () => {
    expect(stuckFrom(lr([]), locks(102, [103])).allStuck).toBe(false);
  });

  it('stops the verdict note naming a waiter when every long-runner is one', () => {
    const s = stuckFrom(lr([103, 104]), locks(102, [103, 104]));
    expect(s.allStuck).toBe(true);
    expect(s.longRunning.ok && s.longRunning.verdict?.note).toBe('2 waiting on 102');
    // The level is untouched: the sessions really are stuck.
    expect(s.longRunning.ok && s.longRunning.verdict?.level).toBe('warn');
  });

  it('leaves the note alone when one long-runner is genuinely slow', () => {
    const s = stuckFrom(lr([103, 999]), locks(102, [103]));
    expect(s.longRunning.ok && s.longRunning.verdict?.note).toBe('pid running');
  });

  // `locks()` builds a single root, so two roots are constructed inline to
  // exercise `soleRoot === undefined`.
  it('leaves the note alone when waiters queue behind two different roots', () => {
    const twoRoots = {
      ok: true as const,
      data: {
        roots: [
          { pid: 102, user: null, app: null, query: null, state: 'idle in transaction', backendStart: null,
            waitingMode: null, waitingOn: null, xactAgeSecs: 30, waitSecs: null,
            waiters: [waiter(103)], totalWaiters: 1 },
          { pid: 105, user: null, app: null, query: null, state: 'idle in transaction', backendStart: null,
            waitingMode: null, waitingOn: null, xactAgeSecs: 30, waitSecs: null,
            waiters: [waiter(104)], totalWaiters: 1 },
        ],
        truncated: false,
      },
      verdict: { level: 'warn' as const, note: '2 sessions blocked' },
      measuredAt: 0,
    };
    const s = stuckFrom(lr([103, 104]), twoRoots);
    expect(s.allStuck).toBe(true);
    expect(s.longRunning.ok && s.longRunning.verdict?.note).toBe('pid running');
  });

  // A null verdict ("the check reports but does not judge", see types.ts)
  // must stay null, not become an object with a note and no level.
  it('leaves the verdict null when the long-running check does not judge', () => {
    const noVerdict = {
      ok: true as const,
      data: {
        queries: [103, 104].map((pid) => ({ pid, runningSecs: 100, query: 'x', backendStart: null })),
        truncated: false,
      },
      verdict: null,
      measuredAt: 0,
    };
    const s = stuckFrom(noVerdict, locks(102, [103, 104]));
    expect(s.allStuck).toBe(true);
    expect(s.longRunning.ok && s.longRunning.verdict).toBeNull();
  });

  // A root can block sessions the long-running panel never lists (below the
  // floor, or truncated). Here the root has 3 waiters but only 2 are long-running.
  it('counts from the wait graph, not the panel row count, when they differ', () => {
    const s = stuckFrom(lr([103, 104]), locks(102, [103, 104, 106]));
    expect(s.longRunning.ok && s.longRunning.verdict?.note).toBe('3 waiting on 102');
  });

  it('reports the reason the lock graph could not be read', () => {
    const s = stuckFrom(lr([103]), { ok: false, reason: 'privilege', message: 'permission denied for view pg_locks' });
    expect(s.locksUnavailable).toBe('privilege');
  });

  it('reports nothing when the lock check ran, blocked or not', () => {
    expect(stuckFrom(lr([103]), locks(102, [103])).locksUnavailable).toBeNull();
    expect(stuckFrom(lr([]), locks(102, [])).locksUnavailable).toBeNull();
  });
});

/**
 * The set the triage page folds on: every pid the lock graph accounts for —
 * roots, waiters at any depth, and cycle back-edges.
 */
describe('chainPids', () => {
  it('collects every pid in the graph, at any depth', () => {
    const deep: Waiter = {
      ...waiter(104),
      waiters: [{ ...waiter(105), waiters: [waiter(106)] }],
    };
    const l = locks(102, [103]);
    l.data.roots[0]!.waiters.push(deep);
    expect([...chainPids(l)].sort((a, b) => a - b)).toEqual([102, 103, 104, 105, 106]);
  });

  /**
   * A cycle back-edge names a session that is in the chain, so it belongs in
   * this set even though `countDistinctWaiters` skips it to avoid counting
   * one session twice.
   */
  it('includes a cycle back-edge', () => {
    const l = locks(1, []);
    l.data.roots[0]!.waiters.push({ ...waiter(2), waiters: [{ ...waiter(1), cycle: true }] });
    expect([...chainPids(l)].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  /** A fold must not demote real verdicts on the strength of a graph that could not be read. */
  it('is empty when the lock check failed', () => {
    expect(chainPids({ ok: false, reason: 'privilege', message: 'no' }).size).toBe(0);
  });

  it('is empty when the graph ran and found nothing', () => {
    expect(chainPids({ ok: true, data: { roots: [], truncated: false }, verdict: { level: 'ok' }, measuredAt: 0 }).size).toBe(0);
  });
});
