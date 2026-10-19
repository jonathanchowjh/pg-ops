import { describe, expect, it } from 'vitest';
import {
  CLASSES, classOf, isIdleInTransaction, prepareSessions, sessions, sessionStates, type StateRow,
  type Session, type SessionRow,
} from '../src/checks/sessions.js';

const s = (o: Partial<Session>): Session => ({
  pid: 1, state: 'idle', user: 'u', app: 'a', clientAddr: null, backendStart: null,
  inStateSecs: 0, queryAgeSecs: 0, xactAgeSecs: null, query: '',
  cls: null, own: false, queryId: null, blockedBy: [], relations: [], wanted: null, waitSecs: null, ...o,
});

describe('isIdleInTransaction', () => {
  it('covers both Postgres spellings, and only those', () => {
    expect(isIdleInTransaction('idle in transaction')).toBe(true);
    expect(isIdleInTransaction('idle in transaction (aborted)')).toBe(true);
    expect(isIdleInTransaction('idle')).toBe(false);
    expect(isIdleInTransaction(null)).toBe(false);
  });
});

describe('prepareSessions', () => {
  it('ranks idle-in-transaction first, then active, then idle', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle' }), s({ pid: 2, state: 'active' }),
       s({ pid: 3, state: 'idle in transaction' })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([3, 2, 1]);
  });

  // For an `idle` session queryAgeSecs says nothing about how long it has
  // been idle. pid 2 has the smaller queryAgeSecs, so sorting by that would
  // rank them the other way around.
  it('orders idle sessions by time in state, not by a stale query age (A9)', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle', inStateSecs: 5, queryAgeSecs: 900 }),
       s({ pid: 2, state: 'idle', inStateSecs: 60, queryAgeSecs: 1 })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([2, 1]);
  });

  it('orders idle-in-transaction sessions by time in state too', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle in transaction', inStateSecs: 5, queryAgeSecs: 900 }),
       s({ pid: 2, state: 'idle in transaction', inStateSecs: 60, queryAgeSecs: 1 })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([2, 1]);
  });

  // An operator arriving from a log line or an alert usually holds only a pid.
  it('matches a pid typed into the filter (A10)', () => {
    const out = prepareSessions(
      [s({ pid: 4242, app: 'web' }), s({ pid: 7, app: 'cron' })],
      { sort: 'triage', filter: '4242' },
    );
    expect(out.map((r) => r.pid)).toEqual([4242]);
  });

  it('still matches on user/app/state/query as before', () => {
    const out = prepareSessions(
      [s({ pid: 1, app: 'web' }), s({ pid: 2, app: 'cron' })],
      { sort: 'triage', filter: 'cron' },
    );
    expect(out.map((r) => r.pid)).toEqual([2]);
  });
});

const row = (o: Partial<SessionRow>): SessionRow => ({
  pid: 1, state: 'active', usename: 'u', app: 'a', client_addr: null, backend_start: null,
  in_state_secs: '1', query_age_secs: '1', xact_age_secs: null, query: 'select 1', total_matching: 1,
  wait_event_type: null, query_id: null, own: false, blocked_by: [], relations: [], wanted: null,
  wait_secs: null, hidden: 0, ...o,
});

describe('sessions.map', () => {
  // `total_matching` is the SQL's count(*) OVER (), the count before LIMIT.
  // Without it a clipped result looks like a database with only 2 sessions.
  it('signals truncation when the pre-LIMIT count exceeds the returned rows (A7)', () => {
    const data = sessions.map([row({ pid: 1, total_matching: 3 }), row({ pid: 2, total_matching: 3 })]);
    expect(data.truncated).toBe(true);
    expect(data.sessions).toHaveLength(2);
  });

  it('does not signal truncation when every matching row was returned', () => {
    const data = sessions.map([row({ pid: 1, total_matching: 1 })]);
    expect(data.truncated).toBe(false);
  });

  it('does not signal truncation on an empty result', () => {
    expect(sessions.map([]).truncated).toBe(false);
  });

  it('maps snake_case columns to the camelCase domain shape', () => {
    const data = sessions.map([row({
      pid: 42, state: 'active', usename: 'app', app: 'web',
      client_addr: '10.0.0.1', backend_start: '2026-01-01T00:00:00Z',
      in_state_secs: '3.5', query_age_secs: '1.25', xact_age_secs: '4.5', query: 'select 1',
      total_matching: 1,
    })]);
    expect(data.sessions[0]).toEqual({
      pid: 42, state: 'active', user: 'app', app: 'web',
      clientAddr: '10.0.0.1', backendStart: '2026-01-01T00:00:00Z',
      inStateSecs: 3.5, queryAgeSecs: 1.25, xactAgeSecs: 4.5, query: 'select 1',
      cls: 'cpu', own: false, queryId: null, blockedBy: [], relations: [], wanted: null, waitSecs: null,
    });
  });

  it('carries the transaction age', () => {
    const d = sessions.map([row({ xact_age_secs: '30' })]);
    expect(d.sessions[0]!.xactAgeSecs).toBe(30);
  });

  it('maps a null transaction age to null, never 0', () => {
    const d = sessions.map([row({ state: 'idle', xact_age_secs: null })]);
    expect(d.sessions[0]!.xactAgeSecs).toBeNull();
  });
});

describe('the fused read\'s map', () => {
  it('drops the carrier row and keeps its hidden count', () => {
    const data = sessions.map([row({ pid: null, hidden: 3, total_matching: 0 })]);
    expect(data).toEqual({ sessions: [], truncated: false, hidden: 3 });
  });

  it('classes each session and keeps its tables strongest first', () => {
    const data = sessions.map([row({
      wait_event_type: 'Lock', blocked_by: [9], relations: ['public.b', 'public.a'], wanted: 'public.b', wait_secs: '4.5',
    })]);
    expect(data.sessions[0]).toMatchObject({
      cls: 'lock', blockedBy: [9], relations: ['public.b', 'public.a'], wanted: 'public.b', waitSecs: 4.5,
    });
  });
});

describe('classOf', () => {
  it.each([
    ['active', null, 'cpu'],
    ['active', 'IO', 'io'],
    ['active', 'Lock', 'lock'],
    ['active', 'LWLock', 'other'],
    // A waiting ClientRead is not CPU.
    ['active', 'Client', 'other'],
    // pg_sleep.
    ['active', 'Timeout', 'other'],
    ['fastpath function call', null, 'cpu'],
    ['idle in transaction', 'Client', 'idle'],
    ['idle in transaction (aborted)', null, 'idle'],
    ['idle', 'Client', null],
    ['disabled', null, null],
    // Not visible to this role.
    [null, null, null],
  ] as const)('%s waiting on %s is %s', (state, wait, cls) => {
    expect(classOf(state, wait)).toBe(cls);
  });

  it('lists the classes bottom up, lock wait on top', () => {
    expect(CLASSES).toEqual(['cpu', 'io', 'idle', 'other', 'lock']);
  });
});

describe('sessions SQL parameter wiring (fix-round 1)', () => {
  // `SessionOpts.pid` must reach the query as `$2`, or the server-side pid
  // lookup never fires. sessions.int.test.ts proves the predicate itself.
  it('passes limit and pid through as positional parameters', () => {
    if (typeof sessions.sql !== 'function') throw new Error('expected a function sql');
    const q = sessions.sql({ limit: 7, pid: 4242 });
    expect(q.values).toEqual([7, 4242]);
    expect(q.text).toContain('$2');
  });

  it('defaults pid to null so the predicate is a no-op when omitted', () => {
    if (typeof sessions.sql !== 'function') throw new Error('expected a function sql');
    const q = sessions.sql({});
    expect(q.values).toEqual([500, null]);
  });
});

/**
 * The check knows which session set the idle-in-transaction age, so it names
 * it rather than sending the operator to look for it.
 */
describe('sessionStates.map — the session that set the verdict', () => {
  const census = (over: Partial<StateRow> = {}): StateRow => ({
    kind: 'state', state: 'idle', sessions: 4, longest_secs: '2',
    pid: null, app: null, ...over,
  });

  it('names the pid and application of the oldest idle-in-transaction session', () => {
    const d = sessionStates.map([
      census(),
      census({ state: 'idle in transaction', sessions: 1, longest_secs: '253' }),
      { kind: 'oldest', state: null, sessions: 0, longest_secs: '253', pid: 18705, app: 'batch-worker' },
    ]);
    expect(d.oldestIdleInTxnSecs).toBe(253);
    expect(d.oldestIdleInTxnPid).toBe(18705);
    expect(d.oldestIdleInTxnApp).toBe('batch-worker');
    // The census itself must not gain a row from the second branch.
    expect(d.byState.map((r) => r.state)).toEqual(['idle', 'idle in transaction']);
  });

  it('leaves the pid null when nothing is idle in transaction', () => {
    const d = sessionStates.map([census()]);
    expect(d.oldestIdleInTxnSecs).toBeNull();
    expect(d.oldestIdleInTxnPid).toBeNull();
    expect(d.oldestIdleInTxnApp).toBeNull();
  });

  /**
   * A restricted role reads `application_name` as null for a session it does
   * not own; the pid is still what the panel's link points at.
   */
  it('keeps the pid when the application cannot be read', () => {
    const d = sessionStates.map([
      census({ state: 'idle in transaction', sessions: 1, longest_secs: '70' }),
      { kind: 'oldest', state: null, sessions: 0, longest_secs: '70', pid: 991, app: null },
    ]);
    expect(d.oldestIdleInTxnPid).toBe(991);
    expect(d.oldestIdleInTxnApp).toBeNull();
  });

  /**
   * `oldestIdleInTxnSecs` comes from the census branch, so the verdict's
   * threshold reads the same max. The second branch is for identity only; if
   * the two ever disagreed, the number an operator sees beside the pid must
   * be the pid's own.
   */
  it('reports the named session own age, not the census maximum', () => {
    const d = sessionStates.map([
      census({ state: 'idle in transaction', sessions: 2, longest_secs: '400' }),
      { kind: 'oldest', state: null, sessions: 0, longest_secs: '400', pid: 7, app: 'a' },
    ]);
    expect(d.oldestIdleInTxnSecs).toBe(400);
    expect(d.oldestIdleInTxnPid).toBe(7);
  });
});

/**
 * Each threshold is asserted at its value and one unit either side. Both
 * comparisons are `>=`: a threshold is the value at which the condition
 * becomes a problem.
 */
describe('sessionStates.verdict', () => {
  const t = sessionStates.thresholds!;
  const warnAt = t.find((x) => x.level === 'warn')!.value;
  const critAt = t.find((x) => x.level === 'critical')!.value;

  /** A census with one idle-in-transaction session, idle for `secs`. */
  const at = (secs: number | null) => sessionStates.verdict!(
    {
      byState: [{ state: 'idle in transaction', sessions: 1, longestInStateSecs: secs ?? 0 }],
      oldestIdleInTxnSecs: secs, oldestIdleInTxnPid: null, oldestIdleInTxnApp: null,
    },
    t,
  ).level;

  it('reports ok when nothing is idle in transaction at all', () => {
    expect(at(null)).toBe('ok');
  });

  it('flips to warn exactly at the warn threshold', () => {
    expect(at(warnAt - 1)).toBe('ok');
    expect(at(warnAt)).toBe('warn');
    expect(at(warnAt + 1)).toBe('warn');
  });

  it('flips to critical exactly at the critical threshold', () => {
    expect(at(critAt - 1)).toBe('warn');
    expect(at(critAt)).toBe('critical');
    expect(at(critAt + 1)).toBe('critical');
  });

  /**
   * The note carries the identity, so the panel can link it and the triage
   * fold can tell whether the lock graph already names this session.
   */
  it('names the session in the note, and says only what it knows', () => {
    const note = (pid: number | null, app: string | null) => sessionStates.verdict!(
      {
        byState: [{ state: 'idle in transaction', sessions: 1, longestInStateSecs: 253 }],
        oldestIdleInTxnSecs: 253, oldestIdleInTxnPid: pid, oldestIdleInTxnApp: app,
      },
      t,
    ).note;

    expect(note(18705, 'batch-worker')).toBe('idle in transaction for 253s · pid 18705 batch-worker');
    expect(note(991, null)).toBe('idle in transaction for 253s · pid 991');
    expect(note(null, null)).toBe('idle in transaction for 253s');
  });

  // The lookups must not use a non-null assertion.
  it('does not throw when a threshold level is absent from the array', () => {
    const warnOnly = t.filter((x) => x.level === 'warn');
    const d = {
      byState: [{ state: 'idle in transaction', sessions: 1, longestInStateSecs: 99999 }],
      oldestIdleInTxnSecs: 99999, oldestIdleInTxnPid: null, oldestIdleInTxnApp: null,
    };
    expect(sessionStates.verdict!(d, warnOnly).level).toBe('warn');
    expect(sessionStates.verdict!(d, []).level).toBe('ok');
  });
});
