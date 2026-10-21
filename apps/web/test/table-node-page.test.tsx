import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexRead, SequenceEntry, TableRead } from '@pgops/checks';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/tables/[relation]/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), notFound: nav.notFound }));
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));

const state = vi.hoisted(() => ({
  replica: false,
  sessions: [] as unknown[],
  catalog: null as unknown,
  hours: { ok: false, kind: 'off', message: 'History is off.' } as unknown,
  /** What the store reads after the hours answer, in order: the rhythm. */
  later: [] as unknown[],
  read: 0,
  sizes: { ok: false, reason: 'missing-store', message: 'no store' } as unknown,
  scans: { ok: false, kind: 'off', message: 'History is off.' } as unknown,
  asked: [] as (string | undefined)[],
}));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => (check.id === 'identity'
    ? { ok: true, measuredAt: 0, data: { replica: state.replica } }
    : { ok: true, measuredAt: 0, data: { sessions: state.sessions, truncated: false, hidden: 0 } })),
  identityFor: vi.fn(async () => ({ ok: true, measuredAt: 0, data: { replica: state.replica } })),
  runSeriesFor: vi.fn(async () => state.sizes),
  // The hours are read first, then the rhythm.
  readStore: vi.fn(async () => {
    const r = state.later.length > 0 && state.read > 0 ? state.later.shift() : state.hours;
    state.read += 1;
    return r;
  }),
}));
vi.mock('@/lib/catalog', async (orig) => ({
  ...(await orig<typeof import('@/lib/catalog')>()),
  catalogFor: async (_name: string, relation?: string) => { state.asked.push(relation); return state.catalog; },
  scansFor: async () => state.scans,
}));
vi.mock('@/lib/shapes', () => ({ shapesFor: async () => ({ shapes: [], allMs: null }) }));

import { forget } from '@/lib/samples';

const table = (over: Partial<TableRead> = {}): TableRead => ({
  name: 'public.orders', kind: 'table', sizeBytes: 9_000_000, heapBytes: 8_000_000, indexBytes: 1_000_000, liveRows: 48_000,
  deadRows: 90_000, vacuumTrigger: 9_650, inserted: 0, updated: 0, deleted: 0, seqScans: 0, seqRows: 0, idxScans: 9, idxRows: 9,
  hitRate: 0.99, lastVacuum: null, lastAnalyze: null, xidAge: 1, indexes: 1, unvalidated: 0, vacuuming: null, ...over,
});
const index: IndexRead = {
  name: 'public.orders_pkey', table: 'public.orders', columns: 'id', sizeBytes: 4096, scans: 12, hitRate: null, unique: true, primary: true, valid: true, duplicateOf: null,
};
const seq: SequenceEntry = {
  name: 'public.orders_id_seq', table: 'public.orders', column: 'id', columnType: 'integer', maxValue: 2147483647, lastValue: 48_000, pctUsed: 0.002, readable: true,
};
const catalog = (over: Record<string, unknown> = {}) => ({
  tables: [table()], indexes: [index], sequences: [seq], tablesTotal: 1, indexesTotal: 1,
  at: Date.UTC(2026, 9, 12, 8, 0, 0), statsReset: null, freezeMaxAge: 2e8, failed: [], ...over,
});
const session = (pid: number, over = {}) => ({
  pid, backendStart: `b${pid}`, user: 'app', app: 'web', clientAddr: null, state: 'active', cls: 'cpu', own: false,
  // `token`, not any column: redactSecrets keys on the credential-ish name beside the literal.
  queryId: '42', query: "UPDATE orders SET token = 'hunter2' WHERE id = 1", inStateSecs: 90, queryAgeSecs: 90, xactAgeSecs: 90,
  blockedBy: [], relations: ['public.orders'], wanted: null, waitSecs: null, ...over,
});

let view: Rendered;
/** Whether `view` is on the page: a test that only expects a 404 mounts nothing. */
let shown = false;
const mount = (sp: Record<string, string> = {}) =>
  Page({ params: Promise.resolve({ name: 'prod', relation: 'public.orders' }), searchParams: Promise.resolve(sp) });
const show = async (sp: Record<string, string> = {}) => {
  if (shown) view.unmount();
  view = await render(await mount(sp));
  shown = true;
};
beforeEach(() => {
  state.replica = false;
  forget();
  Object.assign(state, {
    sessions: [], catalog: catalog(), hours: { ok: false, kind: 'off', message: 'History is off.' }, later: [], read: 0,
    sizes: { ok: false, reason: 'missing-store', message: 'no store' }, scans: { ok: false, kind: 'off', message: 'History is off.' }, asked: [],
  });
  nav.notFound.mockClear();
  vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
});
afterEach(() => {
  if (shown) view.unmount();
  shown = false;
  vi.unstubAllEnvs();
});

describe('/tables/[relation]', () => {
  it('asks the catalog about this one table, and prints it under its ancestors', async () => {
    await show();
    expect(state.asked).toEqual(['public.orders']);
    expect(view.container.querySelector('nav[aria-label=Breadcrumb]')!.textContent).toBe('prod › Tables › ');
    expect(view.container.querySelector('h1')!.textContent).toBe('public.orders');
    expect(view.text()).toContain('48,000 rows · 8.6 MB');
    expect(view.text()).toContain('vacuum overdue');
  });

  // Review Focus 2.
  it('is a 404 when the catalog was read and the table is not in it', async () => {
    state.catalog = catalog({ tables: [], indexes: [], sequences: [] });
    await expect(mount()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // Review Focus 2.
  it('is not a 404 when the catalog could not be read: it says so', async () => {
    state.catalog = catalog({ tables: [], indexes: [], sequences: [], at: null, failed: [{ read: 'tables', message: 'statement timeout' }] });
    await show();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(view.text()).toContain('could not be read: statement timeout');
  });

  it('lists its statements and their sessions, redacted, with no row for the table itself', async () => {
    state.sessions = [session(1)];
    await show();
    expect(view.text()).toContain('UPDATE orders SET token');
    expect(view.container.innerHTML).not.toContain('hunter2');
    expect(view.container.querySelector('#pid-1')).not.toBeNull();
    expect(view.container.querySelector('[role=row][aria-level="1"]')!.textContent).toContain('UPDATE orders');
  });

  it('lists its indexes and its sequences as rows, the sequence a bar against its limit', async () => {
    await show();
    expect(view.text()).toContain('public.orders_pkey (id)');
    expect(view.text()).toContain('48,000 of integer');
  });

  it('draws its load always, and its hours only where a store keeps them', async () => {
    await show();
    expect(view.text()).toContain('Load');
    expect(view.text()).not.toContain('Dead rows');
    expect(view.text()).toContain('No store is configured');
    state.hours = { ok: true, value: [] };
    await show();
    for (const title of ['Dead rows', 'Rows written', 'Rows read', 'Rhythm']) expect(view.text()).toContain(title);
  });

  it('says an index or sequence list it could not read could not be read, never "none"', async () => {
    state.catalog = catalog({ indexes: [], sequences: [] });
    await show();
    expect(view.text()).toMatch(/Indexesnone/);
    expect(view.text()).toMatch(/against the limit of their typenone/);
    state.catalog = catalog({
      indexes: [], sequences: [],
      failed: [{ read: 'indexes', message: 'lock timeout' }, { read: 'sequences', message: 'lock timeout' }],
    });
    await show();
    expect(view.text()).not.toMatch(/none/);
    expect(view.text()).toMatch(/Indexescould not be read/);
    expect(view.text()).toMatch(/against the limit of their typecould not be read/);
  });

  it('says so in one line when its size or its rhythm could not be read, rather than leaving a gap', async () => {
    state.hours = { ok: true, value: [] };
    state.sizes = { ok: false, reason: 'error', message: 'store timeout' };
    state.later = [{ ok: false, kind: 'error', message: 'store timeout' }];
    await show();
    expect(view.text()).toContain('Its size could not be read: store timeout');
    expect(view.text()).toContain('Its rhythm could not be read: store timeout');
  });

  it('says the store could not be read when it falls back to scans since the reset', async () => {
    state.scans = { ok: false, kind: 'error', message: 'connection refused' };
    await show();
    expect(view.text()).toContain('The store could not be read, so scans are since the reset: connection refused');
    expect(view.text()).toContain('Scans, since the reset');
  });

  it('offers Analyze on a live window with actions on, and names the table in what it posts', async () => {
    await show();
    const analyze = [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Analyze');
    expect(analyze).toBeDefined();
    await show({ win: '900', end: String(Date.now() - 3_600_000) });
    expect([...view.container.querySelectorAll('button')].some((b) => b.textContent === 'Analyze')).toBe(false);
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', '');
    await show();
    expect([...view.container.querySelectorAll('button')].some((b) => b.textContent === 'Analyze')).toBe(false);
  });

  it('does not offer Analyze on a standby, where it would fail', async () => {
    state.replica = true;
    await show();
    expect([...view.container.querySelectorAll('button')].some((b) => b.textContent === 'Analyze')).toBe(false);
  });
});
