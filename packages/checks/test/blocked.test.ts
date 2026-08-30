import { describe, expect, it } from 'vitest';
import { blocked, type BlockedRow } from '../src/checks/blocked.js';

describe('blocked.map', () => {
  it('converts an empty result (no rows matched WHERE) to a zero count and null age', () => {
    const rows: BlockedRow[] = [{ blocked: 0, longest_query_age_secs: null, suspect_pid: null }];
    const d = blocked.map(rows);
    expect(d).toEqual({ count: 0, longestQueryAgeSecs: null, suspectPid: null });
  });

  it('converts the `::text` age column to a number, and passes the already-numeric suspect pid through, without renaming the field back to a wait quantity', () => {
    const rows: BlockedRow[] = [{ blocked: 2, longest_query_age_secs: '605.5', suspect_pid: 4242 }];
    const d = blocked.map(rows);
    // A8: asserted by NAME. If this field were renamed back to `waitSecs` —
    // the shipped label this check exists to correct — `d.longestQueryAgeSecs`
    // reads `undefined` here and the assertion below fails.
    expect(d.longestQueryAgeSecs).toBe(605.5);
    expect(d.suspectPid).toBe(4242);
    expect(d.count).toBe(2);
  });
});

describe('blocked.verdict', () => {
  const t = blocked.thresholds!;

  it('reports ok on a quiet database', () => {
    expect(blocked.verdict!({ count: 0, longestQueryAgeSecs: null, suspectPid: null }, t).level).toBe('ok');
  });

  it('warns below the critical age threshold', () => {
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 5, suspectPid: 99 }, t);
    expect(v.level).toBe('warn');
  });

  it('escalates to critical at the age threshold', () => {
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: critAt, suspectPid: 99 }, t);
    expect(v.level).toBe('critical');
  });

  /**
   * I5. The two assertions above hit `critAt` and an arbitrary 5 — never the
   * unit immediately below the flip point, which is the half spec §9 names
   * ("just below and just above each Threshold.value"). Both thresholds get
   * the full sweep here, and `>=` is the package-wide ruling: a threshold is
   * the value AT WHICH the condition becomes a problem.
   */
  it('flips at each threshold itself, not one unit past it (I5)', () => {
    const warnAt = t.find((x) => x.level === 'warn')!.value;
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const at = (count: number, secs: number) => blocked.verdict!(
      { count, longestQueryAgeSecs: secs, suspectPid: 99 }, t,
    ).level;

    // warn is a COUNT of blocked sessions; its value is 1, so one unit below
    // is a database with nothing blocked at all.
    expect(warnAt).toBe(1);
    expect(at(warnAt - 1, 9999)).toBe('ok');
    expect(at(warnAt, 0)).toBe('warn');
    expect(at(warnAt + 1, 0)).toBe('warn');

    // critical is the blocked session's own query age, in seconds.
    expect(at(1, critAt - 1)).toBe('warn');
    expect(at(1, critAt)).toBe('critical');
    expect(at(1, critAt + 1)).toBe('critical');
  });

  // Convention 3: the lookup must not use a non-null assertion. Proven here
  // by actually calling `verdict` with a thresholds array missing `critical`
  // — a `t.find(...)!` would throw `Cannot read properties of undefined`
  // instead of degrading to `warn`.
  it('does not throw, and stays visible, when the critical threshold is absent', () => {
    const warnOnly = t.filter((x) => x.level === 'warn');
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 9999, suspectPid: 99 }, warnOnly);
    expect(v.level).toBe('warn');
  });
});
