import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/page';

// Per-file requirement — see actions.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const state = vi.hoisted(() => ({
  sessions: [] as unknown[],
  fail: null as unknown,
  wraparound: null as { level: string; note: string } | null,
  run: [] as string[],
}));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    state.run.push(check.id);
    if (check.id === 'sessions') {
      return state.fail ?? { ok: true, verdict: null, measuredAt: 0, data: { sessions: state.sessions, truncated: false, hidden: 0 } };
    }
    const verdict = check.id === 'wraparound' && state.wraparound !== null ? state.wraparound : { level: 'ok' };
    return { ok: true, verdict, measuredAt: 0, data: {} };
  }),
}));

// The real `recordFor` and `windowFor`, on the memory path: no store here.
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));
const catalog = vi.hoisted(() => ({
  value: { tables: [], indexes: [], sequences: [] as unknown[], tablesTotal: 0, indexesTotal: 0, at: null, statsReset: null, freezeMaxAge: null, failed: [] as string[] },
  tablesFor: vi.fn(async () => ({ facts: [], total: 0 })),
}));
vi.mock('@/lib/catalog', async (orig) => ({
  ...(await orig<typeof import('@/lib/catalog')>()),
  catalogFor: async () => catalog.value,
  tablesFor: catalog.tablesFor,
}));

import { forget } from '@/lib/samples';

const session = (pid: number, over = {}) => ({
  pid, backendStart: `b${pid}`, user: 'app', app: 'web', clientAddr: null, state: 'active', cls: 'cpu', own: false,
  queryId: '42', query: "UPDATE users SET token = 'hunter2' WHERE id = 1", inStateSecs: 90, queryAgeSecs: 90, xactAgeSecs: 90,
  blockedBy: [], relations: ['public.users'], wanted: null, waitSecs: null, ...over,
});

let view: Rendered;
const mount = async (sp: Record<string, string> = {}) => {
  view = await render(await Page({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve(sp) }));
};
const buttons = (label: string) => [...view.container.querySelectorAll('button')].filter((b) => b.textContent === label);

beforeEach(() => {
  forget();
  Object.assign(state, { sessions: [], fail: null, wraparound: null, run: [] });
  catalog.tablesFor.mockClear();
  catalog.value.sequences = [];
  vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
});
afterEach(() => { view.unmount(); vi.unstubAllEnvs(); });

describe('the database page', () => {
  it('reads the sessions once, and the three Server checks beside them', async () => {
    await mount();
    expect(state.run).toEqual(['sessions', 'replicationLag', 'wraparound', 'connections']);
  });

  it('draws the chain it just read, with its action, before any sample was stored', async () => {
    state.sessions = [
      session(1, { state: 'idle in transaction', cls: 'idle' }),
      session(2, { cls: 'lock', blockedBy: [1], waitSecs: 90 }),
    ];
    await mount();
    expect(view.text()).toMatch(/1 blocks 1 on public\.users/);
    expect(buttons('Terminate').length).toBeGreaterThan(0);
  });

  /**
   * The poll after a Terminate lands in the bucket that already holds the
   * chain. Live is the read just made, so the chain goes on that poll and
   * not when the bucket closes.
   */
  it('drops a chain on the first read that no longer has it', async () => {
    state.sessions = [
      session(1, { state: 'idle in transaction', cls: 'idle' }),
      session(2, { cls: 'lock', blockedBy: [1], waitSecs: 90 }),
    ];
    await mount();
    view.unmount();
    await new Promise((r) => setTimeout(r, 5));
    state.sessions = [session(2)];
    await mount();
    expect(view.text()).not.toMatch(/blocks/);
    expect(view.text()).toContain('nothing needs attention');
  });

  it('never hands the browser a statement it has not redacted', async () => {
    state.sessions = [session(1)];
    await mount();
    expect(view.text()).toContain('UPDATE users SET token');
    expect(view.container.innerHTML).not.toContain('hunter2');
  });

  it('hands the browser a statement\'s shape, never a value it carried', async () => {
    state.sessions = [session(1, { query: "SELECT * FROM users WHERE email = 'jo@x.com' AND id = 1234567" })];
    await mount();
    expect(view.text()).toContain('SELECT * FROM users WHERE email = $1 AND id = $2');
    expect(view.container.innerHTML).not.toContain('jo@x.com');
    expect(view.container.innerHTML).not.toContain('1234567');
  });

  it('reads no database for a window in the past, and offers no action', async () => {
    await mount({ win: '900', end: String(Date.now() - 3_600_000) });
    expect(state.run).toEqual([]);
    expect(buttons('Terminate')).toHaveLength(0);
  });

  it('says the read failed instead of drawing a calm tree', async () => {
    state.fail = { ok: false, reason: 'unreachable', message: 'connection refused' };
    await mount();
    expect(view.text()).toContain('connection refused');
    expect(view.text()).not.toContain('nothing needs attention');
  });

  it('carries the find text from the URL into the tree and the table read', async () => {
    state.sessions = [session(1)];
    await mount({ find: 'orders' });
    expect(view.text()).toContain('nothing named “orders”');
    expect(catalog.tablesFor).toHaveBeenCalledWith('prod', 'orders');
  });

  it('opens on the fifteen minutes it holds when there is no store, and says so only when asked for more', async () => {
    state.sessions = [session(1)];
    await mount();
    expect(view.text()).not.toContain('No store is configured');
    view.unmount();
    await mount({ win: '3600' });
    expect(view.text()).toContain('No store is configured');
  });

  it('names a sequence near its limit at the top, pointing at its table', async () => {
    catalog.value.sequences = [{
      name: 'public.events_id_seq', table: 'public.events', column: 'id', columnType: 'integer',
      maxValue: 2147483647, lastValue: 2_000_000_000, pctUsed: 93.1, readable: true,
    }];
    await mount();
    expect(view.text()).toContain('public.events_id_seq 93% of integer');
    expect(view.container.querySelector('a[href="/db/prod/tables/public.events"]')).not.toBeNull();
  });

  it('shows what a Server read judged, pointing at the page that holds it', async () => {
    state.wraparound = { level: 'warn', note: '212M transactions old' };
    await mount();
    expect(view.text()).toContain('212M transactions old');
    expect(view.container.querySelector('a[href="/db/prod/cleanup"]')).not.toBeNull();
  });
});
