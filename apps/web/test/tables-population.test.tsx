import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceEntry, TableRead } from '@pgops/checks';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/tables/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
// The real clockFor and windowFor, on the memory path.
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));
const ran = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_n: string, check: { id: string }) => { ran.ids.push(check.id); return { ok: true, measuredAt: 0, data: {} }; }),
  readStore: vi.fn(async () => ({ ok: false, kind: 'off', message: '' })),
}));
const state = vi.hoisted(() => ({
  /** Undefined: as many as are listed. Null: never read. */
  tables: [] as unknown[], sequences: [] as unknown[], total: undefined as number | null | undefined, failed: [] as unknown[],
  written: null as unknown,
}));
vi.mock('@/lib/catalog', async (orig) => ({
  ...(await orig<typeof import('@/lib/catalog')>()),
  catalogFor: async () => ({
    tables: state.tables, indexes: [], sequences: state.sequences, tablesTotal: state.total === undefined ? state.tables.length : state.total, indexesTotal: 0,
    at: Date.UTC(2026, 9, 12, 8, 0, 0), statsReset: null, freezeMaxAge: 2e8, failed: state.failed,
  }),
  writtenFor: async () => state.written,
}));

const table = (name: string, sizeBytes: number, over: Partial<TableRead> = {}): TableRead => ({
  name, kind: 'table', sizeBytes, heapBytes: sizeBytes, indexBytes: 0, liveRows: 1200, deadRows: 3, vacuumTrigger: 290,
  inserted: 0, updated: 0, deleted: 0, seqScans: 0, seqRows: 0, idxScans: 0, idxRows: 0, hitRate: null,
  lastVacuum: null, lastAnalyze: null, xidAge: 1, indexes: 1, unvalidated: 0, vacuuming: null, ...over,
});
const seq = (name: string, tableName: string | null): SequenceEntry =>
  ({ name, table: tableName, column: tableName === null ? null : 'id', columnType: tableName === null ? null : 'integer', maxValue: 1000, lastValue: 10, pctUsed: 1, readable: true });

let view: Rendered;
const mount = async (sp: Record<string, string> = {}) => {
  view = await render(await Page({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve(sp) }));
};
beforeEach(() => { Object.assign(state, { tables: [], sequences: [], total: undefined, failed: [], written: { ok: false, kind: 'off', message: 'History is off.' } }); ran.ids = []; });
afterEach(() => { view.unmount(); });
const names = () => [...view.container.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent);

describe('/tables', () => {
  it('lists every table with its catalog columns, and runs no check on the monitored database itself', async () => {
    state.tables = [table('public.orders', 9_000_000, { deadRows: 600 }), table('public.users', 4096)];
    await mount();
    expect(names()).toEqual(['public.orders', 'public.users']);
    expect(view.text()).toContain('2 · 8.6 MB · 1 vacuum overdue');
    expect(view.container.querySelector('a[href="/db/prod/tables/public.orders"]')).not.toBeNull();
    expect(ran.ids).toEqual([]);
  });

  // Review Focus 5.
  it('lists the sequences no column owns at its foot, and only those', async () => {
    state.tables = [table('public.users', 4096)];
    state.sequences = [seq('public.ticket_seq', null), seq('public.users_id_seq', 'public.users')];
    await mount();
    expect(view.text()).toContain('public.ticket_seq unowned');
    expect(view.text()).not.toContain('public.users_id_seq');
  });

  // Review Focus 6.
  it('puts every point in "none" with no store, and says once that rows written are not kept', async () => {
    state.tables = [table('public.orders', 9_000_000), table('public.users', 4096)];
    await mount();
    expect(view.container.querySelectorAll('[data-dot]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-band]')).toHaveLength(2);
    expect(view.text().match(/rows written are not kept/g)).toHaveLength(1);
  });

  it('places a table by the rows written to it in the window when the store has them', async () => {
    state.tables = [table('public.orders', 9_000_000), table('public.users', 4096)];
    state.written = { ok: true, value: new Map([['public.orders', 5_000]]) };
    await mount();
    expect(view.container.querySelectorAll('[data-band]')).toHaveLength(1);
    expect(view.text()).not.toContain('rows written are not kept');
  });

  it('says the store could not be read, not that none is configured, when it is down', async () => {
    state.tables = [table('public.orders', 9_000_000)];
    state.written = { ok: false, kind: 'error', message: 'connection refused' };
    await mount();
    expect(view.text()).not.toContain('No store is configured');
    expect(view.text()).toContain('The store could not be read, so rows written are not shown: connection refused');
  });

  it('says the tables were not read, never that there are none', async () => {
    state.total = null;
    state.failed = [{ read: 'tables', message: 'lock timeout' }];
    await mount();
    expect(view.text()).toContain('not read');
    expect(view.text()).not.toMatch(/0 · 0 B|vacuum overdue|no tables/);
    expect(view.text()).toContain('could not be read: lock timeout');
  });

  it('narrows the rows and the plot to the find text', async () => {
    state.tables = [table('public.orders', 9_000_000), table('public.users', 4096)];
    await mount({ find: 'USER' });
    expect(names()).toEqual(['public.users']);
    expect(view.container.querySelectorAll('[data-dot]')).toHaveLength(1);
  });

  it('lists two hundred and counts the rest; says what the cap left out and what could not be read', async () => {
    state.tables = [...Array(205)].map((_, i) => table(`public.t${i}`, 1000 - i));
    state.total = 9_000;
    state.failed = [{ read: 'tables', message: 'statement timeout' }];
    await mount();
    expect(names()).toHaveLength(200);
    expect(view.text()).toContain('+ 5 more');
    expect(view.text()).toContain('the 205 largest of 9,000 tables');
    expect(view.text()).toContain('could not be read: statement timeout');
  });
});
