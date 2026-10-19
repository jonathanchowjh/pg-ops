import { describe, expect, it } from 'vitest';
import { longRunning, type LongRunningRow } from '../src/checks/long-running.js';

const lrRow = (o: Partial<LongRunningRow>): LongRunningRow => ({
  pid: 1, running_secs: '61.2', query: 'select 1',
  backend_start: '2026-09-18 00:00:00+00', total_matching: 1, ...o,
});

describe('longRunning.map', () => {
  it('converts running_secs from text without renaming it to a wait quantity', () => {
    const d = longRunning.map([lrRow({ pid: 123, running_secs: '61.2', query: 'select 1', total_matching: 1 })]);
    expect(d).toEqual({
      queries: [{
        pid: 123, runningSecs: 61.2, query: 'select 1',
        backendStart: '2026-09-18 00:00:00+00',
      }],
      truncated: false,
    });
  });

  // `limit` is a runtime option, so `map` can only detect truncation from
  // the pre-LIMIT count carried on every row.
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

  it('carries the session identity, which is what a kill is pinned to', () => {
    const d = longRunning.map([lrRow({ backend_start: '2026-09-18 01:00:00+00' })]);
    expect(d.queries[0]!.backendStart).toBe('2026-09-18 01:00:00+00');
  });

  /**
   * `killBackend` takes a null identity to mean "kill on pid alone"; a
   * substituted string would never match and turn every kill into
   * `session-changed`.
   */
  it('passes a null identity through rather than inventing one', () => {
    const d = longRunning.map([lrRow({ backend_start: null })]);
    expect(d.queries[0]!.backendStart).toBeNull();
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
    const q = (runningSecs: number) => ({
      queries: [{ pid: 1, runningSecs, query: null, backendStart: null }], truncated: false,
    });
    expect(longRunning.verdict!(q(warnAt + 1), t).level).toBe('warn');
    expect(longRunning.verdict!(q(critAt + 1), t).level).toBe('critical');
  });

  /**
   * Each threshold is asserted at its value and one unit either side. The
   * package convention is `>=`: a threshold is the value at which the
   * condition becomes a problem, so exactly 60.0s is `warn` and exactly
   * 300.0s is `critical`.
   */
  it('flips at the threshold itself, not one second past it (I5)', () => {
    const warnAt = t.find((x) => x.level === 'warn')!.value;
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const at = (runningSecs: number) => longRunning.verdict!(
      { queries: [{ pid: 1, runningSecs, query: null, backendStart: null }], truncated: false }, t,
    ).level;

    expect(at(warnAt - 1)).toBe('ok');
    expect(at(warnAt)).toBe('warn');
    expect(at(warnAt + 1)).toBe('warn');

    expect(at(critAt - 1)).toBe('warn');
    expect(at(critAt)).toBe('critical');
    expect(at(critAt + 1)).toBe('critical');
  });

  it('does not throw when a threshold level is absent from the array', () => {
    const v = longRunning.verdict!(
      { queries: [{ pid: 1, runningSecs: 99999, query: null, backendStart: null }], truncated: false },
      [],
    );
    expect(v.level).toBe('ok');
  });
});

describe('longRunning SQL / verdict agreement', () => {
  /**
   * `minSecs` defaults to the warn threshold, and the verdict escalates at
   * `>=`. With `>` in the SQL, a query at exactly 60.000s never reaches the
   * verdict. Pinned at the source because "exactly 60s" cannot be
   * constructed against a real server.
   */
  it('filters on >=, matching the verdict it feeds', () => {
    const sql = longRunning.sql;
    if (typeof sql !== 'function') throw new Error('longRunning.sql must be opts-driven');
    expect(sql({ minSecs: 60 }).text).toContain('>= make_interval');
  });
});
