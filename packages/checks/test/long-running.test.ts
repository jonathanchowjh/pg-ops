import { describe, expect, it } from 'vitest';
import { longRunning, type LongRunningRow } from '../src/checks/long-running.js';

const lrRow = (o: Partial<LongRunningRow>): LongRunningRow => ({
  pid: 1, running_secs: '61.2', query: 'select 1', total_matching: 1, ...o,
});

describe('longRunning.map', () => {
  it('converts running_secs from text without renaming it to a wait quantity', () => {
    const d = longRunning.map([lrRow({ pid: 123, running_secs: '61.2', query: 'select 1', total_matching: 1 })]);
    expect(d).toEqual({ queries: [{ pid: 123, runningSecs: 61.2, query: 'select 1' }], truncated: false });
  });

  // A7, same technique as sessions.ts's own `total_matching`: `limit` is a
  // runtime Opts value here, so `map` (pure over `rows` alone) can only
  // detect truncation via the pre-LIMIT count carried on every row.
  it('signals truncation when the pre-LIMIT count exceeds the returned rows (A7)', () => {
    const d = longRunning.map([
      lrRow({ pid: 1, total_matching: 3 }),
      lrRow({ pid: 2, total_matching: 3 }),
    ]);
    expect(d.truncated).toBe(true);
    expect(d.queries).toHaveLength(2);
  });

  it('does not signal truncation when every matching row was returned', () => {
    expect(longRunning.map([lrRow({ pid: 1, total_matching: 1 })]).truncated).toBe(false);
  });

  it('does not signal truncation on an empty result', () => {
    expect(longRunning.map([]).truncated).toBe(false);
  });
});

describe('longRunning.verdict', () => {
  const t = longRunning.thresholds!;

  it('reports ok with nothing running past the floor', () => {
    expect(longRunning.verdict!({ queries: [], truncated: false }, t).level).toBe('ok');
  });

  it('warns past the warn threshold and critical past the critical one', () => {
    const warnAt = t.find((x) => x.level === 'warn')!.value;
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const q = (runningSecs: number) => ({ queries: [{ pid: 1, runningSecs, query: null }], truncated: false });
    expect(longRunning.verdict!(q(warnAt + 1), t).level).toBe('warn');
    expect(longRunning.verdict!(q(critAt + 1), t).level).toBe('critical');
  });

  /**
   * I5. Spec §9 requires each threshold be asserted AT its value and one
   * unit either side — "this is what would have caught A1; a test that
   * asserts a constant equals itself cannot." The two assertions above only
   * ever probed `warnAt + 1` and `critAt + 1`, so the flip point itself was
   * pinned by nothing.
   *
   * It was also the outlier in the `>=` vs `>` divergence the final review
   * found: this check used strict `>` while `blocked`, `locks` and `slots`
   * used `>=`, and `sessionStates` used both inside one function. The ruling
   * standardised on `>=` — a threshold is the value AT WHICH the condition
   * becomes a problem, which is how every `because` string in this package
   * is worded ("pgHero #9 uses 60s as the definition of long-running", not
   * "past 60s"). So a query running exactly 60.0s is `warn`, and exactly
   * 300.0s is `critical`.
   */
  it('flips at the threshold itself, not one second past it (I5)', () => {
    const warnAt = t.find((x) => x.level === 'warn')!.value;
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const at = (runningSecs: number) => longRunning.verdict!(
      { queries: [{ pid: 1, runningSecs, query: null }], truncated: false }, t,
    ).level;

    expect(at(warnAt - 1)).toBe('ok');
    expect(at(warnAt)).toBe('warn');
    expect(at(warnAt + 1)).toBe('warn');

    expect(at(critAt - 1)).toBe('warn');
    expect(at(critAt)).toBe('critical');
    expect(at(critAt + 1)).toBe('critical');
  });

  // Same Convention 3 proof as blocked.verdict above, for this check's own
  // two-threshold lookup.
  it('does not throw when a threshold level is absent from the array', () => {
    const v = longRunning.verdict!({ queries: [{ pid: 1, runningSecs: 99999, query: null }], truncated: false }, []);
    expect(v.level).toBe('ok');
  });
});

describe('longRunning SQL / verdict agreement', () => {
  /**
   * The verdict escalates at `>=` its warn threshold (the package-wide
   * convention: a threshold is the value AT WHICH a condition becomes a
   * problem). The SQL's own age predicate has to agree, because `minSecs`
   * defaults to exactly that warn threshold — with `>` there, a query at
   * precisely 60.000s never reaches the verdict at all and the check reports
   * `ok`, contradicting the boundary test one layer up.
   *
   * Float equality on a clock makes that measure-zero in practice, which is
   * why this is pinned at the source rather than with a live query: there is
   * no way to construct "exactly 60.000000s" against a real server, and a
   * disagreement no test can reach is exactly the kind that survives.
   */
  it('filters on >=, matching the verdict it feeds', () => {
    const sql = longRunning.sql;
    if (typeof sql !== 'function') throw new Error('longRunning.sql must be opts-driven');
    expect(sql({ minSecs: 60 }).text).toContain('>= make_interval');
  });
});
