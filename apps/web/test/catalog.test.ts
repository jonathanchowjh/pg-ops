// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: 'off' as 'off' | 'up' | 'down',
  captured: null as Record<string, unknown> | null,
  ran: [] as [string, unknown][],
  fail: null as string | null,
  /** While set, every check waits on it: a slow scan. */
  gate: null as Promise<void> | null,
  /** Set: the next check throws, as no runner ever should. */
  throws: false,
}));
vi.mock('@pgops/checks', async (orig) => ({
  ...(await orig<typeof import('@pgops/checks')>()),
  readCaptured: async (_store: unknown, _name: string, read: string) => state.captured?.[read] ?? null,
}));
vi.mock('@/lib/check', () => ({
  readStore: async (read: (store: unknown) => Promise<unknown>) => {
    if (state.store === 'off') return { ok: false, kind: 'off', message: 'History is off.' };
    if (state.store === 'down') return { ok: false, kind: 'error', message: 'connection refused' };
    return { ok: true, value: await read({}) };
  },
  runCheckFor: async (_name: string, check: { id: string }, opts: unknown) => {
    state.ran.push([check.id, opts]);
    if (state.gate !== null) await state.gate;
    if (state.throws) { state.throws = false; throw new Error('runner rejected'); }
    if (state.fail === check.id) return { ok: false, reason: 'error', message: 'statement timeout' };
    const data = check.id === 'tables' ? { tables: [T('public.users')], total: 9, truncated: true, statsReset: null, freezeMaxAge: 2e8 }
      : check.id === 'indexes' ? { indexes: [], total: 0, truncated: false, statsReset: 777 }
        : { sequences: [], total: 0, truncated: false, unreadable: 0, worstPctUsed: null };
    return { ok: true, verdict: null, measuredAt: 0, data };
  },
}));

import type { IndexRead, SequenceEntry, TableRead } from '@pgops/checks';
import { catalogFor, forgetCatalog, pointersOf, tablesFor, type Catalog } from '@/lib/catalog';

function T(name: string, over: Partial<TableRead> = {}): TableRead {
  return {
    name, kind: 'table', sizeBytes: 100, heapBytes: 80, indexBytes: 20, liveRows: 7, deadRows: 0, vacuumTrigger: 51,
    inserted: 0, updated: 0, deleted: 0, seqScans: 0, seqRows: 0, idxScans: 0, idxRows: 0, hitRate: null,
    lastVacuum: null, lastAnalyze: null, xidAge: 1, indexes: 1, unvalidated: 0, vacuuming: null, ...over,
  };
}
function I(name: string, sizeBytes: number): IndexRead {
  return { name, table: 'public.t', columns: 'id', sizeBytes, scans: 0, hitRate: null, unique: false, primary: false, valid: true, duplicateOf: null };
}
function S(name: string, pctUsed: number | null): SequenceEntry {
  return { name, table: null, column: null, columnType: null, maxValue: 100, lastValue: pctUsed, pctUsed, readable: pctUsed !== null };
}
const head = (rows: unknown[], at: number, over = {}) =>
  ({ rows, at, ok: true, message: null, total: rows.length, statsReset: null, freezeMaxAge: 2e8, ...over });
const NOW = Date.parse('2026-10-12T08:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  forgetCatalog();
  Object.assign(state, { store: 'off', captured: null, ran: [], fail: null, gate: null, throws: false });
});
afterEach(() => { vi.useRealTimers(); });

describe('catalogFor', () => {
  it('is the capture\'s rows when the store has a fresh one, and runs no check', async () => {
    state.store = 'up';
    state.captured = {
      tables: head([T('public.small', { sizeBytes: 1 }), T('public.big', { sizeBytes: 9 })], NOW - 120_000, { total: 12 }),
      indexes: head([I('public.small_ix', 1), I('public.big_ix', 9)], NOW - 120_000, { statsReset: 555 }),
      sequences: head([S('public.none_seq', null), S('public.low_seq', 10), S('public.high_seq', 95)], NOW - 120_000),
    };
    const c = await catalogFor('db');
    // The store hands its rows back in no set order.
    expect(c.tables.map((t) => t.name)).toEqual(['public.big', 'public.small']);
    expect(c.indexes.map((i) => i.name)).toEqual(['public.big_ix', 'public.small_ix']);
    expect(c.sequences.map((s) => s.name)).toEqual(['public.high_seq', 'public.low_seq', 'public.none_seq']);
    expect(c).toMatchObject({ tablesTotal: 12, at: NOW - 120_000, statsReset: 555, freezeMaxAge: 2e8, failed: [] });
    expect(state.ran).toEqual([]);
  });

  it('reads the catalog itself with no store, the three one after another, once a minute', async () => {
    const c = await catalogFor('db');
    expect(state.ran).toEqual([
      ['tables', { limit: 5000, relation: undefined }], ['indexes', { limit: 5000, relation: undefined }],
      ['sequences', { limit: 5000, relation: undefined }],
    ]);
    expect(c).toMatchObject({ tablesTotal: 9, at: NOW, statsReset: 777 });
    vi.advanceTimersByTime(55_000);
    await catalogFor('db');
    expect(state.ran).toHaveLength(3);
    vi.advanceTimersByTime(10_000);
    await catalogFor('db');
    expect(state.ran).toHaveLength(6);
  });

  // Review Focus 6.
  it('reads the catalog itself when the store will not answer', async () => {
    state.store = 'down';
    expect((await catalogFor('db')).tables.map((t) => t.name)).toEqual(['public.users']);
  });

  // Review Focus 6.
  it('does not take a capture older than two intervals for the catalog', async () => {
    state.store = 'up';
    state.captured = { tables: head([T('public.old')], NOW - 11 * 60_000), indexes: head([], NOW), sequences: head([], NOW) };
    expect((await catalogFor('db')).tables.map((t) => t.name)).toEqual(['public.users']);
  });

  it('does not call a catalog empty when its first capture failed', async () => {
    state.store = 'up';
    state.captured = {
      tables: head([], NOW - 60_000, { ok: false, message: 'statement timeout' }),
      indexes: head([], NOW - 60_000), sequences: head([], NOW - 60_000),
    };
    expect(await catalogFor('db')).toMatchObject({ tablesTotal: null, indexesTotal: 0, failed: [{ read: 'tables', message: 'statement timeout' }] });
  });

  it('says a captured read failed, and keeps the rows it has', async () => {
    state.store = 'up';
    state.captured = {
      tables: head([T('public.users')], NOW - 60_000, { ok: false, message: 'statement timeout' }),
      indexes: head([], NOW - 60_000), sequences: head([], NOW - 60_000),
    };
    const c = await catalogFor('db');
    expect(c.failed).toEqual([{ read: 'tables', message: 'statement timeout' }]);
    expect(c.tables).toHaveLength(1);
  });

  it('keeps the rows before a read that fails, and does not start the scan again on the next poll', async () => {
    await catalogFor('db');
    vi.advanceTimersByTime(61_000);
    state.fail = 'tables';
    const c = await catalogFor('db');
    expect(c.tables.map((t) => t.name)).toEqual(['public.users']);
    expect(c.failed).toEqual([{ read: 'tables', message: 'statement timeout' }]);
    vi.advanceTimersByTime(5_000);
    await catalogFor('db');
    expect(state.ran).toHaveLength(6);
  });

  /** Each read holds a pool connection. One a poll, during a slow scan, emptied the pool the tree's sessions read needs. */
  it('makes one read for every call that arrives while it is in flight', async () => {
    let open!: () => void;
    state.gate = new Promise((resolve) => { open = resolve; });
    const calls = Array.from({ length: 8 }, () => catalogFor('db'));
    await vi.advanceTimersByTimeAsync(0);
    open();
    const all = await Promise.all(calls);
    expect(state.ran).toHaveLength(3);
    expect(new Set(all).size).toBe(1);
    // Dated when it finished, so the next minute is fresh from then.
    await catalogFor('db');
    expect(state.ran).toHaveLength(3);
  });

  it('forgets a read that rejected, so the next call reads again', async () => {
    state.throws = true;
    await expect(catalogFor('db')).rejects.toThrow('runner rejected');
    expect((await catalogFor('db')).tables.map((t) => t.name)).toEqual(['public.users']);
  });

  it('asks about one table live, whatever the store holds, and keeps that apart', async () => {
    state.store = 'up';
    state.captured = { tables: head([], NOW), indexes: head([], NOW), sequences: head([], NOW) };
    await catalogFor('db', 'public.users');
    expect(state.ran.map(([id, o]) => [id, (o as { relation: string }).relation])).toEqual([
      ['tables', 'public.users'], ['indexes', 'public.users'], ['sequences', 'public.users'],
    ]);
    expect((await catalogFor('db')).tables).toEqual([]);
  });
});

describe('tablesFor', () => {
  it('is the catalog\'s tables as facts, each with its flags', async () => {
    const { facts, total } = await tablesFor('db', '');
    expect(facts).toEqual([{ name: 'public.users', sizeBytes: 100, liveRows: 7, flags: [] }]);
    expect(total).toBe(9);
  });

  it('searches by name, live, when the find box holds one, and caches that apart', async () => {
    await tablesFor('db', ' audit ');
    await tablesFor('db', '');
    expect(state.ran[0]).toEqual(['tables', { limit: 1000, search: 'audit' }]);
    expect(state.ran).toHaveLength(4);
    await tablesFor('db', 'audit');
    expect(state.ran).toHaveLength(4);
  });

  it('says the total is unknown when the catalog was never read', async () => {
    state.fail = 'tables';
    expect(await tablesFor('db', '')).toEqual({ facts: [], total: null });
  });
});

describe('pointersOf', () => {
  const seq = (name: string, pctUsed: number | null, table: string | null = 'public.events'): SequenceEntry =>
    ({ name, table, column: table === null ? null : 'id', columnType: table === null ? null : 'integer', maxValue: 2147483647, lastValue: 1, pctUsed, readable: pctUsed !== null });
  const catalog = (over: Partial<Catalog>): Catalog => ({
    tables: [], indexes: [], sequences: [], tablesTotal: 0, indexesTotal: 0, at: NOW, statsReset: null, freezeMaxAge: 2e8, failed: [], ...over,
  });

  it('names a sequence past ninety per cent and points at its table, or at Tables when it has none', () => {
    const p = pointersOf('prod', catalog({ sequences: [seq('public.a_seq', 97.4), seq('public.b_seq', 91, null), seq('public.c_seq', 89.9), seq('public.d_seq', null)] }));
    expect(p).toEqual([
      { label: 'public.a_seq', note: '97% of integer', level: 'warn', href: '/db/prod/tables/public.events' },
      { label: 'public.b_seq', note: '91% of its range', level: 'warn', href: '/db/prod/tables' },
    ]);
  });

  it('names a table read by full scan, and at most three of a kind', () => {
    const scanned = (n: number) => T(`public.t${n}`, { liveRows: 10_000 * n, seqScans: 50, idxScans: 50 });
    const p = pointersOf('prod', catalog({ tables: [scanned(4), scanned(3), scanned(2), scanned(1)] }));
    expect(p.map((x) => [x.label, x.note, x.href])).toEqual([
      ['public.t4', 'read by full scan', '/db/prod/tables/public.t4'],
      ['public.t3', 'read by full scan', '/db/prod/tables/public.t3'],
      ['public.t2', 'read by full scan', '/db/prod/tables/public.t2'],
    ]);
  });

  it('encodes a name once on the way into a URL', () => {
    const p = pointersOf('prod', catalog({ tables: [T('public.a/b', { liveRows: 10_000, seqScans: 50, idxScans: 50 })] }));
    expect(p[0]!.href).toBe('/db/prod/tables/public.a%2Fb');
  });
});
