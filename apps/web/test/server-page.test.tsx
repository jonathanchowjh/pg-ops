import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionDetailRow, HealthMinute, HorizonHolder, Standby } from '@pgops/checks';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/server/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));

const state = vi.hoisted(() => ({
  standby: false,
  holders: [] as unknown[],
  rows: [] as unknown[],
  standbys: [] as unknown[],
  fail: {} as Record<string, string>,
  health: { ok: false, kind: 'off', message: 'History is off.' } as unknown,
  run: [] as string[],
  statsReset: null as number | null,
}));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    state.run.push(check.id);
    if (check.id in state.fail) return { ok: false, reason: 'privilege', message: state.fail[check.id] };
    const data: Record<string, unknown> = {
      replicationLag: { inRecovery: state.standby, lagSeconds: state.standby ? 3 : null, standbys: 0, receiving: state.standby ? true : null },
      wraparound: { worst: [{ database: 'prod', xactAge: 1000, txnsUntilShutdown: 2_147_482_647, pctToForcedVacuum: 0 }] },
      connections: { max: 100, used: 12, reserved: 3, headroom: 85 },
      horizon: { holders: state.holders, truncated: false },
      connectionDetail: { connections: state.rows, sources: [], bySslStatus: {}, total: state.rows.length, truncated: false },
      standbys: { standbys: state.standbys },
      slots: { slots: [] },
      settings: {
        main: [{ name: 'max_connections', value: '100' }, { name: 'statement_timeout', value: '0' }, { name: 'lock_timeout', value: '5s' }],
        autovacuum: [{ name: 'autovacuum_freeze_max_age', value: '200000000' }], vacuum: [],
      },
    };
    return { ok: true, measuredAt: 0, data: data[check.id] ?? {} };
  }),
  readStore: vi.fn(async () => state.health),
}));
vi.mock('@/lib/catalog', async (orig) => ({
  ...(await orig<typeof import('@/lib/catalog')>()),
  catalogFor: async () => ({ tables: [], indexes: [], sequences: [], tablesTotal: 0, indexesTotal: 0, at: null, statsReset: state.statsReset, freezeMaxAge: 2e8, failed: [] }),
}));

import { forget } from '@/lib/samples';

const NOW = Date.now();
const row = (over: Partial<ConnectionDetailRow>): ConnectionDetailRow => ({
  pid: 1, database: 'appdb', user: 'app', source: 'web', ip: null, state: 'active', ssl: null, total_matching: 0, ...over,
});
const holder = (over: Partial<HorizonHolder>): HorizonHolder => ({
  kind: 'backend', who: '4021', xminAge: 500, ageSecs: 90, detail: 'web · idle in transaction', backendStart: 'b4021', waiting: false, ...over,
});
const minute = (over: Partial<HealthMinute> = {}): HealthMinute => ({
  at: NOW - 60_000, connections: 5, serverConnections: 12, maxConnections: 97, lagSecs: null, lagBytes: null, walBytes: 100, xidAge: 1000,
  xminAge: 10, deadlocks: 0, commits: 10, rollbacks: 0, statsReset: null, sizeBytes: null, ...over,
});

let view: Rendered;
const mount = async (sp: Record<string, string> = {}) => {
  view = await render(await Page({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve(sp) }));
};
const buttons = (label: string | RegExp) => [...view.container.querySelectorAll('button')].filter((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
const rows = (heading: string) => {
  const h2 = [...view.container.querySelectorAll('h2')].find((h) => h.textContent?.startsWith(heading));
  let el = h2?.nextElementSibling ?? null;
  while (el !== null && el.querySelector('tbody') === null) el = el.nextElementSibling;
  return [...(el?.querySelectorAll('tbody tr') ?? [])].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''));
};

beforeEach(() => {
  forget();
  Object.assign(state, { standby: false, holders: [], rows: [], standbys: [], fail: {}, health: { ok: false, kind: 'off', message: 'History is off.' }, run: [], statsReset: Date.UTC(2026, 9, 20, 7, 0, 0) });
  vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
});
afterEach(() => { view.unmount(); vi.unstubAllEnvs(); });

describe('the Server page', () => {
  it('draws the panels from the live reads when there is no store, and says the minutes are not kept', async () => {
    await mount();
    for (const title of ['Connections', 'Transaction ID age', 'WAL', 'Transactions']) expect(view.text()).toContain(title);
    expect(view.text()).toContain('No store is configured, so the server’s minutes are not kept');
    expect(view.text()).toContain('No replication lag in this window');
    expect(view.text()).toContain('statistics since');
    // The live reading is the last column: the moment, on a console that keeps no minutes.
    const panel = [...view.container.querySelectorAll('section')].find((s) => s.textContent?.startsWith('Connections'))!;
    expect([...panel.querySelectorAll('tbody tr')].at(-1)!.textContent).toContain('12');
    expect(panel.querySelectorAll('svg path').length).toBeGreaterThan(0);
  });

  it('draws the lag panels when the health row holds a lag', async () => {
    state.health = { ok: true, value: [minute({ lagSecs: 2, lagBytes: 4096 })] };
    await mount();
    expect(view.text()).toContain('Replication lag');
    expect(view.text()).toContain('Still to replay');
    expect(view.text()).not.toContain('No replication lag');
  });

  /** Found by review: the size was written every minute and shown nowhere. */
  it('states the database size the newest minute measured, and nothing with no store', async () => {
    await mount();
    expect(view.text()).not.toContain('on disk');
    view.unmount();
    state.health = { ok: true, value: [minute({ sizeBytes: 2048 }), minute({ at: NOW - 30_000, sizeBytes: null })] };
    await mount();
    expect(view.container.querySelector('h1')!.parentElement!.textContent).toContain('2 KB on disk');
  });

  /** Found by review: the catalog is the last capture, so right after Reset statistics it named the old reset for minutes. */
  it('dates "statistics since" from the newest minute that read a reset, not the catalog', async () => {
    const older = Date.UTC(2026, 9, 21, 7, 0, 0);
    const newer = Date.UTC(2026, 9, 22, 7, 0, 0);
    state.health = { ok: true, value: [minute({ at: NOW - 120_000, statsReset: older }), minute({ statsReset: newer }), minute({ at: NOW - 30_000 })] };
    await mount();
    const since = [...view.container.querySelectorAll('span')].find((s) => s.textContent?.startsWith('statistics since'))!;
    expect(since.querySelector('time')!.getAttribute('datetime')).toBe(new Date(newer).toISOString());
  });

  it('omits "statistics since" when the catalog could not be read', async () => {
    state.statsReset = null;
    await mount();
    expect(view.text()).not.toContain('statistics since');
  });

  it('groups who holds the connections by application and state, and skips the background processes', async () => {
    state.rows = [
      row({ pid: 1 }), row({ pid: 2 }), row({ pid: 3, state: 'idle' }),
      row({ pid: 4, source: 'api', state: 'idle in transaction' }),
      row({ pid: 5, source: '', state: null }),
      row({ pid: 6, database: null, source: '', state: null }),
    ];
    await mount();
    expect(rows('Who holds the connections').map((r) => [r[0], r[2]])).toEqual([['web', '3'], ['api', '1'], ['—', '1']]);
    expect(view.text()).toContain('Idle in transaction');
    expect(view.text()).toContain('Unreadable by this role');
  });

  it('lists what holds the horizon, with Terminate on each backend and Terminate all for the ones over a minute', async () => {
    state.holders = [holder({}), holder({ who: '7', ageSecs: 10, backendStart: 'b7' }), holder({ kind: 'slot', who: 'sub_1', ageSecs: null, detail: 'inactive', backendStart: null })];
    await mount();
    expect(rows('Transactions open longest').map((r) => [r[1], r[3]])).toEqual([['4021', '1m 30s'], ['7', '10s'], ['sub_1', '—']]);
    expect(buttons('Terminate')).toHaveLength(2);
    expect(buttons('Terminate all over 60 s')).toHaveLength(1);
    expect(view.container.querySelector('a[href="/db/prod#pid-4021"]')).not.toBeNull();
  });

  it('offers no Terminate on a waiter, says it is waiting, and leaves it out of Terminate all', async () => {
    state.holders = [holder({ who: '1', backendStart: 'b1' }), holder({ who: '2', backendStart: 'b2', waiting: true })];
    await mount();
    // Terminate is the first cell: at 390 px the table scrolls, and the action must not be what is scrolled off.
    expect(rows('Transactions open longest').map((r) => [r[1], r[2]!.includes('waiting on a lock'), r[0]])).toEqual([
      ['1', false, 'Terminate'], ['2', true, ''],
    ]);
    expect(buttons('Terminate all over 60 s')).toHaveLength(1);
    view.unmount();
    state.holders = [holder({ waiting: true })];
    await mount();
    expect(buttons('Terminate all over 60 s')).toHaveLength(0);
  });

  it('offers no Terminate all when nothing has been open a minute, and says when nothing holds a snapshot', async () => {
    state.holders = [holder({ ageSecs: 10 })];
    await mount();
    expect(buttons('Terminate all over 60 s')).toHaveLength(0);
    view.unmount();
    state.holders = [];
    await mount();
    expect(view.text()).toContain('Nothing holds a snapshot open');
  });

  it('tags a timeout of 0 off, and not one that is set', async () => {
    await mount();
    const settings = rows('Settings');
    expect(settings.find((r) => r[0] === 'statement_timeout')?.[1]).toBe('off0');
    expect(settings.find((r) => r[0] === 'lock_timeout')?.[1]).toBe('5s');
    expect(settings.find((r) => r[0] === 'max_connections')?.[1]).toBe('100');
  });

  it('draws the panels alone in a window in the past: no live read, no section, no action', async () => {
    state.holders = [holder({})];
    await mount({ win: '900', end: String(NOW - 3_600_000) });
    expect(state.run).toEqual([]);
    expect(view.text()).toContain('Connections');
    expect(view.text()).not.toContain('Who holds the connections');
    expect(buttons(/Terminate|Reset/)).toHaveLength(0);
    expect(view.text()).toContain('Recent terminations');
  });

  it('offers Reset statistics on a live window, and nothing on a console that may not act', async () => {
    await mount();
    expect(buttons('Reset statistics')).toHaveLength(1);
    expect(buttons('Reset query statistics')).toHaveLength(1);
    view.unmount();
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'false');
    state.holders = [holder({})];
    await mount();
    expect(buttons(/Terminate|Reset/)).toHaveLength(0);
  });

  it('says a standby is behind, and lists a primary\'s standbys with an unreadable stage as unknown', async () => {
    state.standby = true;
    await mount();
    expect(view.text()).toContain('this server is a standby 3s behind');
    view.unmount();
    state.standby = false;
    state.standbys = [{ app: 'r1', clientAddr: '10.0.0.2', state: 'streaming', syncState: 'async', writeSecs: null, flushSecs: null, replaySecs: null, sentBytes: 0, replayBytes: 1024 } satisfies Standby];
    await mount();
    expect(rows('Replication').map((r) => [r[0], r[3], r[4]])).toEqual([['r110.0.0.2', '—', '1 KB']]);
  });

  it('says why a read failed where its rows would have been', async () => {
    state.fail = { horizon: 'permission denied for view pg_stat_activity', connectionDetail: 'timeout' };
    await mount();
    expect(view.text()).toContain('The holders could not be read: permission denied');
    expect(view.text()).toContain('The connections could not be read: timeout');
  });
});
