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
// Annotated `Waiter`, so a nested `waiters` array is not inferred as
// `never[]` — which is what apps/web's own typecheck caught when chainPids'
// tests started building trees more than one level deep.
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
    // The LEVEL is untouched: the sessions really are stuck and the panel must stay loud.
    expect(s.longRunning.ok && s.longRunning.verdict?.level).toBe('warn');
  });

  it('leaves the note alone when one long-runner is genuinely slow', () => {
    const s = stuckFrom(lr([103, 999]), locks(102, [103]));
    expect(s.longRunning.ok && s.longRunning.verdict?.note).toBe('pid running');
  });

  // Review item 1: `locks()` above only ever builds a single root, so it
  // cannot exercise `soleRoot === undefined` — construct two roots inline,
  // in the same LocksData shape, each blocking one of the two waiters.
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

  // Review item 2: `lr()` always returns a non-null verdict, so nothing
  // exercised the `verdict === null` branch — "the check reports but does
  // not judge" (see types.ts's CheckResult doc) must stay null, not become
  // an object with a note and no level.
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

  // Review item 4: a root can block sessions the long-running panel never
  // lists (waiters that have not crossed the floor, or a truncated page), so
  // the count must come from the wait graph (locks' totalWaiters), not from
  // queries.length. Here the root has 3 waiters but only 2 are long-running.
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
 * A17. The set the triage page folds on. Every pid the lock graph accounts
 * for — roots, waiters at any depth, and cycle back-edges — so a panel in
 * any band can ask whether the verdict it is about is already explained by
 * the chain.
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
   * A cycle back-edge names a session that is genuinely in the chain, so it
   * belongs in this set even though `countDistinctWaiters` skips it to avoid
   * counting one session twice. Membership is not a count.
   */
  it('includes a cycle back-edge', () => {
    const l = locks(1, []);
    l.data.roots[0]!.waiters.push({ ...waiter(2), waiters: [{ ...waiter(1), cycle: true }] });
    expect([...chainPids(l)].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  /**
   * Empty when the lock check did not run. A fold keyed on a reading this
   * console could not take is the false-negative the whole console is built
   * against: it would quietly demote four real verdicts on the strength of
   * a graph nobody saw.
   */
  it('is empty when the lock check failed', () => {
    expect(chainPids({ ok: false, reason: 'privilege', message: 'no' }).size).toBe(0);
  });

  it('is empty when the graph ran and found nothing', () => {
    expect(chainPids({ ok: true, data: { roots: [], truncated: false }, verdict: { level: 'ok' }, measuredAt: 0 }).size).toBe(0);
  });
});
