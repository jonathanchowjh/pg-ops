import { describe, expect, it } from 'vitest';
import {
  CLASSES, classOf, isIdleInTransaction, sessions,
  type SessionRow,
} from '../src/checks/sessions.js';

describe('isIdleInTransaction', () => {
  it('covers both Postgres spellings, and only those', () => {
    expect(isIdleInTransaction('idle in transaction')).toBe(true);
    expect(isIdleInTransaction('idle in transaction (aborted)')).toBe(true);
    expect(isIdleInTransaction('idle')).toBe(false);
    expect(isIdleInTransaction(null)).toBe(false);
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
