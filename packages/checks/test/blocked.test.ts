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
    // A8: asserted by NAME. If this field were renamed back to `waitSecs` —
    // the shipped label this check exists to correct — `d.longestQueryAgeSecs`
    // reads `undefined` here and the assertion below fails.
    expect(d.longestQueryAgeSecs).toBe(605.5);
    // B9: and the quantity the verdict reads, kept separate from the age.
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
    // The query age is deliberately well BELOW the threshold here. Against a
    // verdict that read the age, this reports warn.
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 5, longestWaitSecs: critAt, suspectPid: 99 }, t);
    expect(v.level).toBe('critical');
  });

  /**
   * B9, the defect itself. This check's critical threshold talks about
   * client and proxy timeouts having fired, which is a claim about how long
   * a session has been WAITING, and the verdict compared it to how long that
   * session's query had been running. A nightly job that worked for ten
   * minutes and then queued behind a lock one second ago was reported as an
   * outage in progress.
   *
   * locks.ts fixed exactly this under I3 using `pg_locks.waitstart`, and
   * these two panels sit one above the other in the triage page's Locks
   * band, so until now they could report different severities for the same
   * event — the disagreement I3's own note set out to end.
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
   * `waitstart` is documented as briefly NULL for a wait that has only just
   * begun (locks.ts carries the same note). A blocked session whose wait
   * cannot yet be measured must stay visible as a warn, never fall to ok:
   * this check exists to surface blocking, so an unreadable duration fails
   * toward visible like every other unknown in this package.
   */
  it('stays visible when the wait could not be measured yet', () => {
    const v = blocked.verdict!({ count: 2, longestQueryAgeSecs: 9999, longestWaitSecs: null, suspectPid: 9 }, t);
    expect(v.level).toBe('warn');
    expect(v.note).toBe('2 sessions blocked');
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
      // B9: `secs` is the time WAITED. The query age is pinned at a value
      // that would read critical if the verdict ever reads it again.
      { count, longestQueryAgeSecs: 9999, longestWaitSecs: secs, suspectPid: 99 }, t,
    ).level;

    // warn is a COUNT of blocked sessions; its value is 1, so one unit below
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

  // Convention 3: the lookup must not use a non-null assertion. Proven here
  // by actually calling `verdict` with a thresholds array missing `critical`
  // — a `t.find(...)!` would throw `Cannot read properties of undefined`
  // instead of degrading to `warn`.
  it('does not throw, and stays visible, when the critical threshold is absent', () => {
    const warnOnly = t.filter((x) => x.level === 'warn');
    const v = blocked.verdict!({ count: 1, longestQueryAgeSecs: 9999, longestWaitSecs: 9999, suspectPid: 99 }, warnOnly);
    expect(v.level).toBe('warn');
  });
});
