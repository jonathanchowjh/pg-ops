// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ pool: null as unknown }));
const read = vi.hoisted(() => ({ result: null as unknown, calls: 0 }));
const connect = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('@/lib/pools', () => ({
  storePool: () => store.pool,
  contextFor: async () => { if (connect.error !== null) throw connect.error; return {}; },
  UnknownDatabaseError: class extends Error {},
}));
vi.mock('@pgops/checks', async (orig) => ({
  ...(await orig<typeof import('@pgops/checks')>()),
  runCheck: async () => { read.calls += 1; return read.result; },
}));
vi.mock('@/lib/check', () => ({ runCheckFor: async () => { read.calls += 1; return read.result; } }));

import { clockFor, eventFor, forget, recordFor, sampleTick, windowFor } from '@/lib/samples';

const ok = (sessions: unknown[]) => ({ ok: true, data: { sessions, truncated: false, hidden: 0 }, verdict: null, measuredAt: Date.now() });
const active = { pid: 1, backendStart: 'b1', app: 'web', cls: 'cpu', own: false, queryId: '7', query: 'SELECT 1',
  inStateSecs: 1, waitSecs: null, blockedBy: [], relations: ['public.users'] };
const grid = (mins: number) => ({ from: Date.now() - mins * 60_000, to: Date.now(), columns: 120, raw: true });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T08:00:01Z')); forget(); read.calls = 0; store.pool = null; connect.error = null; });
afterEach(() => { vi.useRealTimers(); });

describe('samples without a store', () => {
  it('keeps one sample per bucket, whoever records it', async () => {
    await recordFor('db', ok([active]) as never);
    vi.advanceTimersByTime(5_000);
    await recordFor('db', ok([active]) as never);          // the same bucket: dropped
    vi.advanceTimersByTime(15_000);
    await recordFor('db', ok([active]) as never);
    const w = await windowFor('db', grid(15));
    expect(w.kept).toBe('memory');
    expect(w.samples).toHaveLength(2);
    expect(w.statements.get('7')).toEqual({ text: 'SELECT $1', relations: ['public.users'] });
  });

  it('the sampler reads only a bucket nobody filled', async () => {
    read.result = ok([active]);
    await recordFor('db', ok([active]) as never);
    await sampleTick('db');
    expect(read.calls).toBe(0);
    vi.advanceTimersByTime(15_000);
    await sampleTick('db');
    expect(read.calls).toBe(1);
    expect((await windowFor('db', grid(15))).samples).toHaveLength(2);
  });

  it('forgets what is older than fifteen minutes', async () => {
    await recordFor('db', ok([active]) as never);
    vi.advanceTimersByTime(16 * 60_000);
    await recordFor('db', ok([active]) as never);
    expect((await windowFor('db', grid(60))).samples).toHaveLength(1);
  });

  it('marks unreachable once, then reachable once', async () => {
    read.result = { ok: false, reason: 'unreachable', message: 'down' };
    await sampleTick('db');
    vi.advanceTimersByTime(15_000);
    await sampleTick('db');
    read.result = ok([]);
    vi.advanceTimersByTime(15_000);
    await sampleTick('db');
    expect((await windowFor('db', grid(15))).events.map((e) => e.kind)).toEqual(['unreachable', 'reachable']);
  });

  it('marks a database unreachable when its first connection fails', async () => {
    connect.error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    await sampleTick('db');
    expect((await windowFor('db', grid(15))).events.map((e) => e.kind)).toEqual(['unreachable']);
  });

  it('does not blame the database for this console\'s configuration', async () => {
    const { ConfigError } = await import('@/lib/config');
    connect.error = new ConfigError('PGOPS_DATABASES is not JSON');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sampleTick('db');
    expect((await windowFor('db', grid(15))).events).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('closes a chain it stopped seeing before a gap, and forgets a statement nothing names', async () => {
    const waiter = { ...active, pid: 2, cls: 'lock', blockedBy: [1], waitSecs: 1, wanted: null, queryId: '8', query: 'SELECT 2' };
    await recordFor('db', ok([active, waiter]) as never);
    vi.advanceTimersByTime(5 * 60_000);
    await recordFor('db', ok([active]) as never);
    const w = await windowFor('db', grid(15));
    expect(w.events.map((e) => e.kind)).toEqual(['chain-begin', 'chain-end']);
    expect(w.events[1]!.at - w.events[0]!.at).toBe(15_000);
    vi.advanceTimersByTime(16 * 60_000);
    await recordFor('db', ok([active]) as never);
    expect([...(await windowFor('db', grid(15))).statements.keys()]).toEqual(['7']);
  });

  it('marks a database reachable again when it was a page that read it', async () => {
    read.result = { ok: false, reason: 'unreachable', message: 'down' };
    await sampleTick('db');
    vi.advanceTimersByTime(15_000);
    await recordFor('db', ok([active]) as never);          // a page's poll fills the bucket
    await sampleTick('db');
    expect((await windowFor('db', grid(15))).events.map((e) => e.kind)).toEqual(['unreachable', 'reachable']);
  });

  it('grows nothing for a name it never sampled', async () => {
    expect((await windowFor('nope', grid(15))).samples).toEqual([]);
    await recordFor('db', ok([active]) as never);
    expect((await windowFor('nope', grid(15))).samples).toEqual([]);
  });

  it('falls back to memory when the store is down, and logs the outage once', async () => {
    const down = async () => { throw new Error('connection refused'); };
    store.pool = { connect: down, query: down };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await recordFor('db', ok([active]) as never);
      vi.advanceTimersByTime(15_000);
      read.result = ok([active]);
      await sampleTick('db');
      const w = await windowFor('db', grid(15));
      expect(w.kept).toBe('memory');
      expect(w.samples).toHaveLength(2);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps an action as an event', async () => {
    await eventFor('db', 'terminate');
    expect((await windowFor('db', grid(15))).events.map((e) => e.kind)).toEqual(['terminate']);
  });

  it('a failed read is not a sample', async () => {
    expect(await recordFor('db', { ok: false, reason: 'error', message: 'x' } as never)).toBeNull();
    expect((await windowFor('db', grid(15))).samples).toHaveLength(0);
  });
});

describe('a table\'s own events, with no store', () => {
  it('keeps a table\'s analyze off the database\'s window and on its own', async () => {
    await eventFor('db', 'analyze', 'public.users');
    await eventFor('db', 'terminate');
    expect((await windowFor('db', grid(15))).events.map((e) => e.kind)).toEqual(['terminate']);
    expect((await windowFor('db', grid(15), 'public.users')).events.map((e) => e.kind)).toEqual(['analyze', 'terminate']);
    expect((await windowFor('db', grid(15), 'public.orders')).events.map((e) => e.kind)).toEqual(['terminate']);
  });
});

describe('clockFor', () => {
  it('reads the sessions once for a live window, and draws that read last', async () => {
    read.result = ok([active]);
    const c = await clockFor('db', {});
    expect(c.live).toBe(true);
    expect(c.samples.at(-1)!.sessions.map((s) => s.pid)).toEqual([1]);
    expect(c.grid.winSecs).toBe(900);
  });

  it('reads no database for a window in the past, or for a page with no sessions', async () => {
    read.result = ok([active]);
    expect((await clockFor('db', { win: '900', end: String(Date.now() - 3_600_000) })).read).toBeNull();
    expect((await clockFor('db', {}, { sessions: false })).read).toBeNull();
    expect(read.calls).toBe(0);
  });
});
