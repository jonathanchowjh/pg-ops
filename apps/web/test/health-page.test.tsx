import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATES, GATE_ORDER, HEALTH_METRICS, type HealthPoint } from '@pgops/checks';
import { render, type Rendered } from './render.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ read: null as unknown, asked: null as null | { from: Date; to: Date } }));

vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/lib/health', async (original) => ({
  ...(await original<typeof import('@/lib/health')>()),
  healthFor: vi.fn(async (_names: string[], from: Date, to: Date) => {
    state.asked = { from, to };
    return state.read;
  }),
}));

import Health from '@/app/db/[name]/health/page';
import { COLLECTING, HISTORY_OFF } from '@/lib/health';

const DAY = 86_400_000;
const point = (at: number, over: Partial<HealthPoint>): HealthPoint => ({
  at, ...Object.fromEntries(HEALTH_METRICS.map((m) => [m, null])), ...over,
} as HealthPoint);

/**
 * `days` × 24 hours of history ending now, four points a day. The trend
 * counts 24-hour periods back from the end of the window, which the page
 * takes a moment AFTER this runs; the minute's offset keeps the oldest point
 * inside the oldest period instead of on its edge.
 */
const history = (days: number, over: (day: number) => Partial<HealthPoint>) => {
  const start = Date.now() - days * DAY + 60_000;
  const points = Array.from({ length: days * 4 }, (_, i) =>
    point(start + i * 6 * 3_600_000, over(Math.floor(i / 4))));
  return { ok: true, histories: [{ name: 'prod', rows: points.length, lastAt: Date.now(), points }] };
};

const page = (sp: Record<string, string> = {}) =>
  Health({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve(sp) });

let view: Rendered | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

describe('/db/<name>/health', () => {
  it('says history is off, and how to turn it on', async () => {
    state.read = { ok: false, kind: 'off', message: HISTORY_OFF };
    view = await render(await page());
    expect(view.text()).toContain('PGOPS_STORE_URL');
    expect(view.container.querySelectorAll('figure')).toHaveLength(0);
  });

  it('says it is collecting when there are fewer than two rows', async () => {
    state.read = {
      ok: true,
      histories: [{ name: 'prod', rows: 1, lastAt: Date.now(), points: [point(Date.now(), { blocked: 0 })] }],
    };
    view = await render(await page());
    expect(view.text()).toContain(COLLECTING);
    expect(view.container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('says a past window is empty, not that it is collecting', async () => {
    state.read = { ok: true, histories: [{ name: 'prod', rows: 0, lastAt: Date.now(), points: [] }] };
    view = await render(await page({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T06:00:00Z' }));
    expect(view.text()).toContain('No readings in this window.');
    expect(view.text()).not.toContain(COLLECTING);
  });

  it('groups the charts under the four gates, in gate order', async () => {
    state.read = history(2, () => ({ serverConnections: 30, connections: 9, maxConnections: 97, blocked: 0 }));
    view = await render(await page());
    const headings = [...view.container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual(GATE_ORDER.map((g) => GATES[g].title));
  });

  it('gives the reason in place of a chart whose column was null all window', async () => {
    state.read = history(2, () => ({ serverConnections: 30, blocked: 0 }));
    view = await render(await page());
    expect(view.text()).toContain('No standby reported a replay lag');
  });

  it('labels a server-wide figure as server-wide', async () => {
    state.read = history(2, () => ({ serverConnections: 30, maxConnections: 97 }));
    view = await render(await page());
    expect(view.text()).toContain('Connections · server-wide');
    expect(view.text()).not.toContain('Blocked sessions · server-wide');
  });

  it('says the averages are credited when a statement finishes', async () => {
    state.read = history(2, () => ({ avgActive: 0.4 }));
    view = await render(await page());
    expect(view.text()).toContain('Postgres credits a statement when it finishes');
  });

  it('says how many days of history a trend still needs', async () => {
    state.read = history(3, () => ({ serverConnections: 30, maxConnections: 97 }));
    view = await render(await page({ window: '30d' }));
    expect(view.text()).toContain('Trend needs 7 days of history; 4 more days to go.');
  });

  it('draws the projection and says how it was fitted', async () => {
    state.read = history(10, (d) => ({ serverConnections: 50 + d * 2, maxConnections: 100 }));
    view = await render(await page({ window: '30d' }));
    expect(view.text()).toContain('A straight line through the daily peaks reaches 100');
    expect(view.container.querySelector('line[data-series="fit"]')).not.toBeNull();
  });

  it('marks the current window, and asks the store for exactly that range', async () => {
    state.read = history(2, () => ({ blocked: 0 }));
    view = await render(await page({ window: '7d' }));
    const current = view.container.querySelector('nav[aria-label="Window"] a[aria-current="true"]');
    expect(current!.textContent).toBe('7 days');
    expect(state.asked!.to.getTime() - state.asked!.from.getTime()).toBe(7 * DAY);
  });

  /** Review Focus 2, at the page. */
  it('renders the default window for a URL nobody could mean', async () => {
    state.read = history(2, () => ({ blocked: 0 }));
    view = await render(await page({ from: 'banana', to: 'also banana' }));
    const current = view.container.querySelector('nav[aria-label="Window"] a[aria-current="true"]');
    expect(current!.textContent).toBe('48 hours');
  });

  it('states a URL window in words, since no named window is current', async () => {
    state.read = history(2, () => ({ blocked: 0 }));
    view = await render(await page({ from: '2026-10-01T02:00:00Z', to: '2026-10-01T08:00:00Z' }));
    expect(view.container.querySelector('nav[aria-label="Window"] a[aria-current="true"]')).toBeNull();
    expect(view.text()).toContain('10-01 02:00 to 10-01 08:00 UTC');
  });

  /** Final review: see the same test on the fleet page. */
  it('does not say "collecting" for a database whose last row is old', async () => {
    const last = Date.parse('2026-10-01T02:14:00Z');
    state.read = { ok: true, histories: [{ name: 'prod', rows: 0, lastAt: last, points: [] }] };
    view = await render(await page());
    expect(view.text()).not.toContain(COLLECTING);
    expect(view.text()).toContain('The last was at 10-01 02:14 UTC.');
  });

  it('says it is collecting for a database with no row ever', async () => {
    state.read = { ok: true, histories: [{ name: 'prod', rows: 0, lastAt: null, points: [] }] };
    view = await render(await page());
    expect(view.text()).toContain(COLLECTING);
  });
});
