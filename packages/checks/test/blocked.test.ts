import { describe, expect, it } from 'vitest';
import { blocked, type BlockedRow } from '../src/checks/blocked.js';

describe('blocked.map', () => {
  it('converts an empty result (no rows matched WHERE) to a zero count and null age', () => {
    const rows: BlockedRow[] = [{ blocked: 0, longest_query_age_secs: null, longest_wait_secs: null, suspect_pid: null }];
    const d = blocked.map(rows);
    expect(d).toEqual({ count: 0, longestQueryAgeSecs: null, longestWaitSecs: null, suspectPid: null });
  });

  it('converts the `::text` age column to a number, and passes the already-numeric suspect pid through, without renaming the field back to a wait quantity', () => {
    const rows: BlockedRow[] = [{ blocked: 2, longest_query_age_secs: '605.5', longest_wait_secs: '4.5', suspect_pid: 4242 }];
    const d = blocked.map(rows);
    // Asserted by name: this is a query age, not a wait.
    expect(d.longestQueryAgeSecs).toBe(605.5);
    // The quantity the verdict reads, kept separate from the age.
    expect(d.longestWaitSecs).toBe(4.5);
    expect(d.suspectPid).toBe(4242);
    expect(d.count).toBe(2);
  });
});

describe('blocked.verdict', () => {
  const t = blocked.thresholds!;

  it('reports ok on a quiet database', () => {
    expect(blocked.verdict!({ count: 0, longestQueryAgeSecs: null, longestWaitSecs: null, suspectPid: null }, t).level).toBe('ok');
  });

  it('warns below the critical wait threshold', () => {
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 5, longestWaitSecs: 5, suspectPid: 99 }, t);
    expect(v.level).toBe('warn');
  });

  it('escalates to critical at the wait threshold', () => {
    const critAt = t.find((x) => x.level === 'critical')!.value;
    // The query age is well below the threshold: a verdict that read the age
    // would report warn.
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 5, longestWaitSecs: critAt, suspectPid: 99 }, t);
    expect(v.level).toBe('critical');
  });

  /**
   * The critical threshold is about time spent waiting, not query age: a job
   * that ran ten minutes and queued behind a lock one second ago is not an
   * outage. locks.ts judges the same event the same way.
   */
  it('does not escalate an old query that only just started waiting', () => {
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 600, longestWaitSecs: 1, suspectPid: 9 }, t);
    expect(v.level).toBe('warn');
  });

  it('escalates a young query that has waited past the threshold', () => {
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: critAt / 10, longestWaitSecs: critAt, suspectPid: 9 }, t);
    expect(v.level).toBe('critical');
  });

  /**
   * `waitstart` is briefly NULL for a wait that has only just begun. Such a
   * session must stay visible as a warn, never fall to ok.
   */
  it('stays visible when the wait could not be measured yet', () => {
    const v = blocked.verdict!({ count: 2, longestQueryAgeSecs: 9999, longestWaitSecs: null, suspectPid: 9 }, t);
    expect(v.level).toBe('warn');
    expect(v.note).toBe('2 sessions blocked');
  });

  /** `>=` package-wide: a threshold is the value at which the condition becomes a problem. */
  it('flips at each threshold itself, not one unit past it (I5)', () => {
    const warnAt = t.find((x) => x.level === 'warn')!.value;
    const critAt = t.find((x) => x.level === 'critical')!.value;
    const at = (count: number, secs: number) => blocked.verdict!(
      // `secs` is the time waited. The query age is pinned at a value that
      // would read critical if the verdict read it.
      { count, longestQueryAgeSecs: 9999, longestWaitSecs: secs, suspectPid: 99 }, t,
    ).level;

    // warn is a count of blocked sessions; its value is 1, so one unit below
    // is a database with nothing blocked at all.
    expect(warnAt).toBe(1);
    expect(at(warnAt - 1, 9999)).toBe('ok');
    expect(at(warnAt, 0)).toBe('warn');
    expect(at(warnAt + 1, 0)).toBe('warn');

    // critical is the time the session has spent waiting, in seconds.
    expect(at(1, critAt - 1)).toBe('warn');
    expect(at(1, critAt)).toBe('critical');
    expect(at(1, critAt + 1)).toBe('critical');
  });

  // A `t.find(...)!` lookup would throw here instead of degrading to `warn`.
  it('does not throw, and stays visible, when the critical threshold is absent', () => {
    const warnOnly = t.filter((x) => x.level === 'warn');
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 9999, longestWaitSecs: 9999, suspectPid: 99 }, warnOnly);
    expect(v.level).toBe('warn');
  });
});
