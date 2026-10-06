import { describe, expect, it } from 'vitest';
import {
  isIdleInTransaction, prepareSessions, sessions, sessionStates, type StateRow,
  type Session, type SessionRow,
} from '../src/checks/sessions.js';

const s = (o: Partial<Session>): Session => ({
  pid: 1, state: 'idle', user: 'u', app: 'a', clientAddr: null, backendStart: null,
  inStateSecs: 0, queryAgeSecs: 0, xactAgeSecs: null, query: '', ...o,
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

  // A9: the old comparator fell back to queryAgeSecs (renamed from
  // runningSecs — see A8) for anything not idle-in-transaction. For an
  // `idle` session that number is time since its LAST query finished, so it
  // carries no information about how long the session has actually been
  // idle. This test pins pid 2 first specifically because its queryAgeSecs
  // (1) is smaller than pid 1's (900) — a regression to sorting by
  // queryAgeSecs would rank them the other way around.
  it('orders idle sessions by time in state, not by a stale query age (A9)', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle', inStateSecs: 5, queryAgeSecs: 900 }),
       s({ pid: 2, state: 'idle', inStateSecs: 60, queryAgeSecs: 1 })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([2, 1]);
  });

  // A9, same principle for the idle-in-transaction group: state_change, not
  // query_start, is what "how long stuck" means for a session that already
  // finished its last statement and is just sitting in the transaction.
  it('orders idle-in-transaction sessions by time in state too', () => {
    const out = prepareSessions(
      [s({ pid: 1, state: 'idle in transaction', inStateSecs: 5, queryAgeSecs: 900 }),
       s({ pid: 2, state: 'idle in transaction', inStateSecs: 60, queryAgeSecs: 1 })],
      { sort: 'triage', filter: '' },
    );
    expect(out.map((r) => r.pid)).toEqual([2, 1]);
  });

  // A10: the old filter searched user/app/state/query only. An operator
  // arriving from a log line or an alert almost always holds a pid and
  // nothing else.
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
  in_state_secs: '1', query_age_secs: '1', xact_age_secs: null, query: 'select 1', total_matching: 1, ...o,
});

describe('sessions.map', () => {
  // A7: pg_stat_activity is unbounded. `total_matching` is the SQL's
  // count(*) OVER () — the count BEFORE the LIMIT clipped it (window
  // functions run before LIMIT in Postgres's execution order). A bare
  // `LIMIT $1` with no such signal would make this indistinguishable from
  // a database that genuinely only had 2 sessions.
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
    });
  });

  it('carries the transaction age', () => {
    const d = sessions.map([{
      pid: 1, state: 'active', usename: 'u', app: 'a', client_addr: null, backend_start: null,
      in_state_secs: '1', query_age_secs: '2', xact_age_secs: '30',
      query: 'x', total_matching: 1,
    }]);
    expect(d.sessions[0]!.xactAgeSecs).toBe(30);
  });

  it('maps a null transaction age to null, never 0', () => {
    const d = sessions.map([{
      pid: 1, state: 'idle', usename: null, app: null, client_addr: null, backend_start: null,
      in_state_secs: null, query_age_secs: null, xact_age_secs: null,
      query: null, total_matching: 1,
    }]);
    expect(d.sessions[0]!.xactAgeSecs).toBeNull();
  });
});

describe('sessions SQL parameter wiring (fix-round 1)', () => {
  // Fix-round 1, A7 vs A10: `SessionOpts.pid` must actually reach the
  // query as `$2`, or the server-side pid lookup this whole fix depends on
  // silently never fires. Pure — no database needed to prove the wiring;
  // sessions.int.test.ts proves the predicate does what the wiring implies.
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
 * B12. The panel reads "WARN idle in transaction for 253s" and its remedy
 * says "Find the application holding it open — Sessions shows its
 * application_name". The check knew which session set that number and threw
 * it away, so the console told an operator to go and look for something it
 * had already identified.
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
   * not own, and the pid is still worth having on its own: it is what the
   * link on the panel points at.
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
   * `oldestIdleInTxnSecs` comes from the census branch, as it always has, so
   * the verdict's threshold still reads the same max. The second branch is
   * for identity only — if the two ever disagreed, the number an operator
   * sees beside the pid must be the pid's own.
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
 * I5. `sessionStates.verdict` had no test of any kind, and it was the check
 * carrying the `>=` vs `>` divergence INSIDE one function: `s >= crit.value`
 * for critical but `s > warn.value` for warn. Nothing pinned either. Spec §9
 * requires each threshold be asserted at its value and one unit either side;
 * the ruling standardised both comparisons on `>=`, since a threshold is the
 * value AT WHICH the condition becomes a problem — which is how this check's
 * own `because` strings read ("a transaction idle for a minute is holding
 * row locks", not "idle for more than a minute").
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
   * B12: the note carries the identity, so the panel can link it and the
   * triage fold (A17) can tell whether this panel is about a session the
   * lock graph already names.
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

  // Convention 3, the same proof the other checks carry: the lookups must
  // not use a non-null assertion.
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
