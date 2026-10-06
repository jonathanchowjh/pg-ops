import { describe, expect, it, vi } from 'vitest';
import { ratesFor } from '@/lib/rates';

/**
 * B11. The console's own statement count comes from the pool wrapper in
 * lib/pools.ts, which is where statements actually leave this process.
 * Mocked here so a test can say how many were issued in a window: the real
 * one resolves a database NAME to its URL through the environment, and these
 * tests run with nothing configured.
 */
const own = vi.hoisted(() => ({
  n: 0,
  /**
   * ACCUMULATES, like the real counter in lib/pools.ts, and is reset only by
   * being read. An earlier version of this fixture ASSIGNED `own.n` before
   * each sample, which quietly destroyed the window test below: assignment
   * overwrites whatever the previous read left behind, so the test passed
   * whether or not `ratesFor` reset the counter on its first sample — the
   * exact mutation it exists to catch. Confirmed by running it.
   */
  add(k: number) { own.n += k; },
}));
vi.mock('@/lib/pools', () => ({
  ownStatementsSince: () => { const n = own.n; own.n = 0; return n; },
}));

/**
 * `measuredAt` is deliberately a time that gives the WRONG answer if ratesFor
 * ever goes back to using it, so a regression to the host clock FAILS these
 * tests instead of passing them quietly.
 *
 * It SCALES the sample instant rather than shifting it, and that detail is the
 * whole point. This fixture first used `sampledAtMs - 3_600_000`, a constant
 * offset — which cancels out of a difference, so every rate assertion below
 * passed under exactly the regression the fixture existed to catch. Only the
 * blank-`sampledAt` test caught it, and only incidentally, because `measuredAt`
 * never goes blank. Multiplying makes the two intervals genuinely differ
 * (5s of server time against 15s of host time), so the regression now fails
 * every assertion that reads a rate.
 */
const ok = (xactCommit: number, sampledAtMs: number) => ({
  ok: true as const, measuredAt: sampledAtMs * 3, verdict: null,
  data: { xactCommit, xactRollback: 0, deadlocks: 0, conflicts: 0, tempFiles: 0, tempBytes: 0, blksRead: 0, blksHit: 0,
    tupReturned: 0, tupFetched: 0, tupInserted: 0, tupUpdated: 0, tupDeleted: 0, statsResetAt: null,
    sampledAt: new Date(sampledAtMs).toISOString() },
});

describe('ratesFor', () => {
  it('needs two samples, then differences them', () => {
    expect(ratesFor('rates-a', ok(100, 0))).toBeNull();
    const r = ratesFor('rates-a', ok(600, 5_000));
    expect(r?.commitsPerSec).toBe(100);
  });

  it('keeps databases apart', () => {
    ratesFor('rates-b', ok(100, 0));
    expect(ratesFor('rates-c', ok(100, 5_000))).toBeNull();
  });

  it('refuses a sample with no usable instant rather than reporting NaN/s', () => {
    // The map yields sampledAt: '' when pg_stat_database returned no row at all.
    const blank = { ...ok(100, 0), data: { ...ok(100, 0).data, sampledAt: '' } };
    expect(ratesFor('rates-blank', blank)).toBeNull();
    expect(ratesFor('rates-blank', ok(600, 5_000))).toBeNull(); // the blank stored nothing
  });

  it('forgets nothing on a failed read, so the next good one still has a partner', () => {
    ratesFor('rates-d', ok(100, 0));
    expect(ratesFor('rates-d', { ok: false, reason: 'error', message: 'x' })).toBeNull();
    expect(ratesFor('rates-d', ok(200, 10_000))?.commitsPerSec).toBe(10);
  });

  /**
   * B11, the defect. Triage read "17 commits/s" against a database holding a
   * three-session lock chain and doing nothing else: every poll of every page
   * is a transaction, and pg_stat_database cannot be filtered by
   * application, so A8's marker does not reach this counter. The console was
   * reporting its own heartbeat as the application's load.
   *
   * Stated, not subtracted — see lib/rates.ts. The count is per web process,
   * so a second replica's polling is invisible here; a subtracted rate would
   * read as the application's load and be wrong by exactly the amount nobody
   * can see.
   */
  it('reports how many of the commits in the window were this console own reads', () => {
    expect(ratesFor('rates-own', ok(100, 0))).toBeNull();
    own.add(60);
    const r = ratesFor('rates-own', ok(600, 5_000));
    expect(r?.commitsPerSec).toBe(100);
    expect(r?.ownPerSec).toBe(12);
  });

  /**
   * The counter is read and reset on every sample, including the first, so
   * the count divided into a rate covers exactly the window that rate covers
   * — not everything since the process started.
   */
  it('counts only the window, not everything since the process started', () => {
    own.add(9_999);
    expect(ratesFor('rates-own-window', ok(100, 0))).toBeNull();
    own.add(10);
    expect(ratesFor('rates-own-window', ok(200, 10_000))?.ownPerSec).toBe(1);
  });
});