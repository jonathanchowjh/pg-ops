import { describe, expect, it } from 'vitest';
import { chainEvents, lockTables, sampleOf } from '../src/samples.js';
import type { Session, SessionsData } from '../src/checks/sessions.js';

const AT = Date.UTC(2026, 9, 12, 8, 0, 0);
const session = (over: Partial<Session>): Session => ({
  pid: 1, backendStart: 'b1', user: 'app', app: 'web', clientAddr: null, state: 'active', cls: 'cpu',
  own: false, queryId: '7', query: 'SELECT 1', inStateSecs: 10, queryAgeSecs: 10, xactAgeSecs: 10,
  blockedBy: [], relations: ['public.users'], wanted: null, waitSecs: null, ...over,
});
const data = (sessions: Session[], over: Partial<SessionsData> = {}): SessionsData =>
  ({ sessions, truncated: false, hidden: 0, ...over });

describe('sampleOf', () => {
  it('keeps sessions not idle and drops idle ones, hidden ones and pgops\'s own', () => {
    const { sample } = sampleOf(data([
      session({ pid: 1 }),
      session({ pid: 2, cls: null, state: 'idle' }),
      session({ pid: 3, own: true }),
      session({ pid: 4, backendStart: null }),
    ]), AT);
    expect(sample.sessions.map((s) => s.pid)).toEqual([1]);
  });

  it('dates a state from its age, and a lock wait from when the wait began', () => {
    const { sample } = sampleOf(data([
      session({ pid: 1, inStateSecs: 10 }),
      session({ pid: 2, cls: 'lock', inStateSecs: 40, waitSecs: 30, blockedBy: [9, 5] }),
    ]), AT);
    expect(sample.sessions[0]!.since).toBe(AT - 10_000);
    expect(sample.sessions[1]!.since).toBe(AT - 30_000);
    // Two blockers, one tie: the lowest pid, so the tie does not move between polls.
    expect(sample.sessions[1]!.blockedBy).toBe(5);
  });

  it('keys a statement by its id, or by its shape when there is none', () => {
    const { sample, texts } = sampleOf(data([
      session({ pid: 1, queryId: '7', query: 'SELECT  1' }),
      session({ pid: 2, queryId: null, query: "ALTER USER a PASSWORD 'hunter2'", relations: [] }),
      session({ pid: 3, queryId: null, query: null }),
    ]), AT);
    expect(sample.sessions[0]!.statement).toBe('7');
    expect(texts.get('7')).toEqual({ text: 'SELECT $1', relations: ['public.users'] });
    const key = sample.sessions[1]!.statement!;
    expect(key).toMatch(/^t[0-9a-f]{16}$/);
    expect(texts.get(key)!.text).not.toContain('hunter2');
    expect(sample.sessions[2]!.statement).toBeNull();
  });

  it('stores no value a statement carried: two that differ only in one are one statement', () => {
    const { sample, texts } = sampleOf(data([
      session({ pid: 1, queryId: null, query: "SELECT * FROM u WHERE email = 'jo@x.com'" }),
      session({ pid: 2, queryId: null, query: "SELECT * FROM u WHERE email = 'al@y.org'" }),
    ]), AT);
    expect(sample.sessions[0]!.statement).toBe(sample.sessions[1]!.statement);
    expect([...texts.values()].map((t) => t.text)).toEqual(['SELECT * FROM u WHERE email = $1']);
  });

  it('puts the table a waiter waits for first, whatever it holds more strongly', () => {
    const { sample } = sampleOf(data([
      session({ cls: 'lock', blockedBy: [9], relations: ['public.a', 'public.b'], wanted: 'public.b' }),
    ]), AT);
    expect(sample.sessions[0]!.relations).toEqual(['public.b', 'public.a']);
    expect(lockTables(sample)).toEqual(['public.b']);
  });

  it('carries the cut and the restricted role as flags', () => {
    expect(sampleOf(data([], { truncated: true, hidden: 5 }), AT).sample)
      .toMatchObject({ truncated: true, hidden: true });
  });
});

describe('chainEvents', () => {
  const waiting = (relation: string | null) => sampleOf(data([
    session({ cls: 'lock', blockedBy: [9], relations: relation === null ? [] : [relation] }),
  ]), AT).sample;
  const calm = sampleOf(data([session({})]), AT).sample;

  const B = AT;
  const before = (tables: string[], ago = 15_000) => ({ bucket: B - ago, tables });
  it('begins on the first sample with a lock wait on a table', () => {
    expect(chainEvents(before([]), waiting('public.users'), B)).toEqual([{ at: B, kind: 'chain-begin', relation: 'public.users' }]);
  });
  it('says nothing while the wait goes on', () => {
    expect(chainEvents(before(['public.users']), waiting('public.users'), B)).toEqual([]);
  });
  it('ends on the first sample without one', () => {
    expect(chainEvents(before(['public.users']), calm, B)).toEqual([{ at: B, kind: 'chain-end', relation: 'public.users' }]);
  });
  it('with no sample before, begins what it sees and ends nothing', () => {
    expect(chainEvents(null, waiting('public.users'), B)).toEqual([{ at: B, kind: 'chain-begin', relation: 'public.users' }]);
    expect(chainEvents(null, calm, B)).toEqual([]);
  });
  it('after a gap, closes what it last saw at the bucket after it, and begins again', () => {
    expect(chainEvents(before(['public.users'], 75_000), waiting('public.users'), B)).toEqual([
      { at: B - 60_000, kind: 'chain-end', relation: 'public.users' },
      { at: B, kind: 'chain-begin', relation: 'public.users' },
    ]);
  });
  it('carries a wait across a minute, not past it', () => {
    expect(chainEvents(before(['public.users'], 60_000), waiting('public.users'), B)).toEqual([]);
  });
  it('names a wait on no table as the database\'s', () => {
    expect(lockTables(waiting(null))).toEqual(['']);
  });
});
