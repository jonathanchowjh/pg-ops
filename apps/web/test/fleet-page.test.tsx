import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult, SessionsData } from '@pgops/checks';
import { render, type Rendered } from './render';
import Fleet from '@/app/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const state = vi.hoisted(() => ({ names: ['prod', 'analytics'] as string[] }));
// No store: every row comes from this process's memory, which the test fills through the real sampler path.
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null, databaseNames: () => state.names }));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async () => { throw new Error('the fleet contacts no database'); }),
  readStore: async () => ({ ok: false, kind: 'off', message: 'History is off.' }),
}));

import { eventFor, forget, recordFor } from '@/lib/samples';
import { GAP_MS } from '@/lib/tree';

const session = (pid: number, over = {}) => ({
  pid, backendStart: `b${pid}`, user: 'app', app: 'web', clientAddr: null, state: 'active', cls: 'cpu', own: false,
  queryId: '42', query: 'UPDATE users SET n = $1', inStateSecs: 90, queryAgeSecs: 90, xactAgeSecs: 90,
  blockedBy: [], relations: ['public.users'], wanted: null, waitSecs: null, ...over,
});
const read = (sessions: unknown[]) => ({ ok: true, verdict: null, measuredAt: 0, data: { sessions, truncated: false, hidden: 0 } }) as unknown as CheckResult<SessionsData>;

let view: Rendered;
const mount = async (sp: Record<string, string> = {}) => {
  view = await render(await Fleet({ searchParams: Promise.resolve(sp) }));
};
const rows = () => [...view.container.querySelectorAll('[role=row]')].map((r) => r.textContent ?? '');

beforeEach(() => { forget(); state.names = ['prod', 'analytics']; });
afterEach(() => { view.unmount(); });

describe('the fleet', () => {
  it('lists every configured database as a row linking to its tree, in the configured order, and contacts none', async () => {
    await mount();
    expect(rows().map((r) => r.slice(0, 9))).toEqual(['prod—›', 'analytics']);
    expect(view.container.querySelector('a[href="/db/prod"]')).not.toBeNull();
    expect(view.container.querySelector('a[href="/db/analytics"]')).not.toBeNull();
    expect(view.text()).toContain('2 databases');
    expect([...view.container.querySelectorAll('button')].filter((b) => /Terminate|Reset|Analyze/.test(b.textContent ?? ''))).toHaveLength(0);
  });

  it('draws a row from the samples this process holds, and says a stretch nobody sampled is not sampled', async () => {
    await recordFor('prod', read([session(1), session(2)]), Date.now() - 30_000);
    await recordFor('prod', read([session(1)]), Date.now() - 15_000);
    await mount();
    const prod = rows()[0]!;
    expect(prod).toMatch(/^prod/);
    // The reading at live is the last sample's, which runs to the window's end.
    expect(prod).toContain('1.0');
    expect(view.container.querySelector('[role=row] svg path')).not.toBeNull();
    expect(rows()[1]).toContain('—');
  });

  it('says since when a database has been unreachable, counts it in the head, and offers nothing on it', async () => {
    await eventFor('analytics', 'unreachable');
    // The event is stamped as it happens; the page's moment must come after it.
    await new Promise((r) => setTimeout(r, 5));
    await mount();
    expect(rows()[1]).toMatch(/unreachable since \d\d:\d\d/);
    expect(view.text()).toContain('2 databases · 1 unreachable');
    expect([...view.container.querySelectorAll('button')].filter((b) => b.textContent === 'Terminate')).toHaveLength(0);
  });

  it('is reachable again once the sampler says so', async () => {
    await eventFor('prod', 'unreachable');
    await eventFor('prod', 'reachable');
    await mount();
    expect(rows()[0]).not.toContain('unreachable');
    expect(view.text()).not.toContain('unreachable');
  });

  it('reads the newest sample at live until the next tick is due, and nothing past a gap', async () => {
    await recordFor('prod', read([session(1), session(2)]), Date.now() - 25_000);
    await mount();
    expect(rows()[0]).toContain('2.0');
    view.unmount();
    forget();
    await recordFor('prod', read([session(1), session(2)]), Date.now() - 60_000);
    await mount();
    expect(rows()[0]).toContain('—');
  });

  it('holds the newest sample as the live column to a gap\'s edge, and not a second past it', async () => {
    await recordFor('prod', read([session(1), session(2)]), Date.now() - (GAP_MS - 1000));
    await mount();
    expect(rows()[0]).toContain('2.0');
    view.unmount();
    forget();
    await recordFor('prod', read([session(1), session(2)]), Date.now() - (GAP_MS + 1000));
    await mount();
    expect(rows()[0]).toContain('—');
  });

  it('tags a row with the chain on it, from the same findings the tree answers with', async () => {
    const chain = [
      session(1, { state: 'idle in transaction', cls: 'idle', inStateSecs: 120 }),
      session(2, { cls: 'lock', blockedBy: [1], waitSecs: 95 }),
    ];
    await recordFor('prod', read(chain), Date.now() - 30_000);
    await recordFor('prod', read(chain), Date.now() - 15_000);
    await recordFor('prod', read(chain), Date.now() - 1);
    await mount();
    expect(rows()[0]).toContain('lock chain');
  });

  it('polls at the sample cadence on a live window, and opens on the fifteen minutes it holds with no store', async () => {
    await mount();
    expect(view.container.querySelector('[aria-current="true"]')?.textContent).toBe('15m');
  });

  it('keys its rows by class, and sends each row only its band, not its tables', async () => {
    await recordFor('prod', read([session(1)]), Date.now() - 5_000);
    await mount();
    expect(view.text()).toContain('Lock wait');
    const html = view.container.innerHTML;
    expect(html).not.toContain('public.users');
  });

  it('says so when no database is configured', async () => {
    state.names = [];
    await mount();
    expect(view.text()).toContain('No database is configured.');
  });
});
