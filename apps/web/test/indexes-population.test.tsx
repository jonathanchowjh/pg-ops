import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexRead } from '@pgops/checks';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/indexes/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
// The real clockFor and windowFor, on the memory path.
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));
const ran = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_n: string, check: { id: string }) => {
    ran.ids.push(check.id);
    return { ok: true, verdict: null, measuredAt: 0, data: { indexes: [], total: 0, truncated: false } };
  }),
  runToolFor: vi.fn(async (_n: string, tool: { id: string }) => {
    ran.ids.push(tool.id);
    return { ok: true, verdict: null, measuredAt: 0, data: { indexes: [], byQuery: [], examined: 0, totalShapes: 0, statsResetAt: null } };
  }),
  readStore: vi.fn(async () => ({ ok: false, kind: 'off', message: '' })),
}));
const state = vi.hoisted(() => ({
  indexes: [] as unknown[], reset: null as number | null, scans: null as unknown,
  /** Undefined: as many as are listed. Null: never read. */
  total: undefined as number | null | undefined, failed: [] as unknown[],
}));
vi.mock('@/lib/catalog', () => ({
  catalogFor: async () => ({
    tables: [], indexes: state.indexes, sequences: [], tablesTotal: 0, indexesTotal: state.total === undefined ? state.indexes.length : state.total,
    at: Date.UTC(2026, 9, 12, 8, 0, 0), statsReset: state.reset, freezeMaxAge: 2e8, failed: state.failed,
  }),
  scansFor: async () => state.scans,
}));

let view: Rendered;
const mount = async (sp: Record<string, string> = {}) => {
  view = await render(await Page({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve(sp) }));
};
beforeEach(() => { Object.assign(state, { indexes: [], reset: null, scans: { ok: false, kind: 'off', message: 'History is off.' }, total: undefined, failed: [] }); ran.ids = []; });
afterEach(() => { view.unmount(); });
const names = () => [...view.container.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent);

const index = (name: string, sizeBytes: number, over: Partial<IndexRead> = {}): IndexRead => ({
  name, table: 'public.orders', columns: 'status', sizeBytes, scans: 0, hitRate: null, unique: false, primary: false, valid: true, duplicateOf: null, ...over,
});

describe('/indexes', () => {
  it('lists what could be dropped, largest first, each with its table: never used, or a duplicate', async () => {
    state.indexes = [
      index('public.big_used', 9_000, { scans: 40 }), index('public.never', 5_000),
      index('public.dup', 4_000, { scans: 7, duplicateOf: 'public.big_used' }), index('public.orders_pkey', 3_000, { unique: true, primary: true }),
    ];
    await mount();
    expect(names()).toEqual(['public.never (status)', 'public.dup (status)']);
    expect(view.text()).toContain('duplicate of big_used');
    expect(view.container.querySelector('tbody a')!.getAttribute('href')).toBe('/db/prod/tables/public.orders');
    expect(view.text()).toContain('4 · 1 never used');
    expect(view.text()).toContain('1 duplicate · 8.8 KB to reclaim');
  });

  // Review Focus 4.
  it('names the reset "never used" counts from, once, in the head', async () => {
    state.indexes = [index('public.never', 5_000)];
    state.reset = Date.UTC(2026, 9, 3, 14, 2, 0);
    await mount();
    const times = [...view.container.querySelectorAll('h1 ~ * time')].map((t) => t.getAttribute('datetime'));
    expect(times).toEqual(['2026-10-03T14:02:00.000Z']);
    expect(view.text().match(/never used since/g)).toHaveLength(1);
  });

  // Review Focus 4.
  it('says the statistics were never reset rather than naming no moment', async () => {
    state.indexes = [index('public.never', 5_000)];
    await mount();
    expect(view.text()).toContain('never used since statistics began');
  });

  it('puts an index never scanned in the band, and one not scanned in this window on the left edge', async () => {
    state.indexes = [index('public.never', 5_000), index('public.old', 5_000, { scans: 90 }), index('public.hot', 5_000, { scans: 900 })];
    state.scans = { ok: true, value: new Map([['public.hot', 300]]) };
    await mount();
    expect(view.container.querySelectorAll('[data-band]')).toHaveLength(1);
    expect(view.text()).toContain('scans in the window');
  });

  // Review Focus 6.
  it('plots scans since the reset, and says so, when no store keeps the hours', async () => {
    state.indexes = [index('public.hot', 5_000, { scans: 900 })];
    await mount();
    expect(view.text()).toContain('scans since the reset');
  });

  it('says the store could not be read when it plots scans since the reset for that reason', async () => {
    state.indexes = [index('public.hot', 5_000, { scans: 900 })];
    state.scans = { ok: false, kind: 'error', message: 'connection refused' };
    await mount();
    expect(view.text()).toContain('scans since the reset');
    expect(view.text()).toContain('The store could not be read, so scans are since the reset: connection refused');
  });

  it('says the indexes were not read, never that there are none to drop', async () => {
    state.total = null;
    state.failed = [{ read: 'indexes', message: 'lock timeout' }];
    await mount();
    expect(view.text()).toContain('not read');
    expect(view.text()).not.toMatch(/0 never used|to reclaim|nothing to drop/);
    expect(view.text()).toContain('could not be read: lock timeout');
  });

  // Review Focus 3.
  it('draws two thousand of ten thousand, lists two hundred, and counts the rest of each', async () => {
    state.indexes = [...Array(10_000)].map((_, i) => index(`public.i${i}`, 20_000 - i));
    await mount();
    expect(view.container.querySelectorAll('[data-dot]')).toHaveLength(2_000);
    expect(view.text()).toContain('8,000 more not drawn');
    expect(names()).toHaveLength(200);
    expect(view.text()).toContain('+ 9,800 more');
  });

  it('estimates bloat and suggests indexes only from their buttons', async () => {
    state.indexes = [index('public.never', 5_000)];
    await mount();
    expect(ran.ids).toEqual([]);
    expect(view.container.querySelector('a[href*="run=bloat"]')).not.toBeNull();
    view.unmount();
    await mount({ run: 'bloat' });
    expect(ran.ids).toEqual(['indexBloat']);
    view.unmount();
    await mount({ run: 'suggest' });
    expect(ran.ids).toEqual(['indexBloat', 'suggestedIndexes']);
  });
});
