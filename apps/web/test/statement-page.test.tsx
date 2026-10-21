import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/queries/[queryid]/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), notFound: nav.notFound }));
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));

const state = vi.hoisted(() => ({
  sessions: [] as unknown[],
  shape: null as unknown,
  allMs: null as number | null,
  live: null as unknown,
  ran: [] as [string, unknown][],
}));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_n: string, check: { id: string }, opts: unknown) => {
    state.ran.push([check.id, opts]);
    if (check.id === 'sessions') return { ok: true, measuredAt: 0, data: { sessions: state.sessions, truncated: false, hidden: 0 } };
    return state.live;
  }),
}));
vi.mock('@/lib/shapes', () => ({ shapeFor: async () => ({ shape: state.shape, allMs: state.allMs }) }));
vi.mock('@/lib/catalog', () => ({
  catalogFor: async () => ({
    tables: [{ name: 'public.orders', kind: 'table', sizeBytes: 4096, liveRows: 10, deadRows: 0, vacuumTrigger: 52, lastVacuum: null, xidAge: 1, unvalidated: 0, vacuuming: null, idxScans: 0, seqScans: 0 }],
    indexes: [], sequences: [], tablesTotal: 1, indexesTotal: 0, at: 1, statsReset: null, freezeMaxAge: 2e8, failed: [],
  }),
}));

import { forget } from '@/lib/samples';

const session = (pid: number, over = {}) => ({
  pid, backendStart: `b${pid}`, user: 'app', app: 'web', clientAddr: null, state: 'active', cls: 'cpu', own: false,
  // `token`, not any column: redactSecrets keys on the credential-ish name beside the literal.
  queryId: '42', query: "UPDATE orders SET token = 'hunter2' WHERE id = 1", inStateSecs: 90, queryAgeSecs: 90, xactAgeSecs: 90,
  blockedBy: [], relations: ['public.orders'], wanted: null, waitSecs: null, ...over,
});

let view: Rendered;
/** Whether `view` is on the page: a test that only expects a 404 mounts nothing. */
let shown = false;
afterEach(() => {
  if (shown) view.unmount();
  shown = false;
  vi.unstubAllEnvs();
});

const liveRow = (over = {}) => ({
  queryid: '42', query: "UPDATE orders SET token = 'hunter2' WHERE id = $1", calls: 1000, totalMs: 5000, meanMs: 5, stddevMs: 0,
  rows: 3000, cacheHitPct: 80, redacted: false, ...over,
});
const live = (rows: unknown[]) => ({
  ok: true, measuredAt: 0,
  data: { rows, totalShapes: 9, ownShapes: 0, sort: 'total', statsResetAt: '2026-10-12T00:00:00Z', allMs: 20_000 },
});
const shape = { key: '42', text: "UPDATE orders SET token = 'hunter2' WHERE id = $1", relations: ['public.orders'], callsPerSec: 12.4, meanMs: 3.2, calls: 7440, totalMs: 23_808, rowsPerCall: 1, cacheHit: 0.974 };

const mount = (sp: Record<string, string> = {}) =>
  Page({ params: Promise.resolve({ name: 'prod', queryid: '42' }), searchParams: Promise.resolve(sp) });
const show = async (sp: Record<string, string> = {}) => {
  if (shown) view.unmount();
  view = await render(await mount(sp));
  shown = true;
};
const stat = (label: string) => [...view.container.querySelectorAll('[data-stat]')].find((s) => s.textContent!.startsWith(label))?.textContent;
beforeEach(() => {
  forget();
  Object.assign(state, { sessions: [], shape: null, allMs: null, live: live([liveRow()]), ran: [] });
  vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
});

describe('/queries/[queryid]', () => {
  it('reads the sessions and this one shape\'s statistics, under its ancestors', async () => {
    await show();
    expect(state.ran).toEqual([['sessions', {}], ['queryStats', { sort: 'total', limit: 1, queryid: '42' }]]);
    expect(view.container.querySelector('nav[aria-label=Breadcrumb]')!.textContent).toBe('prod › Queries › ');
  });

  it('prints the window\'s numbers on its stat line: rate, mean, rows a call, cache hit and share as meters', async () => {
    state.shape = shape;
    state.allMs = 47_616;
    await show();
    expect(stat('calls / s')).toBe('calls / s12');
    expect(stat('mean')).toBe('mean3.2ms');
    expect(stat('rows / call')).toBe('rows / call1.0');
    expect(stat('cache hit')).toBe('cache hit97.4%');
    expect(stat('share of time')).toBe('share of time50.0%');
    expect(view.container.querySelectorAll('[data-stat] [data-bar]')).toHaveLength(2);
  });

  // Review Focus 6.
  it('falls back to the live counters when the store holds no window, with no rate it cannot know, and says since when', async () => {
    await show();
    expect(stat('calls / s')).toBe('calls / s—');
    expect(stat('mean')).toBe('mean5ms');
    expect(stat('rows / call')).toBe('rows / call3.0');
    expect(stat('share of time')).toBe('share of time25.0%');
    expect(view.text()).toContain('since the statistics were reset');
  });

  it('never hands the browser the statement unredacted: not in the head, the whole text or the Explain button', async () => {
    state.shape = shape;
    state.sessions = [session(1)];
    await show();
    expect(view.container.querySelector('h1')!.textContent).toContain('UPDATE orders SET token');
    expect(view.container.innerHTML).not.toContain('hunter2');
    expect([...view.container.querySelectorAll('button')].some((b) => b.textContent === 'Explain')).toBe(true);
  });

  it('lists the tables it is on and the sessions running it, each at the left edge', async () => {
    state.shape = shape;
    state.sessions = [session(1), session(2, { cls: 'lock', blockedBy: [1], waitSecs: 90 })];
    await show();
    expect(view.container.querySelector('tbody a')!.getAttribute('href')).toBe('/db/prod/tables/public.orders');
    expect(view.container.querySelector('#pid-1')!.getAttribute('aria-level')).toBe('1');
    expect(view.container.querySelector('#pid-2')).not.toBeNull();
  });

  it('says a statement no plan has placed yet is not placed, and one placed on no table is on no table', async () => {
    state.shape = { ...shape, relations: null };
    await show();
    expect(view.text()).toMatch(/this statement reads or writesnot placed/);
    state.shape = null;
    await show();
    expect(view.text()).toMatch(/this statement reads or writesnot placed/);
    state.shape = { ...shape, relations: [] };
    await show();
    expect(view.text()).toMatch(/this statement reads or writeson no table/);
  });

  it('is a 404 for an id nothing knows, and not when the statistics could not be read', async () => {
    state.live = live([]);
    await expect(mount()).rejects.toThrow('NEXT_NOT_FOUND');
    state.live = { ok: false, reason: 'missing-extension', message: 'no pg_stat_statements', remedy: 'CREATE EXTENSION pg_stat_statements;' };
    await show();
    expect(view.container.querySelector('h1')!.textContent).toBe('statement 42');
    // Found by review: dashes and "not placed" with no reason given.
    expect(view.text()).toContain('could not be read: no pg_stat_statements');
    expect(view.text()).toContain('CREATE EXTENSION pg_stat_statements;');
  });
});
